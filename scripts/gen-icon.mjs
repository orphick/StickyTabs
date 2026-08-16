/**
 * Writes `icon-source.png`, the 1024x1024 master that `tauri icon` slices into every
 * platform size.
 *
 * Hand-rolled PNG encoder rather than a dependency: the artwork is four rectangles, and
 * pulling in an image library to draw them would be the largest dependency in the project.
 * node:zlib does the only hard part.
 *
 *   node scripts/gen-icon.mjs && npx tauri icon icon-source.png
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;

// Same palette as the dark theme, so the tray icon belongs to the window it opens.
const PAPER = [0x1c, 0x1a, 0x17];
const NOTE = [0xe9, 0xe0, 0xcf];
const ACCENT = [0xc9, 0x90, 0x2f];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

function fill(x0, y0, w, h, [r, g, b], radius = 0) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;

      if (radius > 0) {
        // Corner test: only the four corner boxes need a distance check.
        const dx = x < x0 + radius ? x0 + radius - x : x > x0 + w - 1 - radius ? x - (x0 + w - 1 - radius) : 0;
        const dy = y < y0 + radius ? y0 + radius - y : y > y0 + h - 1 - radius ? y - (y0 + h - 1 - radius) : 0;
        if (dx * dx + dy * dy > radius * radius) continue;
      }

      const i = (y * SIZE + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
}

// Scaled 10.24x from the 100x100 mark in the visual-direction mockup.
const u = SIZE / 100;
fill(0, 0, SIZE, SIZE, PAPER);
fill(Math.round(22 * u), Math.round(22 * u), Math.round(56 * u), Math.round(56 * u), NOTE, Math.round(5 * u));
fill(Math.round(22 * u), Math.round(22 * u), Math.round(25 * u), Math.round(8 * u), ACCENT);

// --- PNG container -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// bytes 10-12 stay zero: deflate, adaptive filtering, no interlace

// Each scanline is prefixed with its filter byte. Filter 0 (none) keeps this simple; the
// image is flat colour, so deflate compresses it to a few kilobytes regardless.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../icon-source.png", import.meta.url), png);
console.log(`icon-source.png written (${SIZE}x${SIZE}, ${png.length} bytes)`);
