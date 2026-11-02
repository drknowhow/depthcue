import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseText, styleOf } from "@depthcue/core";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { run } from "../src/index.ts";
import { buildPresentation } from "../src/pptx/build.ts";
import type { Box, Ink, Item, SlideMeasure, TextPlace } from "../src/pptx/measure.ts";
import { finishPackage, inspectOutput, MARKER_NAME, MARKER_PART } from "../src/pptx/package.ts";
import { flowRuns, inch, plainRuns, pt, type RunContext, textFrame } from "../src/pptx/text.ts";

const v01 = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const decode = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

async function partsOf(bytes: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) parts.set(name, await entry.async("string"));
  }
  return parts;
}

const part = (parts: Map<string, string>, name: string): string => {
  const found = parts.get(name);
  if (found === undefined) throw new Error(`The file has no ${name}.`);
  return found;
};

/** The words in a part, one entry per `<a:t>`. */
const wordsIn = (xml: string) =>
  [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decode(match[1] as string));

// ---------------------------------------------------------------------------------------------------------------------
// The package step: the same bytes for the same deck, and a mark that says whose file it is.
// ---------------------------------------------------------------------------------------------------------------------

/** What the writer makes for a slide with the things the package step has to tidy. */
async function sample(): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  const slide = pptx.addSlide();
  const face = { fontFace: "Inter", fontSize: 18, color: "14161B" };
  slide.addText(
    [
      { text: "Orders ", options: { ...face, lang: "en~caps", bold: true } },
      { text: "grew", options: { ...face, lang: "en~caps", breakLine: true } },
      { text: "first", options: { ...face, lang: "en~bu=A8341A", bullet: { indent: 14 }, breakLine: true } },
      { text: "second", options: { ...face, lang: "en", bullet: { type: "number", indent: 14 } } },
    ],
    { x: 1, y: 0.5, w: 6, h: 2, objectName: "words" },
  );
  slide.addTable(
    [
      [{ text: "A" }, { text: "B" }],
      [{ text: "1" }, { text: "2" }],
    ],
    { x: 1, y: 3, w: 4, colW: [2, 2], objectName: "with-header" },
  );
  slide.addTable([[{ text: "C" }]], { x: 6, y: 3, w: 2, colW: [2], objectName: "without-header" });
  slide.addChart(pptx.ChartType.bar, [{ name: "Orders", labels: ["Q1", "Q2"], values: [4, 5] }], {
    x: 1,
    y: 5,
    w: 4,
    h: 2,
    objectName: "chart",
  });
  slide.addNotes("Say this slowly.");
  return (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array;
}

const HINTS = { headers: [["with-header"]] };

