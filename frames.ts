/**
 * bridge ↔ server 間だけの WS フレーミング(連番 + リプレイ + ACK)。
 *
 * 目的: WS が切れた瞬間、「ws.send() に渡したけれど届いたか分からない」フレームが
 * 必ず発生する。そのまま中継するとバイト列に穴や重複ができ、MC クライアントは
 * 「Badly compressed packet」で落ちる。そこで:
 *
 * - 送信側は各データフレームに連番を付け、ACK が来るまでリプレイ用リングに保持する。
 * - 受信側は期待連番より先のフレームが来たら穴と判断し「expected 以降を再生してくれ」
 *   を要求する。順番が来たぶんだけ下流へ渡す(順番どおりを崩さない)。
 * - 受信側は交付済み連番を ACK で返し、送信側はそれより古いぶんをリングから捨てる。
 *
 * WS 1 メッセージ = 1 フレーム:
 *   [0x00][seq BE32][payload...]      データ
 *   [0x01][0x00][expected BE32]      リプレイ要求(expected 以降を再送してほしい)
 *   [0x01][0x01][delivered BE32]     ACK(ここまで下流へ渡した)
 *
 * このモジュールは純粋(net / ws に依存しない)。MC のバイトストリーム自体は透過のまま。
 */

/** データフレームヘッダ(種別 1 バイト + 連番 4 バイト)。 */
export const FRAME_HEADER_BYTES = 5;

/** 制御フレームヘッダ(種別 1 バイト + サブタイプ 1 バイト + 連番 4 バイト)。 */
export const CONTROL_FRAME_BYTES = 6;

/** 1 フレームの payload 上限。deliverRaw はこれを超えるデータを分割する。 */
export const MAX_FRAME_PAYLOAD = 1024 * 1024;

/** リプレイ要求に出して戻ってこなければ復旧不能とみなす時間。 */
const REPLAY_TIMEOUT_MS = 10_000;

/** ACK をまとめて送る目安(この枚数たまったら即送る)。 */
const ACK_EVERY_FRAMES = 32;

/** ACK をまとめて送る間隔。 */
const ACK_INTERVAL_MS = 250;

/** フレーム上の異常。呼び出し側は接続を閉じる。 */
export class FrameError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export type IncomingFrame =
  | { kind: "data"; seq: number; payload: Buffer }
  | { kind: "replay-request"; seq: number }
  | { kind: "ack"; seq: number };

/** データフレームを組み立てる。 */
export function encodeDataFrame(seq: number, payload: Buffer): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  buf[0] = 0x00;
  buf.writeUInt32BE(seq >>> 0, 1);
  payload.copy(buf, FRAME_HEADER_BYTES);
  return buf;
}

/** リプレイ要求(expectedSeq 以降を再送してほしい)。制御フレームは種別+サブタイプ+連番の 6 バイト。 */
export function encodeReplayRequest(expectedSeq: number): Buffer {
  const buf = Buffer.allocUnsafe(CONTROL_FRAME_BYTES);
  buf[0] = 0x01;
  buf[1] = 0x00;
  buf.writeUInt32BE(expectedSeq >>> 0, 2);
  return buf;
}

/** ACK(deliveredSeq まで下流へ渡した)。 */
export function encodeAck(deliveredSeq: number): Buffer {
  const buf = Buffer.allocUnsafe(CONTROL_FRAME_BYTES);
  buf[0] = 0x01;
  buf[1] = 0x01;
  buf.writeUInt32BE(deliveredSeq >>> 0, 2);
  return buf;
}

