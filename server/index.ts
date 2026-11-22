/**
 * WS サーバー(オリジンで常駐)。
 *
 * プレイヤー側ブリッジからの WebSocket を、バックエンドの Minecraft サーバー(TCP)へ
 * 双方向中継する。バックエンドが落ちているときだけ §4.3 のオフライン応答を返す。
 *
 * WS が切れてもバックエンド TCP は維持し、ブリッジが ?session= を付けて張り直してきたら
 * 同じ TCP に繋ぎ直す(セッション再開)。MC のログイン状態は TCP 接続に紐づくため、
 * 「WS を張り直すだけ」ではクライアントが壊れる。
 *
 * 実行: UPSTREAM_HOST=127.0.0.1 PORT=80 node server/index.ts
 */
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  ProtocolError,
  echoPacket,
  encodeOfflineDisconnect,
  encodeOfflineStatusResponse,
  isPing,
  isStatusRequest,
  parseHandshake,
  readPacket,
  type Handshake,
  type Packet,
} from "./protocol.ts";

// §4.4 タイムアウト
const GREETING_TIMEOUT_MS = 10_000;
const BACKEND_CONNECT_TIMEOUT_MS = 5_000;
const OFFLINE_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 5_000;

/** WS が切れてからセッションを畳むまでの猶予。MC の keepalive 猶予(30 秒)より短くする。 */
const RESUME_GRACE_MS = 20_000;
/** 切断中にバックエンドから届いたぶんを溜めておける上限。超えたらセッションを畳む。 */
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024;
/** keepalive の間隔。死んだ WS をこの 2 倍以内に検出する。 */
const PING_INTERVAL_MS = 15_000;

/**
 * WS の close code で「張り直してよいか」をブリッジに伝える。
 * - 1000: セッション終了(オフライン応答を返した等)。張り直さない。
 * - 4008: トークンに対応するセッションが無い。張り直しても無駄。
 * - それ以外(1006 = 回線断): 張り直して再開する。
 */
const CLOSE_SESSION_OVER = 1000;
const CLOSE_NO_SESSION = 4008;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(name + " is required");
    process.exit(1);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(name + " must be a port number, got: " + raw);
    process.exit(1);
  }
  return value;
}

const UPSTREAM_HOST = requireEnv("UPSTREAM_HOST");
const UPSTREAM_PORT = intEnv("UPSTREAM_PORT", 25565);
const PORT = intEnv("PORT", 80);
const WS_PATH = process.env.WS_PATH ?? "/minecraft";

const httpServer = createServer((req, res) => {
  // テスト専用: 接続中の WS を落として再接続経路を検証する。
  // DROP_HOOK=1 のときだけ有効(本番では 404)。
  if (process.env.DROP_HOOK === "1" && req.url === "/__drop") {
    for (const client of wss.clients) client.terminate();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("dropped\n");
    return;
  }
  // Cloudflare 経由の Upgrade 以外はここに来る。存在を悟らせない。
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found\n");
});

const wss = new WebSocketServer({ noServer: true });

/** ?session= のトークン → セッション。再開のためだけに使う。 */
const sessions = new Map<string, Session>();

httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? "/", "http://origin");
  if (url.pathname !== WS_PATH) {
    socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    return;
  }
  const token = url.searchParams.get("session");
  // 初回接続は session=、張り直しは resume=1 を付けてくる。
  const isResume = url.searchParams.get("resume") === "1";
  wss.handleUpgrade(req, socket, head, (ws) => {
    onConnection(ws, req, token, isResume);
  });
});

/** WS 送信。WRITE_TIMEOUT_MS 以内に送れなければ失敗扱い。 */
function send(ws: WebSocket, data: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, WRITE_TIMEOUT_MS);
    ws.send(data, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(!error);
    });
  });
}

type Phase = "greeting" | "connecting" | "relay" | "offline" | "done";

