/**
 * Minecraft Java Edition プロトコル(実装に必要な範囲のみ)。
 *
 * このモジュールは純粋関数だけで構成する(net / ws に依存しない)。
 * 仕様書 §4 がそのまま仕様。
 */

/** 受信パケットの宣言長の上限。超えたら「過大」とみなし切断する(§4.1)。 */
export const MAX_PACKET_SIZE = 2048;

/** ハンドシェイクの nextState(§4.2)。 */
export const NEXT_STATE = {
  STATUS: 1,
  LOGIN: 2,
  TRANSFER: 3,
} as const;

/** バックエンドに接続できないときの Status Response の JSON(§4.3)。 */
export const OFFLINE_STATUS_JSON =
  '{"version":{"name":"Offline","protocol":-1},"players":{"max":0,"online":0},"description":{"text":"The Minecraft server is offline right now. Try again later."}}';

/** バックエンドに接続できないときの Disconnect の JSON(§4.3)。 */
export const OFFLINE_DISCONNECT_JSON =
  '{"text":"The Minecraft server is offline right now. Try again later."}';

/** プロトコル上の異常。呼び出し側は接続を閉じる。 */
export class ProtocolError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export interface VarIntResult {
  value: number;
  size: number;
}

export interface Packet {
  /** packetId */
  id: number;
  /** packetId より後ろの本文 */
  payload: Buffer;
  /** パケット全体(本文長 VarInt + 本文)のバイト数 */
  size: number;
}

export interface Handshake {
  protocolVersion: number;
  host: string;
  port: number;
  nextState: number;
  /** ハンドシェイクパケット全体のバイト数 */
  packetSize: number;
  /** ハンドシェイクの後ろに続く読み過ぎたバイト列 */
  rest: Buffer;
}

/** VarInt を書き出す(§4.1: 7 ビットずつ下位から、継続ビット 0x80、最大 5 バイト)。 */
export function writeVarInt(value: number): Buffer {
  if (!Number.isInteger(value)) {
    throw new ProtocolError("varint-not-integer", "VarInt must be an integer: " + value);
  }
  let v = value;
  if (v < 0) {
    // MC の VarInt は 32bit 符号付きの 2 の補数表現。
    v += 0x100000000;
  }
  if (v > 0xffffffff) {
    throw new ProtocolError("varint-out-of-range", "VarInt out of range: " + value);
  }
  const bytes: number[] = [];
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** VarInt を書き出したときのバイト数。 */
export function varIntSize(value: number): number {
  return writeVarInt(value).length;
}

/**
 * VarInt を読み出す。まだバイトが足りなければ null を返す(呼び出し側が蓄積して再試行する)。
 * 5 バイトを超えて継続ビットが立っていたら異常。
 */
export function readVarInt(buf: Buffer, offset = 0): VarIntResult | null {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const index = offset + i;
    if (index >= buf.length) return null;
    const byte = buf[index];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      // 32bit 符号付きに戻す
      if (value >= 0x80000000) value -= 0x100000000;
      return { value, size: i + 1 };
    }
    shift += 7;
  }
  throw new ProtocolError("varint-too-long", "VarInt is longer than 5 bytes");
}

