/**
 * ブリッジ(プレイヤーの PC で実行)。
 *
 * Minecraft クライアントからの生 TCP を受け、WS サーバーへ双方向バイト中継する。
 * MC プロトコルは解釈しない。
 *
 * WS が切れても Minecraft クライアントの TCP は切らず、WS を張り直す。
 * 張り直しは ?session= トークンを付けて行い、サーバー側が同じバックエンド TCP に
 * 繋ぎ直す。MC のログイン状態は TCP 接続に紐づくため、WS を張り直すだけでは足りない。
 *
 * 実行: node bridge/index.ts --url wss://mc.example.com
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";

/** WS の送信待ちがこれを超えたら TCP を pause() する(§3.2 バックプレッシャ)。 */
const HIGH_WATER_BYTES = 1024 * 1024;

/** --url にパスが無いときに使う既定パス(server/index.ts の WS_PATH 既定値と一致させる)。 */
const DEFAULT_WS_PATH = "/minecraft";

/** pause() 中に bufferedAmount を確認する間隔。 */
// shortcut: ws は bufferedAmount の減少をイベントで知らせないためタイマーで見る。
// 巨大なフレームを大量に流す用途が出たら ws の _sender 側にフックする。
const DRAIN_POLL_MS = 10;

/** 再接続の初回待ちと上限(指数バックオフ)。 */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** これ以上張り直せないなら諦めてクライアントを切断する。 */
const RECONNECT_DEADLINE_MS = 5 * 60_000;
/** 再接続中にクライアントから預かる上限。超えたら諦める。 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** サーバーが使う close code(server/index.ts と揃える)。 */
const CLOSE_SESSION_OVER = 1000;
const CLOSE_NO_SESSION = 4008;

interface Options {
  url: string;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), "");
    }
  }

  const raw = flags.get("url") ?? process.env.BRIDGE_URL;
  if (!raw) {
    console.error("--url (or BRIDGE_URL) is required, e.g. --url wss://mc.example.com");
    process.exit(1);
  }
  if (!/^wss?:\/\//.test(raw)) {
    console.error("--url must start with ws:// or wss://, got: " + raw);
    process.exit(1);
  }
  // パス省略時はサーバーの WS_PATH 既定値に合わせる(--url wss://mc.example.com で通る)。
  const parsed = new URL(raw);
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = DEFAULT_WS_PATH;
  }

  const port = Number.parseInt(flags.get("port") ?? process.env.BRIDGE_PORT ?? "25565", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("--port (or BRIDGE_PORT) must be a port number");
    process.exit(1);
  }

  const host = flags.get("host") ?? process.env.BRIDGE_HOST ?? "127.0.0.1";

  return { url: parsed.toString(), port, host };
}

function log(line: string): void {
  console.log("[" + new Date().toISOString() + "] " + line);
}

const options = parseArgs(process.argv.slice(2));
let connectionId = 0;
let activeConnections = 0;