interface Session {
  id: number;
  /** 再開用トークン。ブリッジが ?session= で付けてくる。 */
  token: string | null;
  /** 切断中は null。 */
  ws: WebSocket | null;
  peer: string;
  phase: Phase;
  buffer: Buffer;
  socket: net.Socket | null;
  handshake: Handshake | null;
  statusSent: boolean;
  greetingTimer: NodeJS.Timeout | null;
  offlineTimer: NodeJS.Timeout | null;
  writeTimer: NodeJS.Timeout | null;
  detachTimer: NodeJS.Timeout | null;
  /** WS が切れている間にバックエンドから届いたぶん。再開時に順番どおり流す。 */
  outbox: Buffer[];
  outboxBytes: number;
  relayPaused: boolean;
  closed: boolean;
}

let nextSessionId = 1;

function onConnection(ws: WebSocket, req: IncomingMessage, token: string | null, isResume: boolean): void {
  const existing = token ? sessions.get(token) : undefined;

  if (isResume) {
    // 張り直し: バックエンド TCP が生きていれば、そのまま新しい WS に繋ぎ直す。
    if (existing && !existing.closed && existing.phase === "relay" && existing.socket && !existing.socket.destroyed) {
      resumeSession(existing, ws);
      return;
    }
    // 再開先が無い = セッションは既に終わっている。張り直しても無駄なので伝えて終わる。
    log("resume-miss " + (token ?? "?").slice(0, 8) + " " + (req.socket.remoteAddress ?? "unknown"));
    ws.close(CLOSE_NO_SESSION, "no-session");
    return;
  }

  const session: Session = {
    id: nextSessionId++,
    token,
    ws,
    peer: req.socket.remoteAddress ?? "unknown",
    phase: "greeting",
    buffer: Buffer.alloc(0),
    socket: null,
    handshake: null,
    statusSent: false,
    greetingTimer: null,
    offlineTimer: null,
    writeTimer: null,
    detachTimer: null,
    outbox: [],
    outboxBytes: 0,
    relayPaused: false,
    closed: false,
  };
  if (token) sessions.set(token, session);

  log("open #" + session.id + " " + session.peer + (token ? " (resumable)" : ""));

  session.greetingTimer = setTimeout(() => {
    shutdown(session, "greeting-timeout");
  }, GREETING_TIMEOUT_MS);

  bindWs(session, ws);
}

/** WS のイベントをセッションに繋ぐ。再開時は新しい ws で呼び直す。 */
function bindWs(session: Session, ws: WebSocket): void {
  session.ws = ws;

  ws.on("message", (data, isBinary) => {
    if (session.ws !== ws || session.closed) return;
    if (!isBinary) {
      onWsGone(session, "binary-frame-expected");
      return;
    }
    const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
    onWsData(session, chunk);
  });

  ws.on("close", () => {
    if (session.ws !== ws) return;
    onWsGone(session, "peer-closed");
  });

  ws.on("error", () => {
    if (session.ws !== ws) return;
    onWsGone(session, "ws-error");
  });
}

function log(line: string): void {
  console.log("[" + new Date().toISOString() + "] " + line);
}

/** WS が切れた。中継中でトークンがあれば、バックエンドを維持したまま再開を待つ。 */
function onWsGone(session: Session, reason: string): void {
  if (session.closed) return;
  if (session.phase !== "relay" || session.token === null) {
    shutdown(session, reason);
    return;
  }
  session.ws = null;
  session.detachTimer = setTimeout(() => {
    shutdown(session, "resume-timeout");
  }, RESUME_GRACE_MS);
  log("detach #" + session.id + " (" + reason + ") waiting " + RESUME_GRACE_MS + "ms for resume");
}

/** 張り直してきた WS を、生きているバックエンド TCP に繋ぎ直す。 */
function resumeSession(session: Session, ws: WebSocket): void {
  if (session.detachTimer) clearTimeout(session.detachTimer);
  session.detachTimer = null;

  const stale = session.ws;
  bindWs(session, ws);
  if (stale && stale.readyState === WebSocket.OPEN) stale.terminate();

  log("resume #" + session.id + " (outbox " + session.outboxBytes + " bytes)");

  const pendingOut = session.outbox;
  session.outbox = [];
  session.outboxBytes = 0;
  for (const chunk of pendingOut) {
    void send(ws, chunk).then((ok) => {
      if (!ok) onWsGone(session, "ws-write-failed");
    });
  }

  // 切断前にバックエンド書き込みが詰まっていた場合、新しい WS は pause されたままなので解除する。
  if (session.relayPaused) {
    session.relayPaused = false;
    if (session.socket && !session.socket.destroyed) session.socket.resume();
  }
}

