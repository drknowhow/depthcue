import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scene, Template } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { run } from "../src/index.ts";
import { overflow } from "../src/pptx/build.ts";
import { eotOf, readEot } from "../src/pptx/eot.ts";
import {
  applyNames,
  type FaceFile,
  listFonts,
  pairFaces,
  parseUnicodeRange,
  pitchFamily,
  planFonts,
  type Slot,
  scanUsage,
  type Usage,
} from "../src/pptx/fonts.ts";
import { describeShape, firstInSlots, linkShape, placeholderType } from "../src/pptx/master.ts";
import type { SlideMeasure } from "../src/pptx/measure.ts";
import { cannotEmbed, mp4Tracks } from "../src/pptx/media.ts";
import {
  FontError,
  factsOf,
  fontKind,
  readSfnt,
  type Sfnt,
  unpackFont,
  writeSfnt,
} from "../src/pptx/sfnt.ts";
import { extValue } from "../src/serve.ts";

/**
 * The parts of the PowerPoint extras that need no browser: reading a font and wrapping it as PowerPoint embeds one,
 * choosing which faces go in and saying why the rest do not, reading an MP4's tracks, the placeholder each slot becomes
 * and how a slide's shape is tied to it, and the words for content past the slide's edge.
 */

const brandDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const harborRegular = join(brandDeck, "brand", "fonts", "HarborSans-Regular.woff2");
const harborBold = join(brandDeck, "brand", "fonts", "HarborSans-Bold.woff2");
const tinyMp4 = fileURLToPath(new URL("./fixtures/tiny.mp4", import.meta.url));
/** fontTools' own decoding of the Space Grotesk WOFF2 above, saved as TrueType with nothing recalculated (OFL). */
const reference = fileURLToPath(new URL("./fixtures/fonts/SpaceGrotesk-Regular.ttf", import.meta.url));
/**
 * Hostile WOFF2 files of a few hundred bytes from the step 6 review: two brotli bombs that decompress to hundreds of
 * megabytes, and two glyphs that ask for millions of points.
 */
