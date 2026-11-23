/**
 * WS サーバーのコア実装(GUI / CLI 両方から使える形)。
 *
 * プレイヤー側ブリッジからの WebSocket を、バックエンドの Minecraft サーバー(TCP)へ
 * 双方向中継する。バックエンドが落ちているときだけ §4.3 のオフライン応答を返す。
 *
 * WS が切れてもバックエンド TCP は維持し、ブリッジが ?session= を付けて張り直してきたら
 * 同じ TCP に繋ぎ直す(セッション再開)。MC のログイン状態は TCP 接続に紐づくため、
 * 「WS を張り直すだけ」ではクライアントが壊れる。
 *
 * 中継は frames.ts の FrameChannel(連番 + リプレイ + ACK)経由で行う。
 * WS が切れた瞬間の「送ったけど届いたか分からない」フレームを、受信側が連番で検出して
 * 再送させることで、バイトストリームを欠損なく再開する。
 *
 * CLI: server/index.ts
 */
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  FrameChannel,
} from "../frames.ts";
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
/** keepalive の間隔。死んだ WS をこの 2 倍以内に検出する。 */
const PING_INTERVAL_MS = 15_000;

/** リプレイ用リングの上限(1 セッションあたり、方向ごと)。 */
const REPLAY_WINDOW_BYTES = 16 * 1024 * 1024;
/** バックエンド → WS 方向の流量制限。未交付がこれを超えたらバックエンドの読み取りを止める。 */
const OUT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const OUT_LOW_WATER_BYTES = 1 * 1024 * 1024;

/**
 * WS の close code で「張り直してよいか」をブリッジに伝える。
 * - 1000: セッション終了(オフライン応答を返した等)。張り直さない。
 * - 4008: トークンに対応するセッションが無い。張り直しても無駄。
 * - 4009: リプレイ範囲がリング外で、バイト連続性を回復できない。張り直しても無駄。
 * - それ以外(1006 = 回線断): 張り直して再開する。
 */
const CLOSE_SESSION_OVER = 1000;
const CLOSE_NO_SESSION = 4008;
const CLOSE_REPLAY_GAP = 4009;

export interface WsServerConfig {
  /** バックエンドの IP またはホスト名(必須)。 */
  upstreamHost: string;
  /** バックエンドのポート(既定 25565)。 */
  upstreamPort: number;
  /** HTTP / WS を受けるポート(既定 80)。 */
  port: number;
  /** WS のパス(既定 /minecraft)。 */
  wsPath: string;
  /** テスト専用の WS 切断フック(/__drop)を有効化する。 */
  dropHook?: boolean;
}

export interface WsServerHooks {
  /** 進行状況の 1 行ログ(時刻は付けない)。 */
  log?(line: string): void;
  /** 警告・エラーの 1 行ログ。 */
  error?(line: string): void;
}

export interface WsServerHandle {
  sessions(): number;
  stop(): Promise<void>;
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
  /** WS ↔ ブリッジのフレーム処理(連番 + リプレイ + ACK)。 */
  channel: FrameChannel;
  /** バックエンド → WS 方向の流量制限で止まっているか。 */
  outPaused: boolean;
  /** バックエンドへの書き込みが詰まっている(bridge → backend 方向の ACK を遅らせる)。 */
  relayPaused: boolean;
  closed: boolean;
}

