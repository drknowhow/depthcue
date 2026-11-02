/**
 * A font as PowerPoint can carry it: an sfnt (TrueType outlines in a `glyf` table) unpacked from the WOFF or WOFF2 file
 * a page loads, and read for what the export needs to know about it: its names, its embedding permission, its weight
 * and slant, and which characters it has. WOFF2 is decoded here in full, the `glyf` and `loca` transform included, with
 * brotli from `node:zlib`, so no font library is needed and the same file always gives the same bytes.
 */
import { brotliDecompressSync, inflateSync } from "node:zlib";

/** A font file that cannot be read as a font, with what is wrong with it. */
export class FontError extends Error {}

/**
 * The most a font may unpack to: no real font comes near it, and a file built to unpack to gigabytes, or to a glyph of
 * millions of points, is refused before it can take the process down. A TrueType glyph's point count is 16-bit.
 */
export const FONT_LIMITS = { file: 32 * 1024 * 1024, unpacked: 64 * 1024 * 1024, points: 0xffff } as const;

/** The tables of an sfnt, by tag, and its version (TrueType `0x00010000`, or `OTTO` for CFF outlines). */
export interface Sfnt {
  flavor: number;
  tables: Map<string, Uint8Array>;
}

const TAG_OTTO = 0x4f54544f;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const tagAt = (data: DataView, at: number) =>
  String.fromCharCode(data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3));

/** What kind of font file the bytes are: the first four bytes say. */
export function fontKind(bytes: Uint8Array): "woff2" | "woff" | "ttf" | "otf" | "unknown" {
  if (bytes.length < 4) return "unknown";
  const tag = tagAt(view(bytes), 0);
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return "ttf";
  return "unknown";
}

/** Reads the tables of a plain sfnt. */
export function readSfnt(bytes: Uint8Array): Sfnt {
  const data = view(bytes);
  if (bytes.length < 12) throw new FontError("The file is too short to be a font.");
  const flavor = data.getUint32(0);
  const count = data.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) throw new FontError("The font's table list runs past its end.");
    const offset = data.getUint32(at + 8);
    const length = data.getUint32(at + 12);
    if (offset + length > bytes.length) throw new FontError("A font table runs past the end of the file.");
    tables.set(tagAt(data, at), bytes.subarray(offset, offset + length));
  }
  return { flavor, tables };
}

const pad4 = (n: number) => (n + 3) & ~3;

function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array(pad4(bytes.length));
  padded.set(bytes);
  const data = view(padded);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + data.getUint32(at)) >>> 0;
  return sum;
}

/**
 * Writes the tables as one sfnt: the table list by tag, each table on a four-byte boundary, and the `head` table's
 * whole-font checksum worked out again, as a decoder must.
 */