/** WS メッセージ 1 件(= 1 フレーム)を解析する。異常は FrameError。 */
export function parseFrame(message: Buffer): IncomingFrame {
  if (message.length < 1) {
    throw new FrameError("empty-frame", "WS メッセージが空です");
  }
  const type = message[0];
  if (type === 0x00) {
    if (message.length < FRAME_HEADER_BYTES) {
      throw new FrameError("short-frame", "データフレームがヘッダより短い");
    }
    return {
      kind: "data",
      seq: message.readUInt32BE(1),
      payload: message.subarray(FRAME_HEADER_BYTES),
    };
  }
  if (type === 0x01) {
    if (message.length < CONTROL_FRAME_BYTES) {
      throw new FrameError("short-frame", "制御フレームがヘッダより短い");
    }
    const subtype = message[1];
    const seq = message.readUInt32BE(2);
    if (subtype === 0x00) return { kind: "replay-request", seq };
    if (subtype === 0x01) return { kind: "ack", seq };
    throw new FrameError("bad-control", "未知の制御フレーム: " + subtype);
  }
  throw new FrameError("bad-frame", "未知のフレーム種別: " + type);
}

export interface FrameChannelOptions {
  /** リプレイ用リングの上限(全フレームのバイト数)。 */
  windowBytes: number;
  /** 未交付バイトがこれを超えたら送り元を止めてほしい。 */
  highWaterBytes: number;
  /** これを下回ったら送り元を再開してよい。 */
  lowWaterBytes: number;
  /** WS への送信(OPEN のときだけ呼ばれる)。 */
  send(frame: Buffer): void;
  /** WS が今 OPEN か。 */
  isSendable(): boolean;
  /** 順序どおり受信した payload を下流へ渡す。 */
  onDeliver(payload: Buffer): void;
  /** 受信側として復旧不可能(壊れたフレーム / リプレイ希望応答なし)。接続を畳むこと。 */
  onFatal(reason: string): void;
  /** 送信側としてリプレイに応じられない(expected がリング外)。WS を 4009 で切るなど。 */
  onReplayImpossible(expectedSeq: number): void;
  /** ACK を受けて未交付が減った(pause 中の送り元の再開判定などに使う)。 */
  onAck?(): void;
  /** ACK 送出を保留する(下流が詰まっている間 ACK を遅らせ、送り元に流量制限を効かせる)。 */
  ackGate?(): boolean;
}

/**
 * bridge / server の両方が使う、方向ごとのフレーム処理。
 * 1 インスタンス = 1 方向(送信 + 受信)。同期のみで動く(内部で待ちを持たない)。
 */
export class FrameChannel {
  private readonly opt: FrameChannelOptions;

  // ---- 送信側 ----
  private nextSeq = 1;
  private ackedSeq = 0;
  private ring: { seq: number; buf: Buffer }[] = [];
  private ringBytes = 0;
  private unacked = 0; // ring 内フレームの payload 合計(下流へ渡っていないぶん)

  // ---- 受信側 ----
  private expectedSeq: number | null = null;
  private replayTimer: NodeJS.Timeout | null = null;
  private ackDirty = false;
  private ackCounter = 0;
  private readonly ackTimer: NodeJS.Timeout;

  constructor(opt: FrameChannelOptions) {
    this.opt = opt;
    this.ackTimer = setInterval(() => this.flushAck(), ACK_INTERVAL_MS);
    this.ackTimer.unref();
  }

  /** 上流からの新規データ。MAX_FRAME_PAYLOAD ごとに分割してリングに保持し、OPEN なら送る。 */
  deliverRaw(payload: Buffer): void {
    for (let offset = 0; offset < payload.length; ) {
      const size = Math.min(MAX_FRAME_PAYLOAD, payload.length - offset);
      const part = payload.subarray(offset, offset + size);
      offset += size;
      const seq = this.nextSeq++;
      const frame = encodeDataFrame(seq, part);
      this.ring.push({ seq, buf: frame });
      this.ringBytes += frame.length;
      this.unacked += part.length;
      this.evict();
      if (this.opt.isSendable()) this.opt.send(frame);
    }
  }

  /** 未交付(ACK 未確定)バイト数。送り元の pause / resume 判定に使う。 */
  unackedBytes(): number {
    return this.unacked;
  }

  /** 再接続直後: ACK 済み+1 以降を積極的に再送する(損失の早回し修復)。重複は受信側が捨てる。 */
  replayUnacked(): void {
    if (this.ackedSeq + 1 < this.nextSeq) {
      this.replayFrom(this.ackedSeq + 1);
    }
  }

