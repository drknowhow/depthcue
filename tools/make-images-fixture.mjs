// Writes fixtures/decks/images/assets/grid.png: 300 by 300 pixels in a 3 by 3 grid of 100-pixel cells, each a color of
// its own, so a test can tell which part of the picture sits at a point of the page. Run it to regenerate the file.
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

/** Row by row, left to right. */
export const CELLS = [
  [255, 0, 0],
  [255, 128, 0],
  [255, 255, 0],
  [0, 200, 0],
  [128, 128, 128],
  [0, 255, 255],
  [0, 0, 255],
  [160, 0, 255],
  [255, 0, 255],
];
const SIZE = 300;

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
const rows = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
  const at = y * (SIZE * 3 + 1);
  for (let x = 0; x < SIZE; x++) {
    rows.set(CELLS[Math.floor(y / 100) * 3 + Math.floor(x / 100)], at + 1 + x * 3);
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(rows, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const target = new URL("../fixtures/decks/images/assets/grid.png", import.meta.url);
mkdirSync(new URL("./", target), { recursive: true });
writeFileSync(target, png);
console.log(`${target.pathname}: ${png.length} bytes`);