export function writeSfnt(font: Sfnt): Uint8Array {
  const tags = [...font.tables.keys()].sort();
  const count = tags.length;
  let power = 1;
  let log = 0;
  while (power * 2 <= count) {
    power *= 2;
    log++;
  }
  const headerSize = 12 + 16 * count;
  let size = headerSize;
  for (const tag of tags) size += pad4((font.tables.get(tag) as Uint8Array).length);
  const out = new Uint8Array(size);
  const data = view(out);
  data.setUint32(0, font.flavor);
  data.setUint16(4, count);
  data.setUint16(6, power * 16);
  data.setUint16(8, log);
  data.setUint16(10, count * 16 - power * 16);
  let offset = headerSize;
  let headAt = -1;
  tags.forEach((tag, i) => {
    let table = font.tables.get(tag) as Uint8Array;
    if (tag === "head" && table.length >= 12) {
      table = table.slice();
      view(table).setUint32(8, 0);
      headAt = offset;
    }
    const at = 12 + i * 16;
    for (let k = 0; k < 4; k++) data.setUint8(at + k, tag.charCodeAt(k));
    data.setUint32(at + 4, checksum(table));
    data.setUint32(at + 8, offset);
    data.setUint32(at + 12, table.length);
    out.set(table, offset);
    offset += pad4(table.length);
  });
  if (headAt >= 0) data.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// WOFF 1: each table on its own, deflated when that made it smaller.
// ---------------------------------------------------------------------------------------------------------------------

function unwoff(bytes: Uint8Array): Sfnt {
  const data = view(bytes);
  if (bytes.length < 44) throw new FontError("The WOFF file is too short.");
  const flavor = data.getUint32(4);
  const count = data.getUint16(12);
  const tables = new Map<string, Uint8Array>();
  let unpacked = 0;
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    if (at + 20 > bytes.length) throw new FontError("The WOFF table list runs past its end.");
    const offset = data.getUint32(at + 4);
    const compressed = data.getUint32(at + 8);
    const length = data.getUint32(at + 12);
    if (offset + compressed > bytes.length)
      throw new FontError("A WOFF table runs past the end of the file.");
    unpacked += length;
    if (unpacked > FONT_LIMITS.unpacked)
      throw new FontError("The WOFF tables would unpack to more than 64 MB, which no font needs.");
    const raw = bytes.subarray(offset, offset + compressed);
    let table: Uint8Array;
    try {
      // A table may not inflate past the size it states: anything more is refused, not unpacked.
      table =
        compressed < length
          ? new Uint8Array(inflateSync(raw, { maxOutputLength: Math.max(1, length) }))
          : raw;
    } catch {
      throw new FontError("A WOFF table could not be unpacked to its stated size.");
    }
    if (table.length !== length) throw new FontError("A WOFF table did not unpack to its stated size.");
    tables.set(tagAt(data, at), table);
  }
  return { flavor, tables };
}

// ---------------------------------------------------------------------------------------------------------------------
// WOFF 2: every table in one brotli stream, `glyf` and `loca` (and sometimes `hmtx`) stored in a smaller form that is
// turned back into the ordinary one here. The steps follow the W3C WOFF 2.0 recommendation, section 5.
// ---------------------------------------------------------------------------------------------------------------------

// biome-ignore format: the spec's table, 63 tags in its order
const KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
  "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS",
  "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc",
  "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** Reads a stream of bytes from the front. */
class Reader {
  at = 0;
  readonly bytes: Uint8Array;
  readonly data: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.data = view(bytes);
  }
  private need(n: number) {
    if (this.at + n > this.bytes.length) throw new FontError("The WOFF2 data ends too soon.");
  }
  u8(): number {
    this.need(1);
    return this.data.getUint8(this.at++);
  }
  u16(): number {
    this.need(2);
    const value = this.data.getUint16(this.at);
    this.at += 2;
    return value;
  }
  i16(): number {
    this.need(2);
    const value = this.data.getInt16(this.at);
    this.at += 2;
    return value;
  }
  u32(): number {
    this.need(4);
    const value = this.data.getUint32(this.at);
    this.at += 4;
    return value;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const part = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return part;
  }
  /** UIntBase128: up to five bytes of seven bits each, no leading zeros. */
  base128(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      if (i === 0 && byte === 0x80) throw new FontError("A WOFF2 number has a leading zero.");
      if (value & 0xfe000000) throw new FontError("A WOFF2 number is too large.");
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value >>> 0;
    }
    throw new FontError("A WOFF2 number is longer than five bytes.");
  }
  /** 255UInt16. */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

interface Entry {
  tag: string;
  origLength: number;
  /** The length in the stream: the transformed length when the table is transformed. */
  length: number;
  transformed: boolean;
}

const withSign = (flag: number, value: number) => (flag & 1 ? value : -value);

/** One point of a simple glyph. */
interface Point {
  x: number;
  y: number;
  on: boolean;
}

