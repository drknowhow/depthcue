import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  planFonts,
  type Slot,
  scanUsage,
  type Usage,
} from "../src/pptx/fonts.ts";
import { describeShape, firstInSlots, linkShape, placeholderType } from "../src/pptx/master.ts";
import type { SlideMeasure } from "../src/pptx/measure.ts";
import { cannotEmbed, mp4Tracks } from "../src/pptx/media.ts";
import { factsOf, fontKind, readSfnt, type Sfnt, unpackFont, writeSfnt } from "../src/pptx/sfnt.ts";

/**
 * The parts of the PowerPoint extras that need no browser: reading a font and wrapping it as PowerPoint embeds one,
 * choosing which faces go in and saying why the rest do not, reading an MP4's tracks, the placeholder each slot becomes
 * and how a slide's shape is tied to it, and the words for content past the slide's edge.
 */

const brandDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const harborRegular = join(brandDeck, "brand", "fonts", "HarborSans-Regular.woff2");
const harborBold = join(brandDeck, "brand", "fonts", "HarborSans-Bold.woff2");
const tinyMp4 = fileURLToPath(new URL("./fixtures/tiny.mp4", import.meta.url));

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
  });

  it("is wrapped as an EOT 2.2 with its names in the header and the font after it, unchanged", () => {
    const font = fontOf(harborRegular);
    const sfnt = writeSfnt(font);
    const facts = factsOf(font);
    const eot = eotOf(sfnt, facts);
    const header = readEot(eot);
    expect(header.magic).toBe(0x504c);
    expect([eot[34], eot[35]]).toEqual([0x4c, 0x50]);
    expect(header.version).toBe(0x00020002);
    expect(header.flags).toBe(0);
    expect(header.size).toBe(eot.length);
    expect(header.fontSize).toBe(sfnt.length);
    expect(header.fsType).toBe(facts.fsType);
    expect(header.family).toBe("Space Grotesk");
    expect(header.style).toBe("Regular");
    expect(header.font).toEqual(sfnt);
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
        panose: expect.stringMatching(/^[0-9A-F]{20}$/),
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
    for (const part of fonts.parts) expect(readEot(part.bytes).family).toBe("Space Grotesk");
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
    expect(listed.presentation).toMatch(
      /<p:notesSz cx="2" cy="2"\/><p:embeddedFontLst><p:embeddedFont><p:font typeface="Space Grotesk" panose="[0-9A-F]{20}" charset="0"\/><p:regular r:id="rIdFont1"\/><p:bold r:id="rIdFont2"\/><\/p:embeddedFont><\/p:embeddedFontLst><p:defaultTextStyle\/>/,
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
    expect(mp4Tracks(new Uint8Array(readFileSync(tinyMp4)))).toEqual({ video: ["avc1"], audio: ["mp4a"] });
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