function shutdown(session: Session, reason: string): void {
  if (session.closed) return;
  session.closed = true;
  session.phase = "done";
  if (session.token !== null && sessions.get(session.token) === session) {
    sessions.delete(session.token);
  }
  if (session.greetingTimer) clearTimeout(session.greetingTimer);
  if (session.offlineTimer) clearTimeout(session.offlineTimer);
  if (session.writeTimer) clearTimeout(session.writeTimer);
  if (session.detachTimer) clearTimeout(session.detachTimer);
  session.greetingTimer = null;
  session.offlineTimer = null;
  session.writeTimer = null;
  session.detachTimer = null;
  session.outbox = [];
  session.outboxBytes = 0;
  session.socket?.destroy();
  session.socket = null;
  const ws = session.ws;
  session.ws = null;
  // 送信済みのバイトを捨てないよう、開いている WS は close で畳む
  // (close フレームは送信待ちのフレームの後ろに並ぶ)。取りこぼす相手は 1 秒で切る。
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(CLOSE_SESSION_OVER);
    const timer = setTimeout(() => ws.terminate(), 1000);
    timer.unref();
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
  }
  log("close #" + session.id + " " + reason);
}

function onWsData(session: Session, chunk: Buffer): void {
  if (session.closed) return;

  switch (session.phase) {
    case "greeting": {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      let handshake: Handshake | null = null;
      try {
        handshake = parseHandshake(session.buffer);
      } catch (error) {
        const code = error instanceof ProtocolError ? error.code : "parse-error";
        shutdown(session, "bad-greeting(" + code + ")");
        return;
      }
      if (handshake === null) return; // まだ足りない。蓄積を続ける。
      if (session.greetingTimer) clearTimeout(session.greetingTimer);
      session.greetingTimer = null;
      session.handshake = handshake;
      connectBackend(session);
      return;
    }

    case "connecting": {
      // バックエンド接続中。捨てずに蓄積し、確立後にまとめて転送する。
      session.buffer = Buffer.concat([session.buffer, chunk]);
      return;
    }

    case "relay": {
      const socket = session.socket;
      if (!socket || socket.destroyed) {
        shutdown(session, "backend-gone");
        return;
      }
      if (!socket.write(chunk)) {
        session.ws?.pause();
        session.relayPaused = true;
        if (session.writeTimer === null) {
          session.writeTimer = setTimeout(() => {
            shutdown(session, "backend-write-timeout");
          }, WRITE_TIMEOUT_MS);
        }
      }
      return;
    }

    case "offline": {
      session.buffer = Buffer.concat([session.buffer, chunk]);
      pumpOffline(session);
      return;
    }

    default:
      return;
  }
}

function connectBackend(session: Session): void {
  const handshake = session.handshake!;
  session.phase = "connecting";

  const socket = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
  session.socket = socket;
  let settled = false;

  const connectTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    goOffline(session, "backend-timeout");
  }, BACKEND_CONNECT_TIMEOUT_MS);

  socket.once("connect", () => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    if (session.closed) {
      socket.destroy();
      return;
    }
    session.phase = "relay";
    log(
      "relay #" + session.id + " host=" + handshake.host + " state=" + handshake.nextState +
        " -> " + UPSTREAM_HOST + ":" + UPSTREAM_PORT,
    );

    // 受信済みバイト(ハンドシェイク + 読み過ぎた残り)をそのまま転送する。
    const pendingBytes = session.buffer;
    session.buffer = Buffer.alloc(0);
    socket.write(pendingBytes);

    socket.on("data", (data: Buffer) => {
      if (session.closed) return;
      const ws = session.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // 切断中。再開時に順番どおり流す。
        if (session.outboxBytes + data.length > MAX_OUTBOX_BYTES) {
          shutdown(session, "resume-backlog-overflow");
          return;
        }
        session.outbox.push(data);
        session.outboxBytes += data.length;
        return;
      }
      void send(ws, data).then((ok) => {
        if (!ok) onWsGone(session, "ws-write-failed");
      });
    });

    socket.on("drain", () => {
      if (session.writeTimer) {
        clearTimeout(session.writeTimer);
        session.writeTimer = null;
      }
      if (session.relayPaused && !session.closed) {
        session.relayPaused = false;
        session.ws?.resume();
      }
    });

    socket.on("close", () => {
      shutdown(session, "backend-closed");
    });

    socket.on("error", () => {
      shutdown(session, "backend-error");
    });
  });

  socket.once("error", () => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    socket.destroy();
    goOffline(session, "backend-unreachable");
  });
}