/** The points of a simple glyph from its flags and the glyph stream's triplets (WOFF2 5.2). */
function decodeTriplets(flags: Uint8Array, glyphs: Reader, count: number): Point[] {
  const points: Point[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    const raw = flags[i] as number;
    const on = raw >> 7 === 0;
    const flag = raw & 0x7f;
    let dx: number;
    let dy: number;
    if (flag < 10) {
      dx = 0;
      dy = withSign(flag, ((flag & 14) << 7) + glyphs.u8());
    } else if (flag < 20) {
      dx = withSign(flag, (((flag - 10) & 14) << 7) + glyphs.u8());
      dy = 0;
    } else if (flag < 84) {
      const b0 = flag - 20;
      const b1 = glyphs.u8();
      dx = withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
      dy = withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
    } else if (flag < 120) {
      const b0 = flag - 84;
      const b1 = glyphs.u8();
      const b2 = glyphs.u8();
      dx = withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + b1);
      dy = withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2);
    } else if (flag < 124) {
      const b1 = glyphs.u8();
      const b2 = glyphs.u8();
      const b3 = glyphs.u8();
      dx = withSign(flag, (b1 << 4) + (b2 >> 4));
      dy = withSign(flag >> 1, ((b2 & 0x0f) << 8) + b3);
    } else {
      const b1 = glyphs.u8();
      const b2 = glyphs.u8();
      const b3 = glyphs.u8();
      const b4 = glyphs.u8();
      dx = withSign(flag, (b1 << 8) + b2);
      dy = withSign(flag >> 1, (b3 << 8) + b4);
    }
    x += dx;
    y += dy;
    points.push({ x, y, on });
  }
  return points;
}