/** WS サーバーを起動する。listen が確立したら resolve、失敗したら reject。 */
export function startServer(config: WsServerConfig, hooks: WsServerHooks = {}): Promise<WsServerHandle> {
  return new Promise((resolve, reject) => {
    const log = hooks.log ?? (() => {});
    const warn = hooks.error ?? (() => {});

    const httpServer = createServer((req, res) => {
      // テスト専用: 接続中の WS を落として再接続経路を検証する。
      // 明示的に有効化したときだけ(本番では 404)。
      if (config.dropHook && req.url === "/__drop") {
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
    let nextSessionId = 1;

    httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", "http://origin");
      if (url.pathname !== config.wsPath) {
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
        channel: null as unknown as FrameChannel,
        outPaused: false,
        relayPaused: false,
        closed: false,
      };

      // ブリッジ → このサーバー方向のフレーム処理。
      session.channel = new FrameChannel({
        windowBytes: REPLAY_WINDOW_BYTES,
        highWaterBytes: OUT_HIGH_WATER_BYTES,
        lowWaterBytes: OUT_LOW_WATER_BYTES,
        send: (frame) => {
          if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(frame);
        },
        isSendable: () => session.ws !== null && session.ws.readyState === WebSocket.OPEN,
        onDeliver: (payload) => onWsData(session, payload),
        onFatal: (reason) => shutdown(session, "frame-fatal(" + reason + ")"),
        onReplayImpossible: () => {
          // リングから落ちた連番を要求された → もうバイト連続性は回復できない。
          const ws = session.ws;
          if (ws) ws.close(CLOSE_REPLAY_GAP, "replay-gap");
        },
        // バックエンドへの書き込みが詰まっている間は ACK を遅らせ、
        // ブリッジ側の送信(クライアントの読み取り)に流量制限を効かせる。
        ackGate: () => !session.relayPaused,
      });
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

      // keepalive の死活管理。noServer + handleUpgrade では wss の connection イベントが
      // 発火しないため、WS を束ねるこの関数で付ける(再開後の新しい ws にも効く)。
      const state = ws as WebSocket & { isAlive?: boolean };
      state.isAlive = true;
      ws.on("pong", () => {
        state.isAlive = true;
      });

      ws.on("message", (data, isBinary) => {
        if (session.ws !== ws || session.closed) return;
        if (!isBinary) {
          onWsGone(session, "binary-frame-expected");
          return;
        }
        const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        session.channel.feed(chunk);
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

      log("resume #" + session.id + " (unacked " + session.channel.unackedBytes() + " bytes)");

      // 切断中の損失があれば、連番で検出されてリプレイが飛んでくる。
      // 応答速度のため、ACK されていないぶんはこちらから積極的に再送しておく。
      session.channel.replayUnacked();

      // 切断前にバックエンド書き込みが詰まっていた場合、解除する。
      if (session.relayPaused) {
        session.relayPaused = false;
        if (session.socket && !session.socket.destroyed) session.socket.resume();
      }
    }

    function shutdown(session: Session, reason: string): void {
      if (session.closed) return;
      session.closed = true;
      session.phase = "done";
      session.channel.close();
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

    /** ブリッジからのフレーム(payload は MC バイト列)を状態機械へ流す。 */
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

    /** バックエンド → WS 方向の流量制限: 未交付が閾値を超えたらバックエンドの読み取りを止める。 */
    function checkOutPause(session: Session): void {
      if (session.outPaused || session.closed) return;
      const socket = session.socket;
      if (!socket || socket.destroyed) return;
      if (session.channel.unackedBytes() > OUT_HIGH_WATER_BYTES) {
        session.outPaused = true;
        socket.pause();
      }
    }

    /** ACK が戻って未交付が減ったら、止めていたバックエンドの読み取りを再開する。 */
    function maybeResumeOut(session: Session): void {
      if (!session.outPaused || session.closed) return;
      const socket = session.socket;
      if (!socket || socket.destroyed) return;
      if (session.channel.unackedBytes() < OUT_LOW_WATER_BYTES) {
        session.outPaused = false;
        socket.resume();
      }
    }

    function connectBackend(session: Session): void {
      const handshake = session.handshake!;
      session.phase = "connecting";

      const socket = net.connect({ host: config.upstreamHost, port: config.upstreamPort });
      // MC は小さなパケットを高頻度で往復させる。Nagle + delayed ACK の
      // 相互作用で数十 ms のジッターが出るため無効化する。
      socket.setNoDelay(true);
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
            " -> " + config.upstreamHost + ":" + config.upstreamPort,
        );

        // 受信済みバイト(ハンドシェイク + 読み過ぎた残り)をそのまま転送する。
        const pendingBytes = session.buffer;
        session.buffer = Buffer.alloc(0);
        socket.write(pendingBytes);

        socket.on("data", (data: Buffer) => {
          if (session.closed) return;
          // FrameChannel が連番を付け、リングに保持し、開いていれば WS へ送る。
          // WS が切れていてもリングに残るので、再開後に欠損なく届く。
          session.channel.deliverRaw(data);
          checkOutPause(session);
        });

        socket.on("drain", () => {
          if (session.writeTimer) {
            clearTimeout(session.writeTimer);
            session.writeTimer = null;
          }
          if (session.relayPaused && !session.closed) {
            session.relayPaused = false;
            // 詰まりが解けたら ACK を遅らせていたぶんをすぐ出す。
            session.channel.flushAck();
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
        if (session.ws === null) {
          shutdown(session, "offline-no-ws");
          return;
        }
        session.channel.deliverRaw(encodeOfflineDisconnect());
        shutdown(session, "offline-disconnect-sent");
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
          if (session.ws === null) {
            shutdown(session, "offline-no-ws");
            return;
          }
          session.channel.deliverRaw(encodeOfflineStatusResponse());
          continue;
        }

        // その後は Ping だけ受け付け、そのままエコーして閉じる。
        if (isPing(packet)) {
          if (session.ws === null) {
            shutdown(session, "offline-no-ws");
            return;
          }
          session.channel.deliverRaw(echoPacket(packet));
          shutdown(session, "offline-ping-echoed");
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

    httpServer.on("error", (error: Error & { code?: string }) => {
      if (listenError) return;
      listenError = error;
      if (error.code === "EADDRINUSE") {
        warn("ポート " + config.port + " は既に使われています");
      } else if (error.code === "EACCES") {
        warn("ポート " + config.port + " を開く権限がありません");
      } else {
        warn("listen error: " + error.message);
      }
      clearInterval(keepalive);
      reject(error);
    });

    let listenError: (Error & { code?: string }) | null = null;

    httpServer.listen(config.port, () => {
      log("listening on :" + config.port + " ws path " + config.wsPath + " -> " +
        config.upstreamHost + ":" + config.upstreamPort);
      resolve({
        sessions: () => {
          let count = 0;
          for (const session of sessions.values()) if (!session.closed) count++;
          return count;
        },
        stop: () =>
          new Promise<void>((done) => {
            clearInterval(keepalive);
            for (const session of sessions.values()) {
              shutdown(session, "server-stopping");
            }
            for (const client of wss.clients) client.terminate();
            wss.close();
            httpServer.close(() => done());
            httpServer.closeAllConnections?.();
            setTimeout(done, 500).unref();
          }),
      });
    });
  });
}
