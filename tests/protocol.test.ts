/**
 * server/protocol.ts の単体テスト(§6)。
 * assert ベース・依存なし。実行: node tests/protocol.test.ts
 */
import assert from "node:assert/strict";
import {
  MAX_PACKET_SIZE,
  NEXT_STATE,
  OFFLINE_DISCONNECT_JSON,
  OFFLINE_STATUS_JSON,
  ProtocolError,
  encodeHandshake,
  encodeOfflineDisconnect,
  encodeOfflineStatusResponse,
  encodePacket,
  encodePing,
  encodeStatusRequest,
  isPing,
  isStatusRequest,
  parseHandshake,
  readPacket,
  readString,
  readVarInt,
  writeString,
  writeVarInt,
} from "../server/protocol.ts";

let checks = 0;
let failures = 0;

function check(name: string, fn: () => void): void {
  checks++;
  try {
    fn();
    console.log("  ok   " + name);
  } catch (error) {
    failures++;
    console.log("  FAIL " + name);
    console.log("       " + (error instanceof Error ? error.message : String(error)));
  }
}

function throwsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProtocolError, "expected ProtocolError, got " + String(error));
    assert.equal(error.code, code);
    return;
  }
  assert.fail("expected ProtocolError(" + code + ") but nothing was thrown");
}

console.log("VarInt");

// 1-7: 往復
for (const value of [0, 1, 127, 128, 300, 25565, 2097151]) {
  check("VarInt round trip: " + value, () => {
    const encoded = writeVarInt(value);
    const decoded = readVarInt(encoded);
    assert.ok(decoded !== null);
    assert.equal(decoded.value, value);
    assert.equal(decoded.size, encoded.length);
  });
}
// 8: 既知のバイト列
check("VarInt encodes 0 as 0x00", () => {
  assert.deepEqual([...writeVarInt(0)], [0x00]);
});
// 9
check("VarInt encodes 127 as 0x7f", () => {
  assert.deepEqual([...writeVarInt(127)], [0x7f]);
});
// 10
check("VarInt encodes 128 as 0x80 0x01", () => {
  assert.deepEqual([...writeVarInt(128)], [0x80, 0x01]);
});
// 11
check("VarInt encodes 25565 as 0xdd 0xc7 0x01", () => {
  assert.deepEqual([...writeVarInt(25565)], [0xdd, 0xc7, 0x01]);
});
// 12: 先頭バイトだけでは読めない
check("readVarInt returns null when incomplete", () => {
  assert.equal(readVarInt(Buffer.from([0x80])), null);
  assert.equal(readVarInt(Buffer.alloc(0)), null);
});
// 13: オフセット指定
check("readVarInt honours offset", () => {
  const buf = Buffer.concat([Buffer.from([0xff]), writeVarInt(300)]);
  const decoded = readVarInt(buf, 1);
  assert.ok(decoded !== null);
  assert.equal(decoded.value, 300);
});
// 14: 6 バイト目で異常
check("readVarInt rejects more than 5 bytes", () => {
  throwsCode(() => readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), "varint-too-long");
});

console.log("Strings");

// 15
check("writeString/readString round trip (ascii)", () => {
  const buf = writeString("mc.example.com");
  const decoded = readString(buf);
  assert.ok(decoded !== null);
  assert.equal(decoded.value, "mc.example.com");
  assert.equal(decoded.size, buf.length);
});
// 16
check("writeString/readString round trip (utf8)", () => {
  const buf = writeString("サーバー");
  const decoded = readString(buf);
  assert.ok(decoded !== null);
  assert.equal(decoded.value, "サーバー");
});
// 17
check("readString returns null when truncated", () => {
  const buf = writeString("hello");
  assert.equal(readString(buf.subarray(0, buf.length - 1)), null);
});
// 18
check("writeString prefixes the byte length, not the character count", () => {
  const buf = writeString("あ");
  assert.equal(buf[0], 3);
  assert.equal(buf.length, 4);
});

console.log("Packets");