/** Bytes written one value at a time, big-endian, as sfnt tables are. */
class Writer {
  private chunks: number[] = [];
  u8(value: number) {
    this.chunks.push(value & 0xff);
  }
  u16(value: number) {
    this.chunks.push((value >> 8) & 0xff, value & 0xff);
  }
  bytes(values: Uint8Array) {
    for (const value of values) this.chunks.push(value);
  }
  get length() {
    return this.chunks.length;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME = 0x10;
const Y_SAME = 0x20;
const OVERLAP_SIMPLE = 0x40;

/** A simple glyph in the ordinary `glyf` form, its coordinates packed as small as the format allows. */
function simpleGlyph(
  ends: number[],
  points: Point[],
  box: [number, number, number, number],
  instructions: Uint8Array,
  overlap: boolean,
): Uint8Array {
  const out = new Writer();
  out.u16(ends.length);
  for (const value of box) out.u16(value);
  for (const end of ends) out.u16(end);
  out.u16(instructions.length);
  out.bytes(instructions);
  const flags: number[] = [];
  const xs = new Writer();
  const ys = new Writer();
  let lastX = 0;
  let lastY = 0;
  points.forEach((point, i) => {
    let flag = point.on ? ON_CURVE : 0;
    if (i === 0 && overlap) flag |= OVERLAP_SIMPLE;
    const dx = point.x - lastX;
    const dy = point.y - lastY;
    if (dx === 0) flag |= X_SAME;
    else if (dx > -256 && dx < 256) {
      flag |= X_SHORT | (dx > 0 ? X_SAME : 0);
      xs.u8(Math.abs(dx));
    } else xs.u16(dx & 0xffff);
    if (dy === 0) flag |= Y_SAME;
    else if (dy > -256 && dy < 256) {
      flag |= Y_SHORT | (dy > 0 ? Y_SAME : 0);
      ys.u8(Math.abs(dy));
    } else ys.u16(dy & 0xffff);
    flags.push(flag);
    lastX = point.x;
    lastY = point.y;
  });
  for (let i = 0; i < flags.length; ) {
    const flag = flags[i] as number;
    let run = 0;
    while (i + run + 1 < flags.length && flags[i + run + 1] === flag && run < 255) run++;
    if (run > 0) {
      out.u8(flag | REPEAT);
      out.u8(run);
    } else out.u8(flag);
    i += run + 1;
  }
  out.bytes(xs.done());
  out.bytes(ys.done());
  return out.done();
}

/** The flags a composite glyph's components carry that say how long each record is. */
const ARGS_ARE_WORDS = 0x0001;
const HAVE_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const HAVE_XY_SCALE = 0x0040;
const HAVE_TWO_BY_TWO = 0x0080;
const HAVE_INSTRUCTIONS = 0x0100;

/** Turns the transformed `glyf` table back into `glyf` and `loca` (WOFF2 5.1 to 5.4). */
function rebuildGlyf(table: Uint8Array): {
  glyf: Uint8Array;
  loca: Uint8Array;
  boxes: Int16Array;
  long: boolean;
} {
  const head = new Reader(table);
  head.u16();
  const options = head.u16();
  const numGlyphs = head.u16();
  const indexFormat = head.u16();
  const sizes = Array.from({ length: 7 }, () => head.u32());
  const streams: Reader[] = [];
  for (const size of sizes) streams.push(new Reader(head.take(size)));
  const [contours, pointCounts, flagStream, glyphs, composites, bboxes, instructionStream] = streams as [
    Reader,
    Reader,
    Reader,
    Reader,
    Reader,
    Reader,
    Reader,
  ];
  const bitmapSize = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxes.take(bitmapSize);
  const overlapBitmap = options & 1 ? head.take(Math.floor((numGlyphs + 7) / 8)) : undefined;
  const hasBox = (i: number) => ((bboxBitmap[i >> 3] as number) & (0x80 >> (i & 7))) !== 0;

  const parts: Uint8Array[] = [];
  const offsets: number[] = [0];
  const boxes = new Int16Array(numGlyphs * 4);
  let total = 0;
  for (let i = 0; i < numGlyphs; i++) {
    const count = contours.i16();
    let glyph: Uint8Array;
    if (count === 0) {
      if (hasBox(i)) throw new FontError("An empty WOFF2 glyph has a bounding box.");
      glyph = new Uint8Array(0);
    } else if (count > 0) {
      const ends: number[] = [];
      let points = 0;
      for (let c = 0; c < count; c++) {
        points += pointCounts.u255();
        // Refused before anything is read for it: a glyph's last point number is 16-bit.
        if (points > FONT_LIMITS.points)
          throw new FontError("A WOFF2 glyph has more points than a TrueType glyph may have.");
        ends.push(points - 1);
      }
      const flags = flagStream.take(points);
      const decoded = decodeTriplets(flags, glyphs, points);
      const instructions = instructionStream.take(glyphs.u255());
      let box: [number, number, number, number];
      if (hasBox(i)) box = [bboxes.i16(), bboxes.i16(), bboxes.i16(), bboxes.i16()];
      else {
        const xs = decoded.map((point) => point.x);
        const ys = decoded.map((point) => point.y);
        box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      }
      const overlap = overlapBitmap ? ((overlapBitmap[i >> 3] as number) & (0x80 >> (i & 7))) !== 0 : false;
      glyph = simpleGlyph(ends, decoded, box, instructions, overlap);
      boxes.set(box, i * 4);
    } else if (count === -1) {
      if (!hasBox(i)) throw new FontError("A composite WOFF2 glyph has no bounding box.");
      const box: [number, number, number, number] = [bboxes.i16(), bboxes.i16(), bboxes.i16(), bboxes.i16()];
      const start = composites.at;
      let instructed = false;
      for (let more = true; more; ) {
        const flags = composites.u16();
        composites.u16();
        composites.take(flags & ARGS_ARE_WORDS ? 4 : 2);
        if (flags & HAVE_SCALE) composites.take(2);
        else if (flags & HAVE_XY_SCALE) composites.take(4);
        else if (flags & HAVE_TWO_BY_TWO) composites.take(8);
        if (flags & HAVE_INSTRUCTIONS) instructed = true;
        more = (flags & MORE_COMPONENTS) !== 0;
      }
      const records = composites.bytes.subarray(start, composites.at);
      const out = new Writer();
      out.u16(0xffff);
      for (const value of box) out.u16(value);
      out.bytes(records);
      if (instructed) {
        const instructions = instructionStream.take(glyphs.u255());
        out.u16(instructions.length);
        out.bytes(instructions);
      }
      glyph = out.done();
      boxes.set(box, i * 4);
    } else {
      throw new FontError("A WOFF2 glyph has a number of contours the format does not allow.");
    }
    parts.push(glyph);
    total += pad4(glyph.length);
    offsets.push(total);
  }
  const glyf = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    glyf.set(part, at);
    at += pad4(part.length);
  }
  const long = indexFormat === 1 || total > 0x1fffe;
  const loca = new Uint8Array((numGlyphs + 1) * (long ? 4 : 2));
  const locaView = view(loca);
  offsets.forEach((offset, i) => {
    if (long) locaView.setUint32(i * 4, offset);
    else locaView.setUint16(i * 2, offset / 2);
  });
  return { glyf, loca, boxes, long };
}

/** Turns the transformed `hmtx` table back into the ordinary one (WOFF2 5.5): missing side bearings are the boxes' xMin. */
function rebuildHmtx(table: Uint8Array, numGlyphs: number, metrics: number, boxes: Int16Array): Uint8Array {
  const read = new Reader(table);
  const flags = read.u8();
  const advances = Array.from({ length: metrics }, () => read.u16());
  const sides: number[] = [];
  for (let i = 0; i < metrics; i++) sides.push(flags & 1 ? (boxes[i * 4] as number) : read.i16());
  for (let i = metrics; i < numGlyphs; i++) sides.push(flags & 2 ? (boxes[i * 4] as number) : read.i16());
  const out = new Writer();
  for (let i = 0; i < numGlyphs; i++) {
    if (i < metrics) out.u16(advances[i] as number);
    out.u16((sides[i] as number) & 0xffff);
  }
  return out.done();
}

function unwoff2(bytes: Uint8Array): Sfnt {
  const read = new Reader(bytes);
  read.u32();
  const flavor = read.u32();
  if (flavor === 0x74746366)
    throw new FontError("The WOFF2 file is a font collection, which PowerPoint cannot embed.");
  read.u32();
  const count = read.u16();
  read.u16();
  read.u32();
  const compressedSize = read.u32();
  read.take(24);
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const flags = read.u8();
    const index = flags & 0x3f;
    const tag = index === 63 ? String.fromCharCode(...read.take(4)) : (KNOWN_TAGS[index] as string);
    const version = flags >> 6;
    const origLength = read.base128();
    // glyf and loca are transformed unless the version is 3; every other table is transformed unless it is 0.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    const length = transformed ? read.base128() : origLength;
    entries.push({ tag, origLength, length, transformed });
  }
  // The stream holds the tables and nothing else, so it may not unpack to more than their lengths add up to.
  const expected = entries.reduce((sum, entry) => sum + entry.length, 0);
  if (expected > FONT_LIMITS.unpacked)
    throw new FontError("The WOFF2 tables would unpack to more than 64 MB, which no font needs.");
  let stream: Uint8Array;
  try {
    stream = new Uint8Array(
      brotliDecompressSync(read.take(compressedSize), { maxOutputLength: Math.max(1, expected) }),
    );
  } catch (error) {
    if (error instanceof FontError) throw error;
    throw new FontError("The WOFF2 data could not be decompressed to the size its tables state.");
  }
  const raw = new Map<string, { entry: Entry; data: Uint8Array }>();
  let at = 0;
  for (const entry of entries) {
    if (at + entry.length > stream.length)
      throw new FontError("A WOFF2 table runs past the end of its data.");
    raw.set(entry.tag, { entry, data: stream.subarray(at, at + entry.length) });
    at += entry.length;
  }
  const tables = new Map<string, Uint8Array>();
  let boxes: Int16Array | undefined;
  const glyf = raw.get("glyf");
  if (glyf?.entry.transformed) {
    const rebuilt = rebuildGlyf(glyf.data);
    tables.set("glyf", rebuilt.glyf);
    tables.set("loca", rebuilt.loca);
    boxes = rebuilt.boxes;
    const head = raw.get("head");
    if (head && head.data.length >= 54) {
      const copy = head.data.slice();
      view(copy).setInt16(50, rebuilt.long ? 1 : 0);
      raw.set("head", { entry: head.entry, data: copy });
    }
  }
  for (const [tag, { entry, data }] of raw) {
    if (tag === "glyf" || tag === "loca") {
      if (!entry.transformed) tables.set(tag, data);
      continue;
    }
    if (tag === "hmtx" && entry.transformed) {
      const hhea = raw.get("hhea")?.data;
      const maxp = raw.get("maxp")?.data;
      if (!hhea || !maxp || !boxes)
        throw new FontError("A WOFF2 hmtx table is transformed without the tables it needs.");
      tables.set("hmtx", rebuildHmtx(data, view(maxp).getUint16(4), view(hhea).getUint16(34), boxes));
      continue;
    }
    if (entry.transformed)
      throw new FontError(`The WOFF2 table "${tag}" uses a transform this reader does not know.`);
    tables.set(tag, data);
  }
  return { flavor, tables };
}

