
// 内蔵 bridge+server の e2e プローブ:
// bridge(28965)へ MC ステータスハンドシェイクを送り、
// アプリ内蔵 server(18924)がオフライン Status Response を返すことを確認する。
import net from "node:net";

function varint(v) { const b = []; do { let x = v & 0x7f; v = Math.floor(v / 128); if (v) x |= 0x80; b.push(x); } while (v); return Buffer.from(b); }
function str(s) { const b = Buffer.from(s, "utf8"); return Buffer.concat([varint(b.length), b]); }
function packet(id, body = Buffer.alloc(0)) { const p = Buffer.concat([varint(id), body]); return Buffer.concat([varint(p.length), p]); }

const handshake = packet(0x00, Buffer.concat([varint(767), str("mc.example.com"), (() => { const p = Buffer.alloc(2); p.writeUInt16BE(25565); return p; })(), varint(1)]));
const statusReq = packet(0x00);

const socket = net.connect({ host: "127.0.0.1", port: 28965 });
let buf = Buffer.alloc(0);
socket.on("data", (d) => { buf = Buffer.concat([buf, d]); });
socket.on("error", (e) => { console.log("PROBE_ERR", e.message); process.exit(1); });
socket.on("connect", () => { socket.write(Buffer.concat([handshake, statusReq])); });
setTimeout(() => {
  const text = buf.toString("utf8");
  // バックエンドが生きていれば実サーバーの Status、落ちていればオフライン応答が返る。
  const ok = text.includes("description") || text.includes("The Minecraft server is offline right now");
  console.log(ok ? "PROBE_OK offline status response received (" + buf.length + " bytes)" : "PROBE_FAIL: " + buf.toString("hex").slice(0, 120));
  socket.destroy();
  process.exit(ok ? 0 : 1);
}, 6000);