// 19
check("encodePacket writes length = id + payload", () => {
  const packet = encodePacket(0x00, Buffer.from([1, 2, 3]));
  assert.equal(packet[0], 4);
  assert.equal(packet.length, 5);
});
// 20
check("empty packet encodes as 0x01 0x00", () => {
  assert.deepEqual([...encodePacket(0x00)], [0x01, 0x00]);
});
// 21
check("readPacket round trip", () => {
  const packet = readPacket(encodePacket(0x05, Buffer.from([9, 9])));
  assert.ok(packet !== null);
  assert.equal(packet.id, 0x05);
  assert.deepEqual([...packet.payload], [9, 9]);
});
// 22
check("readPacket returns null when the body is incomplete", () => {
  const packet = encodePacket(0x00, Buffer.from([1, 2, 3]));
  assert.equal(readPacket(packet.subarray(0, 3)), null);
});
// 23
check("readPacket returns null when even the length prefix is incomplete", () => {
  assert.equal(readPacket(Buffer.from([0x80])), null);
});
// 24: 過大パケットの拒否
check("readPacket rejects oversized declared length", () => {
  throwsCode(() => readPacket(Buffer.concat([writeVarInt(MAX_PACKET_SIZE + 1), Buffer.alloc(4)])), "packet-too-large");
});
// 25
check("readPacket accepts the maximum declared length", () => {
  assert.doesNotThrow(() => readPacket(Buffer.concat([writeVarInt(MAX_PACKET_SIZE), Buffer.alloc(4)])));
});
// 26
check("readPacket rejects a negative declared length", () => {
  throwsCode(() => readPacket(Buffer.concat([writeVarInt(-1), Buffer.alloc(4)])), "bad-packet-length");
});

console.log("Handshake");

// 27: ステータスハンドシェイクの解析
check("parseHandshake parses a Status handshake", () => {
  const buf = encodeHandshake(767, "mc.example.com", 25565, NEXT_STATE.STATUS);
  const handshake = parseHandshake(buf);
  assert.ok(handshake !== null);
  assert.equal(handshake.protocolVersion, 767);
  assert.equal(handshake.host, "mc.example.com");
  assert.equal(handshake.port, 25565);
  assert.equal(handshake.nextState, NEXT_STATE.STATUS);
  assert.equal(handshake.packetSize, buf.length);
  assert.equal(handshake.rest.length, 0);
});
// 28: Login の nextState
check("parseHandshake parses Login (nextState=2)", () => {
  const handshake = parseHandshake(encodeHandshake(767, "mc.example.com", 25565, NEXT_STATE.LOGIN));
  assert.ok(handshake !== null);
  assert.equal(handshake.nextState, NEXT_STATE.LOGIN);
});
// 29: Transfer の nextState
check("parseHandshake parses Transfer (nextState=3)", () => {
  const handshake = parseHandshake(encodeHandshake(767, "mc.example.com", 25565, NEXT_STATE.TRANSFER));
  assert.ok(handshake !== null);
  assert.equal(handshake.nextState, NEXT_STATE.TRANSFER);
});
// 30
check("parseHandshake returns null for a partial handshake", () => {
  const buf = encodeHandshake(767, "mc.example.com", 25565, NEXT_STATE.LOGIN);
  for (const cut of [1, 2, 5, buf.length - 1]) {
    assert.equal(parseHandshake(buf.subarray(0, cut)), null, "cut=" + cut);
  }
});
// 31: チャンク分割からの再構築
check("parseHandshake rebuilds a handshake split across chunks", () => {
  const buf = encodeHandshake(767, "mc.example.com", 25565, NEXT_STATE.STATUS);
  let acc = Buffer.alloc(0);
  let result = null;
  for (let i = 0; i < buf.length; i++) {
    acc = Buffer.concat([acc, buf.subarray(i, i + 1)]);
    const parsed = parseHandshake(acc);
    if (parsed !== null) {
      result = parsed;
      break;
    }
  }
  assert.ok(result !== null);
  assert.equal(result.host, "mc.example.com");
  assert.equal(result.nextState, NEXT_STATE.STATUS);
});
// 32: 読み過ぎた残りバイトを保持する
check("parseHandshake keeps bytes after the handshake as rest", () => {
  const statusRequest = encodeStatusRequest();
  const buf = Buffer.concat([encodeHandshake(767, "mc.example.com", 25565, NEXT_STATE.STATUS), statusRequest]);
  const handshake = parseHandshake(buf);
  assert.ok(handshake !== null);
  assert.deepEqual([...handshake.rest], [...statusRequest]);
});
// 33
check("parseHandshake keeps a partial trailing packet as rest", () => {
  const tail = Buffer.from([0xff, 0x01]);
  const buf = Buffer.concat([encodeHandshake(767, "h", 1, NEXT_STATE.STATUS), tail]);
  const handshake = parseHandshake(buf);
  assert.ok(handshake !== null);
  assert.deepEqual([...handshake.rest], [...tail]);
});
// 34: 非 MC 先頭パケットの拒否(packetId が 0x00 でない)
check("parseHandshake rejects a non-handshake packet id", () => {
  const bogus = encodePacket(0x01, writeVarInt(767));
  throwsCode(() => parseHandshake(bogus), "not-handshake");
});
// 35: 非 MC 先頭パケットの拒否(HTTP リクエスト)
check("parseHandshake rejects plain HTTP traffic", () => {
  // 短い HTTP リクエストは宣言長に届かない = ハンドシェイクとして確定しない
  const http = Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n", "ascii");
  assert.equal(parseHandshake(http), null);
  // ヘッダ付きで 2048 を超える HTTP リクエストは過大として拒否
  const longHttp = Buffer.from(
    "GET / HTTP/1.1\r\nHost: x\r\n" + "X-Pad: " + "a".repeat(4096) + "\r\n\r\n",
    "ascii",
  );
  assert.throws(() => parseHandshake(longHttp), (error) => error instanceof ProtocolError);
});
// 36: nextState が範囲外
check("parseHandshake rejects nextState out of range", () => {
  throwsCode(() => parseHandshake(encodeHandshake(767, "h", 1, 4)), "bad-next-state");
  throwsCode(() => parseHandshake(encodeHandshake(767, "h", 1, 0)), "bad-next-state");
});
// 37: 本文が途中で終わっているハンドシェイク(長さの宣言は満たしている)
check("parseHandshake rejects a structurally short handshake", () => {
  throwsCode(() => parseHandshake(encodePacket(0x00, writeVarInt(767))), "truncated-handshake");
  throwsCode(
    () => parseHandshake(encodePacket(0x00, Buffer.concat([writeVarInt(767), writeString("h")]))),
    "truncated-handshake",
  );
});
// 38: ポートはビッグエンディアン
check("parseHandshake reads the port as big endian", () => {
  const handshake = parseHandshake(encodeHandshake(767, "h", 25565, NEXT_STATE.STATUS));
  assert.ok(handshake !== null);
  assert.equal(handshake.port, 25565);
});