/** The sfnt inside a TrueType, OpenType, WOFF or WOFF2 file. */
export function unpackFont(bytes: Uint8Array): Sfnt {
  const kind = fontKind(bytes);
  if (kind === "woff2") return unwoff2(bytes);
  if (kind === "woff") return unwoff(bytes);
  if (kind === "ttf" || kind === "otf") return readSfnt(bytes);
  throw new FontError("The file is not a font this export can read (TrueType, OpenType, WOFF or WOFF2).");
}

// ---------------------------------------------------------------------------------------------------------------------
// What a font says about itself.
// ---------------------------------------------------------------------------------------------------------------------

export interface FontFacts {
  /** The family Windows knows it by (name 1), its style (name 2), its version (name 5) and its full name (name 4). */
  family: string;
  style: string;
  version: string;
  full: string;
  /** TrueType outlines, which PowerPoint embeds; CFF outlines it does not. */
  outlines: "truetype" | "cff";
  fsType: number;
  weight: number;
  bold: boolean;
  italic: boolean;
  panose: Uint8Array;
  /** Every glyph is as wide as every other (`post` isFixedPitch). */
  fixedPitch: boolean;
  unicodeRanges: [number, number, number, number];
  codePages: [number, number];
  checkSumAdjustment: number;
  /** The characters the font maps to a glyph. */
  covers(code: number): boolean;
}

