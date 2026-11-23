/**
 * ブリッジのコア実装(GUI / CLI 両方から使える形)。
 *
 * Minecraft クライアントからの生 TCP を受け、WS サーバーへ双方向バイト中継する。
 * MC プロトコルは解釈しない。
 *
 * WS が切れても Minecraft クライアントの TCP は切らず、WS を張り直す。
 * 張り直しは ?session= トークンを付けて行い、サーバー側が同じバックエンド TCP に
 * 繋ぎ直す。MC のログイン状態は TCP 接続に紐づくため、WS を張り直すだけでは足りない。
 *
 * 中継は frames.ts の FrameChannel(連番 + リプレイ + ACK)経由で行う。
 * WS が切れた瞬間の「送ったけど届いたか分からない」フレームを、受信側が連番で検出して
 * 再送させることで、バイトストリームを欠損なく再開する。
 *
 * CLI: bridge/index.ts
 */
import { randomUUID } from "node:crypto";
import net from "node:net";
import { WebSocket } from "ws";
import { FrameChannel } from "../frames.ts";

/** 未交付バイトがこれを超えたらクライアントの TCP を pause() する(§3.2 バックプレッシャ)。 */
const HIGH_WATER_BYTES = 1024 * 1024;
/** 未交付がこれを下回ったらクライアントの TCP を再開する。 */
const LOW_WATER_BYTES = 256 * 1024;

/** リプレイ用リングの上限(1 接続あたり、方向ごと)。 */
const REPLAY_WINDOW_BYTES = 16 * 1024 * 1024;

/** --url にパスが無いときに使う既定パス(server/index.ts の WS_PATH 既定値と一致させる)。 */
export const DEFAULT_WS_PATH = "/minecraft";

/** 再接続の初回待ちと上限(指数バックオフ)。 */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5_000;
/** これ以上張り直せないなら諦めてクライアントを切断する。 */
const RECONNECT_DEADLINE_MS = 5 * 60_000;

/** サーバーが使う close code(server/index.ts と揃える)。 */
const CLOSE_SESSION_OVER = 1000;
const CLOSE_NO_SESSION = 4008;
const CLOSE_REPLAY_GAP = 4009;

export interface BridgeOptions {
  /** WS サーバーの URL(ws:// or wss://)。 */
  url: string;
  /** TCP listen ポート(既定 25565)。 */
  port: number;
  /** listen アドレス(既定 127.0.0.1)。 */
  host: string;
}

export interface BridgeHooks {
  /** 進行状況の 1 行ログ(時刻は付けない)。 */
  log?(line: string): void;
  /** 警告・エラーの 1 行ログ。 */
  error?(line: string): void;
}

export interface BridgeHandle {
  connections(): number;
  stop(): Promise<void>;
}

/** ブリッジの設定を検証し、URL を正規化する(パス省略時は既定パス)。 */
export function normalizeBridgeUrl(raw: string): string {
  if (!/^wss?:\/\//.test(raw)) {
    throw new Error("URL は ws:// か wss:// で始まる必要があります: " + raw);
  }
  const parsed = new URL(raw);
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = DEFAULT_WS_PATH;
  }
  return parsed.toString();
}