function goOffline(session: Session, reason: string): void {
  if (session.closed) return;
  const handshake = session.handshake!;
  session.socket?.destroy();
  session.socket = null;
  session.phase = "offline";
  // ハンドシェイク自体は消費済み。接続試行中に届いたぶんも含め、後続バイトを残す。
  session.buffer = session.buffer.subarray(handshake.packetSize);
  log("backend-unreachable #" + session.id + " (" + reason + ") nextState=" + handshake.nextState);

  session.offlineTimer = setTimeout(() => {
    shutdown(session, "offline-timeout");
  }, OFFLINE_TIMEOUT_MS);

  if (handshake.nextState !== 1) {
    // Login / Transfer: Disconnect を返して閉じる。
    const ws = session.ws;
    if (!ws) {
      shutdown(session, "offline-no-ws");
      return;
    }
    void send(ws, encodeOfflineDisconnect()).then(() => {
      shutdown(session, "offline-disconnect-sent");
    });
    return;
  }

  // Status: ハンドシェイクの後ろに既に来ているパケットを処理する。
  pumpOffline(session);
}

function pumpOffline(session: Session): void {
  if (session.closed) return;

  for (;;) {
    let packet: Packet | null = null;
    try {
      packet = readPacket(session.buffer);
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : "parse-error";
      shutdown(session, "offline-bad-packet(" + code + ")");
      return;
    }
    if (packet === null) return;
    session.buffer = session.buffer.subarray(packet.size);

    // Status Request には 1 回だけ Status Response を返す。
    if (!session.statusSent) {
      if (!isStatusRequest(packet)) {
        shutdown(session, "offline-unexpected-packet");
        return;
      }
      session.statusSent = true;
      const ws = session.ws;
      if (!ws) {
        shutdown(session, "offline-no-ws");
        return;
      }
      void send(ws, encodeOfflineStatusResponse()).then((ok) => {
        if (!ok) shutdown(session, "ws-write-failed");
      });
      continue;
    }

    // その後は Ping だけ受け付け、そのままエコーして閉じる。
    if (isPing(packet)) {
      const ws = session.ws;
      if (!ws) {
        shutdown(session, "offline-no-ws");
        return;
      }
      void send(ws, echoPacket(packet)).then(() => {
        shutdown(session, "offline-ping-echoed");
      });
      return;
    }

    shutdown(session, "offline-unexpected-packet");
    return;
  }
}

// 無通信のまま死んだ WS を刈る。応答が無いものは terminate → 再開待ちに落ちる。
const keepalive = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const state = client as WebSocket & { isAlive?: boolean };
    if (state.isAlive === false) {
      client.terminate();
      continue;
    }
    state.isAlive = false;
    client.ping();
  }
}, PING_INTERVAL_MS);
keepalive.unref();

wss.on("connection", (ws: WebSocket) => {
  const state = ws as WebSocket & { isAlive?: boolean };
  state.isAlive = true;
  ws.on("pong", () => {
    state.isAlive = true;
  });
});

httpServer.listen(PORT, () => {
  log("listening on :" + PORT + " ws path " + WS_PATH + " -> " + UPSTREAM_HOST + ":" + UPSTREAM_PORT);
});

function stop(): void {
  clearInterval(keepalive);
  for (const client of wss.clients) client.terminate();
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