/**
 * A name from the `name` table: the Windows English (US) one, else the Unicode platform's, else another Windows
 * language's, else the Macintosh Roman one. Empty when the font has none of them.
 */
function nameOf(table: Uint8Array | undefined, id: number): string {
  if (!table || table.length < 6) return "";
  const data = view(table);
  const count = data.getUint16(2);
  const strings = data.getUint16(4);
  const utf16 = (raw: Uint8Array) => {
    let text = "";
    for (let k = 0; k + 1 < raw.length; k += 2)
      text += String.fromCharCode(((raw[k] as number) << 8) | (raw[k + 1] as number));
    return text;
  };
  // Lower is better: Windows English (US), the Unicode platform, any other Windows name, Macintosh Roman.
  let best = { rank: 4, text: "" };
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > table.length) break;
    const platform = data.getUint16(at);
    const encoding = data.getUint16(at + 2);
    const language = data.getUint16(at + 4);
    const nameId = data.getUint16(at + 6);
    const length = data.getUint16(at + 8);
    const offset = strings + data.getUint16(at + 10);
    if (nameId !== id || offset + length > table.length) continue;
    const raw = table.subarray(offset, offset + length);
    const windows = platform === 3 && (encoding === 1 || encoding === 0);
    const rank =
      windows && language === 0x409
        ? 0
        : platform === 0
          ? 1
          : windows
            ? 2
            : platform === 1 && encoding === 0
              ? 3
              : 4;
    if (rank >= best.rank) continue;
    const text = rank === 3 ? String.fromCharCode(...raw) : utf16(raw);
    if (text.trim() !== "") best = { rank, text };
  }
  return best.text;
}