describe("the package step", () => {
  it("gives the same bytes whatever the time, though the writer stamps the time on everything", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2021-03-04T05:06:07Z"));
    const rawA = await sample();
    vi.setSystemTime(new Date("2029-11-12T13:14:15Z"));
    const rawB = await sample();
    vi.useRealTimers();
    // The check is only worth something if the writer's own output does differ.
    expect(Buffer.compare(Buffer.from(rawA), Buffer.from(rawB))).not.toBe(0);

    const a = await finishPackage(rawA, HINTS);
    const b = await finishPackage(rawB, HINTS);
    expect(Buffer.compare(a, b)).toBe(0);
    const parts = await partsOf(a);
    expect(part(parts, "docProps/core.xml")).toContain("2000-01-01T00:00:00Z");
    expect(part(parts, "docProps/core.xml")).not.toMatch(/202[19]-/);
  });

  it("lists the parts in a fixed order, the content types first", async () => {
    const zip = await JSZip.loadAsync(await finishPackage(await sample(), HINTS));
    const names = Object.keys(zip.files);
    expect(names.slice(0, 2)).toEqual(["[Content_Types].xml", "_rels/.rels"]);
    const rest = names.slice(2);
    expect(rest).toEqual([...rest].sort());
  });

  it("marks the file as Depthcue's, and the content types and relationships name the mark", async () => {
    const parts = await partsOf(await finishPackage(await sample(), HINTS));
    expect(part(parts, MARKER_PART)).toMatch(
      new RegExp(`name="${MARKER_NAME}"[^>]*><vt:lpwstr>v1:[0-9a-f]{64}</vt:lpwstr>`),
    );
    expect(part(parts, "[Content_Types].xml")).toContain(`PartName="/${MARKER_PART}"`);
    expect(part(parts, "_rels/.rels")).toContain(`Target="${MARKER_PART}"`);
  });

  it("keeps one paragraph-properties element per paragraph", async () => {
    const parts = await partsOf(await finishPackage(await sample(), HINTS));
    const slide = part(parts, "ppt/slides/slide1.xml");
    const paragraphs = [...slide.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) => match[1] as string);
    expect(paragraphs.length).toBeGreaterThan(3);
    for (const paragraph of paragraphs) {
      expect(paragraph.match(/<a:pPr\b/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("turns the capitals mark into all caps and leaves no mark behind", async () => {
    const slide = part(await partsOf(await finishPackage(await sample(), HINTS)), "ppt/slides/slide1.xml");
    expect(slide).toContain('cap="all"');
    expect(slide).not.toContain("~caps");
    expect(slide).not.toContain("~bu=");
    expect(slide).toContain("Orders ");
  });

  it("gives a bullet its own color and a numbered item the text's face", async () => {
    const slide = part(await partsOf(await finishPackage(await sample(), HINTS)), "ppt/slides/slide1.xml");
    expect(slide).toContain('<a:buClr><a:srgbClr val="A8341A"/></a:buClr><a:buSzPct');
    expect(slide).toContain("<a:buFontTx/>");
    expect(slide).not.toContain('<a:buFont typeface="+mj-lt"/>');
  });

  it("sets Header Row on the tables the hints name and on no other", async () => {
    const slide = part(await partsOf(await finishPackage(await sample(), HINTS)), "ppt/slides/slide1.xml");
    const frames = slide.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? [];
    const withHeader = frames.find((frame) => frame.includes('name="with-header"')) as string;
    const without = frames.find((frame) => frame.includes('name="without-header"')) as string;
    expect(withHeader).toContain('<a:tblPr firstRow="1"/>');
    expect(without).not.toContain("firstRow");
  });

  it("gives a doughnut's default label style the chart's own face, so the file names no face the deck lacks", async () => {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    pptx
      .addSlide()
      .addChart(pptx.ChartType.doughnut, [{ name: "Orders", labels: ["a", "b"], values: [1, 2] }], {
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        showPercent: true,
        dataLabelFontFace: "IBM Plex Mono",
        showLegend: true,
        legendFontFace: "IBM Plex Mono",
      });
    const raw = (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array;
    const before = [...(await partsOf(raw)).entries()].find(([name]) =>
      /^ppt\/charts\/chart\d+\.xml$/.test(name),
    );
    expect(before?.[1]).toContain('<a:latin typeface="Arial"/>');
    const after = part(await partsOf(await finishPackage(raw)), "ppt/charts/chart1.xml");
    expect(after).not.toContain("Arial");
    expect(after).toContain('<a:latin typeface="IBM Plex Mono"/>');
  });

  it("keeps the parts that are not slides as the writer made them", async () => {
    const raw = await sample();
    const before = await partsOf(raw);
    const after = await partsOf(await finishPackage(raw, HINTS));
    for (const name of ["ppt/presentation.xml", "ppt/notesSlides/notesSlide1.xml"]) {
      expect(after.get(name)).toBe(before.get(name));
    }
    // The chart is the writer's, though renumbered: its counter lives as long as the process, so it may not be the first.
    const written = [...before.keys()].find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)) as string;
    expect(after.get("ppt/charts/chart1.xml")).toBe(before.get(written));
  });

  it("numbers the charts from 1 whatever the writer's counter says, in the names that refer to them too", async () => {
    // Make one chart first so the writer is past its first, whichever tests ran before.
    await sample();
    const raw = await sample();
    const names = [...(await partsOf(raw)).keys()];
    const made = names.find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)) as string;
    expect(made).not.toBe("ppt/charts/chart1.xml");

    const parts = await partsOf(await finishPackage(raw, HINTS));
    expect([...parts.keys()].filter((name) => /chart\d+|Worksheet\d+/.test(name)).sort()).toEqual([
      "ppt/charts/_rels/chart1.xml.rels",
      "ppt/charts/chart1.xml",
      "ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx",
    ]);
    expect(part(parts, "ppt/slides/_rels/slide1.xml.rels")).toContain('Target="/ppt/charts/chart1.xml"');
    expect(part(parts, "ppt/charts/_rels/chart1.xml.rels")).toContain("Microsoft_Excel_Worksheet1.xlsx");
    expect(part(parts, "[Content_Types].xml")).toContain('PartName="/ppt/charts/chart1.xml"');
    expect(part(parts, "[Content_Types].xml")).not.toContain(made.replace("ppt/charts/", ""));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// What the writer gets wrong, which the package step puts right.
// ---------------------------------------------------------------------------------------------------------------------

/** What XML 1.0 cannot hold, whatever the escaping. */
function forbidden(xml: string): boolean {
  return [...xml].some((character) => {
    const code = character.codePointAt(0) as number;
    return code < 0x20 ? ![0x9, 0xa, 0xd].includes(code) : code === 0xfffe || code === 0xffff;
  });
}

async function rawDeck(build: (pptx: PptxGenJS) => void): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  build(pptx);
  return (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array;
}

const xmlParts = (parts: Map<string, string>) =>
  [...parts.entries()].filter(([name]) => /\.(xml|rels)$/.test(name));

/** The parts of the workbook behind the first chart, as text. */
async function workbookOf(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const name = Object.keys(zip.files).find((candidate) => candidate.endsWith(".xlsx"));
  const entry = name === undefined ? undefined : zip.file(name);
  if (!entry) throw new Error("The file has no chart workbook.");
  return partsOf(await entry.async("uint8array"));
}

/** The first chart, whatever number the writer's counter gave it. */
function chartIn(parts: Map<string, string>): string {
  const name = [...parts.keys()].find((candidate) => /^ppt\/charts\/chart\d+\.xml$/.test(candidate));
  return part(parts, name ?? "ppt/charts/chart.xml");
}

describe("the package step puts right what the writer gets wrong", () => {
  it("leaves no character XML forbids in any part, the workbook behind a chart included", async () => {
    const dirty = "Bell\u0007 tab\u000b form\u000c low\u0001 end￾";
    const raw = await rawDeck((pptx) => {
      pptx.title = dirty;
      const slide = pptx.addSlide();
      slide.addText(dirty, { x: 1, y: 1, w: 5, h: 1 });
      slide.addTable([[{ text: dirty }]], { x: 1, y: 3, w: 4, colW: [4] });
      slide.addChart(pptx.ChartType.bar, [{ name: dirty, labels: ["a", dirty], values: [1, 2] }], {
        x: 1,
        y: 5,
        w: 4,
        h: 2,
      });
      slide.addNotes(dirty);
    });
    // The writer puts them in as they are, so this is worth checking.
    expect(xmlParts(await partsOf(raw)).filter(([, xml]) => forbidden(xml)).length).toBeGreaterThan(3);
    expect(xmlParts(await workbookOf(raw)).filter(([, xml]) => forbidden(xml)).length).toBeGreaterThan(0);

    const finished = await finishPackage(raw);
    for (const [name, xml] of xmlParts(await partsOf(finished))) expect(forbidden(xml), name).toBe(false);
    for (const [name, xml] of xmlParts(await workbookOf(finished))) expect(forbidden(xml), name).toBe(false);
    // The words around them stay.
    const slide = part(await partsOf(finished), "ppt/slides/slide1.xml");
    expect(wordsIn(slide)).toContain("Bell tab form low end");
  });

  it("numbers the shapes of a slide from 2 after the slide's own group, none twice", async () => {
    const ids = (xml: string) => [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => Number(match[1]));
    const raw = await sample();
    const written = ids(part(await partsOf(raw), "ppt/slides/slide1.xml"));
    // The writer numbers a table from a sum that lands on another shape's number.
    expect(new Set(written).size).toBeLessThan(written.length);

    const finished = ids(part(await partsOf(await finishPackage(raw, HINTS)), "ppt/slides/slide1.xml"));
    expect(finished).toEqual(finished.map((_id, at) => at + 1));
    expect(finished.length).toBeGreaterThan(4);
  });

  it("takes the bullet and capitals marks from a run's language and from nowhere else", async () => {
    const raw = await rawDeck((pptx) => {
      pptx.addSlide().addText(
        [
          {
            text: 'Typed as ~bu=123456 and ~caps and lang="en~bu=654321"',
            options: { lang: "en~bu=A8341A", bullet: { indent: 14 } },
          },
        ],
        { x: 1, y: 1, w: 6, h: 1 },
      );
    });
    const slide = part(await partsOf(await finishPackage(raw)), "ppt/slides/slide1.xml");
    expect(wordsIn(slide)).toEqual(['Typed as ~bu=123456 and ~caps and lang="en~bu=654321"']);
    expect(slide).toContain('<a:buClr><a:srgbClr val="A8341A"/></a:buClr>');
    expect(slide.match(/<a:buClr>/g)).toHaveLength(1);
    expect(slide).not.toContain('lang="en~bu');
  });

  it("changes only the Arial the writer chooses for itself, and not one the deck chose", async () => {
    const raw = await rawDeck((pptx) => {
      const slide = pptx.addSlide();
      slide.addChart(pptx.ChartType.bar, [{ name: "Orders", labels: ["Q1", "Q2"], values: [4, 5] }], {
        x: 1,
        y: 1,
        w: 4,
        h: 3,
        catAxisLabelFontFace: "Arial",
        valAxisLabelFontFace: "Inter",
        dataLabelFontFace: "Inter",
        legendFontFace: "Inter",
      });
    });
    const chart = part(await partsOf(await finishPackage(raw)), "ppt/charts/chart1.xml");
    const category = /<c:catAx>[\s\S]*?<\/c:catAx>/.exec(chart)?.[0] ?? "";
    expect(category).toContain('<a:latin typeface="Arial"/>');
    const value = /<c:valAx>[\s\S]*?<\/c:valAx>/.exec(chart)?.[0] ?? "";
    expect(value).toContain('<a:latin typeface="Inter"/>');
  });

  it("keeps each line of the speaker notes as a paragraph of its own", async () => {
    const raw = await rawDeck((pptx) => {
      pptx.addSlide().addNotes("First line.\nSecond line.\n\nFourth, after a blank.");
    });
    // The writer puts them all in one run, joined by carriage return and line feed.
    expect(part(await partsOf(raw), "ppt/notesSlides/notesSlide1.xml")).toMatch(
      /<a:t>First line\.\r\nSecond line\.\r\n\r\nFourth, after a blank\.<\/a:t>/,
    );

    const notes = part(await partsOf(await finishPackage(raw)), "ppt/notesSlides/notesSlide1.xml");
    const body = /name="Notes Placeholder 2"[\s\S]*?<\/p:sp>/.exec(notes)?.[0] ?? "";
    const paragraphs = [...body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) =>
      wordsIn(match[1] as string).join(""),
    );
    expect(paragraphs).toEqual(["First line.", "Second line.", "", "Fourth, after a blank."]);
    expect(notes).not.toMatch(/<a:t>[^<]*\r/);
  });

  it("leaves a gap where a chart's cell is empty: no point in the chart, no value in the workbook", async () => {
    const raw = await rawDeck((pptx) => {
      pptx.addSlide().addChart(
        pptx.ChartType.line,
        [
          { name: "Orders", labels: ["Q1", "Q2", "Q3", "Q4"], values: [4, null as unknown as number, 6, 7] },
          { name: "Returns", labels: ["Q1", "Q2", "Q3", "Q4"], values: [1, 2, 3, 4] },
        ],
        { x: 1, y: 1, w: 5, h: 3, displayBlanksAs: "gap" },
      );
    });
    // What the writer makes of it: a point with no value, and an empty value in the workbook.
    expect(chartIn(await partsOf(raw))).toContain('<c:pt idx="1"><c:v></c:v></c:pt>');
    expect(part(await workbookOf(raw), "xl/worksheets/sheet1.xml")).toContain('<c r="B3"><v></v></c>');

    const finished = await finishPackage(raw);
    const chart = part(await partsOf(finished), "ppt/charts/chart1.xml");
    expect(chart).toContain('<c:dispBlanksAs val="gap"/>');
    const orders = /<c:val>[\s\S]*?<\/c:val>/.exec(chart)?.[0] ?? "";
    expect(orders).toContain('<c:ptCount val="4"/>');
    expect([...orders.matchAll(/<c:pt idx="(\d+)">/g)].map((match) => match[1])).toEqual(["0", "2", "3"]);
    expect(chart).not.toContain("<c:v></c:v>");
    // The other series, and the names of the categories, are as they were.
    expect(chart.match(/<c:pt idx="\d+"><c:v>\d<\/c:v><\/c:pt>/g)?.length).toBe(3 + 4);

    const sheet = part(await workbookOf(finished), "xl/worksheets/sheet1.xml");
    expect(sheet).not.toMatch(/<c r="B3"/);
    for (const cell of ["B2", "B4", "B5", "C2", "C3", "C4", "C5"]) expect(sheet).toContain(`<c r="${cell}"`);
  });

  it("leaves a gap in a scatter too, where the workbook would hold an empty value", async () => {
    const raw = await rawDeck((pptx) => {
      pptx.addSlide().addChart(
        pptx.ChartType.scatter,
        [
          { name: "Length", values: [1, 2, 3] },
          { name: "Weight", values: [5, null as unknown as number, 9] },
        ],
        { x: 1, y: 1, w: 5, h: 3, displayBlanksAs: "gap" },
      );
    });
    const finished = await finishPackage(raw);
    const chart = part(await partsOf(finished), "ppt/charts/chart1.xml");
    const weights = /<c:yVal>[\s\S]*?<\/c:yVal>/.exec(chart)?.[0] ?? "";
    expect([...weights.matchAll(/<c:pt idx="(\d+)">/g)].map((match) => match[1])).toEqual(["0", "2"]);
    const sheet = part(await workbookOf(finished), "xl/worksheets/sheet1.xml");
    expect(sheet).not.toMatch(/<c r="B3"/);
    expect(sheet).toContain('<c r="B2"');
    expect(sheet).toContain('<c r="B4"');
  });
});

describe("what is at the output path", () => {
  const file = () => join(root, "deck.pptx");

  it("is absent when there is nothing there", async () => {
    expect(await inspectOutput(file())).toBe("absent");
  });

  it("is ours when Depthcue wrote it and nobody has changed it", async () => {
    writeFileSync(file(), await finishPackage(await sample(), HINTS));
    expect(await inspectOutput(file())).toBe("ours");
  });

  it("is edited when a part has changed, as it does when someone saves it in PowerPoint", async () => {
    const zip = await JSZip.loadAsync(await finishPackage(await sample(), HINTS));
    const slide = await (zip.file("ppt/slides/slide1.xml") as JSZip.JSZipObject).async("string");
    zip.file("ppt/slides/slide1.xml", slide.replace("Orders ", "Orders, edited "));
    writeFileSync(file(), await zip.generateAsync({ type: "nodebuffer" }));
    expect(await inspectOutput(file())).toBe("edited");
  });

  it("is edited when a part has been added", async () => {
    const zip = await JSZip.loadAsync(await finishPackage(await sample(), HINTS));
    zip.file("ppt/extra.xml", "<extra/>");
    writeFileSync(file(), await zip.generateAsync({ type: "nodebuffer" }));
    expect(await inspectOutput(file())).toBe("edited");
  });

  it("is foreign when the writer made it and Depthcue did not mark it", async () => {
    writeFileSync(file(), await sample());
    expect(await inspectOutput(file())).toBe("foreign");
  });

  it("is foreign when it is not a zip, or is empty", async () => {
    writeFileSync(file(), "a letter to the board");
    expect(await inspectOutput(file())).toBe("foreign");
    writeFileSync(file(), "");
    expect(await inspectOutput(file())).toBe("foreign");
  });

  it("is foreign when the mark is not one of ours", async () => {
    const zip = await JSZip.loadAsync(await finishPackage(await sample(), HINTS));
    zip.file(MARKER_PART, "<Properties/>");
    writeFileSync(file(), await zip.generateAsync({ type: "nodebuffer" }));
    expect(await inspectOutput(file())).toBe("foreign");
  });

  describe("how much of the file is unpacked to tell", () => {
    /** The names of the parts unpacked while `look` runs. */
    async function unpackedWhile(look: () => Promise<unknown>): Promise<string[]> {
      const prototype = Object.getPrototypeOf(new JSZip().file("probe", "x").file("probe"));
      const original = prototype.async as (this: { name: string }, ...args: unknown[]) => unknown;
      const unpacked: string[] = [];
      vi.spyOn(prototype, "async").mockImplementation(function (this: { name: string }, ...args: unknown[]) {
        unpacked.push(this.name);
        return original.apply(this, args);
      });
      await look();
      return unpacked;
    }

    it("is none of it for a big file that is not ours, whose mark is looked for first", async () => {
      const zip = new JSZip();
      zip.file("ppt/slides/slide1.xml", "<sld/>");
      zip.file("ppt/media/big.bin", Buffer.alloc(2_000_000, 7));
      writeFileSync(file(), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
      let found: string | undefined;
      const unpacked = await unpackedWhile(async () => {
        found = await inspectOutput(file());
      });
      expect(found).toBe("foreign");
      expect(unpacked).toEqual([]);
    });

    it("is the mark first, and then the rest, for a file that has one", async () => {
      writeFileSync(file(), await finishPackage(await sample(), HINTS));
      let found: string | undefined;
      const unpacked = await unpackedWhile(async () => {
        found = await inspectOutput(file());
      });
      expect(found).toBe("ours");
      expect(unpacked[0]).toBe(MARKER_PART);
      expect(unpacked.length).toBeGreaterThan(5);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Text as runs.
// ---------------------------------------------------------------------------------------------------------------------

const ink = (over: Partial<Ink> = {}): Ink => ({
  family: "Inter",
  px: 24,
  weight: 400,
  italic: false,
  color: "4B505B",
  align: "left",
  lineHeight: 36,
  natural: 36,
  spacing: 0,
  caps: false,
  ...over,
});

const context: RunContext = {
  tones: { action: "A8341A", evidence: "1F4FD1" },
  link: "1F4FD1",
  language: "en",
};

const place = (box: Box, over: Partial<TextPlace> = {}): TextPlace => ({
  text: "",
  box,
  inset: { t: 0, r: 0, b: 0, l: 0 },
  ink: ink(),
  ...over,
});

describe("text as runs", () => {
  it("counts a pixel as three quarters of a point and ninety-six to the inch", () => {
    expect(pt(16)).toBe(12);
    expect(pt(18.5)).toBe(13.88);
    expect(inch(96)).toBe(1);
  });

  it("breaks the line at a vertical tab, as at a new line, because XML cannot hold the character", () => {
    const runs = flowRuns(
      [{ type: "paragraph", children: [{ type: "text", text: "one\u000btwo\nthree" }] }],
      ink(),
      context,
    );
    expect(runs.map((run) => run.text)).toEqual(["one", "two", "three"]);
    expect(runs.map((run) => run.options?.softBreakBefore)).toEqual([undefined, true, true]);
  });

  it("carries bold, italic, a link and a tone as the run's own options", () => {
    const flow = parseText(
      "Orders **grew** *fast* in [channel B]{action}, see [the report](https://example.com/q3).",
      {
        lists: true,
      },
    );
    const runs = flowRuns(flow, ink(), context);
    const byText = Object.fromEntries(runs.map((run) => [run.text, run.options ?? {}]));
    expect(runs.map((run) => run.text).join("")).toBe("Orders grew fast in channel B, see the report.");
    expect(byText.grew).toMatchObject({ bold: true });
    expect(byText.fast).toMatchObject({ italic: true });
    expect(byText["channel B"]).toMatchObject({ color: "A8341A" });
    expect(byText["the report"]).toMatchObject({
      color: "1F4FD1",
      hyperlink: { url: "https://example.com/q3" },
    });
    expect(byText["Orders "]).toMatchObject({ fontFace: "Inter", fontSize: 18, color: "4B505B", lang: "en" });
    expect(byText["Orders "]).not.toHaveProperty("bold");
  });

  it("nests marks, so a bold word in a link is both", () => {
    const flow = parseText("[the **big** report](https://example.com)", { lists: true });
    const runs = flowRuns(flow, ink(), context);
    expect(runs.map((run) => run.text)).toEqual(["the ", "big", " report"]);
    expect(runs[1]?.options).toMatchObject({ bold: true, hyperlink: { url: "https://example.com" } });
    expect(runs[0]?.options).toMatchObject({ hyperlink: { url: "https://example.com" } });
  });

  it("sets exact line spacing from the page's line height, once per paragraph, with the gaps the stylesheet leaves", () => {
    const flow = parseText("One\n- a\n- b\nTwo", { lists: true });
    const runs = flowRuns(flow, ink({ lineHeight: 30 }), context);
    expect(runs.map((run) => run.text)).toEqual(["One", "a", "b", "Two"]);
    expect(runs.map((run) => run.options?.lineSpacing)).toEqual([22.5, 22.5, 22.5, 22.5]);
    const before = runs.map((run) => run.options?.paraSpaceBefore);
    expect(before[0]).toBeUndefined();
    // A list starts after a paragraph's gap, and its items are closer together than that.
    expect(before[1]).toBeGreaterThan(before[2] as number);
    expect(before[2]).toBeGreaterThan(0);
    expect(before[3]).toBe(before[1]);
  });

  it("ends every paragraph but the last, so the writer knows where each stops", () => {
    const runs = flowRuns(parseText("One\n- a\n- b\nTwo", { lists: true }), ink(), context);
    expect(runs.map((run) => run.options?.breakLine === true)).toEqual([true, true, true, false]);
  });

  it("makes a list item its own paragraph with a bullet or a number that counts up from the start", () => {
    const flow = parseText("Two things:\n- returns count\n- one count\n3. late\n4. later", { lists: true });
    const runs = flowRuns(flow, ink(), context);
    expect(runs.map((run) => run.text)).toEqual([
      "Two things:",
      "returns count",
      "one count",
      "late",
      "later",
    ]);
    const bullets = runs.map((run) => run.options?.bullet);
    expect(bullets[0]).toBeUndefined();
    expect(bullets[1]).toMatchObject({ indent: expect.any(Number) });
    expect(bullets[2]).toMatchObject({ indent: expect.any(Number) });
    expect(bullets[1]).not.toHaveProperty("type");
    // Every item of a numbered list names the number the list starts from, so PowerPoint numbers them in a row.
    expect(bullets[3]).toMatchObject({ type: "number", numberStartAt: 3 });
    expect(bullets[4]).toMatchObject({ type: "number", numberStartAt: 3 });
    expect(runs[0]?.options).not.toHaveProperty("bullet");
  });

  it("marks a bullet with the text's color for the package step, and nothing else", () => {
    const runs = flowRuns(parseText("- [first]{action} item", { lists: true }), ink(), context);
    expect(runs[0]?.options?.lang).toBe("en~bu=4B505B");
    expect(runs[1]?.options?.lang).toBe("en");
  });

  it("keeps a line break inside a paragraph as a soft break before the next run", () => {
    const runs = flowRuns(parseText("one\ntwo", { lists: true }), ink(), context);
    expect(runs.map((run) => run.text)).toEqual(["one", "two"]);
    expect(runs[0]?.options?.softBreakBefore).toBeUndefined();
    expect(runs[1]?.options?.softBreakBefore).toBe(true);
  });

  it("takes weight, slant, spacing and capitals from how the page draws the text", () => {
    const runs = plainRuns(
      "Evidence",
      ink({ weight: 700, italic: true, spacing: 2, caps: true, px: 14 }),
      context,
    );
    expect(runs[0]?.options).toMatchObject({ bold: true, italic: true, charSpacing: 1.5, fontSize: 10.5 });
    expect(runs[0]?.options?.lang).toBe("en~caps");
  });

  it("aligns every run as the page aligns the text", () => {
    const runs = plainRuns("Centered", ink({ align: "center" }), context);
    expect(runs[0]?.options?.align).toBe("center");
  });

  it("gives an empty text one empty run, so the box exists", () => {
    expect(plainRuns("", ink(), context).map((run) => run.text)).toEqual([""]);
  });
});

describe("where a text box goes", () => {
  it("takes the page's box without its padding", () => {
    const frame = textFrame(
      place({ x: 100, y: 200, w: 500, h: 120 }, { inset: { t: 10, r: 20, b: 30, l: 40 } }),
    );
    expect(frame).toEqual({ x: 140, y: 210, w: 440, h: 80 });
  });

  it("lifts the box by half of what the line height adds, so the first line sits where the page's does", () => {
    const frame = textFrame(
      place({ x: 0, y: 100, w: 400, h: 100 }, { ink: ink({ lineHeight: 40, natural: 30 }) }),
    );
    expect(frame.y).toBe(100 - 5);
    const tight = textFrame(
      place({ x: 0, y: 100, w: 400, h: 100 }, { ink: ink({ lineHeight: 28, natural: 40 }) }),
    );
    expect(tight.y).toBe(100 + 6);
  });

  it("does not lift when the face's natural height is unknown", () => {
    expect(textFrame(place({ x: 0, y: 100, w: 400, h: 100 }, { ink: ink({ natural: 0 }) })).y).toBe(100);
  });

  it("narrows a balanced heading to its widest line, and keeps a one-line heading's whole width", () => {
    const balanced = textFrame(place({ x: 0, y: 0, w: 800, h: 200 }, { widest: 500 }));
    expect(balanced.w).toBeCloseTo(500 * 1.03 + 3, 5);
    expect(balanced.x).toBe(0);
    const centered = textFrame(
      place({ x: 0, y: 0, w: 800, h: 200 }, { widest: 500, ink: ink({ align: "center" }) }),
    );
    expect(centered.x).toBeCloseTo((800 - centered.w) / 2, 5);
    const whole = textFrame(place({ x: 0, y: 0, w: 800, h: 200 }));
    expect(whole.w).toBe(800);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A deck drawn from measurements made up for the test, so the drawing is checked without a browser.
// ---------------------------------------------------------------------------------------------------------------------

const WORDS = {
  schemaVersion: "0.3",
  id: "words",
  title: "Words and marks",
  layout: "text-media",
  blocks: [
    { id: "words-heading", type: "text", role: "heading", text: "Channel **B** now leads" },
    {
      id: "words-body",
      type: "text",
      role: "body",
      text: "Orders grew *fastest* in [channel B]{action}, see [the report](https://example.com/q3).\n- same quarter\n- one count\n1. returns excluded",
    },
  ],
  notes: "Pause here, then ask for questions.",
};

const NUMBERS = {
  schemaVersion: "0.3",
  id: "numbers",
  title: "Numbers",
  layout: "claim-evidence",
  summary: {
    id: "numbers-claim",
    text: "Channel B leads, 60 to 40.",
    evidenceIds: ["numbers-table", "numbers-chart"],
  },
  blocks: [
    {
      id: "numbers-table",
      type: "table",
      title: "Orders, latest quarter",
      columns: [
        { label: "Channel" },
        { label: "Orders", kind: "number", unit: "orders" },
        { label: "Share", kind: "number", unit: "%" },
      ],
      rows: [
        ["Channel A", 4000, 40],
        ["Channel B", 6000, 60],
        ["Not known", null, null],
      ],
      sourceIds: ["numbers-source"],
    },
    {
      id: "numbers-chart",
      type: "chart",
      kind: "bar",
      title: "Share of orders by quarter",
      unit: "%",
      columns: [{ label: "Quarter" }, { label: "Channel A" }, { label: "Channel B" }],
      rows: [
        ["Q1", 55, 45],
        ["Q2", 48, 52],
        ["Q3", 40, 60],
      ],
      sourceIds: ["numbers-source"],
    },
  ],
  sources: [{ id: "numbers-source", title: "Quarterly order snapshot", url: "https://example.com/orders" }],
  steps: [
    { id: "numbers-s1", reveal: ["numbers-claim"] },
    { id: "numbers-s2", reveal: ["numbers-table", "numbers-chart"] },
  ],
  notes: "The share is of all orders.",
};

function syntheticDeck(): string {
  const folder = join(root, "synthetic");
  mkdirSync(join(folder, "scenes"), { recursive: true });
  writeFileSync(
    join(folder, "deck.json"),
    JSON.stringify({
      schemaVersion: "0.3",
      id: "synthetic",
      title: "A deck drawn from made-up measurements",
      language: "en",
      theme: "paper",
      palette: { action: "#A8341A", evidence: "#1F4FD1" },
      scenes: ["words", "numbers"],
    }),
  );
  writeFileSync(join(folder, "scenes", "words.json"), JSON.stringify(WORDS));
  writeFileSync(join(folder, "scenes", "numbers.json"), JSON.stringify(NUMBERS));
  return folder;
}

const SLIDE = { w: 1280, h: 720 };

const wordsMeasure = (): SlideMeasure => ({
  slide: SLIDE,
  beyond: { right: 0, bottom: 0 },
  fonts: { display: "Inter", body: "Inter", mono: "IBM Plex Mono" },
  tones: { action: "A8341A", evidence: "1F4FD1" },
  link: "1F4FD1",
  items: [
    {
      kind: "shape",
      name: "Title dot",
      box: { x: 90, y: 63, w: 20, h: 20 },
      fill: "A8341A",
      line: null,
      lineWidth: 0,
      radius: 0,
      ellipse: true,
    },
    {
      kind: "text",
      id: "words-heading",
      text: place(
        { x: 90, y: 120, w: 700, h: 160 },
        { ink: ink({ px: 54, weight: 700, color: "14161B", lineHeight: 60, natural: 66 }) },
      ),
    },
    { kind: "text", id: "words-body", text: place({ x: 90, y: 320, w: 640, h: 300 }) },
    // A panel the page drew past the slide's edge: it is cut at the edge and still there.
    {
      kind: "shape",
      name: "Overhanging panel",
      box: { x: 1200, y: 680, w: 400, h: 200 },
      fill: "F0EEE6",
      line: "D8D4C8",
      lineWidth: 1,
      radius: 12,
      ellipse: false,
    },
  ],
});

const numbersMeasure = (): SlideMeasure => {
  const head = ink({ px: 14, weight: 600, color: "14161B", family: "IBM Plex Mono" });
  const body = ink({ px: 18, color: "14161B", family: "IBM Plex Mono" });
  const padding = { t: 8, r: 16, b: 8, l: 0 };
  const items: Item[] = [
    {
      kind: "claim",
      text: place(
        { x: 90, y: 100, w: 500, h: 120 },
        { ink: ink({ px: 40, color: "14161B", family: "Inter" }) },
      ),
    },
    {
      kind: "table",
      id: "numbers-table",
      caption: place({ x: 640, y: 80, w: 520, h: 24 }, { ink: ink({ px: 14, family: "IBM Plex Mono" }) }),
      grid: { x: 640, y: 110, w: 520, h: 160 },
      columns: [
        { w: 240, align: "left", padding },
        { w: 160, align: "right", padding },
        { w: 120, align: "right", padding: { ...padding, r: 0 } },
      ],
      rows: [
        { h: 40, head: true },
        { h: 40, head: false },
        { h: 40, head: false },
        { h: 40, head: false },
      ],
      head,
      body,
      unit: ink({ px: 14, color: "4B505B", family: "IBM Plex Mono" }),
      headRule: { color: "14161B", width: 2 },
      bodyRule: { color: "D8D4C8", width: 1 },
    },
    {
      kind: "chart",
      id: "numbers-chart",
      box: { x: 640, y: 300, w: 520, h: 300 },
      plot: { x: 680, y: 340, w: 460, h: 220 },
      title: place(
        { x: 640, y: 290, w: 520, h: 20 },
        { ink: ink({ px: 14, family: "IBM Plex Mono", caps: true }) },
      ),
      colors: ["2C54E8", "A8341A", "1F7A4D", "B5791D", "6B3FA0", "444444"],
      ticks: { y: [0, 20, 40, 60], x: [] },
      axis: ink({ px: 12, family: "IBM Plex Mono" }),
      value: ink({ px: 12, family: "IBM Plex Mono", color: "14161B" }),
      grid: "D8D4C8",
    },
    {
      kind: "sources",
      label: place(
        { x: 90, y: 660, w: 1100, h: 14 },
        { text: "Sources", ink: ink({ px: 12, family: "IBM Plex Mono" }) },
      ),
      list: place(
        { x: 90, y: 676, w: 1100, h: 16 },
        {
          text: "1. Quarterly order snapshot",
          ink: ink({ px: 12, family: "IBM Plex Mono", color: "14161B" }),
        },
      ),
    },
  ];
  return {
    slide: SLIDE,
    beyond: { right: 0, bottom: 0 },
    fonts: { display: "Inter", body: "Inter", mono: "IBM Plex Mono" },
    tones: {},
    link: "1F4FD1",
    items,
  };
};

async function buildSynthetic(notes = true) {
  const opened = openDeck(syntheticDeck());
  if (!opened.ok) throw new Error(`the synthetic deck is not valid: ${JSON.stringify(opened.diagnostics)}`);
  const { doc } = opened;
  const scenes = doc.deck.scenes.map((id) => doc.scenes[id]).filter((scene) => scene !== undefined);
  const built = await buildPresentation({
    deck: doc.deck,
    style: styleOf(doc.deck),
    scenes,
    measures: [wordsMeasure(), numbersMeasure()],
    folder: join(root, "synthetic"),
    out: join(root, "deck.pptx"),
    notes,
    numberText: (value) => String(value),
  });
  const bytes = await finishPackage(built.raw, { headers: built.headers });
  return { built, bytes, parts: await partsOf(bytes), background: styleOf(doc.deck).colors.bg };
}

describe("a deck drawn from measurements", () => {
  it("makes one slide per scene, in the deck's order", async () => {
    const { parts, built } = await buildSynthetic();
    expect(built.slides.map((slide) => slide.scene)).toEqual(["words", "numbers"]);
    const slides = [...parts.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
    expect(slides).toEqual(["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]);
    expect(wordsIn(part(parts, slides[0] as string)).join("")).toContain("Channel B now leads");
    expect(wordsIn(part(parts, slides[1] as string)).join("")).toContain("Channel B leads, 60 to 40.");
  });

  it("sets the slide's background to the deck's own", async () => {
    const { parts, background } = await buildSynthetic();
    const color = background.replace("#", "").toUpperCase();
    for (const name of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
      expect(part(parts, name)).toMatch(new RegExp(`<p:bg>.*?<a:srgbClr val="${color}"`));
    }
  });

  it("writes each mark as a run of its own, with the link as a real link", async () => {
    const { parts } = await buildSynthetic();
    const slide = part(parts, "ppt/slides/slide1.xml");
    const runs = [...slide.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)].map((match) => match[1] as string);
    const run = (text: string) =>
      runs.find((candidate) => candidate.includes(`<a:t>${text}</a:t>`)) as string;
    expect(run("B")).toMatch(/<a:rPr[^>]* b="1"/);
    expect(run("fastest")).toMatch(/<a:rPr[^>]* i="1"/);
    expect(run("channel B")).toContain('<a:srgbClr val="A8341A"/>');
    expect(run("the report")).toContain("<a:hlinkClick");
    expect(part(parts, "ppt/slides/_rels/slide1.xml.rels")).toContain('Target="https://example.com/q3"');
    expect(run("same quarter")).toBeDefined();
  });

  it("makes list items bulleted and numbered paragraphs", async () => {
    const { parts } = await buildSynthetic();
    const slide = part(parts, "ppt/slides/slide1.xml");
    expect(slide.match(/<a:buChar\b/g)?.length).toBe(2);
    expect(slide.match(/<a:buAutoNum\b/g)?.length).toBe(1);
  });

  it("keeps the face and size the page used, and the families it names", async () => {
    const { parts, built } = await buildSynthetic();
    expect(part(parts, "ppt/slides/slide1.xml")).toContain('<a:latin typeface="Inter"');
    expect(part(parts, "ppt/slides/slide2.xml")).toContain('<a:latin typeface="IBM Plex Mono"');
    expect(built.fonts).toEqual([
      { family: "IBM Plex Mono", roles: ["data and labels"] },
      { family: "Inter", roles: ["headings", "text"] },
    ]);
  });

  it("holds every shape inside the slide, cutting a panel the page drew past the edge", async () => {
    const { parts } = await buildSynthetic();
    const size = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(
      part(parts, "ppt/presentation.xml"),
    ) as RegExpExecArray;
    const [width, height] = [Number(size[1]), Number(size[2])];
    for (const name of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
      const boxes = [
        ...part(parts, name).matchAll(
          /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/g,
        ),
      ];
      expect(boxes.length).toBeGreaterThan(2);
      for (const [, x, y, cx, cy] of boxes.map((match) => match.map(Number))) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect((x as number) + (cx as number)).toBeLessThanOrEqual(width + 2);
        expect((y as number) + (cy as number)).toBeLessThanOrEqual(height + 2);
      }
    }
  });

  it("draws a table with every cell, a header row, the unit beside the label and numbers on the right", async () => {
    const { parts } = await buildSynthetic();
    const slide = part(parts, "ppt/slides/slide2.xml");
    const table = (slide.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? []).find((frame) =>
      frame.includes('name="numbers-table"'),
    ) as string;
    expect(table).toContain('<a:tblPr firstRow="1"/>');
    const rows = (table.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? []).map((row) =>
      (row.match(/<a:tc>[\s\S]*?<\/a:tc>/g) ?? []).map((cell) => wordsIn(cell).join("")),
    );
    expect(rows).toEqual([
      ["Channel", "Orders (orders)", "Share (%)"],
      ["Channel A", "4000", "40"],
      ["Channel B", "6000", "60"],
      ["Not known", "", ""],
    ]);
    const alignments = (table.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) ?? [])[1]?.match(/<a:pPr algn="(\w)"/g);
    expect(alignments).toEqual(['<a:pPr algn="l"', '<a:pPr algn="r"', '<a:pPr algn="r"']);
    expect(wordsIn(slide)).toContain("Orders, latest quarter");
  });

  it("draws a native chart with the deck's numbers, its series names and the page's axis", async () => {
    const { parts } = await buildSynthetic();
    const chart = part(parts, "ppt/charts/chart1.xml");
    expect(chart).toContain("<c:barChart>");
    expect(chart).toContain('<c:barDir val="col"/>');
    for (const text of ["Channel A", "Channel B", "Q1", "Q2", "Q3"])
      expect(chart).toContain(`<c:v>${text}</c:v>`);
    for (const number of [55, 48, 40, 45, 52, 60]) expect(chart).toContain(`<c:v>${number}</c:v>`);
    // The scale is the page's: 0 to 60 in steps of 20.
    expect(chart).toMatch(/<c:max val="60"\/>/);
    expect(chart).toMatch(/<c:majorUnit val="20"\/>/);
    expect(chart).toContain("Share of orders by quarter");
    expect(part(parts, "ppt/slides/_rels/slide2.xml.rels")).toContain("charts/chart1.xml");
    expect(
      parts.has("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx") ||
        [...parts.keys()].some((name) => name.endsWith(".xlsx")),
    ).toBe(true);
  });

  it("writes the sources as one line of linked titles at the foot", async () => {
    const { parts } = await buildSynthetic();
    const slide = part(parts, "ppt/slides/slide2.xml");
    expect(wordsIn(slide)).toEqual(expect.arrayContaining(["Sources", "1. ", "Quarterly order snapshot"]));
    expect(part(parts, "ppt/slides/_rels/slide2.xml.rels")).toContain('Target="https://example.com/orders"');
  });

  it("puts the speaker notes in the file, and leaves them out on request", async () => {
    const withNotes = await buildSynthetic(true);
    const notes = [...withNotes.parts.entries()].filter(([name]) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name),
    );
    expect(notes.map(([, xml]) => wordsIn(xml).join(" ")).join(" | ")).toContain(
      "Pause here, then ask for questions.",
    );
    expect(notes.map(([, xml]) => wordsIn(xml).join(" ")).join(" | ")).toContain(
      "The share is of all orders.",
    );

    const without = await buildSynthetic(false);
    for (const xml of without.parts.values()) {
      expect(xml).not.toContain("Pause here");
      expect(xml).not.toContain("The share is of all orders");
    }
  });

  it("reports, per slide, what had no PowerPoint form", async () => {
    const { built } = await buildSynthetic();
    expect(built.slides[0]?.left).toEqual([]);
    const second = built.slides[1]?.left ?? [];
    expect(second.some((line) => line.includes("2 steps flattened"))).toBe(true);
    expect(second.some((line) => line.includes("numbers-chart") && line.includes("color only"))).toBe(true);
  });

  it("reports content that runs past the slide in the player too", async () => {
    const opened = openDeck(syntheticDeck());
    if (!opened.ok) throw new Error("not valid");
    const { doc } = opened;
    const scenes = doc.deck.scenes.map((id) => doc.scenes[id]).filter((scene) => scene !== undefined);
    const tall = { ...wordsMeasure(), beyond: { right: 0, bottom: 145 } };
    const built = await buildPresentation({
      deck: doc.deck,
      style: styleOf(doc.deck),
      scenes,
      measures: [tall, numbersMeasure()],
      folder: join(root, "synthetic"),
      out: join(root, "deck.pptx"),
      notes: true,
      numberText: (value) => String(value),
    });
    expect(built.slides[0]?.left.join(" ")).toContain("145px past the slide in the player too");
  });

  it("names a block the page did not draw, rather than dropping it without a word", async () => {
    const opened = openDeck(syntheticDeck());
    if (!opened.ok) throw new Error("not valid");
    const { doc } = opened;
    const scenes = doc.deck.scenes.map((id) => doc.scenes[id]).filter((scene) => scene !== undefined);
    const bare = {
      ...wordsMeasure(),
      items: wordsMeasure().items.filter((entry) => entry.kind !== "text" || entry.id !== "words-body"),
    };
    const built = await buildPresentation({
      deck: doc.deck,
      style: styleOf(doc.deck),
      scenes,
      measures: [bare, numbersMeasure()],
      folder: join(root, "synthetic"),
      out: join(root, "deck.pptx"),
      notes: true,
      numberText: (value) => String(value),
    });
    expect(built.slides[0]?.left).toContain('"words-body" is not on the slide: the player did not draw it.');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The command, as far as it goes before a browser starts.
// ---------------------------------------------------------------------------------------------------------------------

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
  };
}

async function pptxCommand(...args: string[]) {
  const { io, lines, errors } = capture();
  const code = await run(["export", ...args], io);
  return { code, lines, errors, text: lines.join("\n"), errorText: errors.join("\n") };
}

describe("depthcue export --format pptx, before the browser", () => {
  let deck: string;
  beforeEach(() => {
    deck = join(root, "deck");
    cpSync(v01, deck, { recursive: true });
  });

  it("is in the usage text, with what it does and what its exit codes are", async () => {
    const { io, errors } = capture();
    expect(run([], io)).toBe(2);
    const text = errors.join("\n");
    expect(text).toContain(
      "depthcue export <deck-folder> --format pptx [--out <file.pptx>] [--no-notes] [--pictures] [--steps]",
    );
    expect(text).toContain("[--posters] [--json]");
    expect(text).toContain("depthcue export <deck-folder> [--out <dir>] [--no-notes] [--json]");
    expect(text).toContain("--format pptx writes one PowerPoint file instead");
    expect(text).toContain("Exit codes: 0 done, 1 the deck has errors, 2 the export could not run.");
  });

  it("prints its own help with export --help and exits 0", () => {
    const { io, lines, errors } = capture();
    expect(run(["export", "--help"], io)).toBe(0);
    expect(errors).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("--format pptx");
    expect(text).toContain("changed since, is never replaced");
    // The folder export is still described next to it.
    expect(text).toContain("Writes a folder that opens by double-click");
  });

  it("leaves --help to export alone", () => {
    const { io, errors } = capture();
    expect(run(["check", "--help"], io)).toBe(2);
    expect(errors.join("\n")).toContain("Unknown option --help.");
  });

  it("takes pptx as the one format", async () => {
    const { code, errorText } = await pptxCommand(deck, "--format", "docx");
    expect(code).toBe(2);
    expect(errorText).toContain("--format needs pptx");
  });

  it("keeps --format for export alone", () => {
    for (const command of [
      ["check", deck],
      ["rev", deck],
      ["serve", deck],
      ["render", deck],
    ]) {
      const { io, errors } = capture();
      expect(run([...command, "--format", "pptx"], io)).toBe(2);
      expect(errors.join("\n")).toContain("--format belongs to export.");
    }
  });

  it("takes none of the flags that belong to other commands", async () => {
    for (const flag of [
      ["--step", "1"],
      ["--width", "800"],
      ["--port", "4000"],
      ["--base-rev", "abc"],
    ]) {
      expect((await pptxCommand(deck, "--format", "pptx", ...flag)).code).toBe(2);
    }
  });

  it("exits 1 for a deck with errors, lists them, and writes nothing", async () => {
    writeFileSync(join(deck, "scenes", "method.json"), "{ not json");
    const out = join(root, "out.pptx");
    const { code, lines } = await pptxCommand(deck, "--format", "pptx", "--out", out);
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith("scenes/method.json"))).toBe(true);
    expect(lines.at(-1)).toBe("Nothing was exported. Fix the errors and run it again.");
    expect(existsSync(out)).toBe(false);
  });

  it("reports a deck with errors as JSON and exits 1", async () => {
    writeFileSync(join(deck, "scenes", "method.json"), "{ not json");
    const { code, lines } = await pptxCommand(
      deck,
      "--format",
      "pptx",
      "--out",
      join(root, "out.pptx"),
      "--json",
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: false, code: "deck-invalid" });
  });

  it("exits 2 for a folder that is not there", async () => {
    const { code, errorText } = await pptxCommand(
      join(root, "nothing"),
      "--format",
      "pptx",
      "--out",
      join(root, "o.pptx"),
    );
    expect(code).toBe(2);
    expect(errorText).toContain("is not a directory");
  });

  it("asks for a name ending in .pptx, and writes nothing", async () => {
    const out = join(root, "out.zip");
    const { code, errorText } = await pptxCommand(deck, "--format", "pptx", "--out", out);
    expect(code).toBe(2);
    expect(errorText).toBe(`${out} does not end in .pptx. Name the file with --out <name>.pptx.`);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a folder as the output, and says how to name a file", async () => {
    const out = join(root, "folder.pptx");
    mkdirSync(out);
    const { code, errorText } = await pptxCommand(deck, "--format", "pptx", "--out", out);
    expect(code).toBe(2);
    expect(errorText).toContain(`${out} is a folder. Name the file: --out `);
  });

  it("never replaces a file Depthcue did not write, and says so before any browser starts", async () => {
    const out = join(root, "mine.pptx");
    writeFileSync(out, "my own notes");
    const { code, errorText } = await pptxCommand(deck, "--format", "pptx", "--out", out);
    expect(code).toBe(2);
    expect(errorText).toContain("exists and Depthcue did not write it, so nothing was written");
    expect(readFileSync(out, "utf8")).toBe("my own notes");
  });

  it("never replaces a PowerPoint file from another tool", async () => {
    const out = join(root, "theirs.pptx");
    const theirs = await sample();
    writeFileSync(out, theirs);
    const { code, errorText } = await pptxCommand(deck, "--format", "pptx", "--out", out);
    expect(code).toBe(2);
    expect(errorText).toContain("Depthcue did not write it");
    expect(Buffer.compare(readFileSync(out), Buffer.from(theirs))).toBe(0);
  });

  it("never replaces a file of its own that has been changed since", async () => {
    const out = join(root, "edited.pptx");
    const zip = await JSZip.loadAsync(await finishPackage(await sample(), HINTS));
    zip.file("ppt/extra.xml", "<edited/>");
    const edited = await zip.generateAsync({ type: "nodebuffer" });
    writeFileSync(out, edited);
    const { code, errorText } = await pptxCommand(deck, "--format", "pptx", "--out", out);
    expect(code).toBe(2);
    expect(errorText).toContain("has been changed since, in PowerPoint or by hand, so nothing was written");
    expect(Buffer.compare(readFileSync(out), edited)).toBe(0);
  });

  it("says the same as JSON on stdout with --json, and prints nothing on stderr", async () => {
    const out = join(root, "mine.pptx");
    writeFileSync(out, "my own notes");
    const { code, lines, errors } = await pptxCommand(deck, "--format", "pptx", "--out", out, "--json");
    expect(code).toBe(2);
    expect(errors).toEqual([]);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: false, code: "out-not-ours" });
  });
});