const server = net.createServer((client: net.Socket) => {
  const id = ++connectionId;
  activeConnections++;

  // この TCP 接続の識別子。張り直しのたびに ?session= で送り、
  // サーバーが同じバックエンド TCP に繋ぎ直せるようにする。
  const token = randomUUID();
  const targetUrl = new URL(options.url);
  targetUrl.searchParams.set("session", token);

  client.setNoDelay(true);
  log("tcp " + id + " accepted from " + client.remoteAddress + ":" + client.remotePort);

  let closed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  /** 再接続の期限。これを過ぎたらクライアントを切断する。 */
  let deadline = 0;
  /** WS が張れていない間にクライアントから来たバイト(初回接続時・再接続時とも)。 */
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let downloading = false;

  client.pause();

  function close(reason: string): void {
    if (closed) return;
    closed = true;
    activeConnections--;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    client.destroy();
    // 直前に送ったバイトを捨てないよう、開いている WS は close で畳む。
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1000);
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref();
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
    log("closed " + id + " (" + reason + ")");
  }

  function connect(): void {
    if (closed) return;
    const url = new URL(targetUrl);
    if (attempt > 0) url.searchParams.set("resume", "1");
    const socket = new WebSocket(url.toString(), {
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    });
    ws = socket;

    socket.on("open", () => {
      if (closed || ws !== socket) return;
      const reconnected = attempt > 0;
      attempt = 0;
      deadline = 0;
      log("ws " + id + (reconnected ? " reconnected to " : " connected to ") + options.url);
      // 溜めていたクライアントのバイトを順番どおり流す。
      for (const chunk of pending) socket.send(chunk);
      pending = [];
      pendingBytes = 0;
      client.resume();
    });

    socket.on("message", (data, isBinary) => {
      if (closed || ws !== socket || !isBinary) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      if (client.destroyed) return;
      if (!client.write(chunk) && !downloading) {
        socket.pause();
        downloading = true;
      }
    });

    socket.on("error", (error: Error) => {
      // §3.2-4: 接続失敗の原因を標準エラーへ 1 行。
      console.error("ws " + id + " error: " + error.message);
      if (error.message.includes("EPROTO")) {
        console.error("ws " + id + " hint: オリジンは平文 HTTP です。ローカルで試すときは ws:// を使ってください");
      }
    });

    socket.on("close", (code: number) => {
      if (closed || ws !== socket) return;
      ws = null;
      // サーバーが「セッション終了」と言ったら張り直さない(オフライン応答後など)。
      // それ以外(1006 = 回線断、CF のメンテ等)は再開を試みる。
      if (code === CLOSE_SESSION_OVER) {
        close("session-closed-by-server");
        return;
      }
      if (code === CLOSE_NO_SESSION) {
        console.error("ws " + id + " サーバー側のセッションが失われました(再接続では復旧できません)。Minecraft から再接続してください");
        close("session-lost");
        return;
      }
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    if (deadline === 0) deadline = Date.now() + RECONNECT_DEADLINE_MS;
    if (Date.now() > deadline) {
      close("reconnect-deadline");
      return;
    }
    // 張り直し中はクライアントの読み取りを止める(書き込みは TCP バッファが吸収する)。
    client.pause();
    const wait = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt++;
    log("reconnecting " + id + " in " + wait + "ms (attempt " + attempt + ")");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
    reconnectTimer.unref();
  }

  client.on("data", (chunk: Buffer) => {
    if (closed) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (pendingBytes + chunk.length > MAX_PENDING_BYTES) {
        close("pending-overflow");
        return;
      }
      pending.push(chunk);
      pendingBytes += chunk.length;
      return;
    }
    ws.send(chunk);
    // 送信待ちが溜まったら TCP を止める(§3.2 バックプレッシャ)。WS が吐いたら 'drain' に近い
    // タイミングで再開するため、DRAIN_POLL_MS ごとに bufferedAmount を見る。
    if (ws.bufferedAmount > HIGH_WATER_BYTES && !client.isPaused()) {
      client.pause();
      const timer = setTimeout(pollDrain, DRAIN_POLL_MS);
      timer.unref();
    }
  });

  function pollDrain(): void {
    if (closed) return;
    const socket = ws;
    if (!socket || socket.bufferedAmount <= HIGH_WATER_BYTES) {
      if (socket && socket.readyState === WebSocket.OPEN) client.resume();
      return;
    }
    const timer = setTimeout(pollDrain, DRAIN_POLL_MS);
    timer.unref();
  }

  client.on("end", () => {
    // 半終了は扱わない(§3.2-3)。
    close("tcp-end");
  });

  client.on("error", (error: Error) => {
    close("tcp-error:" + error.message);
  });

  client.on("close", () => {
    close("tcp-close");
  });

  client.on("drain", () => {
    if (closed || !downloading) return;
    downloading = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.resume();
  });

  connect();
});

server.on("error", (error: Error) => {
  console.error("listen error: " + error.message);
  process.exit(1);
});

server.listen(options.port, options.host, () => {
  log("listening on " + options.host + ":" + options.port + " -> " + options.url);
  log("add \"localhost\" in Minecraft (or " + options.host + ":" + options.port + ")");
});

function stop(): void {
  log("shutting down (" + activeConnections + " active)");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
