/**
 * A TrueType font wrapped as PowerPoint keeps an embedded font: an Embedded OpenType file, version 2.2, with no
 * compression and no obfuscation (W3C member submission "Embedded OpenType (EOT) File Format", 2008). The header repeats
 * what the font says about itself, so PowerPoint can list the face without reading the font; the font follows as it is.
 * Every number in the header is little-endian, the font after it big-endian, as in any sfnt.
 */
import type { FontFacts } from "./sfnt.ts";

const VERSION = 0x00020002;
/** "LP" at byte 34, by which a reader knows the file for an EOT. */
const MAGIC = 0x504c;
const DEFAULT_CHARSET = 1;
/** The checksum of an empty root string: the sum of its bytes, none, with this value laid over it. */
const ROOT_CHECKSUM_KEY = 0x50475342;

const utf16 = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = code & 0xff;
    out[i * 2 + 1] = code >> 8;
  }
  return out;
};

/** The font as an `.fntdata` part. */
export function eotOf(font: Uint8Array, facts: FontFacts): Uint8Array {
  const names = [facts.family, facts.style, facts.version, facts.full].map(utf16);
  // Fixed fields up to byte 80, then each name with the two-byte padding and the two-byte size before it, the empty
  // root string with its own, then the checksum, code page, padding, empty signature and empty EUDC data.
  const head = 80;
  const strings = names.reduce((sum, name) => sum + 4 + name.length, 0) + 4;
  const tail = 4 + 4 + 2 + 2 + 4 + 4;
  const size = head + strings + tail + font.length;
  const out = new Uint8Array(size);
  const data = new DataView(out.buffer);
  data.setUint32(0, size, true);
  data.setUint32(4, font.length, true);
  data.setUint32(8, VERSION, true);
  data.setUint32(12, 0, true);
  out.set(facts.panose.subarray(0, 10), 16);
  data.setUint8(26, DEFAULT_CHARSET);
  data.setUint8(27, facts.italic ? 1 : 0);
  data.setUint32(28, facts.weight, true);
  data.setUint16(32, facts.fsType, true);
  data.setUint16(34, MAGIC, true);
  for (const [i, range] of facts.unicodeRanges.entries()) data.setUint32(36 + i * 4, range >>> 0, true);
  for (const [i, page] of facts.codePages.entries()) data.setUint32(52 + i * 4, page >>> 0, true);
  data.setUint32(60, facts.checkSumAdjustment >>> 0, true);
  // Four reserved numbers at 64 to 79 stay zero.
  let at = head;
  for (const name of names) {
    data.setUint16(at, 0, true);
    data.setUint16(at + 2, name.length, true);
    out.set(name, at + 4);
    at += 4 + name.length;
  }
  data.setUint16(at, 0, true);
  data.setUint16(at + 2, 0, true);
  at += 4;
  data.setUint32(at, ROOT_CHECKSUM_KEY, true);
  data.setUint32(at + 4, 0, true);
  data.setUint16(at + 8, 0, true);
  data.setUint16(at + 10, 0, true);
  data.setUint32(at + 12, 0, true);
  data.setUint32(at + 16, 0, true);
  at += tail;
  out.set(font, at);
  return out;
}

/** What an EOT header says, for a test or a check: the sizes, the version, the magic number and the family's name. */
export function readEot(bytes: Uint8Array): {
  size: number;
  fontSize: number;
  version: number;
  flags: number;
  magic: number;
  fsType: number;
  family: string;
  style: string;
  font: Uint8Array;
} {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => {
    const length = data.getUint16(at + 2, true);
    let value = "";
    for (let i = 0; i < length; i += 2) value += String.fromCharCode(data.getUint16(at + 4 + i, true));
    return { value, next: at + 4 + length };
  };
  const family = text(80);
  const style = text(family.next);
  const fontSize = data.getUint32(4, true);
  return {
    size: data.getUint32(0, true),
    fontSize,
    version: data.getUint32(8, true),
    flags: data.getUint32(12, true),
    magic: data.getUint16(34, true),
    fsType: data.getUint16(32, true),
    family: family.value,
    style: style.value,
    font: bytes.subarray(bytes.length - fontSize),
  };
}
