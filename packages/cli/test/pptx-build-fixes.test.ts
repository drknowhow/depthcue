import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { styleOf } from "@depthcue/core";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { buildPresentation, cellMargin, linkTo } from "../src/pptx/build.ts";
import type { Box, Ink, Item, Picture, SlideMeasure, TextPlace } from "../src/pptx/measure.ts";
import { finishPackage } from "../src/pptx/package.ts";

/**
 * Decks drawn from measurements made up for the test, so each thing the drawing gets right can be checked without a
 * browser: what a slide holds is read back out of the file.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-build-"));
});

afterEach(() => {
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

const wordsIn = (xml: string) =>
  [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decode(match[1] as string));

/** Whether a part holds a character XML 1.0 cannot. */
function forbidden(xml: string): boolean {
  return [...xml].some((character) => {
    const code = character.codePointAt(0) as number;
    return code < 0x20 ? ![0x9, 0xa, 0xd].includes(code) : code === 0xfffe || code === 0xffff;
  });
}

/** An ampersand that starts no entity: what a link to "R&D deck" becomes when the writer does not escape it. */
const BARE_AMPERSAND = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

/** A picture one pixel wide, which is a picture the writer can take. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PIXEL_BYTES = Buffer.from(PIXEL.slice(PIXEL.indexOf(",") + 1), "base64");

const SLIDE = { w: 1280, h: 720 };

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

const place = (box: Box, over: Partial<TextPlace> = {}): TextPlace => ({
  text: "",
  box,
  inset: { t: 0, r: 0, b: 0, l: 0 },
  ink: ink(),
  ...over,
});

const picture = (box: Box, over: Partial<Picture> = {}): Picture => ({
  box,
  picture: box,
  natural: { w: 1, h: 1 },
  src: "assets/intro.png",
  ...over,
});

const measureOf = (items: Item[]): SlideMeasure => ({
  slide: SLIDE,
  beyond: { right: 0, bottom: 0 },
  fonts: { display: "Inter", body: "Inter", mono: "IBM Plex Mono" },
  tones: {},
  link: "1F4FD1",
  items,
});

interface DeckFiles {
  /** The deck's folder name, which a link to a file in it spells. */
  folder: string;
  scenes: Record<string, object>;
  /** Files to put in the folder, by path. */
  assets?: Record<string, Buffer | string>;
}

/** Writes the deck under `base` and returns its folder. */
function writeDeck(base: string, { folder, scenes, assets = {} }: DeckFiles): string {
  const deck = join(base, folder);
  mkdirSync(join(deck, "scenes"), { recursive: true });
  writeFileSync(
    join(deck, "deck.json"),
    JSON.stringify({
      schemaVersion: "0.3",
      id: "fixes",
      title: "Fixes",
      language: "en",
      theme: "paper",
      scenes: Object.keys(scenes),
    }),
  );
  for (const [id, scene] of Object.entries(scenes)) {
    writeFileSync(join(deck, "scenes", `${id}.json`), JSON.stringify(scene));
  }
  for (const [name, bytes] of Object.entries(assets)) {
    mkdirSync(join(deck, name, ".."), { recursive: true });
    writeFileSync(join(deck, name), bytes);
  }
  return deck;
}