const hostile = (name: string) => fileURLToPath(new URL(`./fixtures/hostile/${name}`, import.meta.url));
const playerFonts = fileURLToPath(new URL("../../../brand/fonts", import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-parts-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const fontOf = (file: string): Sfnt => unpackFont(new Uint8Array(readFileSync(file)));

/** A copy of a font with one table changed, written as a TrueType (or OpenType) file. */
function variant(from: string, name: string, change: (font: Sfnt) => void): string {
  const font = fontOf(from);
  font.tables = new Map([...font.tables].map(([tag, bytes]) => [tag, bytes.slice()]));
  change(font);
  const file = join(root, name);
  writeFileSync(file, writeSfnt(font));
  return file;
}

const face = (family: string, file: string, weight = 400, extra: Partial<FaceFile> = {}): FaceFile => ({
  family,
  weight,
  italic: false,
  file,
  label: file.split(/[\\/]/).pop() as string,
  ...extra,
});

const use = (slots: Slot[], text: string): Usage => ({
  slots: new Set(slots),
  chars: new Set([...text].map((character) => character.codePointAt(0) as number)),
});

const dataOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The sum of a file's 32-bit big-endian words, zero-padded to a whole word, as the sfnt checksum is worked out. */
function sum32(bytes: Uint8Array): number {
  const padded = new Uint8Array((bytes.length + 3) & ~3);
  padded.set(bytes);
  const data = dataOf(padded);
  let sum = 0;
  for (let at = 0; at < padded.length; at += 4) sum = (sum + data.getUint32(at)) >>> 0;
  return sum;
}

/** A `name` table holding these records, each as UTF-16 (or one byte a character on the Macintosh platform). */
function nameTable(
  records: Array<{ platform: number; encoding: number; language: number; id: number; text: string }>,
): Uint8Array {
  const strings = records.map(({ platform, text }) =>
    platform === 1
      ? Uint8Array.from([...text].map((character) => character.charCodeAt(0)))
      : Uint8Array.from(
          [...text].flatMap((character) => [character.charCodeAt(0) >> 8, character.charCodeAt(0) & 0xff]),
        ),
  );
  const head = 6 + records.length * 12;
  const out = new Uint8Array(head + strings.reduce((sum, bytes) => sum + bytes.length, 0));
  const data = dataOf(out);
  data.setUint16(2, records.length);
  data.setUint16(4, head);
  let offset = 0;
  records.forEach((record, i) => {
    const at = 6 + i * 12;
    const bytes = strings[i] as Uint8Array;
    data.setUint16(at, record.platform);
    data.setUint16(at + 2, record.encoding);
    data.setUint16(at + 4, record.language);
    data.setUint16(at + 6, record.id);
    data.setUint16(at + 8, bytes.length);
    data.setUint16(at + 10, offset);
    out.set(bytes, head + offset);
    offset += bytes.length;
  });
  return out;
}

/** One glyph as a TrueType reader sees it: its box, contours, points, instructions, or its components. */
interface Outline {
  contours: number;
  box?: number[];
  ends?: number[];
  points?: Array<[number, number, boolean]>;
  overlap?: boolean;
  components?: number[][];
  instructions?: string;
}

/**
 * Every glyph of a TrueType font, read from its `glyf` and `loca` tables the way a rasterizer reads them, so two fonts
 * whose bytes differ (one packs its flags as fontTools does, the other as this export does) compare by their outlines.
 */
function outlines(font: Sfnt): Outline[] {
  const head = dataOf(font.tables.get("head") as Uint8Array);
  const count = dataOf(font.tables.get("maxp") as Uint8Array).getUint16(4);
  const loca = dataOf(font.tables.get("loca") as Uint8Array);
  const glyf = font.tables.get("glyf") as Uint8Array;
  const data = dataOf(glyf);
  const long = head.getInt16(50) === 1;
  const offset = (i: number) => (long ? loca.getUint32(i * 4) : loca.getUint16(i * 2) * 2);
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  const out: Outline[] = [];
  for (let i = 0; i < count; i++) {
    let at = offset(i);
    if (offset(i + 1) === at) {
      out.push({ contours: 0 });
      continue;
    }
    const contours = data.getInt16(at);
    const box = [1, 2, 3, 4].map((k) => data.getInt16(at + k * 2));
    at += 10;
    if (contours >= 0) {
      const ends = Array.from({ length: contours }, (_, k) => data.getUint16(at + k * 2));
      at += contours * 2;
      const length = data.getUint16(at);
      const instructions = hex(glyf.subarray(at + 2, at + 2 + length));
      at += 2 + length;
      const total = contours === 0 ? 0 : (ends[contours - 1] as number) + 1;
      const flags: number[] = [];
      while (flags.length < total) {
        const flag = data.getUint8(at++);
        flags.push(flag);
        if (flag & 8) for (let n = data.getUint8(at++); n > 0; n--) flags.push(flag);
      }
      const axis = (short: number, same: number) => {
        let value = 0;
        return flags.map((flag) => {
          if (flag & short) {
            const step = data.getUint8(at++);
            value += flag & same ? step : -step;
          } else if (!(flag & same)) {
            value += data.getInt16(at);
            at += 2;
          }
          return value;
        });
      };
      const xs = axis(0x02, 0x10);
      const ys = axis(0x04, 0x20);
      out.push({
        contours,
        box,
        ends,
        points: flags.map((flag, k) => [xs[k] as number, ys[k] as number, (flag & 1) === 1]),
        overlap: ((flags[0] ?? 0) & 0x40) !== 0,
        instructions,
      });
      continue;
    }
    const components: number[][] = [];
    let flags = 0x20;
    let instructed = false;
    while (flags & 0x20) {
      flags = data.getUint16(at);
      if (flags & 0x100) instructed = true;
      const glyph = data.getUint16(at + 2);
      at += 4;
      const words = flags & 1;
      const dx = words ? data.getInt16(at) : data.getInt8(at);
      const dy = words ? data.getInt16(at + 2) : data.getInt8(at + 1);
      at += words ? 4 : 2;
      const scales = flags & 0x08 ? 1 : flags & 0x40 ? 2 : flags & 0x80 ? 4 : 0;
      const scale = Array.from({ length: scales }, (_, k) => data.getInt16(at + k * 2));
      at += scales * 2;
      // How the arguments are stored is the writer's choice; what they mean is not.
      components.push([flags & 0x1e06, glyph, dx, dy, ...scale]);
    }
    const length = instructed ? data.getUint16(at) : 0;
    out.push({
      contours,
      box,
      components,
      instructions: instructed ? hex(glyf.subarray(at + 2, at + 2 + length)) : "",
    });
  }
  return out;
}

/** Each glyph's advance and left side bearing, from `hmtx` with `hhea`'s count of full records. */
function metrics(font: Sfnt): Array<[number, number]> {
  const count = dataOf(font.tables.get("maxp") as Uint8Array).getUint16(4);
  const full = dataOf(font.tables.get("hhea") as Uint8Array).getUint16(34);
  const hmtx = dataOf(font.tables.get("hmtx") as Uint8Array);
  let advance = 0;
  return Array.from({ length: count }, (_, i) => {
    if (i < full) advance = hmtx.getUint16(i * 4);
    const side = i < full ? hmtx.getInt16(i * 4 + 2) : hmtx.getInt16(full * 4 + (i - full) * 2);
    return [advance, side];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Fonts: the file, its facts, and the EOT PowerPoint keeps it in.
// ---------------------------------------------------------------------------------------------------------------------

describe("a font file", () => {
  it("is unpacked from WOFF2 into the sfnt it holds, and says what it is", () => {
    const bytes = new Uint8Array(readFileSync(harborRegular));
    expect(fontKind(bytes)).toBe("woff2");
    const font = unpackFont(bytes);
    const facts = factsOf(font);
    // The brand calls it Harbor Sans; the file calls itself Space Grotesk.
    expect(facts.family).toBe("Space Grotesk");
    expect(facts.outlines).toBe("truetype");
    expect(facts.fsType).toBe(0);
    expect(facts.bold).toBe(false);
    expect(facts.covers("A".codePointAt(0) as number)).toBe(true);
    expect(facts.covers(0x4e00)).toBe(false);
    expect(factsOf(fontOf(harborBold)).bold).toBe(true);
  });

  it("is written back as an sfnt with the same tables, the same way every time", () => {
    const font = fontOf(harborRegular);
    const written = writeSfnt(font);
    expect(fontKind(written)).toBe("ttf");
    expect(writeSfnt(font)).toEqual(written);
    const again = readSfnt(written);
    expect([...again.tables.keys()].sort()).toEqual([...font.tables.keys()].sort());
    for (const tag of ["glyf", "loca", "cmap", "name"]) {
      expect(again.tables.get(tag), tag).toEqual(font.tables.get(tag));
    }
    // The whole font sums to the sfnt's magic number, which head's checkSumAdjustment is set to make it do.
    expect(sum32(written)).toBe(0xb1b0afba);
    const head = again.tables.get("head") as Uint8Array;
    expect(dataOf(head).getUint32(8)).not.toBe(0);
  });

  it("is decoded from WOFF2 to the outlines and metrics fontTools decodes, glyph by glyph", () => {
    const ours = fontOf(harborRegular);
    const theirs = readSfnt(new Uint8Array(readFileSync(reference)));
    const mine = outlines(ours);
    const fontTools = outlines(theirs);
    expect(mine.length).toBeGreaterThan(800);
    expect(mine.length).toBe(fontTools.length);
    // Compared one glyph at a time, so a failure names the glyph rather than printing 800 of them.
    const differ = mine.flatMap((glyph, i) =>
      JSON.stringify(glyph) === JSON.stringify(fontTools[i]) ? [] : [i],
    );
    expect(differ, `glyph ${differ[0]}: ${JSON.stringify(mine[differ[0] ?? 0])}`).toEqual([]);
    expect(mine.some((glyph) => (glyph.components?.length ?? 0) > 0)).toBe(true);
    expect(metrics(ours)).toEqual(metrics(theirs));
    // The tables WOFF2 stores as they are come out as they went in.
    for (const tag of ["cmap", "name", "OS/2", "post", "GSUB", "GPOS"]) {
      expect(
        Buffer.from(ours.tables.get(tag) as Uint8Array).equals(
          Buffer.from(theirs.tables.get(tag) as Uint8Array),
        ),
        tag,
      ).toBe(true);
    }
  });

  it("is refused, quickly and as a font error, when it would unpack to a bomb or to a glyph no TrueType font may have", () => {
    for (const name of ["bomb-1.woff2", "bomb-2.woff2", "points-1.woff2", "points-2.woff2"]) {
      const started = performance.now();
      expect(() => unpackFont(new Uint8Array(readFileSync(hostile(name)))), name).toThrow(FontError);
      expect(performance.now() - started, name).toBeLessThan(5_000);
    }
    expect(() => unpackFont(new Uint8Array(readFileSync(hostile("bomb-1.woff2"))))).toThrow(
      "The WOFF2 data could not be decompressed to the size its tables state.",
    );
    expect(() => unpackFont(new Uint8Array(readFileSync(hostile("points-1.woff2"))))).toThrow(
      "A WOFF2 glyph has more points than a TrueType glyph may have.",
    );
  });

  it("reads its names from the Unicode platform too, and from a Windows name before any other", () => {
    const named = (records: Parameters<typeof nameTable>[0]) =>
      factsOf(
        readSfnt(
          readFileSync(
            variant(harborRegular, `names-${records.length}-${records[0]?.platform}.ttf`, (font) =>
              font.tables.set("name", nameTable(records)),
            ),
          ),
        ),
      );
    const unicode = named([
      { platform: 0, encoding: 3, language: 0, id: 1, text: "Unicode Sans" },
      { platform: 0, encoding: 3, language: 0, id: 2, text: "Bold" },
    ]);
    expect([unicode.family, unicode.style]).toEqual(["Unicode Sans", "Bold"]);
    const ranked = named([
      { platform: 1, encoding: 0, language: 0, id: 1, text: "Mac Sans" },
      { platform: 3, encoding: 1, language: 0x407, id: 1, text: "German Sans" },
      { platform: 0, encoding: 4, language: 0, id: 1, text: "Unicode Sans" },
      { platform: 3, encoding: 1, language: 0x409, id: 1, text: "   " },
      { platform: 3, encoding: 1, language: 0x409, id: 4, text: "English Sans Regular" },
    ]);
    // A blank Windows English name is no name: the Unicode one comes next.
    expect(ranked.family).toBe("Unicode Sans");
    expect(ranked.full).toBe("English Sans Regular");
    expect(named([{ platform: 1, encoding: 0, language: 0, id: 1, text: "Mac Sans" }]).family).toBe(
      "Mac Sans",
    );
    expect(named([{ platform: 3, encoding: 1, language: 0x409, id: 4, text: "No family" }]).family).toBe("");
  });

  it("is wrapped as an EOT 2.2 whose header says what the written font says, field by field, and PowerPoint's way", () => {
    for (const file of [harborRegular, harborBold]) {
      const sfnt = writeSfnt(fontOf(file));
      const written = readSfnt(sfnt);
      const facts = factsOf(written);
      const eot = eotOf(sfnt, facts);
      const header = readEot(eot);
      const utf16 = (text: string) => text.length * 2;
      expect(header).toEqual({
        size: eot.length,
        fontSize: sfnt.length,
        version: 0x00020002,
        flags: 0,
        panose: facts.panose,
        // A Latin font: the ANSI character set, as PowerPoint writes its own.
        charset: 0,
        italic: 0,
        weight: file === harborBold ? 700 : 400,
        fsType: 0,
        magic: 0x504c,
        unicodeRanges: [0xa000007f, 0x4000206a, 0, 0],
        codePages: [0x193, 0],
        checkSumAdjustment: dataOf(written.tables.get("head") as Uint8Array).getUint32(8),
        reserved: [0, 0, 0, 0],
        padding: [0, 0, 0, 0, 0],
        // The family and style end in a NUL their sizes count; the version and full name do not.
        family: { value: "Space Grotesk", bytes: utf16("Space Grotesk\0") },
        style: { value: facts.style, bytes: utf16(`${facts.style}\0`) },
        versionName: { value: facts.version, bytes: utf16(facts.version) },
        full: { value: facts.full, bytes: utf16(facts.full) },
        rootString: 0,
        rootChecksum: 0x50475342,
        eudcCodePage: 1252,
        padding5: 0,
        signatureSize: 0,
        eudcFlags: 0,
        eudcFontSize: 0,
        fontAt: eot.length - sfnt.length,
        font: sfnt,
      });
      expect([eot[34], eot[35]]).toEqual([0x4c, 0x50]);
      expect(Buffer.from(eot.subarray(80, 80 + 4 + header.family.bytes)).toString("utf16le", 4)).toBe(
        "Space Grotesk\0",
      );
      // The header's checksum is the embedded font's own, and the font sums as an sfnt must.
      expect(header.checkSumAdjustment).toBe(
        dataOf(readSfnt(header.font).tables.get("head") as Uint8Array).getUint32(8),
      );
      expect(sum32(header.font)).toBe(0xb1b0afba);
    }
  });

  it("gives PowerPoint's pitch and family numbers for the deck's faces, as PowerPoint writes its own", () => {
    const facts = (name: string) => factsOf(fontOf(join(playerFonts, name)));
    // PowerPoint's own file: 49 for IBM Plex Mono (fixed pitch, modern), 2 for Instrument Serif (variable, no family).
    expect(pitchFamily(facts("IBMPlexMono-Regular-Latin1.woff2"))).toBe(49);
    expect(pitchFamily(facts("InstrumentSerif-Regular.woff2"))).toBe(2);
    expect(pitchFamily(facts("IBMPlexSans-Regular-Latin1.woff2"))).toBe(34);
    expect(pitchFamily({ fixedPitch: false, panose: Uint8Array.from([2, 2, 5, 3, 0, 0, 0, 0, 0, 0]) })).toBe(
      18,
    );
    expect(pitchFamily({ fixedPitch: false, panose: Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]) })).toBe(
      66,
    );
    expect(pitchFamily({ fixedPitch: false, panose: Uint8Array.from([4, 0, 0, 0, 0, 0, 0, 0, 0, 0]) })).toBe(
      82,
    );
  });
});

describe("choosing the faces to embed", () => {
  it("embeds the faces the slides draw, under the name the font gives itself", () => {
    const fonts = planFonts(
      new Map([["Harbor Sans", use(["regular", "bold"], "Ships")]]),
      new Map([["Harbor Sans", [face("Harbor Sans", harborRegular), face("Harbor Sans", harborBold, 700)]]]),
    );
    expect(fonts.parts.map((part) => part.name)).toEqual([
      "ppt/fonts/font1.fntdata",
      "ppt/fonts/font2.fntdata",
    ]);
    expect(fonts.list).toEqual([
      {
        typeface: "Space Grotesk",
        // Its file gives no PANOSE (all zeros), which PowerPoint leaves out rather than writing.
        panose: "",
        pitchFamily: 2,
        charset: 0,
        faces: [
          { slot: "regular", part: 1 },
          { slot: "bold", part: 2 },
        ],
      },
    ]);
    expect(fonts.rename).toEqual(new Map([["Harbor Sans", "Space Grotesk"]]));
    expect(fonts.report).toEqual([
      {
        family: "Harbor Sans",
        as: "Space Grotesk",
        embedded: ["regular", "bold"],
        notes: [
          'its file names itself "Space Grotesk", which is the name PowerPoint knows it by, so the slides use that name.',
        ],
      },
    ]);
    for (const part of fonts.parts) expect(readEot(part.bytes).family.value).toBe("Space Grotesk");
  });

  it("leaves out a file that is too large, would unpack to a bomb, or has no family name, and goes on", () => {
    const big = join(root, "big.woff2");
    closeSync(openSync(big, "w"));
    truncateSync(big, 33 * 1024 * 1024);
    const nameless = variant(harborRegular, "nameless.ttf", (font) =>
      font.tables.set(
        "name",
        nameTable([{ platform: 3, encoding: 1, language: 0x409, id: 2, text: "Regular" }]),
      ),
    );
    const started = performance.now();
    const fonts = planFonts(
      new Map([
        ["Big", use(["regular"], "abc")],
        ["Bomb", use(["regular"], "abc")],
        ["Points", use(["regular"], "abc")],
        ["Nameless", use(["regular"], "abc")],
        ["Harbor Sans", use(["regular"], "abc")],
      ]),
      new Map([
        ["Big", [face("Big", big)]],
        ["Bomb", [face("Bomb", hostile("bomb-1.woff2"))]],
        ["Points", [face("Points", hostile("points-2.woff2"))]],
        ["Nameless", [face("Nameless", nameless)]],
        ["Harbor Sans", [face("Harbor Sans", harborRegular)]],
      ]),
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    const notes = (family: string) => fonts.report.find((line) => line.family === family);
    expect(notes("Big")).toEqual({
      family: "Big",
      embedded: [],
      notes: ["big.woff2: the file is larger than 32 MB, which no font needs, so it is not embedded."],
    });
    expect(notes("Bomb")?.notes).toEqual([
      "bomb-1.woff2: the WOFF2 data could not be decompressed to the size its tables state, so it is not embedded.",
    ]);
    expect(notes("Points")?.notes).toEqual([
      "points-2.woff2: a WOFF2 glyph has more points than a TrueType glyph may have, so it is not embedded.",
    ]);
    expect(notes("Nameless")).toEqual({
      family: "Nameless",
      embedded: [],
      notes: [
        "nameless.ttf has no family name PowerPoint can read, so it is not embedded and the slides keep the deck's name for it.",
      ],
    });
    expect(fonts.rename.has("Nameless")).toBe(false);
    // The export goes on: the family whose file is sound is embedded.
    expect(fonts.list.map((entry) => entry.typeface)).toEqual(["Space Grotesk"]);
    expect(fonts.parts).toHaveLength(1);
  });

  it("counts a face as embedded only when its own file is in the file", () => {
    const other = variant(harborRegular, "other.ttf", (font) => {
      // The same name inside, a different font: a changed advance width is enough.
      const hmtx = font.tables.get("hmtx") as Uint8Array;
      dataOf(hmtx).setUint16(0, dataOf(hmtx).getUint16(0) + 1);
    });
    const fonts = planFonts(
      new Map([
        ["Harbor Sans", use(["regular"], "a")],
        ["Lookalike", use(["regular"], "a")],
        ["Twin", use(["regular"], "a")],
      ]),
      new Map([
        ["Harbor Sans", [face("Harbor Sans", harborRegular)]],
        ["Lookalike", [face("Lookalike", other)]],
        // The very same file under another name is the same face, and it is in the file.
        ["Twin", [face("Twin", harborRegular)]],
      ]),
    );
    expect(fonts.parts).toHaveLength(1);
    const line = (family: string) => fonts.report.find((entry) => entry.family === family);
    expect(line("Harbor Sans")?.embedded).toEqual(["regular"]);
    expect(line("Lookalike")?.embedded).toEqual([]);
    expect(line("Lookalike")?.notes).toContain(
      'its regular face shares the name "Space Grotesk" with another family\'s file, and PowerPoint keeps one: HarborSans-Regular.woff2, so other.ttf is not embedded.',
    );
    expect(line("Twin")?.embedded).toEqual(["regular"]);
  });

  it("leaves out a face whose file may not be embedded, and says so", () => {
    const restricted = variant(harborRegular, "restricted.ttf", (font) => {
      const os2 = font.tables.get("OS/2") as Uint8Array;
      new DataView(os2.buffer, os2.byteOffset).setUint16(8, 0x0002);
    });
    const fonts = planFonts(
      new Map([["Locked", use(["regular"], "abc")]]),
      new Map([["Locked", [face("Locked", restricted)]]]),
    );
    expect(fonts.parts).toEqual([]);
    expect(fonts.report[0]?.embedded).toEqual([]);
    expect(fonts.report[0]?.notes).toEqual([
      "restricted.ttf says it may not be embedded (OS/2 fsType 2), so it is not; a viewer needs it installed.",
    ]);
  });

  it("embeds a face its file allows for preview and print, and says PowerPoint may open the file read-only", () => {
    const preview = variant(harborRegular, "preview.ttf", (font) => {
      const os2 = font.tables.get("OS/2") as Uint8Array;
      new DataView(os2.buffer, os2.byteOffset).setUint16(8, 0x0004);
    });
    const fonts = planFonts(
      new Map([["Preview", use(["regular"], "abc")]]),
      new Map([["Preview", [face("Preview", preview)]]]),
    );
    expect(fonts.parts).toHaveLength(1);
    expect(fonts.report[0]?.notes[0]).toBe(
      "its files allow embedding for preview and print only, so PowerPoint may open the file read-only.",
    );
  });

  it("leaves out a face with CFF outlines, which PowerPoint does not embed", () => {
    const cff = variant(harborRegular, "cff.otf", (font) => {
      font.flavor = 0x4f54544f;
      font.tables.set("CFF ", new Uint8Array(16));
    });
    const fonts = planFonts(
      new Map([["Curvy", use(["regular"], "abc")]]),
      new Map([["Curvy", [face("Curvy", cff)]]]),
    );
    expect(fonts.parts).toEqual([]);
    expect(fonts.report[0]?.notes).toEqual([
      "cff.otf has CFF outlines, which PowerPoint does not embed, so it is not embedded.",
    ]);
  });

  it("names a family the slides draw that has no file, and a file that is not a font", () => {
    const junk = join(root, "junk.woff2");
    writeFileSync(junk, "not a font");
    const fonts = planFonts(
      new Map([
        ["Nowhere", use(["regular"], "abc")],
        ["Broken", use(["regular"], "abc")],
      ]),
      new Map([["Broken", [face("Broken", junk)]]]),
    );
    expect(fonts.parts).toEqual([]);
    expect(fonts.report).toEqual([
      {
        family: "Broken",
        embedded: [],
        notes: [
          "junk.woff2: the file is not a font this export can read (TrueType, OpenType, WOFF or WOFF2), so it is not embedded.",
        ],
      },
      {
        family: "Nowhere",
        embedded: [],
        notes: ["no font file, so a viewer needs it installed to see it as drawn."],
      },
    ]);
  });

  it("says when a bold the slides draw has no file, and when a file is not the face it stands for", () => {
    const fonts = planFonts(
      new Map([
        ["Plain", use(["regular", "bold"], "abc")],
        ["Posing", use(["bold"], "abc")],
      ]),
      new Map([
        ["Plain", [face("Plain", harborRegular)]],
        // The page loads the regular file as the bold one; PowerPoint would take it for regular.
        ["Posing", [face("Posing", harborRegular), face("Posing", harborRegular, 700)]],
      ]),
    );
    const plain = fonts.report.find((line) => line.family === "Plain");
    expect(plain?.embedded).toEqual(["regular"]);
    expect(plain?.notes).toContain(
      "no bold file, so PowerPoint draws bold text from another face, as the player does.",
    );
    const posing = fonts.report.find((line) => line.family === "Posing");
    expect(posing?.notes).toContain(
      'HarborSans-Regular.woff2 is "Space Grotesk Regular" by its own name, not a bold face of a family, so PowerPoint cannot take it as one and draws bold text from the regular face.',
    );
  });

  it("says which characters a family split into files by script draws from another face", () => {
    const fonts = planFonts(
      new Map([["Split", use(["regular"], "Ab一")]]),
      new Map([
        [
          "Split",
          [
            face("Split", harborRegular, 400, { ranges: [[0, 0xff]] }),
            face("Split", harborRegular, 400, { ranges: [[0x100, 0xffff]], label: "other.woff2" }),
          ],
        ],
      ]),
    );
    expect(fonts.parts).toHaveLength(1);
    expect(fonts.report[0]?.notes).toContain(
      "only HarborSans-Regular.woff2 of its files is embedded for regular; 一 (U+4E00) come from another face.",
    );
  });

  it("makes a family the page draws only in a bold file bold in the slides too", () => {
    const fonts = planFonts(
      new Map([["Display", use(["regular"], "Hi")]]),
      new Map([["Display", [face("Display", harborBold, 700)]]]),
    );
    expect(fonts.boldOnly).toEqual(new Set(["Display"]));
    expect(fonts.list[0]?.faces).toEqual([{ slot: "bold", part: 1 }]);
    const xml =
      '<a:r><a:rPr lang="en-US" sz="1800"><a:latin typeface="Display"/></a:rPr><a:t>Hi</a:t></a:r><a:r><a:rPr lang="en-US" b="0"><a:latin typeface="Other"/></a:rPr><a:t>x</a:t></a:r>';
    const named = applyNames(xml, fonts);
    expect(named).toContain('<a:rPr lang="en-US" sz="1800" b="1"><a:latin typeface="Space Grotesk"/>');
    expect(named).toContain('<a:rPr lang="en-US" b="0"><a:latin typeface="Other"/>');
  });
});

describe("what the slides draw, and the fonts listed in the package", () => {
  it("collects each family's faces and characters from the runs", () => {
    const usage = new Map<string, Usage>();
    scanUsage(
      '<a:r><a:rPr b="1" i="1"><a:latin typeface="Inter"/></a:rPr><a:t>Hi &amp; yo</a:t></a:r><a:r><a:rPr><a:latin typeface="+mn-lt"/></a:rPr><a:t>theme</a:t></a:r>',
      usage,
    );
    expect([...usage.keys()]).toEqual(["Inter"]);
    expect(usage.get("Inter")?.slots).toEqual(new Set(["boldItalic"]));
    expect([...(usage.get("Inter")?.chars ?? [])].map((code) => String.fromCodePoint(code)).sort()).toEqual(
      [..."Hi & yo"].filter((c, i, all) => all.indexOf(c) === i).sort(),
    );
    // A chart draws its numbers and categories from its cache, in the faces it names.
    const chart = new Map<string, Usage>();
    scanUsage('<c:txPr><a:defRPr><a:latin typeface="Mono"/></a:defRPr></c:txPr><c:v>42</c:v>', chart, true);
    expect([...(chart.get("Mono")?.chars ?? [])].map((code) => String.fromCodePoint(code)).sort()).toEqual([
      "2",
      "4",
    ]);
  });

  it("reads a stylesheet's faces, with their ranges", () => {
    expect(parseUnicodeRange("U+0020-007E, U+00A0, U+4??")).toEqual([
      [0x20, 0x7e],
      [0xa0, 0xa0],
      [0x400, 0x4ff],
    ]);
    const css =
      '@font-face { font-family: "Inter"; src: url(Inter-Bold.woff2) format("woff2"); font-weight: 700; font-style: normal; unicode-range: U+0000-00FF; }';
    expect(pairFaces(css, "/fonts")).toEqual([
      {
        family: "Inter",
        weight: 700,
        italic: false,
        file: join("/fonts", "Inter-Bold.woff2"),
        label: "Inter-Bold.woff2",
        ranges: [[0, 0xff]],
      },
    ]);
  });

  it("lists each family in presentation.xml after the notes size, linked and typed", () => {
    const fonts = planFonts(
      new Map([["Harbor Sans", use(["regular", "bold"], "a")]]),
      new Map([["Harbor Sans", [face("Harbor Sans", harborRegular), face("Harbor Sans", harborBold, 700)]]]),
    );
    const listed = listFonts(
      '<p:presentation xmlns:p="p" saveSubsetFonts="1"><p:sldSz cx="1" cy="1"/><p:notesSz cx="2" cy="2"/><p:defaultTextStyle/></p:presentation>',
      '<Relationships xmlns="r"><Relationship Id="rId1" Type="t" Target="slides/slide1.xml"/></Relationships>',
      '<Types xmlns="t"><Default Extension="xml" ContentType="application/xml"/></Types>',
      fonts,
    );
    expect(listed.presentation).toContain('saveSubsetFonts="1" embedTrueTypeFonts="1">');
    // No PANOSE (the file gives none), and the pitch and family PowerPoint writes beside its own embedded fonts.
    expect(listed.presentation).toContain(
      '<p:notesSz cx="2" cy="2"/><p:embeddedFontLst><p:embeddedFont><p:font typeface="Space Grotesk" pitchFamily="2" charset="0"/><p:regular r:id="rIdFont1"/><p:bold r:id="rIdFont2"/></p:embeddedFont></p:embeddedFontLst><p:defaultTextStyle/>',
    );
    // A font that gives a PANOSE has it written.
    const plex = planFonts(
      new Map([["IBM Plex Mono", use(["regular"], "a")]]),
      new Map([
        ["IBM Plex Mono", [face("IBM Plex Mono", join(playerFonts, "IBMPlexMono-Regular-Latin1.woff2"))]],
      ]),
    );
    expect(
      listFonts("<p:presentation><p:notesSz/>", "<Relationships/>", "<Types>", plex).presentation,
    ).toContain(
      '<p:font typeface="IBM Plex Mono" panose="020B0509050203000203" pitchFamily="49" charset="0"/>',
    );
    expect(listed.rels).toContain(
      '<Relationship Id="rIdFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/>',
    );
    expect(listed.rels).toContain('Id="rIdFont2"');
    expect(listed.types).toContain('<Default Extension="fntdata" ContentType="application/x-fontdata"/>');
    // Nothing to embed leaves the package as it was.
    const none = listFonts("<p:presentation>", "<Relationships/>", "<Types>", { parts: [], list: [] });
    expect(none).toEqual({ presentation: "<p:presentation>", rels: "<Relationships/>", types: "<Types>" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Videos.
// ---------------------------------------------------------------------------------------------------------------------

describe("whether a clip can be embedded", () => {
  it("reads an MP4's tracks from its boxes", () => {
    // The picture's shape is the video track's header's, which a clip with no poster is drawn in.
    expect(mp4Tracks(new Uint8Array(readFileSync(tinyMp4)))).toEqual({
      video: ["avc1"],
      audio: ["mp4a"],
      size: { w: 320, h: 180 },
    });
    // A track turned a quarter by its matrix is shown upright: its width and height change places.
    const turned = new Uint8Array(readFileSync(tinyMp4));
    const data = dataOf(turned);
    const tkhd = Buffer.from(turned).indexOf("tkhd", 0, "latin1") + 4;
    const matrix = tkhd + (turned[tkhd] === 1 ? 52 : 40);
    expect(data.getUint32(matrix + 36) / 65536).toBe(320);
    data.setInt32(matrix, 0);
    data.setInt32(matrix + 4, 0x10000);
    data.setInt32(matrix + 12, -0x10000);
    data.setInt32(matrix + 16, 0);
    expect(mp4Tracks(turned)?.size).toEqual({ w: 180, h: 320 });
    expect(mp4Tracks(new TextEncoder().encode("not a video at all"))).toBeUndefined();
  });

  it("embeds an H.264 and AAC MP4 in the deck, and says why anything else is not", () => {
    const folder = join(root, "deck");
    const assets = join(folder, "assets");
    mkdirSync(assets, { recursive: true });
    copyFileSync(tinyMp4, join(assets, "tiny.mp4"));
    writeFileSync(join(assets, "words.mp4"), "words, not a video");
    const bytes = readFileSync(tinyMp4);
    const swap = (from: string, to: string) =>
      Buffer.from(bytes.toString("latin1").replaceAll(from, to), "latin1");
    writeFileSync(join(assets, "hevc.mp4"), swap("avc1", "hvc1"));
    writeFileSync(join(assets, "opus.mp4"), swap("mp4a", "Opus"));

    expect(cannotEmbed(folder, "assets/tiny.mp4")).toBeUndefined();
    expect(cannotEmbed(folder, "https://example.com/clip.mp4")).toBe("it is not a file in the deck");
    expect(cannotEmbed(folder, "assets/clip.webm")).toBe(
      "PowerPoint embeds MP4 (H.264 video, AAC sound) and this is WEBM",
    );
    expect(cannotEmbed(folder, "assets/gone.mp4")).toBe("the file is not in the deck folder");
    expect(cannotEmbed(folder, "assets/words.mp4")).toBe("the file is not a readable MP4");
    expect(cannotEmbed(folder, "assets/hevc.mp4")).toBe("its video is hvc1, not H.264");
    expect(cannotEmbed(folder, "assets/opus.mp4")).toBe("its sound is Opus, not AAC");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The slide master's side: placeholders.
// ---------------------------------------------------------------------------------------------------------------------

const brand = (() => {
  const opened = openDeck(brandDeck);
  if (!opened.ok) throw new Error("The brand fixture does not open.");
  return opened.doc;
})();

const template = (slots: Array<{ id: string; role: string }>) =>
  ({ schemaVersion: "0.4", id: "t", name: "T", slots }) as unknown as Template;

describe("the placeholder a slot becomes", () => {
  it("is typed by the slot's role", () => {
    const chartAndNote = brand.templates?.["chart-and-note"] as Template;
    expect(chartAndNote.slots.map((slot) => placeholderType(slot, chartAndNote))).toEqual([
      "title",
      "obj",
      "body",
    ]);
    const cover = brand.templates?.cover as Template;
    expect(cover.slots.map((slot) => placeholderType(slot, cover))).toEqual(["body", "title", "subTitle"]);
    const every = template(
      ["title", "subtitle", "body", "picture", "chart", "table", "content", "claim"].map((role) => ({
        id: role,
        role,
      })),
    );
    expect(every.slots.map((slot) => placeholderType(slot, every))).toEqual([
      "title",
      "subTitle",
      "body",
      "pic",
      "chart",
      "tbl",
      "obj",
      // A layout has one title, so a claim beside a title slot is a body.
      "body",
    ]);
    const claimOnly = template([{ id: "claim", role: "claim" }]);
    expect(placeholderType(claimOnly.slots[0] as Template["slots"][number], claimOnly)).toBe("title");
    // A layout has one title: the first title slot, or the first claim slot when no slot is a title.
    const twoTitles = template([
      { id: "claim", role: "claim" },
      { id: "first", role: "title" },
      { id: "second", role: "title" },
    ]);
    expect(twoTitles.slots.map((slot) => placeholderType(slot, twoTitles))).toEqual([
      "body",
      "title",
      "body",
    ]);
    const twoClaims = template([
      { id: "one", role: "claim" },
      { id: "two", role: "claim" },
    ]);
    expect(twoClaims.slots.map((slot) => placeholderType(slot, twoClaims))).toEqual(["title", "body"]);
  });

  it("is filled by the first block in its slot, and by the claim in a claim slot", () => {
    const growth = brand.scenes.growth as Scene;
    expect(firstInSlots(growth, brand.templates?.["chart-and-note"] as Template)).toEqual(
      new Map([
        ["title", "growth-title"],
        ["chart", "growth-chart"],
        ["note", "growth-note"],
      ]),
    );
    const claimed = {
      ...growth,
      summary: { id: "growth-claim", text: "Ships rose." },
      blocks: [
        {
          id: "pinned",
          type: "text",
          role: "body",
          text: "Pinned.",
          slot: "note",
          frame: { x: 5, y: 5, w: 20, h: 20 },
        },
        { id: "first", type: "text", role: "body", text: "First.", slot: "note" },
        { id: "second", type: "text", role: "body", text: "Second.", slot: "note" },
      ],
    } as unknown as Scene;
    expect(
      firstInSlots(
        claimed,
        template([
          { id: "claim", role: "claim" },
          { id: "note", role: "body" },
        ]),
      ),
    ).toEqual(
      new Map([
        ["claim", "growth-claim"],
        ["note", "first"],
      ]),
    );
  });

  it("is tied to the slide's shape of the block's name, with grouping locked as PowerPoint does", () => {
    const xml = [
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="heading"></p:cNvPr><p:cNvSpPr/><p:nvPr></p:nvPr></p:nvSpPr></p:sp>',
      '<p:pic><p:nvPicPr><p:cNvPr id="3" name="photo" descr="A harbor."/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr></p:pic>',
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr></p:graphicFrame>',
      '<p:sp><p:nvSpPr><p:cNvPr id="5" name="heading"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr></p:sp>',
    ].join("");
    let linked = linkShape(xml, "heading", 'type="title"');
    linked = linkShape(linked, "photo", 'type="pic" idx="14"');
    linked = linkShape(linked, "chart", 'idx="15"');
    expect(linked).toContain(
      '<p:cNvPr id="2" name="heading"></p:cNvPr><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr>',
    );
    expect(linked).toContain(
      '<a:picLocks noGrp="1" noChangeAspect="1"/></p:cNvPicPr><p:nvPr><p:ph type="pic" idx="14"/></p:nvPr>',
    );
    expect(linked).toContain(
      '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr><p:ph idx="15"/></p:nvPr>',
    );
    // Only the first shape of that name: a second one stays as it was.
    expect(linked).toContain('<p:cNvPr id="5" name="heading"/><p:cNvSpPr/><p:nvPr/>');
    expect(linkShape(xml, "nothing", 'type="title"')).toBe(xml);
  });

  it("describes a shape once, with the words escaped", () => {
    const xml = '<p:cNvPr id="7" name="clip &amp; more"/>';
    const described = describeShape(xml, "clip & more", 'The "opening" <clip>');
    expect(described).toBe(
      '<p:cNvPr id="7" name="clip &amp; more" descr="The &quot;opening&quot; &lt;clip&gt;"/>',
    );
    expect(describeShape(described, "clip & more", "again")).toBe(described);
  });

  it("empties the description the writer gave a decorative picture, and only that shape's", () => {
    const xml =
      '<p:cNvPr id="3" name="sea" descr="preencoded.png"><a:hlinkClick/></p:cNvPr><p:cNvPr id="4" name="photo" descr="preencoded.png">';
    const emptied = describeShape(xml, "sea", "");
    expect(emptied).toBe(
      '<p:cNvPr id="3" name="sea" descr=""><a:hlinkClick/></p:cNvPr><p:cNvPr id="4" name="photo" descr="preencoded.png">',
    );
    expect(describeShape(emptied, "sea", "")).toBe(emptied);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------------------------------------------------

describe("content past the slide's edge", () => {
  const past = (beyond: SlideMeasure["beyond"]) => overflow({ beyond } as SlideMeasure);

  it("is said for every edge it crosses, in the order bottom, right, left, top", () => {
    expect(past({ right: 0, bottom: 0 })).toBeUndefined();
    // A pixel is rounding, not content.
    expect(past({ left: 1, top: 1, right: 1, bottom: 1 })).toBeUndefined();
    expect(past({ right: 0, bottom: 195.4 })).toBe("195px past the slide in the player too, at the bottom");
    expect(past({ left: 10, top: 0, right: 30.6, bottom: 0 })).toBe(
      "31px past the slide in the player too, at the right, and 10px at the left",
    );
    expect(past({ left: 4, top: 6, right: 8, bottom: 2 })).toBe(
      "2px past the slide in the player too, at the bottom, and 8px at the right, and 4px at the left, and 6px at the top",
    );
  });
});

describe("where the PowerPoint file may go", () => {
  it("is never inside the deck folder: the export refuses with out-in-deck before anything runs", async () => {
    const deck = join(root, "deck");
    cpSync(brandDeck, deck, { recursive: true });
    for (const out of [join(deck, "deck.pptx"), join(deck, "scenes", "deck.pptx")]) {
      const lines: string[] = [];
      const code = await run(["export", deck, "--format", "pptx", "--out", out, "--json"], {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      });
      expect(code).toBe(2);
      expect(JSON.parse(lines.join("\n"))).toEqual({
        ok: false,
        code: "out-in-deck",
        message: `${out} is inside the deck folder. Pick a place outside it for --out.`,
      });
      expect(existsSync(out)).toBe(false);
    }
  });

  it("is named in the live server's download as RFC 8187 asks, every reserved character escaped", () => {
    expect(extValue("it's (a) deck*")).toBe("it%27s%20%28a%29%20deck%2A");
    expect(extValue("Überblick 2026")).toBe("%C3%9Cberblick%202026");
  });
});

describe("the folder export's summary", () => {
  it("lists the brand files it copied", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const out = join(root, "brand-export");
    const code = await run(["export", brandDeck, "--out", out], {
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    });
    expect(code, errors.join("\n")).toBe(0);
    expect(lines).toContain(
      "  brand files: brand/fonts/HarborSans-Bold.woff2, brand/fonts/HarborSans-Regular.woff2, brand/logos/harbor.svg",
    );
  });
});