/** ブリッジを起動する。listen が確立したら resolve、失敗したら reject。 */
export function startBridge(options: BridgeOptions, hooks: BridgeHooks = {}): Promise<BridgeHandle> {
  return new Promise((resolve, reject) => {
    let url: string;
    try {
      url = normalizeBridgeUrl(options.url);
    } catch (error) {
      reject(error);
      return;
    }

    const log = hooks.log ?? (() => {});
    const warn = hooks.error ?? (() => {});
    const clients = new Set<net.Socket>();
    let closed = false;

    const server = net.createServer((client: net.Socket) => {
      // この TCP 接続の識別子。張り直しのたびに ?session= で送り、
      // サーバーが同じバックエンド TCP に繋ぎ直せるようにする。
      const token = randomUUID();
      const targetUrl = new URL(url);
      targetUrl.searchParams.set("session", token);

      client.setNoDelay(true);
      log("tcp accepted from " + client.remoteAddress + ":" + client.remotePort);

      let connectionClosed = false;
      let ws: WebSocket | null = null;
      let attempt = 0;
      let reconnectTimer: NodeJS.Timeout | null = null;
      /** 再接続の期限。これを過ぎたらクライアントを切断する。 */
      let deadline = 0;
      /** クライアントへの書き込みが詰まっている(サーバー方向の ACK を遅らせる)。 */
      let downloading = false;

      /** MC クライアント → WS サーバー方向のフレーム処理。 */
      const channel = new FrameChannel({
        windowBytes: REPLAY_WINDOW_BYTES,
        highWaterBytes: HIGH_WATER_BYTES,
        lowWaterBytes: LOW_WATER_BYTES,
        send: (frame) => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
        },
        isSendable: () => ws !== null && ws.readyState === WebSocket.OPEN,
        onDeliver: (payload) => {
          if (client.destroyed) return;
          // 書き込みが詰まっても WS を止めず、ACK を遅らせる。
          // サーバー側の未交付が増えて、バックエンドの読み取りが止まる。
          if (!client.write(payload)) {
            downloading = true;
          }
        },
        onFatal: (reason) => {
          close("frame-fatal(" + reason + ")");
        },
        onReplayImpossible: () => {
          // リングから落ちた連番を要求された → もうバイト連続性は回復できない。
          close("replay-gap");
        },
        // クライアントへの書き込みが詰まっている間は ACK を遅らせる。
        ackGate: () => !downloading,
        // ACK で未交付が減ったら、止めていたクライアントの読み取りを再開する。
        onAck: () => {
          if (client.isPaused() && channel.unackedBytes() < LOW_WATER_BYTES) {
            client.resume();
          }
        },
      });

      function close(reason: string): void {
        if (connectionClosed) return;
        connectionClosed = true;
        clients.delete(client);
        channel.close();
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
        log("closed (" + reason + ")");
      }

      function connect(): void {
        if (connectionClosed) return;
        const retryUrl = new URL(targetUrl);
        if (attempt > 0) retryUrl.searchParams.set("resume", "1");
        const socket = new WebSocket(retryUrl.toString(), {
          perMessageDeflate: false,
          handshakeTimeout: 10_000,
        });
        ws = socket;

        socket.on("open", () => {
          if (connectionClosed || ws !== socket) return;
          const reconnected = attempt > 0;
          attempt = 0;
          deadline = 0;
          log("ws " + (reconnected ? "reconnected to " : "connected to ") + url);
          // 切断中に欠けたぶんは、連番で検出されてリプレイ要求が飛んでくる。
          // 応答速度のため、ACK されていないぶんはこちらから積極的に再送しておく。
          channel.replayUnacked();
          client.resume();
        });

        socket.on("message", (data, isBinary) => {
          if (connectionClosed || ws !== socket || !isBinary) return;
          const chunk = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
          channel.feed(chunk);
        });

        socket.on("error", (error: Error) => {
          // §3.2-4: 接続失敗の原因を 1 行。
          warn("ws error: " + error.message);
          if (error.message.includes("EPROTO")) {
            warn("ws hint: オリジンは平文 HTTP です。ローカルで試すときは ws:// を使ってください");
          }
        });

        socket.on("close", (code: number) => {
          if (connectionClosed || ws !== socket) return;
          ws = null;
          // サーバーが「セッション終了」と言ったら張り直さない(オフライン応答後など)。
          // それ以外(1006 = 回線断、CF のメンテ等)は再開を試みる。
          if (code === CLOSE_SESSION_OVER) {
            close("session-closed-by-server");
            return;
          }
          if (code === CLOSE_NO_SESSION) {
            warn("サーバー側のセッションが失われました(再接続では復旧できません)。Minecraft から再接続してください");
            close("session-lost");
            return;
          }
          if (code === CLOSE_REPLAY_GAP) {
            warn("切断中のデータが多すぎてバイトの連続性を回復できません。Minecraft から再接続してください");
            close("replay-gap-unrecoverable");
            return;
          }
          scheduleReconnect();
        });
      }

      function scheduleReconnect(): void {
        if (connectionClosed) return;
        if (deadline === 0) deadline = Date.now() + RECONNECT_DEADLINE_MS;
        if (Date.now() > deadline) {
          close("reconnect-deadline");
          return;
        }
        const wait = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt++;
        log("reconnecting in " + wait + "ms (attempt " + attempt + ")");
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, wait);
        reconnectTimer.unref();
      }

      client.on("data", (chunk: Buffer) => {
        if (connectionClosed) return;
        // FrameChannel が連番を付け、リングに保持し、開いていれば WS へ送る。
        // WS が切れていてもリングに残るので、再開後に欠損なく届く。
        channel.deliverRaw(chunk);
        // 未交付が閾値を超えたらクライアントの読み取りを止める。ACK で戻ったら再開する。
        if (channel.unackedBytes() > HIGH_WATER_BYTES && !client.isPaused()) {
          client.pause();
        }
      });

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
        if (!downloading) return;
        downloading = false;
        // 詰まりが解けたら ACK を遅らせていたぶんをすぐ出す。
        channel.flushAck();
      });

      clients.add(client);
      connect();
    });

    function reportListenError(error: Error & { code?: string }): void {
      if (error.code === "EADDRINUSE") {
        warn("ポート " + options.host + ":" + options.port + " は既に使われています");
      } else if (error.code === "EACCES") {
        warn("ポート " + options.port + " を開く権限がありません");
      } else {
        warn("listen error: " + error.message);
      }
    }

    // Windows の Minecraft は localhost を ::1(IPv6)に解決することがある。
    // 127.0.0.1 だけ(IPv4 のみ)で待っていると ::1 への接続が RST され
    // 「Connection refused: getsockopt」になる。そこで IPv4/IPv6 の両方で
    // 受けられるよう、まず :: + ipv6Only:false(二重スタック)で試し、
    // IPv6 の使えない環境では従来どおり 0.0.0.0 に落ちる。
    const listenHosts =
      options.host === "127.0.0.1" || options.host === "localhost"
        ? ["::", "0.0.0.0"]
        : [options.host];

    function tryListen(index: number): void {
      const host = listenHosts[index]!;
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        closed = false;
        const familyNote = host === "::" ? "(IPv4/IPv6 両方で受け付け) " : "";
        log("listening on " + host + ":" + options.port + " " + familyNote + "-> " + url);
        resolve({
          connections: () => clients.size,
          stop: () =>
            new Promise<void>((done) => {
              closed = true;
              for (const client of clients) client.destroy();
              clients.clear();
              server.close(() => done());
              // 開いたポートは即閉じる(SO_REUSEADDR 待ちで固めない)。
              server.closeAllConnections?.();
              setTimeout(done, 500).unref();
            }),
        });
      };
      const onError = (error: Error & { code?: string }) => {
        cleanup();
        // EADDRINUSE / EACCES はフォールバックしても同じ失敗になるので即 reject。
        const fallback =
          index + 1 < listenHosts.length && error.code !== "EADDRINUSE" && error.code !== "EACCES";
        if (fallback) {
          tryListen(index + 1);
          return;
        }
        closed = true;
        reportListenError(error);
        reject(error);
      };
      server.once("listening", onListening);
      server.once("error", onError);
      server.listen({ port: options.port, host, ipv6Only: false });
    }

    tryListen(0);
  });
}