console.log("Status / Ping");

// 39: オフライン応答の形式(Status Response)
check("encodeOfflineStatusResponse matches §4.3 format", () => {
  const packet = readPacket(encodeOfflineStatusResponse());
  assert.ok(packet !== null);
  assert.equal(packet.id, 0x00);
  const text = readString(packet.payload);
  assert.ok(text !== null);
  assert.equal(text.size, packet.payload.length);
  assert.equal(text.value, OFFLINE_STATUS_JSON);
  const json = JSON.parse(text.value);
  assert.equal(json.version.name, "Offline");
  assert.equal(json.version.protocol, -1);
  assert.equal(json.players.max, 0);
  assert.equal(json.players.online, 0);
  assert.equal(json.description.text, "The Minecraft server is offline right now. Try again later.");
});
// 40: オフライン応答の形式(Disconnect)
check("encodeOfflineDisconnect matches §4.3 format", () => {
  const packet = readPacket(encodeOfflineDisconnect());
  assert.ok(packet !== null);
  assert.equal(packet.id, 0x00);
  const json = JSON.parse(readString(packet.payload)!.value);
  assert.deepEqual(Object.keys(json), ["text"]);
  assert.equal(json.text, "The Minecraft server is offline right now. Try again later.");
});
// 41: Ping 判定
check("isPing accepts packetId 0x01 with 8 bytes", () => {
  const packet = readPacket(encodePing(Buffer.alloc(8, 7)));
  assert.ok(packet !== null);
  assert.equal(packet.size, 10);
  assert.equal(packet.payload.length, 8);
  assert.equal(isPing(packet), true);
  assert.equal(isStatusRequest(packet), false);
});
// 42
check("isPing rejects 0x01 with a different payload length", () => {
  assert.equal(isPing(readPacket(encodePacket(0x01, Buffer.alloc(0)))!), false);
  assert.equal(isPing(readPacket(encodePacket(0x01, Buffer.alloc(7)))!), false);
  assert.equal(isPing(readPacket(encodePacket(0x02, Buffer.alloc(8)))!), false);
});
// 43
check("isStatusRequest accepts packetId 0x00 with an empty body", () => {
  assert.equal(isStatusRequest(readPacket(encodeStatusRequest())!), true);
  assert.equal(isStatusRequest(readPacket(encodePacket(0x00, Buffer.from([1])))!), false);
  assert.equal(isStatusRequest(readPacket(encodePing(Buffer.alloc(8)))!), false);
});

console.log("");
console.log(checks + " checks, " + failures + " failures");
if (failures > 0) process.exit(1);