/** The characters a `cmap` table maps, from its Unicode subtable (format 4 or 12). */
function coverage(table: Uint8Array | undefined): (code: number) => boolean {
  if (!table || table.length < 4) return () => false;
  const data = view(table);
  const count = data.getUint16(2);
  let best: { offset: number; format: number } | undefined;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8;
    if (at + 8 > table.length) break;
    const platform = data.getUint16(at);
    const encoding = data.getUint16(at + 2);
    const offset = data.getUint32(at + 4);
    if (offset + 2 > table.length) continue;
    const format = data.getUint16(offset);
    const unicode = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!best || format === 12) best = { offset, format };
  }
  if (!best) return () => false;
  const ranges: Array<[number, number]> = [];
  const { offset, format } = best;
  if (format === 12) {
    const groups = data.getUint32(offset + 12);
    for (let i = 0; i < groups; i++) {
      const at = offset + 16 + i * 12;
      if (at + 12 > table.length) break;
      if (data.getUint32(at + 8) !== 0 || data.getUint32(at) !== data.getUint32(at + 4))
        ranges.push([data.getUint32(at), data.getUint32(at + 4)]);
    }
  } else {
    const segments = data.getUint16(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      const end = data.getUint16(ends + s * 2);
      const start = data.getUint16(starts + s * 2);
      const delta = data.getUint16(deltas + s * 2);
      const rangeOffset = data.getUint16(rangeOffsets + s * 2);
      if (start === 0xffff) continue;
      for (let code = start; code <= end; code++) {
        let glyph: number;
        if (rangeOffset === 0) glyph = (code + delta) & 0xffff;
        else {
          const at = rangeOffsets + s * 2 + rangeOffset + (code - start) * 2;
          glyph = at + 2 <= table.length ? data.getUint16(at) : 0;
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) {
          const last = ranges[ranges.length - 1];
          if (last && last[1] === code - 1) last[1] = code;
          else ranges.push([code, code]);
        }
      }
    }
  }
  return (code: number) => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end] = ranges[middle] as [number, number];
      if (code < start) high = middle - 1;
      else if (code > end) low = middle + 1;
      else return true;
    }
    return false;
  };
}

export function factsOf(font: Sfnt): FontFacts {
  const name = font.tables.get("name");
  const os2 = font.tables.get("OS/2");
  const head = font.tables.get("head");
  const post = font.tables.get("post");
  const os = os2 && os2.length >= 78 ? view(os2) : undefined;
  const selection = os?.getUint16(62) ?? 0;
  const macStyle = head && head.length >= 46 ? view(head).getUint16(44) : 0;
  return {
    family: nameOf(name, 1),
    style: nameOf(name, 2),
    version: nameOf(name, 5),
    full: nameOf(name, 4),
    outlines:
      font.flavor === TAG_OTTO || font.tables.has("CFF ") || font.tables.has("CFF2") ? "cff" : "truetype",
    fsType: os?.getUint16(8) ?? 0,
    weight: os?.getUint16(4) ?? 400,
    bold: (selection & 0x20) !== 0 || (macStyle & 1) !== 0,
    italic: (selection & 0x01) !== 0 || (macStyle & 2) !== 0,
    panose: os2 && os2.length >= 42 ? os2.slice(32, 42) : new Uint8Array(10),
    fixedPitch: post !== undefined && post.length >= 16 && view(post).getUint32(12) !== 0,
    unicodeRanges: os
      ? [os.getUint32(42), os.getUint32(46), os.getUint32(50), os.getUint32(54)]
      : [0, 0, 0, 0],
    codePages: os && os2 && os2.length >= 86 ? [os.getUint32(78), os.getUint32(82)] : [0, 0],
    checkSumAdjustment: head && head.length >= 12 ? view(head).getUint32(8) : 0,
    covers: coverage(font.tables.get("cmap")),
  };
}