async function build(
  deck: string,
  measures: SlideMeasure[],
  out: string,
  afterOpen: () => void = () => undefined,
) {
  const opened = openDeck(deck);
  if (!opened.ok) throw new Error(`the deck is not valid: ${JSON.stringify(opened.diagnostics)}`);
  afterOpen();
  const { doc } = opened;
  const scenes = doc.deck.scenes.map((id) => doc.scenes[id]).filter((scene) => scene !== undefined);
  const built = await buildPresentation({
    deck: doc.deck,
    style: styleOf(doc.deck),
    scenes,
    measures,
    folder: deck,
    out,
    notes: true,
    numberText: (value) => String(value),
  });
  const bytes = await finishPackage(built.raw, { headers: built.headers });
  return { built, bytes, parts: await partsOf(bytes) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Links to files.
// ---------------------------------------------------------------------------------------------------------------------

const CLIP_SCENE = {
  schemaVersion: "0.3",
  id: "clip-scene",
  title: "A clip",
  layout: "text-media",
  blocks: [
    { id: "clip-heading", type: "text", role: "heading", text: "The opening, in motion" },
    {
      id: "intro-clip",
      type: "clip",
      source: "assets/intro.mp4",
      poster: "assets/intro.png",
      alt: "The opening animation.",
    },
  ],
  sources: [{ id: "report", title: "The report", asset: "assets/report.pdf" }],
};

const clipMeasure = (poster = true): SlideMeasure =>
  measureOf([
    { kind: "text", id: "clip-heading", text: place({ x: 90, y: 60, w: 700, h: 80 }) },
    { kind: "clip", id: "intro-clip", video: picture({ x: 90, y: 160, w: 640, h: 360 }), poster },
    {
      kind: "sources",
      label: place({ x: 90, y: 640, w: 600, h: 14 }, { text: "Sources" }),
      list: place({ x: 90, y: 660, w: 600, h: 16 }, { text: "1. The report" }),
    },
  ]);

const CLIP_ASSETS = {
  "assets/intro.mp4": "not really a video",
  "assets/intro.png": PIXEL_BYTES,
  "assets/report.pdf": "not really a report",
};

describe("links to files in the deck", () => {
  it("are relative to the PowerPoint file, percent-encoded, and well-formed for a folder named R&D deck", async () => {
    const deck = writeDeck(join(root, "work"), {
      folder: "R&D deck",
      scenes: { "clip-scene": CLIP_SCENE },
      assets: CLIP_ASSETS,
    });
    const { parts } = await build(deck, [clipMeasure()], join(root, "work", "out", "deck.pptx"));
    const rels = part(parts, "ppt/slides/_rels/slide1.xml.rels");
    // No ampersand that starts nothing: the part is XML.
    expect(rels).not.toMatch(BARE_AMPERSAND);
    expect(rels).toContain('Target="../R%26D%20deck/assets/intro.mp4"');
    expect(rels).toContain('Target="../R%26D%20deck/assets/report.pdf"');
    // Nothing of the machine it was made on.
    expect(rels).not.toContain("file:");
    expect(rels).not.toContain(root);
    expect(rels).not.toContain(tmpdir());
  });

  it("give the same bytes wherever the deck and the file lie, as long as they lie alike", async () => {
    const made = async (where: string) => {
      const deck = writeDeck(join(root, where), {
        folder: "R&D deck",
        scenes: { "clip-scene": CLIP_SCENE },
        assets: CLIP_ASSETS,
      });
      return (await build(deck, [clipMeasure()], join(root, where, "deck.pptx"))).bytes;
    };
    const a = await made("somewhere");
    const b = await made(join("somewhere else", "deeper"));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("reach a deck folder beside the file or below it", () => {
    expect(linkTo(join(root, "out"), join(root, "deck", "assets", "a b.mp4"))).toBe(
      "../deck/assets/a%20b.mp4",
    );
    expect(linkTo(root, join(root, "deck", "assets", "x.mp4"))).toBe("deck/assets/x.mp4");
  });

  it("are a file address, still encoded, when no relative address exists", () => {
    const link = linkTo("C:\\out", "D:\\R&D deck\\assets\\x.mp4", path.win32);
    expect(link).toBe("file:///D:/R%26D%20deck/assets/x.mp4");
    expect(link).not.toMatch(BARE_AMPERSAND);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A clip whose poster cannot be read.
// ---------------------------------------------------------------------------------------------------------------------

describe("a clip", () => {
  it("is its poster, linked, and says so, when the poster can be read", async () => {
    const deck = writeDeck(root, {
      folder: "deck",
      scenes: { "clip-scene": CLIP_SCENE },
      assets: CLIP_ASSETS,
    });
    const { built, parts } = await build(deck, [clipMeasure()], join(root, "deck.pptx"));
    const left = built.slides[0]?.left.join("\n") ?? "";
    expect(left).toContain('"intro-clip": the video is shown as its poster and linked to assets/intro.mp4');
    expect(left).not.toContain("could not be read");
    expect(part(parts, "ppt/slides/slide1.xml")).toContain("<p:pic>");
  });

  it("is a labeled box that keeps the link, and does not say it is shown as its poster, when the poster cannot be read", async () => {
    const deck = writeDeck(root, {
      folder: "deck",
      scenes: { "clip-scene": CLIP_SCENE },
      assets: CLIP_ASSETS,
    });
    // The poster was there when the deck was opened and is gone by the time the file is made.
    const { built, parts } = await build(deck, [clipMeasure()], join(root, "deck.pptx"), () =>
      rmSync(join(deck, "assets", "intro.png")),
    );
    const left = built.slides[0]?.left ?? [];
    expect(left.some((line) => line.includes("assets/intro.png could not be read"))).toBe(true);
    expect(left.some((line) => line.includes("shown as its poster"))).toBe(false);
    expect(left).toContain(
      '"intro-clip": a labeled box links to assets/intro.mp4 in its place; the video is not embedded, because the file is not a readable MP4.',
    );
    const slide = part(parts, "ppt/slides/slide1.xml");
    expect(wordsIn(slide)).toContain("Video: The opening animation.");
    expect(slide).not.toContain("<p:pic>");
    expect(part(parts, "ppt/slides/_rels/slide1.xml.rels")).toContain('Target="deck/assets/intro.mp4"');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Where a box goes when the page drew it past an edge.
// ---------------------------------------------------------------------------------------------------------------------

const PANEL_SCENE = {
  schemaVersion: "0.3",
  id: "panel",
  title: "A panel",
  layout: "text-media",
  blocks: [{ id: "panel-heading", type: "text", role: "heading", text: "Heading" }],
};

describe("a box the page drew past the left or top edge", () => {
  it("is cut at the edge, and not moved in whole", async () => {
    const deck = writeDeck(root, { folder: "deck", scenes: { panel: PANEL_SCENE } });
    const shape = (name: string, box: Box): Item => ({
      kind: "shape",
      name,
      box,
      fill: "F0EEE6",
      line: null,
      lineWidth: 0,
      radius: 0,
      ellipse: false,
    });
    const measure = measureOf([
      { kind: "text", id: "panel-heading", text: place({ x: 90, y: 60, w: 700, h: 80 }) },
      shape("Over the left", { x: -100, y: 300, w: 300, h: 100 }),
      shape("Over the top", { x: 600, y: -50, w: 100, h: 200 }),
      shape("Over both", { x: -40, y: -30, w: 140, h: 130 }),
      shape("Wholly past the left", { x: -400, y: 300, w: 300, h: 100 }),
    ]);
    const { parts } = await build(deck, [measure], join(root, "deck.pptx"));
    const slide = part(parts, "ppt/slides/slide1.xml");
    const placeOf = (name: string) => {
      const xml = new RegExp(`name="${name}"[\\s\\S]*?</p:sp>`).exec(slide)?.[0];
      if (xml === undefined) return undefined;
      const match = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/.exec(xml);
      return match?.slice(1, 5).map((value) => Number(value) / 9525);
    };
    // The part that hangs over is dropped; the rest stays where the page put it.
    expect(placeOf("Over the left")).toEqual([0, 300, 200, 100]);
    expect(placeOf("Over the top")).toEqual([600, 0, 100, 150]);
    expect(placeOf("Over both")).toEqual([0, 0, 100, 100]);
    // Nothing of it is on the slide.
    expect(placeOf("Wholly past the left")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A table cell's margins.
// ---------------------------------------------------------------------------------------------------------------------

const TABLE_SCENE = {
  schemaVersion: "0.3",
  id: "tables",
  title: "A table",
  layout: "claim-evidence",
  summary: { id: "tables-claim", text: "A claim.", evidenceIds: ["tables-table"] },
  blocks: [
    {
      id: "tables-table",
      type: "table",
      columns: [{ label: "Channel" }, { label: "Orders", kind: "number" }],
      rows: [["A", 1]],
    },
  ],
};

function tableMeasure(padding: { t: number; r: number; b: number; l: number }): SlideMeasure {
  return measureOf([
    {
      kind: "table",
      id: "tables-table",
      grid: { x: 100, y: 100, w: 400, h: 80 },
      columns: [
        { w: 200, align: "left", padding },
        { w: 200, align: "right", padding },
      ],
      rows: [
        { h: 40, head: true },
        { h: 40, head: false },
      ],
      head: ink({ px: 14, weight: 600 }),
      body: ink({ px: 18 }),
      unit: ink({ px: 14 }),
      headRule: null,
      bodyRule: null,
    },
  ]);
}

describe("a table cell's margins", () => {
  const cells = (xml: string) => [...xml.matchAll(/<a:tcPr\b([^>]*)>/g)].map((match) => match[1] as string);
  const emu = (attributes: string, name: string) =>
    Number(new RegExp(`${name}="(\\d+)"`).exec(attributes)?.[1]);

  it("are the page's padding when there is none above the text, and not a hundred times as much", async () => {
    const deck = writeDeck(root, { folder: "deck", scenes: { tables: TABLE_SCENE } });
    const { parts } = await build(deck, [tableMeasure({ t: 0, r: 16, b: 0, l: 4 })], join(root, "deck.pptx"));
    const found = cells(part(parts, "ppt/slides/slide1.xml"));
    expect(found.length).toBe(4);
    for (const attributes of found) {
      expect(emu(attributes, "marT")).toBe(0);
      expect(emu(attributes, "marR")).toBe(16 * 9525);
      expect(emu(attributes, "marB")).toBe(0);
      expect(emu(attributes, "marL")).toBe(4 * 9525);
    }
  });

  it("are the page's padding when there is some above the text too", async () => {
    const deck = writeDeck(root, { folder: "deck", scenes: { tables: TABLE_SCENE } });
    const { parts } = await build(deck, [tableMeasure({ t: 8, r: 16, b: 6, l: 4 })], join(root, "deck.pptx"));
    for (const attributes of cells(part(parts, "ppt/slides/slide1.xml"))) {
      expect(emu(attributes, "marT")).toBe(8 * 9525);
      expect(emu(attributes, "marR")).toBe(16 * 9525);
      expect(emu(attributes, "marB")).toBe(6 * 9525);
      expect(emu(attributes, "marL")).toBe(4 * 9525);
    }
  });

  it("are given in points from one point of padding above, and in inches below it", () => {
    expect(cellMargin({ t: 8, r: 16, b: 6, l: 4 })).toEqual([6, 12, 4.5, 3]);
    expect(cellMargin({ t: 1.5, r: 16, b: 0, l: 4 })).toEqual([1.13, 12, 0, 3]);
    expect(cellMargin({ t: 0.5, r: 96, b: 0, l: 48 })).toEqual([0.5 / 96, 1, 0, 0.5]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A chart with an empty cell.
// ---------------------------------------------------------------------------------------------------------------------

function chartScene(kind: string) {
  return {
    schemaVersion: "0.3",
    id: "gaps",
    title: "Gaps",
    layout: "claim-evidence",
    summary: { id: "gaps-claim", text: "A claim.", evidenceIds: ["gaps-chart"] },
    blocks: [
      {
        id: "gaps-chart",
        type: "chart",
        kind,
        title: "Orders by quarter",
        columns: [{ label: "Quarter" }, { label: "Orders" }, { label: "Returns" }],
        rows: [
          ["Q1", 4, 1],
          ["Q2", null, 2],
          ["Q3", 6, null],
          ["Q4", 7, 4],
        ],
      },
    ],
  };
}

const chartMeasure = (): SlideMeasure =>
  measureOf([
    {
      kind: "chart",
      id: "gaps-chart",
      box: { x: 100, y: 100, w: 600, h: 400 },
      plot: { x: 140, y: 140, w: 540, h: 320 },
      colors: ["2C54E8", "A8341A", "1F7A4D", "B5791D", "6B3FA0", "444444"],
      ticks: { y: [0, 2, 4, 6, 8], x: [] },
      axis: ink({ px: 12, family: "IBM Plex Mono" }),
      value: ink({ px: 12, family: "IBM Plex Mono", color: "14161B" }),
      grid: "D8D4C8",
    },
  ]);

describe("a chart with an empty cell", () => {
  it.each(["line", "bar", "area"])(
    "leaves a gap in a %s chart where the deck has no number, never a zero",
    async (kind) => {
      const deck = writeDeck(root, { folder: "deck", scenes: { gaps: chartScene(kind) } });
      const { parts, bytes } = await build(deck, [chartMeasure()], join(root, "deck.pptx"));
      const chart = part(parts, "ppt/charts/chart1.xml");
      expect(chart).toContain('<c:dispBlanksAs val="gap"/>');
      const series = [...chart.matchAll(/<c:val>[\s\S]*?<\/c:val>/g)].map((match) => match[0]);
      expect(series).toHaveLength(2);
      const indexes = (xml: string) => [...xml.matchAll(/<c:pt idx="(\d+)">/g)].map((match) => match[1]);
      expect(indexes(series[0] as string)).toEqual(["0", "2", "3"]);
      expect(indexes(series[1] as string)).toEqual(["0", "1", "3"]);
      expect(chart).not.toContain("<c:v></c:v>");
      // The workbook behind it agrees, so editing the data in PowerPoint draws the same chart.
      const entry = (await JSZip.loadAsync(bytes)).file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx");
      const book = await partsOf(await (entry as JSZip.JSZipObject).async("uint8array"));
      const sheet = part(book, "xl/worksheets/sheet1.xml");
      expect(sheet).not.toMatch(/<c r="B3"/);
      expect(sheet).not.toMatch(/<c r="C4"/);
      for (const cell of ["B2", "B4", "B5", "C2", "C3", "C5"]) expect(sheet).toContain(`<c r="${cell}"`);
    },
  );

  it("leaves a gap in a scatter's empty value", async () => {
    const scene = chartScene("scatter");
    scene.blocks[0] = {
      ...scene.blocks[0],
      columns: [{ label: "Length" }, { label: "Weight" }],
      rows: [
        [1, 5],
        [2, null],
        [3, 9],
      ],
    } as never;
    const deck = writeDeck(root, { folder: "deck", scenes: { gaps: scene } });
    const { parts } = await build(deck, [chartMeasure()], join(root, "deck.pptx"));
    const chart = part(parts, "ppt/charts/chart1.xml");
    const weights = /<c:yVal>[\s\S]*?<\/c:yVal>/.exec(chart)?.[0] ?? "";
    expect([...weights.matchAll(/<c:pt idx="(\d+)">/g)].map((match) => match[1])).toEqual(["0", "2"]);
    expect(chart).not.toContain("<c:v></c:v>");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Words with characters XML cannot hold, and the speaker notes.
// ---------------------------------------------------------------------------------------------------------------------

describe("words the deck wrote", () => {
  const scene = {
    schemaVersion: "0.3",
    id: "odd",
    title: "Odd characters",
    layout: "text-media",
    blocks: [
      { id: "odd-heading", type: "text", role: "heading", text: "Heading with a bell\u0007 in it" },
      { id: "odd-body", type: "text", role: "body", text: "First line\u000bSecond line\nThird line" },
    ],
    notes: "Open with the number.\nThen the story.\n\nThen questions.",
  };
  const measure = measureOf([
    { kind: "text", id: "odd-heading", text: place({ x: 90, y: 60, w: 700, h: 80 }) },
    { kind: "text", id: "odd-body", text: place({ x: 90, y: 200, w: 700, h: 200 }) },
  ]);

  it("break the line at a vertical tab and drop the characters XML cannot hold", async () => {
    const deck = writeDeck(root, { folder: "deck", scenes: { odd: scene } });
    const { parts } = await build(deck, [measure], join(root, "deck.pptx"));
    const slide = part(parts, "ppt/slides/slide1.xml");
    expect(wordsIn(slide)).toContain("Heading with a bell in it");
    expect(wordsIn(slide)).toEqual(expect.arrayContaining(["First line", "Second line", "Third line"]));
    expect(slide.match(/<a:br\b/g)?.length).toBe(2);
    for (const [name, xml] of parts) {
      if (/\.(xml|rels)$/.test(name)) expect(forbidden(xml), name).toBe(false);
    }
  });

  it("keep the speaker notes a paragraph to a line", async () => {
    const deck = writeDeck(root, { folder: "deck", scenes: { odd: scene } });
    const { parts } = await build(deck, [measure], join(root, "deck.pptx"));
    const notes = part(parts, "ppt/notesSlides/notesSlide1.xml");
    const body = /name="Notes Placeholder 2"[\s\S]*?<\/p:sp>/.exec(notes)?.[0] ?? "";
    expect(
      [...body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) => wordsIn(match[1] as string).join("")),
    ).toEqual(["Open with the number.", "Then the story.", "", "Then questions."]);
  });
});
