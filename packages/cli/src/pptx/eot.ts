/**
 * A TrueType font wrapped as PowerPoint keeps an embedded font: an Embedded OpenType file, version 2.2, with no
 * compression and no obfuscation (W3C member submission "Embedded OpenType (EOT) File Format", 2008). The header repeats
 * what the font says about itself, so PowerPoint can list the face without reading the font; the font follows as it is.
 * Every number in the header is little-endian, the font after it big-endian, as in any sfnt.
 *
 * Where the format leaves a choice, the header is written as PowerPoint writes its own: a Latin font's character set is
 * ANSI (0) and its EUDC code page 1252, and the family and style names end in a NUL that their sizes count, while the
 * version and full names do not.
 */
import type { FontFacts } from "./sfnt.ts";

const VERSION = 0x00020002;
/** "LP" at byte 34, by which a reader knows the file for an EOT. */
const MAGIC = 0x504c;
const ANSI_CHARSET = 0;
const DEFAULT_CHARSET = 1;
const LATIN_CODE_PAGE = 1252;
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

/** A font with Latin-1 in its code pages, or, when it lists none, with Basic Latin in its Unicode ranges. */
export const isLatin = (facts: Pick<FontFacts, "codePages" | "unicodeRanges">): boolean =>
  (facts.codePages[0] & 1) !== 0 ||
  (facts.codePages[0] === 0 && facts.codePages[1] === 0 && (facts.unicodeRanges[0] & 1) !== 0);

/** The font as an `.fntdata` part. The facts must be the written font's own, its checksum included. */
export function eotOf(font: Uint8Array, facts: FontFacts): Uint8Array {
  const latin = isLatin(facts);
  const names = [`${facts.family}\0`, `${facts.style}\0`, facts.version, facts.full].map(utf16);
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
  data.setUint8(26, latin ? ANSI_CHARSET : DEFAULT_CHARSET);
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
  data.setUint32(at + 4, latin ? LATIN_CODE_PAGE : 0, true);
  data.setUint16(at + 8, 0, true);
  data.setUint16(at + 10, 0, true);
  data.setUint32(at + 12, 0, true);
  data.setUint32(at + 16, 0, true);
  at += tail;
  out.set(font, at);
  return out;
}

/** One of the header's names: its text without the NUL a name may end in, and its size in bytes as written. */
export interface EotName {
  value: string;
  bytes: number;
}

/** Every field of an EOT 2.2 header, read back, and the font after it. */
export interface EotHeader {
  size: number;
  fontSize: number;
  version: number;
  flags: number;
  panose: Uint8Array;
  charset: number;
  italic: number;
  weight: number;
  fsType: number;
  magic: number;
  unicodeRanges: number[];
  codePages: number[];
  checkSumAdjustment: number;
  reserved: number[];
  /** The padding before each name and before the root string, which must all be zero. */
  padding: number[];
  family: EotName;
  style: EotName;
  versionName: EotName;
  full: EotName;
  rootString: number;
  rootChecksum: number;
  eudcCodePage: number;
  padding5: number;
  signatureSize: number;
  eudcFlags: number;
  eudcFontSize: number;
  /** Where the font starts. */
  fontAt: number;
  font: Uint8Array;
}

/** Reads an EOT 2.2 header field by field, as a reader of the format would. */
export function readEot(bytes: Uint8Array): EotHeader {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const padding: number[] = [];
  let at = 80;
  const name = (): EotName => {
    padding.push(data.getUint16(at, true));
    const length = data.getUint16(at + 2, true);
    let value = "";
    for (let i = 0; i < length; i += 2) value += String.fromCharCode(data.getUint16(at + 4 + i, true));
    at += 4 + length;
    return { value: value.replace(/\0$/, ""), bytes: length };
  };
  const family = name();
  const style = name();
  const versionName = name();
  const full = name();
  padding.push(data.getUint16(at, true));
  const rootString = data.getUint16(at + 2, true);
  at += 4 + rootString;
  const rootChecksum = data.getUint32(at, true);
  const eudcCodePage = data.getUint32(at + 4, true);
  const padding5 = data.getUint16(at + 8, true);
  const signatureSize = data.getUint16(at + 10, true);
  at += 12 + signatureSize;
  const eudcFlags = data.getUint32(at, true);
  const eudcFontSize = data.getUint32(at + 4, true);
  at += 8 + eudcFontSize;
  const fontSize = data.getUint32(4, true);
  return {
    size: data.getUint32(0, true),
    fontSize,
    version: data.getUint32(8, true),
    flags: data.getUint32(12, true),
    panose: bytes.slice(16, 26),
    charset: data.getUint8(26),
    italic: data.getUint8(27),
    weight: data.getUint32(28, true),
    fsType: data.getUint16(32, true),
    magic: data.getUint16(34, true),
    unicodeRanges: [0, 1, 2, 3].map((i) => data.getUint32(36 + i * 4, true)),
    codePages: [0, 1].map((i) => data.getUint32(52 + i * 4, true)),
    checkSumAdjustment: data.getUint32(60, true),
    reserved: [0, 1, 2, 3].map((i) => data.getUint32(64 + i * 4, true)),
    padding,
    family,
    style,
    versionName,
    full,
    rootString,
    rootChecksum,
    eudcCodePage,
    padding5,
    signatureSize,
    eudcFlags,
    eudcFontSize,
    fontAt: at,
    font: bytes.subarray(at, at + fontSize),
  };
}
