/**
 * アプリアイコン(build/icon.png)を生成する。依存ライブラリなし。
 * 草ブロック風の立方体を描く。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 256;

const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function put(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = a;
}

/** 点が多角形の中か(レイキャスト)。 */
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// 背景の角丸四角形
const R = 56;
const M = 8;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (x < M || y < M || x >= SIZE - M || y >= SIZE - M) continue;
    const cx = Math.max(M + R - x, x - (SIZE - M - 1 - R), 0);
    const cy = Math.max(M + R - y, y - (SIZE - M - 1 - R), 0);
    if (cx * cx + cy * cy > R * R) continue;
    put(x, y, 21, 24, 29, 255);
  }
}

// 立方体(アイソメトリック)。中心座標。
const cxp = 128, cyp = 128, w = 66, h = 64;
const top = [[cxp, cyp - h], [cxp + w, cyp - h / 2], [cxp, cyp], [cxp - w, cyp - h / 2]];
const left = [[cxp - w, cyp - h / 2], [cxp, cyp], [cxp, cyp + h], [cxp - w, cyp + h / 2]];
const right = [[cxp, cyp], [cxp + w, cyp - h / 2], [cxp + w, cyp + h / 2], [cxp, cyp + h]];
const outline = [[cxp, cyp - h], [cxp + w, cyp - h / 2], [cxp + w, cyp + h / 2], [cxp, cyp + h], [cxp - w, cyp + h / 2], [cxp - w, cyp - h / 2]];

// 面ごとに微妙に違う緑/茶。左下に草、側面に土。
const grassTop = [109, 196, 87];
const dirtLeft = [133, 88, 58];
const dirtRight = [104, 68, 44];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // まず面を塗り、面の外側で輪郭ポリゴン内のぶんだけを縁として塗る。
    if (inPoly(x + 0.5, y + 0.5, top)) put(x, y, ...grassTop, 255);
    else if (inPoly(x + 0.5, y + 0.5, left)) put(x, y, ...dirtLeft, 255);
    else if (inPoly(x + 0.5, y + 0.5, right)) put(x, y, ...dirtRight, 255);
    else if (inPoly(x + 0.5, y + 0.5, outline)) put(x, y, 18, 20, 24, 255); // 輪郭
  }
}

// 上の面に草のむらを作る(点々)。
let seed = 20261122;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
for (let i = 0; i < 700; i++) {
  const x = (cxp - w + 2 + rand() * (w * 2 - 4)) | 0;
  const y = (cyp - h + 2 + rand() * (h - 2)) | 0;
  if (inPoly(x + 0.5, y + 0.5, top)) {
    const d = 18 - (rand() * 26) | 0;
    put(x, y, 109 + d, 196 + d, 87 + d, 255);
  }
}

// PNG エンコード
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(path.join(root, "..", "build"), { recursive: true });
const out = path.join(root, "..", "build", "icon.png");
writeFileSync(out, png);
console.log("icon written ->", out, png.length, "bytes");
