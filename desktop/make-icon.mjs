// Generates the app icon: a pixel-art π on a dark rounded square, in the same
// spirit as the pi installer's block logo. Pure Node (zlib), no deps.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const CELL = 96;          // π blocks are 3 cells wide/tall-ish
const GRID = 8;           // 8x8 grid like the install.sh logo
const px = new Uint8Array(SIZE * SIZE * 4);

function put(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

const DARK = [24, 26, 32];
const CYAN = [80, 210, 235];
const ORANGE = [255, 160, 60];

// Background: rounded dark square
const radius = 180;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const cx = Math.min(Math.max(x, radius), SIZE - radius);
    const cy = Math.min(Math.max(y, radius), SIZE - radius);
    const dx = x - cx, dy = y - cy;
    const inside = dx * dx + dy * dy <= radius * radius;
    put(x, y, DARK, inside ? 255 : 0);
  }
}

// π drawn on the 8x8 grid: top bar (rows 1) + two legs (cols 2 and 5)
const cells = new Set();
for (let gx = 1; gx <= 6; gx++) cells.add(`${gx},1`); // bar
for (let gy = 2; gy <= 6; gy++) cells.add(`2,${gy}`); // left leg
for (let gy = 2; gy <= 6; gy++) cells.add(`5,${gy}`); // right leg
cells.add('1,1'); cells.add('6,1');
// serif tips on the legs
cells.add('2,2'); cells.add('5,2');

const origin = Math.floor((SIZE - GRID * CELL) / 2);
for (const key of cells) {
  const [gx, gy] = key.split(',').map(Number);
  const x0 = origin + gx * CELL, y0 = origin + gy * CELL;
  const accent = gy === 1 ? CYAN : ORANGE;
  for (let y = y0; y < y0 + CELL; y++) {
    for (let x = x0; x < x0 + CELL; x++) {
      put(x, y, accent);
    }
  }
}

// PNG encode (RGBA8, one IDAT)
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const stride = SIZE * 4;
const raw = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (stride + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('./app-icon.png', import.meta.url), png);
console.log('icon written: app-icon.png', png.length, 'bytes');