  /** 下流の詰まりが解けたときに呼ぶと、ACK をすぐ送れる。 */
  flushAck(): void {
    this.flushAckNow();
  }

  /** ACK タイマなど後片付け。 */
  close(): void {
    clearInterval(this.ackTimer);
    this.clearReplayTimer();
  }

  /** 受信した WS メッセージ 1 件を処理する。 */
  feed(message: Buffer): void {
    let frame: IncomingFrame;
    try {
      frame = parseFrame(message);
    } catch (error) {
      this.opt.onFatal(error instanceof FrameError ? error.code : "bad-frame");
      return;
    }

    if (frame.kind === "data") {
      if (this.expectedSeq === null) {
        // セッション最初のフレーム。ここを基準にする(初回接続なら 1 のはず)。
        this.expectedSeq = frame.seq;
      }
      if (frame.seq < this.expectedSeq) {
        return; // 再送の重複 → 捨てる
      }
      if (frame.seq > this.expectedSeq) {
        // 穴。リプレイを要求して、順番が揃うまで下流へ渡さない。
        this.requestReplay();
        return;
      }
      this.expectedSeq++;
      this.clearReplayTimer();
      this.opt.onDeliver(frame.payload);
      this.ackDirty = true;
      this.ackCounter++;
      if (this.ackCounter >= ACK_EVERY_FRAMES) this.flushAckNow();
      return;
    }

    if (frame.kind === "replay-request") {
      this.replayFrom(frame.seq);
      return;
    }

    // ack
    if (frame.seq > this.ackedSeq) {
      this.ackedSeq = frame.seq;
      this.drainAcked();
      this.opt.onAck?.();
    }
  }

  /** ring から seq 以降を再送する。足りなければ復旧不能を通知する。 */
  private replayFrom(seq: number): void {
    if (seq >= this.nextSeq) {
      return; // 要求が先を行っている(受信側の勘違い)→ 何もしない
    }
    if (this.ring.length > 0 && seq < this.ring[0].seq) {
      // もうリングに無い → 復旧不能
      this.opt.onReplayImpossible(seq);
      return;
    }
    if (!this.opt.isSendable()) return;
    for (const entry of this.ring) {
      if (entry.seq < seq) continue;
      this.opt.send(entry.buf);
    }
  }

  /** ACK されたぶんをリングから捨てる。 */
  private drainAcked(): void {
    while (this.ring.length > 0 && this.ring[0].seq <= this.ackedSeq) {
      const entry = this.ring.shift()!;
      this.ringBytes -= entry.buf.length;
      this.unacked -= entry.buf.length - FRAME_HEADER_BYTES;
    }
    if (this.unacked < 0) this.unacked = 0;
  }

  /** リング上限超過分を捨てる(未 ACK でも捨てる → 後で復旧不能になる可能性がある)。 */
  private evict(): void {
    while (this.ring.length > 0 && this.ringBytes > this.opt.windowBytes) {
      const entry = this.ring.shift()!;
      this.ringBytes -= entry.buf.length;
      this.unacked -= entry.buf.length - FRAME_HEADER_BYTES;
    }
    if (this.unacked < 0) this.unacked = 0;
  }

  private requestReplay(): void {
    if (this.opt.isSendable()) {
      this.opt.send(encodeReplayRequest(this.expectedSeq!));
    }
    if (this.replayTimer === null) {
      this.replayTimer = setTimeout(() => {
        this.replayTimer = null;
        this.opt.onFatal("replay-timeout");
      }, REPLAY_TIMEOUT_MS);
      this.replayTimer.unref();
    }
  }

  private clearReplayTimer(): void {
    if (this.replayTimer !== null) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
  }

  private flushAckNow(): void {
    if (!this.ackDirty || this.expectedSeq === null) return;
    if (this.opt.ackGate && !this.opt.ackGate()) return;
    if (!this.opt.isSendable()) return;
    this.ackDirty = false;
    this.ackCounter = 0;
    this.opt.send(encodeAck(this.expectedSeq - 1));
  }
}