/** 文字列を書き出す(VarInt バイト長 + UTF-8)。 */
export function writeString(value: string): Buffer {
  const body = Buffer.from(value, "utf8");
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** 文字列を読み出す。バイトが足りなければ null。 */
export function readString(buf: Buffer, offset = 0): { value: string; size: number } | null {
  const len = readVarInt(buf, offset);
  if (len === null) return null;
  if (len.value < 0) {
    throw new ProtocolError("bad-string-length", "Negative string length: " + len.value);
  }
  const start = offset + len.size;
  const end = start + len.value;
  if (end > buf.length) return null;
  return { value: buf.subarray(start, end).toString("utf8"), size: len.size + len.value };
}

/** パケットを組み立てる(本文長 VarInt + packetId + 本文)。 */
export function encodePacket(id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const idBytes = writeVarInt(id);
  const body = Buffer.concat([idBytes, payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/**
 * ストリームの先頭から 1 パケット読み出す。バイトが足りなければ null。
 * 宣言長が MAX_PACKET_SIZE を超えたら「過大」として例外。
 */
export function readPacket(buf: Buffer, offset = 0): Packet | null {
  const len = readVarInt(buf, offset);
  if (len === null) return null;
  if (len.value < 0) {
    throw new ProtocolError("bad-packet-length", "Negative packet length: " + len.value);
  }
  if (len.value > MAX_PACKET_SIZE) {
    throw new ProtocolError(
      "packet-too-large",
      "Packet length " + len.value + " exceeds " + MAX_PACKET_SIZE,
    );
  }
  const bodyStart = offset + len.size;
  const bodyEnd = bodyStart + len.value;
  if (bodyEnd > buf.length) return null;

  const body = buf.subarray(bodyStart, bodyEnd);
  const id = readVarInt(body, 0);
  if (id === null) {
    throw new ProtocolError("truncated-packet", "Packet body is missing packetId");
  }
  return {
    id: id.value,
    payload: body.subarray(id.size),
    size: len.size + len.value,
  };
}

/**
 * ハンドシェイク(§4.2)を解析する。
 * ストリーム先頭がハンドシェイクでない / nextState が 1,2,3 以外なら ProtocolError。
 * バイトが足りなければ null。
 */
export function parseHandshake(buf: Buffer): Handshake | null {
  const packet = readPacket(buf, 0);
  if (packet === null) return null;
  if (packet.id !== 0x00) {
    throw new ProtocolError(
      "not-handshake",
      "Expected handshake (0x00), got 0x" + packet.id.toString(16),
    );
  }

  const body = packet.payload;
  let cursor = 0;

  const protocolVersion = readVarInt(body, cursor);
  if (protocolVersion === null) {
    throw new ProtocolError("truncated-handshake", "Handshake is missing protocol version");
  }
  cursor += protocolVersion.size;

  const host = readString(body, cursor);
  if (host === null) {
    throw new ProtocolError("truncated-handshake", "Handshake is missing host");
  }
  cursor += host.size;

  if (cursor + 2 > body.length) {
    throw new ProtocolError("truncated-handshake", "Handshake is missing port");
  }
  const port = body.readUInt16BE(cursor);
  cursor += 2;

  const nextState = readVarInt(body, cursor);
  if (nextState === null) {
    throw new ProtocolError("truncated-handshake", "Handshake is missing nextState");
  }
  cursor += nextState.size;

  if (
    nextState.value !== NEXT_STATE.STATUS &&
    nextState.value !== NEXT_STATE.LOGIN &&
    nextState.value !== NEXT_STATE.TRANSFER
  ) {
    throw new ProtocolError("bad-next-state", "Unsupported nextState: " + nextState.value);
  }

  return {
    protocolVersion: protocolVersion.value,
    host: host.value,
    port,
    nextState: nextState.value,
    packetSize: packet.size,
    rest: buf.subarray(packet.size),
  };
}

/** ハンドシェイクを組み立てる(テスト・e2e 用)。 */
export function encodeHandshake(
  protocolVersion: number,
  host: string,
  port: number,
  nextState: number,
): Buffer {
  const portBytes = Buffer.allocUnsafe(2);
  portBytes.writeUInt16BE(port, 0);
  return encodePacket(
    0x00,
    Buffer.concat([writeVarInt(protocolVersion), writeString(host), portBytes, writeVarInt(nextState)]),
  );
}

/** Status Request(§4.3-1): packetId=0x00、本文なし。 */
export function encodeStatusRequest(): Buffer {
  return encodePacket(0x00);
}

/** Ping(§4.3-2): packetId=0x01、8 バイトの payload。 */
export function encodePing(payload: Buffer): Buffer {
  if (payload.length !== 8) {
    throw new ProtocolError("bad-ping", "Ping payload must be 8 bytes, got " + payload.length);
  }
  return encodePacket(0x01, payload);
}

/** 受信パケットが Status Request か。 */
export function isStatusRequest(packet: Packet): boolean {
  return packet.id === 0x00 && packet.payload.length === 0;
}

/** 受信パケットが Ping か(§4.3-2: 本文長 9 = id + 8 バイト)。 */
export function isPing(packet: Packet): boolean {
  return packet.id === 0x01 && packet.payload.length === 8;
}

/** オフライン時の Status Response パケット(§4.3-1)。 */
export function encodeOfflineStatusResponse(): Buffer {
  return encodePacket(0x00, writeString(OFFLINE_STATUS_JSON));
}

/** オフライン時の Disconnect パケット(§4.3、Login / Transfer)。 */
export function encodeOfflineDisconnect(): Buffer {
  return encodePacket(0x00, writeString(OFFLINE_DISCONNECT_JSON));
}

/** パケットをそのまま組み直す(Ping のエコー用)。 */
export function echoPacket(packet: Packet): Buffer {
  return encodePacket(packet.id, packet.payload);
}
