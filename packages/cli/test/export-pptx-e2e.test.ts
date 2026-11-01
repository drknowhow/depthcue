import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import {
  type Block,
  type Cell,
  chartFromBarChart,
  type Doc,
  type Scene,
  type Span,
  styleOf,
  textFlow,
} from "@depthcue/core";
import { numberText } from "@depthcue/player";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClip } from "../src/clip.ts";
import { openDeck } from "../src/deck-api.ts";
import { run } from "../src/index.ts";
import { launchBrowser } from "../src/render.ts";
import { builtStandaloneDir } from "../src/serve.ts";

/**
 * The PowerPoint export against the real player, in a real browser: each deck is exported, the file is unzipped, and what
 * is inside is compared with the deck. The player's own pixels are not compared here (the sizes depend on this
 * machine's fonts); the structure is, and the numbers, the words, the marks and the places.
 */

const decks = (name: string) => fileURLToPath(new URL(`../../../fixtures/decks/${name}`, import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/kine-stub.mjs", import.meta.url));
const fontManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../brand/fonts/manifest.json", import.meta.url)), "utf8"),
) as { pairs: Record<string, Record<string, string>> };

const EMU_PER_PX = 9525;

/** A hook that runs when the export starts its browser: what the export did before that, it did first. */
const hooks = vi.hoisted(() => ({ onLaunch: undefined as (() => void) | undefined }));

vi.mock("../src/render.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/render.ts")>();
  return {
    ...original,
    launchBrowser: async () => {
      const hook = hooks.onLaunch;
      hooks.onLaunch = undefined;
      hook?.();
      return original.launchBrowser();
    },
  };
});

let skipReason: string | undefined;
let root: string;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtStandaloneDir(), "depthcue.js")))
      throw new Error("The player is not built. Run pnpm build.");
    const browser = await launchBrowser();
    await browser.close();
  } catch (error) {
    // CI builds first and has Chrome, so it must not skip. A machine without either can run everything else.
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

beforeEach(async (test) => {
  if (skipReason !== undefined) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-e2e-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  hooks.onLaunch = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Running the command.
// ---------------------------------------------------------------------------------------------------------------------

interface Summary {
  ok: boolean;
  out: string;
  scenes: number;
  bytes: number;
  notes: boolean;
  fonts: Array<{ family: string; roles: string[] }>;
  slides: Array<{ scene: string; title: string; left: string[] }>;
  deck: string[];
  diagnostics: unknown[];
}

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
  };
}

async function exportPptx(folder: string, out: string, ...flags: string[]) {
  const { io, lines, errors } = capture();
  const code = await run(["export", folder, "--format", "pptx", "--out", out, ...flags], io);
  return { code, lines, errors };
}

/** Exports with --json and returns what the command reported. */
async function exported(folder: string, out: string, ...flags: string[]): Promise<Summary> {
  const { code, lines, errors } = await exportPptx(folder, out, "--json", ...flags);
  if (code !== 0) throw new Error(`The export exited ${code}: ${[...lines, ...errors].join("\n")}`);
  return JSON.parse(lines.join("\n")) as Summary;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the file.
// ---------------------------------------------------------------------------------------------------------------------

const decode = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
const encodeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

interface RunInfo {
  text: string;
  bold: boolean;
  italic: boolean;
  link: string;
  color: string;
  face: string;
}

interface ParagraphInfo {
  runs: RunInfo[];
  /** The words, with a line break as a newline. */
  text: string;
  /** One key per character, saying how it is marked; line breaks are not counted. */
  marks: string[];
  bullet: "none" | "bullet" | "number";
  align: string;
}

interface ShapeInfo {
  kind: "sp" | "pic" | "graphicFrame";
  name: string;
  alt: string;
  x: number;
  y: number;
  w: number;
  h: number;
  xml: string;
  paragraphs: ParagraphInfo[];
  text: string;
  /** For a table: the words of each cell and each cell's alignment. */
  table?: { rows: string[][]; aligns: string[][]; header: boolean };
  /** For a chart: the part it is drawn from. */
  chart?: string;
  /** The relationship targets this shape's links and pictures point at. */
  targets: string[];
}

interface SlideInfo {
  file: string;
  xml: string;
  rels: Map<string, string>;
  shapes: ShapeInfo[];
  notes: string;
}

const markKey = (run: Pick<RunInfo, "bold" | "italic" | "link">) =>
  `${run.bold ? "b" : ""}${run.italic ? "i" : ""}${run.link ? `>${run.link}` : ""}`;

const relsOf = (xml: string | undefined): Map<string, string> =>
  new Map(
    [...(xml ?? "").matchAll(/<Relationship\b[^>]*>/g)].flatMap((match) => {
      const id = /\bId="([^"]*)"/.exec(match[0])?.[1];
      const target = /\bTarget="([^"]*)"/.exec(match[0])?.[1];
      return id !== undefined && target !== undefined ? [[id, decode(target)] as [string, string]] : [];
    }),
  );

function paragraphOf(xml: string, rels: Map<string, string>): ParagraphInfo {
  const runs: RunInfo[] = [];
  let text = "";
  const marks: string[] = [];
  for (const match of xml.matchAll(/<a:r>([\s\S]*?)<\/a:r>|<a:br\b[^>]*?(?:\/>|>[\s\S]*?<\/a:br>)/g)) {
    if (match[0].startsWith("<a:br")) {
      text += "\n";
      continue;
    }
    const inner = match[1] as string;
    const rPr = /<a:rPr([^>]*)>/.exec(inner)?.[1] ?? "";
    const id = /<a:hlinkClick r:id="([^"]*)"/.exec(inner)?.[1];
    const run: RunInfo = {
      text: decode(/<a:t>([^<]*)<\/a:t>/.exec(inner)?.[1] ?? ""),
      bold: /\bb="1"/.test(rPr),
      italic: /\bi="1"/.test(rPr),
      link: id === undefined ? "" : (rels.get(id) ?? ""),
      color: /<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(inner)?.[1] ?? "",
      face: /<a:latin typeface="([^"]*)"/.exec(inner)?.[1] ?? "",
    };
    runs.push(run);
    text += run.text;
    for (const _character of run.text) marks.push(markKey(run));
  }
  const properties = /<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/.exec(xml)?.[0] ?? "";
  return {
    runs,
    text,
    marks,
    bullet: properties.includes("<a:buAutoNum")
      ? "number"
      : properties.includes("<a:buChar")
        ? "bullet"
        : "none",
    align: /\balgn="(\w+)"/.exec(properties)?.[1] ?? "",
  };
}

function shapeOf(kind: ShapeInfo["kind"], xml: string, rels: Map<string, string>): ShapeInfo {
  const name = decode(/<p:cNvPr id="\d+" name="([^"]*)"/.exec(xml)?.[1] ?? "");
  const alt = decode(/<p:cNvPr id="\d+" name="[^"]*" descr="([^"]*)"/.exec(xml)?.[1] ?? "");
  const place = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(xml);
  if (!place) throw new Error(`${kind} "${name}" has no place on the slide.`);
  const [x, y, w, h] = place.slice(1, 5).map(Number) as [number, number, number, number];
  const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((match) =>
    paragraphOf(match[1] as string, rels),
  );
  const shape: ShapeInfo = {
    kind,
    name,
    alt,
    x,
    y,
    w,
    h,
    xml,
    paragraphs,
    text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
    targets: [...xml.matchAll(/r:(?:id|embed)="([^"]*)"/g)].flatMap((match) => {
      const target = rels.get(match[1] as string);
      return target === undefined ? [] : [target];
    }),
  };
  if (xml.includes("<a:tbl>")) {
    const rows = [...xml.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((row) =>
      [...row[0].matchAll(/<a:tc>[\s\S]*?<\/a:tc>/g)].map((cell) => cell[0]),
    );
    shape.table = {
      rows: rows.map((row) =>
        row.map((cell) =>
          [...cell.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decode(match[1] as string)).join(""),
        ),
      ),
      aligns: rows.map((row) => row.map((cell) => /<a:pPr algn="(\w+)"/.exec(cell)?.[1] ?? "")),
      header: xml.includes('<a:tblPr firstRow="1"'),
    };
  }
  const chart = /<c:chart r:id="([^"]*)"/.exec(xml)?.[1];
  if (chart !== undefined) shape.chart = (rels.get(chart) ?? "").replace(/^\//, "");
  return shape;
}

class Pptx {
  readonly slides: SlideInfo[] = [];

  private constructor(
    readonly zip: JSZip,
    readonly names: string[],
  ) {}

  static async open(file: string): Promise<Pptx> {
    const zip = await JSZip.loadAsync(readFileSync(file));
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
    const pptx = new Pptx(zip, names);
    // The slides in the order the presentation lists them.
    const presentation = await pptx.text("ppt/presentation.xml");
    const rels = relsOf(await pptx.maybe("ppt/_rels/presentation.xml.rels"));
    for (const match of presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]*)"/g)) {
      const target = rels.get(match[1] as string);
      if (!target)
        throw new Error(`The presentation lists a slide ${match[1]} that it has no relationship for.`);
      const path = `ppt/${target.replace(/^\/?(ppt\/)?/, "")}`;
      pptx.slides.push(await pptx.slide(path));
    }
    return pptx;
  }

  async maybe(name: string): Promise<string | undefined> {
    return this.zip.file(name)?.async("string");
  }

  async text(name: string): Promise<string> {
    const found = await this.maybe(name);
    if (found === undefined) throw new Error(`The file has no ${name}.`);
    return found;
  }

  private async slide(file: string): Promise<SlideInfo> {
    const xml = await this.text(file);
    const relsFile = file.replace("slides/", "slides/_rels/").concat(".rels");
    const rels = relsOf(await this.maybe(relsFile));
    const shapes = [...xml.matchAll(/<p:(sp|pic|graphicFrame)>[\s\S]*?<\/p:\1>/g)].map((match) =>
      shapeOf(match[1] as ShapeInfo["kind"], match[0], rels),
    );
    const notesTarget = [...rels.values()].find((target) => target.includes("notesSlides/"));
    const notes = notesTarget
      ? [...(await this.text(`ppt/${notesTarget.replace(/^\.\.\//, "")}`)).matchAll(/<a:t>([^<]*)<\/a:t>/g)]
          .map((match) => decode(match[1] as string))
          .join("\n")
      : "";
    return { file, xml, rels, shapes, notes };
  }

  /** The slide's size in EMU. */
  async size(): Promise<{ w: number; h: number }> {
    const match = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(await this.text("ppt/presentation.xml"));
    if (!match) throw new Error("The presentation has no slide size.");
    return { w: Number(match[1]), h: Number(match[2]) };
  }

  /** Every part's text, for a search that must come up empty. */
  async everything(): Promise<string[]> {
    const out: string[] = [];
    for (const name of this.names) {
      if (/\.(xml|rels)$/.test(name)) out.push(await this.text(name));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What the deck says.
// ---------------------------------------------------------------------------------------------------------------------

function loaded(folder: string): Doc {
  const opened = openDeck(folder);
  if (!opened.ok) throw new Error(`${folder} is not a valid deck: ${JSON.stringify(opened.diagnostics)}`);
  return opened.doc;
}

const scenesOf = (doc: Doc): Scene[] =>
  doc.deck.scenes.map((id) => doc.scenes[id]).filter((scene): scene is Scene => scene !== undefined);

interface Piece {
  text: string;
  bold: boolean;
  italic: boolean;
  link: string;
}

function pieces(spans: readonly Span[], format = { bold: false, italic: false, link: "" }): Piece[] {
  return spans.flatMap((span): Piece[] => {
    if (span.type === "text") return [{ text: span.text, ...format }];
    if (span.type === "strong") return pieces(span.children, { ...format, bold: true });
    if (span.type === "em") return pieces(span.children, { ...format, italic: true });
    if (span.type === "link") return pieces(span.children, { ...format, link: span.href });
    return pieces(span.children, format);
  });
}

interface Expected {
  pieces: Piece[];
  bullet: "none" | "bullet" | "number";
}

function expectedParagraphs(scene: Scene, block: Extract<Block, { type: "text" }>): Expected[] {
  const out: Expected[] = [];
  for (const part of textFlow(scene, block)) {
    if (part.type === "paragraph") out.push({ pieces: pieces(part.children), bullet: "none" });
    else {
      for (const item of part.items) {
        out.push({ pieces: pieces(item), bullet: part.type === "bullets" ? "bullet" : "number" });
      }
    }
  }
  return out;
}

/**
 * Every character of the deck's text carries the mark the deck gives it, and every paragraph the list marker. A style
 * that is bold or italic all through, as a heading's or a quote's may be, is the text's own and not a mark, so the
 * marks are the deck's on top of it. Body text has no such style, and its marks are exact.
 */
function expectText(shape: ShapeInfo, expected: Expected[], styled: boolean) {
  const runs = shape.paragraphs.flatMap((paragraph) => paragraph.runs);
  const allBold = styled && runs.length > 0 && runs.every((run) => run.bold);
  const allItalic = styled && runs.length > 0 && runs.every((run) => run.italic);
  expect(shape.paragraphs.map((paragraph) => paragraph.text)).toEqual(
    expected.map((paragraph) => paragraph.pieces.map((piece) => piece.text).join("")),
  );
  expect(shape.paragraphs.map((paragraph) => paragraph.marks)).toEqual(
    expected.map((paragraph) =>
      paragraph.pieces.flatMap((piece) =>
        [...piece.text.replaceAll("\n", "")].map(() =>
          markKey({ bold: piece.bold || allBold, italic: piece.italic || allItalic, link: piece.link }),
        ),
      ),
    ),
  );
  expect(shape.paragraphs.map((paragraph) => paragraph.bullet)).toEqual(
    expected.map((paragraph) => paragraph.bullet),
  );
}

const cellText = (cell: Cell | undefined, language: string) =>
  cell === null || cell === undefined ? "" : typeof cell === "number" ? numberText(cell, language) : cell;

const CHART_ELEMENT: Record<string, string> = {
  bar: "<c:barChart>",
  "stacked-bar": "<c:barChart>",
  line: "<c:lineChart>",
  area: "<c:areaChart>",
  scatter: "<c:scatterChart>",
  donut: "<c:doughnutChart>",
};

/**
 * Everything the deck says in every scene, found in the slide at the same place in the order: the words with their
 * marks, a table's every cell, a chart's every number.
 */
async function expectDeckInFile(folder: string, file: string, notes: boolean) {
  const doc = loaded(folder);
  const scenes = scenesOf(doc);
  const pptx = await Pptx.open(file);
  const language = doc.deck.language;
  expect(pptx.slides).toHaveLength(scenes.length);
  expect(pptx.slides.map((slide) => slide.file)).toEqual(
    scenes.map((_scene, at) => `ppt/slides/slide${at + 1}.xml`),
  );

  for (const [at, scene] of scenes.entries()) {
    const slide = pptx.slides[at] as SlideInfo;
    const named = (name: string) => slide.shapes.filter((shape) => shape.name === name);
    const one = (name: string) => {
      const found = named(name);
      expect(found, `slide ${at + 1} (${scene.id}) has one "${name}"`).toHaveLength(1);
      return found[0] as ShapeInfo;
    };
    // The scene's title as the page's small heading.
    if (slide.shapes.some((shape) => shape.name === "Eyebrow")) expect(one("Eyebrow").text).toBe(scene.title);
    if (scene.summary) expect(one(scene.summary.id).text).toBe(scene.summary.text);

    for (const block of scene.blocks) {
      if (block.type === "text") {
        expectText(one(block.id), expectedParagraphs(scene, block), block.role !== "body");
      } else if (block.type === "image") {
        const picture = one(block.id);
        expect(picture.kind).toBe("pic");
        expect(picture.alt).toBe(block.alt);
        if (block.caption) expect(one(`${block.id} caption`).text).toBe(block.caption);
      } else if (block.type === "table") {
        const table = one(block.id);
        const header = block.header !== false;
        expect(table.table?.header).toBe(header);
        const expected = [
          ...(header
            ? [block.columns.map((column) => `${column.label}${column.unit ? ` (${column.unit})` : ""}`)]
            : []),
          ...block.rows.map((row) => block.columns.map((_column, column) => cellText(row[column], language))),
        ];
        expect(table.table?.rows).toEqual(expected);
        // A column of numbers lines up on the right, every cell of it, header included.
        block.columns.forEach((column, index) => {
          if (column.kind !== "number") return;
          for (const aligns of table.table?.aligns ?? []) expect(aligns[index]).toBe("r");
        });
        if (block.title) expect(one(`${block.id} title`).text).toBe(block.title);
      } else if (block.type === "chart" || block.type === "bar-chart") {
        const chart = block.type === "chart" ? block : chartFromBarChart(block);
        const shape = one(block.id);
        expect(shape.chart, `"${block.id}" is a native chart`).toBeTruthy();
        const xml = await pptx.text(shape.chart as string);
        expect(xml).toContain(CHART_ELEMENT[chart.kind] as string);
        if (chart.kind === "stacked-bar") expect(xml).toContain('<c:grouping val="stacked"/>');
        if (block.type === "bar-chart") expect(xml).toContain('<c:barDir val="bar"/>');
        for (const column of chart.columns.slice(1)) {
          if (chart.kind !== "donut") expect(xml).toContain(`<c:v>${encodeXml(column.label)}</c:v>`);
        }
        for (const row of chart.rows) {
          for (const cell of row) {
            if (typeof cell === "number") expect(xml).toContain(`<c:v>${cell}</c:v>`);
            else if (typeof cell === "string" && chart.kind !== "scatter")
              expect(xml).toContain(`<c:v>${encodeXml(cell)}</c:v>`);
          }
        }
        if (chart.title) expect(xml).toContain(encodeXml(chart.title));
        // The data is behind it, so "Edit Data" in PowerPoint has a sheet to open.
        const workbook = (
          await pptx.text(shape.chart?.replace("charts/", "charts/_rels/").concat(".rels") as string)
        ).match(/Target="([^"]*\.xlsx)"/)?.[1];
        expect(workbook, `"${block.id}" carries its data`).toBeTruthy();
      } else if (block.type === "clip") {
        expect(named(block.id)).toHaveLength(1);
      }
    }

    // The sources are a line at the foot, each title linked when the source has an address or a file.
    if (scene.sources && scene.sources.length > 0) {
      const sources = one("Sources");
      for (const source of scene.sources) expect(sources.text).toContain(source.title);
      expect(sources.text).toContain("1. ");
    }

    if (notes && scene.notes) expect(slide.notes).toContain(scene.notes);
    if (!notes && scene.notes) expect(slide.notes).not.toContain(scene.notes);
  }
  return { doc, pptx, scenes };
}

// ---------------------------------------------------------------------------------------------------------------------
// The decks.
// ---------------------------------------------------------------------------------------------------------------------

const DECKS = ["demo", "charts", "v0-3"] as const;

/**
 * One export of a deck, made once for the tests that only read it. The tests that need an export of their own, such as
 * the one that exports twice, make it.
 */
function sharedExport(folder: string) {
  const state: { dir: string; out: string; summary: Summary; pptx: Pptx } = {} as never;
  beforeAll(async () => {
    if (skipReason !== undefined) return;
    state.dir = mkdtempSync(join(tmpdir(), "depthcue-pptx-shared-"));
    state.out = join(state.dir, "deck.pptx");
    state.summary = await exported(folder, state.out);
    state.pptx = await Pptx.open(state.out);
  }, 120_000);
  afterAll(() => {
    if (state.dir) rmSync(state.dir, { recursive: true, force: true });
  });
  return state;
}

describe.each(DECKS)("export --format pptx of the %s deck", (name) => {
  const folder = decks(name);
  const shared = sharedExport(folder);

  it("makes one slide per scene, in order, with every block's words, marks, cells and numbers", async () => {
    const { summary, out } = shared;
    expect(summary.ok).toBe(true);
    expect(summary.out).toBe(out);
    const { scenes } = await expectDeckInFile(folder, out, true);
    expect(summary.scenes).toBe(scenes.length);
    expect(summary.slides.map((slide) => slide.scene)).toEqual(scenes.map((scene) => scene.id));
  }, 120_000);

  it("keeps every shape inside the slide, even where the page drew content past the edge", async () => {
    const { pptx } = shared;
    const size = await pptx.size();
    // The slide is the stage in CSS pixels: 1280 by 720.
    expect(size).toEqual({ w: 1280 * EMU_PER_PX, h: 720 * EMU_PER_PX });
    for (const [at, slide] of pptx.slides.entries()) {
      expect(slide.shapes.length).toBeGreaterThan(0);
      for (const shape of slide.shapes) {
        const where = `slide ${at + 1} "${shape.name}"`;
        expect(shape.x, where).toBeGreaterThanOrEqual(0);
        expect(shape.y, where).toBeGreaterThanOrEqual(0);
        expect(shape.x + shape.w, where).toBeLessThanOrEqual(size.w + 2);
        expect(shape.y + shape.h, where).toBeLessThanOrEqual(size.h + 2);
      }
    }
  }, 120_000);

  it("names only the deck's font pair, and reports the families a viewer needs", async () => {
    const { summary, pptx } = shared;
    const doc = loaded(folder);
    const pair = fontManifest.pairs[(doc.deck.fonts as string | undefined) ?? "editorial"] as Record<
      string,
      string
    >;
    const families = new Set(Object.values(pair));
    expect(summary.fonts.length).toBeGreaterThan(0);
    for (const font of summary.fonts) {
      expect(families.has(font.family), `${font.family} is in the pair`).toBe(true);
      expect(font.roles.length).toBeGreaterThan(0);
    }
    const used = new Set<string>();
    for (const name of pptx.names.filter((candidate) =>
      /^ppt\/(slides|charts)\/[^/]+\.xml$/.test(candidate),
    )) {
      for (const match of (await pptx.text(name)).matchAll(/<a:latin typeface="([^"]*)"/g))
        used.add(match[1] as string);
    }
    // The slides and charts draw in the pair's faces and no other, such as the writer's default Arial, and the report
    // names exactly those.
    for (const face of used) expect(families.has(face), `${face} is in the pair`).toBe(true);
    expect([...used].sort()).toEqual(summary.fonts.map((font) => font.family).sort());
    // The theme carries the deck's headings and body faces, so a new text box in PowerPoint starts in them.
    const theme = await pptx.text("ppt/theme/theme1.xml");
    const head = /<a:majorFont><a:latin typeface="([^"]*)"/.exec(theme)?.[1];
    const body = /<a:minorFont><a:latin typeface="([^"]*)"/.exec(theme)?.[1];
    expect(families.has(head as string)).toBe(true);
    expect(families.has(body as string)).toBe(true);
  }, 120_000);

  it("gives the same bytes on a second export, and when it replaces its own file", async () => {
    const first = readFileSync(shared.out);
    const second = join(root, "second.pptx");
    await exported(folder, second);
    expect(Buffer.compare(first, readFileSync(second))).toBe(0);
    // Replacing the file it wrote is allowed, and gives the file it had: the same process made both, and its chart
    // counter, which the writer never resets, had moved on.
    await exported(folder, second);
    expect(Buffer.compare(first, readFileSync(second))).toBe(0);
    expect(readdirSync(root)).toEqual(["second.pptx"]);
  }, 180_000);

  it("leaves the speaker notes out with --no-notes, and nothing of them anywhere in the file", async () => {
    const out = join(root, "quiet.pptx");
    const summary = await exported(folder, out, "--no-notes");
    expect(summary.notes).toBe(false);
    const { scenes, pptx } = await expectDeckInFile(folder, out, false);
    for (const scene of scenes) {
      if (!scene.notes) continue;
      for (const part of await pptx.everything()) expect(part).not.toContain(encodeXml(scene.notes));
    }
  }, 120_000);

  it("reports each slide, in order, with what had no PowerPoint form", async () => {
    const { summary } = shared;
    const doc = loaded(folder);
    const scenes = scenesOf(doc);
    expect(summary.slides).toHaveLength(scenes.length);
    for (const [at, scene] of scenes.entries()) {
      const slide = summary.slides[at];
      expect(slide?.scene).toBe(scene.id);
      expect(slide?.title).toBe(scene.title);
      const steps = scene.steps?.length ?? 0;
      const says = (slide?.left ?? []).some((line) => line.includes("flattened"));
      expect(says, `${scene.id}: build steps are reported when the scene has them`).toBe(steps > 0);
    }
    expect(summary.deck.join(" ")).toContain("no transition");
  }, 120_000);
});

describe("the demo deck", () => {
  const folder = decks("demo");
  const shared = sharedExport(folder);

  it("draws the slides' panels and the quote and title marks as shapes, not as pictures", async () => {
    const { pptx } = shared;
    const shapes = pptx.slides.flatMap((slide) => slide.shapes);
    const panels = shapes.filter(
      (shape) => shape.kind === "sp" && shape.name.length > 0 && shape.text === "",
    );
    expect(panels.length).toBeGreaterThan(0);
    expect(pptx.slides[0]?.shapes.some((shape) => shape.name === "Title dot")).toBe(true);
    // One picture is on a slide: the method diagram, which is an SVG the page drew.
    const pictures = shapes.filter((shape) => shape.kind === "pic");
    expect(pictures.map((shape) => shape.name)).toEqual(["method-diagram"]);
    expect(pictures[0]?.alt).toContain(
      "Diagram: orders from channel A and channel B flow into one deduplicated count.",
    );
  }, 120_000);

  it("sets the slide background to the deck's background color", async () => {
    const { pptx } = shared;
    const bg = styleOf(loaded(folder).deck).colors.bg.replace("#", "").toUpperCase();
    for (const slide of pptx.slides) expect(slide.xml).toMatch(new RegExp(`<p:bg>.*?<a:srgbClr val="${bg}"`));
  }, 120_000);

  it("writes a link as a link and the tone as the deck's color for it", async () => {
    const { pptx } = shared;
    const body = pptx.slides[3]?.shapes.find((shape) => shape.name === "method-body") as ShapeInfo;
    const runs = body.paragraphs.flatMap((paragraph) => paragraph.runs);
    const link = runs.find((run) => run.text === "finance glossary");
    expect(link?.link).toBe("https://example.com/glossary");
    const action = runs.find((run) => run.text === "Returns are excluded");
    const plain = runs.find((run) => run.text.startsWith("Each order is counted once"));
    expect(action?.color).toMatch(/^[0-9A-F]{6}$/);
    expect(action?.color).not.toBe(plain?.color);
    expect(link?.color).not.toBe(plain?.color);
    // The list is a list: three bulleted paragraphs.
    expect(body.paragraphs.map((paragraph) => paragraph.bullet)).toEqual(["bullet", "bullet", "bullet"]);
  }, 120_000);

  it("reads the table's cells as the player writes them, header row and units included", async () => {
    const { pptx } = shared;
    const table = pptx.slides[2]?.shapes.find((shape) => shape.name === "table-orders") as ShapeInfo;
    expect(table.table?.rows).toEqual([
      ["Quarter", "Channel A (orders)", "Channel B (orders)"],
      ["Q1", "5200", "4800"],
      ["Q2", "4800", "5200"],
      ["Q3", "4400", "5600"],
      ["Q4", "4000", "6000"],
    ]);
    expect(table.table?.header).toBe(true);
    expect(table.table?.aligns[1]).toEqual(["l", "r", "r"]);
  }, 120_000);

  it("draws the old bar chart as a native bar chart with its bars' values", async () => {
    const { pptx } = shared;
    const chart = pptx.slides[1]?.shapes.find((shape) => shape.name === "chart-demand") as ShapeInfo;
    const xml = await pptx.text(chart.chart as string);
    expect(xml).toContain('<c:barDir val="bar"/>');
    for (const text of ["Channel A", "Channel B", "40", "60"]) expect(xml).toContain(`<c:v>${text}</c:v>`);
  }, 120_000);

  it("flattens the build steps and says so, and puts the speaker notes on the slide", async () => {
    const { summary, pptx } = shared;
    expect(summary.slides[1]?.left.some((line) => line.includes("2 steps flattened"))).toBe(true);
    // Both of the demand scene's steps' blocks are on its one slide.
    const names = pptx.slides[1]?.shapes.map((shape) => shape.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["claim-shift", "chart-demand"]));
    expect(pptx.slides[1]?.notes).toContain("Pause on the chart.");
  }, 120_000);

  it("prints a plain report, like the other commands, and a file at the default name in the working directory", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { io, lines } = capture();
    const code = await run(["export", folder, "--format", "pptx"], io);
    expect(code).toBe(0);
    const out = join(root, "demo.pptx");
    expect(existsSync(out)).toBe(true);
    expect(lines[0]).toBe(`Exported 4 slides to ${out}`);
    expect(lines[1]).toMatch(/^ {2}\d+\.\d KB, notes kept$/);
    expect(lines.some((line) => line === "  1 opening: everything has a PowerPoint form")).toBe(true);
    expect(lines.some((line) => line === "  2 demand: no PowerPoint form for")).toBe(true);
    expect(lines.some((line) => line.includes("build steps: 2 steps flattened"))).toBe(true);
    expect(lines.some((line) => line.startsWith("  every slide: Scene changes"))).toBe(true);
    expect(lines).toContain("  fonts a viewer needs installed to see it as drawn:");
    expect(lines.some((line) => /^ {6}Space Grotesk \(/.test(line))).toBe(true);
    expect(readdirSync(root)).toEqual(["demo.pptx"]);
  }, 120_000);

  it("reports as data with --json", async () => {
    const out = join(root, "demo.pptx");
    const { code, lines } = await exportPptx(folder, out, "--json");
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const data = JSON.parse(lines[0] as string);
    expect(data).toMatchObject({ ok: true, out, scenes: 4, notes: true });
    expect(data.fonts.map((font: { family: string }) => font.family)).toEqual(
      expect.arrayContaining(["Instrument Serif", "Space Grotesk", "IBM Plex Mono"]),
    );
    expect(data.slides).toHaveLength(4);
    expect(data.bytes).toBe(readFileSync(out).length);
  }, 120_000);
});

describe("the older 0.3 deck", () => {
  const folder = decks("v0-3");
  const shared = sharedExport(folder);

  it("carries bold, italic, tone, links, bullets and numbers, and keeps a literal star a star", async () => {
    const { pptx } = shared;
    const title = pptx.slides[0]?.shapes.find((shape) => shape.name === "overview-title") as ShapeInfo;
    expect(title.text).toBe("Channel B now leads");
    expect(title.paragraphs[0]?.runs.map((run) => [run.text, run.bold])).toEqual([
      ["Channel ", true],
      ["B", true],
      [" now leads", true],
    ]);
    expect(title.paragraphs[0]?.align).toBe("ctr");
    // The heading is toned "action", the deck's own red.
    expect(new Set(title.paragraphs[0]?.runs.map((run) => run.color))).toEqual(new Set(["A8341A"]));

    const body = pptx.slides[0]?.shapes.find((shape) => shape.name === "overview-body") as ShapeInfo;
    const runs = body.paragraphs.flatMap((paragraph) => paragraph.runs);
    expect(runs.find((run) => run.text === "fastest")?.italic).toBe(true);
    expect(runs.find((run) => run.text === "channel B")?.color).toBe("A8341A");
    expect(runs.find((run) => run.text === "the report")?.link).toBe("https://example.com/q3");
    expect(runs.find((run) => run.text === "write to us")?.link).toBe("mailto:team@example.com");
    expect(body.paragraphs.map((paragraph) => paragraph.bullet)).toEqual([
      "none",
      "bullet",
      "bullet",
      "number",
      "number",
    ]);
    expect(body.paragraphs.at(-1)?.text).toBe("5 * 3 is a star, not italic");
    expect(body.paragraphs.at(-1)?.runs.every((run) => !run.italic)).toBe(true);
    // Each list item is the first thing on its line.
    expect(body.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "Orders grew fastest in channel B, see the report or write to us.\nThe method:",
      "same quarter",
      "one count per order",
      "returns excluded",
      "5 * 3 is a star, not italic",
    ]);
  }, 120_000);

  it("draws a table with a blank cell where the deck has none, and a chart per kind", async () => {
    const { pptx } = shared;
    const data = pptx.slides[1] as SlideInfo;
    const table = data.shapes.find((shape) => shape.name === "data-table") as ShapeInfo;
    expect(table.table?.rows.at(-1)).toEqual(["Not known", "", ""]);
    expect(table.table?.rows[0]).toEqual(["Channel", "Orders", "Share (%)"]);
    const bar = data.shapes.find((shape) => shape.name === "data-chart") as ShapeInfo;
    const donut = data.shapes.find((shape) => shape.name === "data-mix") as ShapeInfo;
    expect(await pptx.text(bar.chart as string)).toContain("<c:barChart>");
    expect(await pptx.text(donut.chart as string)).toContain("<c:doughnutChart>");
  }, 120_000);

  it("says where the player itself runs past the slide", async () => {
    const { summary } = shared;
    // The render command reports "overview" and "data" as too tall for the stage; the export says so, per slide.
    const past = (scene: string) =>
      summary.slides
        .find((slide) => slide.scene === scene)
        ?.left.some((line) => line.includes("past the slide in the player too"));
    expect(past("overview")).toBe(true);
    expect(past("data")).toBe(true);
    expect(past("legacy")).toBe(false);
  }, 120_000);
});

describe("the chart deck", () => {
  const folder = decks("charts");
  const shared = sharedExport(folder);

  it("draws each kind as the native chart of that kind, with the page's scale on its axis", async () => {
    const { pptx } = shared;
    const doc = loaded(folder);
    const kinds = new Map<string, string>();
    for (const scene of scenesOf(doc)) {
      for (const block of scene.blocks) if (block.type === "chart") kinds.set(block.id, block.kind);
    }
    expect(new Set(kinds.values())).toEqual(
      new Set(["bar", "stacked-bar", "line", "area", "scatter", "donut"]),
    );
    for (const slide of pptx.slides) {
      for (const shape of slide.shapes.filter((candidate) => candidate.chart)) {
        const kind = kinds.get(shape.name) as string;
        const xml = await pptx.text(shape.chart as string);
        expect(xml).toContain(CHART_ELEMENT[kind] as string);
        // The axes span and step as the page's do, not as PowerPoint would pick.
        if (kind !== "donut") expect(xml).toMatch(/<c:scaling>[\s\S]*?<c:max val="[\d.]+"\/>/);
        if (kind !== "donut") expect(xml).toMatch(/<c:majorUnit val="[\d.]+"\/>/);
      }
    }
  }, 120_000);

  it("says a chart's series are told apart by color only when it has more than one", async () => {
    const { summary } = shared;
    const said = (scene: string) =>
      summary.slides.find((slide) => slide.scene === scene)?.left.some((line) => line.includes("color only"));
    expect(said("stacked")).toBe(true);
    expect(said("line")).toBe(true);
  }, 120_000);

  it("puts pinned blocks where their frames are", async () => {
    const { pptx } = shared;
    const framed = pptx.slides.at(-1) as SlideInfo;
    // The scene pins its heading at 5%, 8% and 90% by 16% of the stage, and two charts side by side below it.
    const heading = framed.shapes.find((shape) => shape.name === "framed-heading") as ShapeInfo;
    const stage = { w: 1280 * EMU_PER_PX, h: 720 * EMU_PER_PX };
    const near = (actual: number, expected: number, slack: number) => Math.abs(actual - expected) <= slack;
    const slack = 40 * EMU_PER_PX;
    expect(near(heading.x, 0.05 * stage.w, slack)).toBe(true);
    expect(near(heading.y, 0.08 * stage.h, slack)).toBe(true);
    expect(heading.w).toBeLessThanOrEqual(0.9 * stage.w + 1);
    const orders = framed.shapes.find((shape) => shape.name === "framed-orders") as ShapeInfo;
    const wait = framed.shapes.find((shape) => shape.name === "framed-wait") as ShapeInfo;
    expect(near(orders.x, 0.05 * stage.w, slack)).toBe(true);
    expect(near(wait.x, 0.52 * stage.w, slack)).toBe(true);
    expect(near(orders.y, 0.3 * stage.h, slack)).toBe(true);
    expect(orders.x + orders.w).toBeLessThanOrEqual(wait.x);
    expect(orders.w).toBeLessThanOrEqual(0.44 * stage.w + 1);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// A deck with a clip, and a pinned scene.
// ---------------------------------------------------------------------------------------------------------------------

const probe = {
  canvas: { w: 1920, h: 1080, fps: 30, duration: 4.2, frames: 126 },
  layers: [
    { id: "dot", type: "circle", in: 0, out: 1.1, parent: null },
    { id: "title", type: "text", in: 1, out: 4.2, parent: null },
  ],
  audio: [],
};

/** A PNG of one color: the stub writes words where a poster goes, and a poster the page cannot decode is no poster. */
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([red, green, blue], y * stride + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A copy of the demo deck with a clip scene added and built the way an author would build it. */
async function deckWithClip(): Promise<string> {
  const deck = join(root, "clip-deck");
  cpSync(decks("demo"), deck, { recursive: true });
  const deckFile = join(deck, "deck.json");
  const manifest = JSON.parse(readFileSync(deckFile, "utf8"));
  writeFileSync(deckFile, JSON.stringify({ ...manifest, scenes: [...manifest.scenes, "clip-scene"] }));
  writeFileSync(
    join(deck, "scenes", "clip-scene.json"),
    JSON.stringify({
      schemaVersion: "0.1",
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
    }),
  );
  const sceneFile = join(root, "intro.json");
  writeFileSync(sceneFile, JSON.stringify({ probe }));
  await buildClip({ folder: deck, scene: sceneFile, kine: [process.execPath, stub] });
  writeFileSync(join(deck, "assets", "intro.png"), solidPng(320, 180, [40, 90, 200]));
  return deck;
}

describe("a clip", () => {
  it("is its poster as a picture with its description, linked to the video file, and said so", async () => {
    const deck = await deckWithClip();
    const out = join(root, "clip.pptx");
    const summary = await exported(deck, out);
    const pptx = await Pptx.open(out);
    const slide = pptx.slides.at(-1) as SlideInfo;
    const clip = slide.shapes.find((shape) => shape.name === "intro-clip") as ShapeInfo;
    expect(clip.kind).toBe("pic");
    expect(clip.alt).toBe("The opening animation.");
    expect(clip.targets).toContain(pathToFileURL(join(deck, "assets", "intro.mp4")).href);
    expect(summary.slides.at(-1)?.left.join(" ")).toContain(
      '"intro-clip": the video is shown as its poster and linked to assets/intro.mp4',
    );
    expect(pptx.names.some((name) => name.startsWith("ppt/media/"))).toBe(true);
    // The video itself is not in the file.
    expect(pptx.names.some((name) => /\.(mp4|mov|webm)$/.test(name))).toBe(false);
  }, 120_000);

  it("is a labeled box that links to the file when there is no poster", async () => {
    const deck = await deckWithClip();
    const sceneFile = join(deck, "scenes", "clip-scene.json");
    const scene = JSON.parse(readFileSync(sceneFile, "utf8"));
    scene.blocks[1] = {
      id: "intro-clip",
      type: "clip",
      source: "assets/intro.mp4",
      alt: "The opening animation.",
    };
    writeFileSync(sceneFile, JSON.stringify(scene));
    const out = join(root, "clip.pptx");
    const summary = await exported(deck, out);
    const pptx = await Pptx.open(out);
    const clip = (pptx.slides.at(-1) as SlideInfo).shapes.find(
      (shape) => shape.name === "intro-clip",
    ) as ShapeInfo;
    expect(clip.kind).toBe("sp");
    expect(clip.text).toBe("Video: The opening animation.");
    expect(clip.targets).toContain(pathToFileURL(join(deck, "assets", "intro.mp4")).href);
    expect(summary.slides.at(-1)?.left.join(" ")).toContain(
      "the video has no poster, so a labeled box links to assets/intro.mp4",
    );
  }, 120_000);
});

describe("a pinned scene", () => {
  it("puts each pinned block at its frame, over the template's blocks", async () => {
    const deck = join(root, "pinned-deck");
    cpSync(decks("demo"), deck, { recursive: true });
    const deckFile = join(deck, "deck.json");
    const manifest = JSON.parse(readFileSync(deckFile, "utf8"));
    writeFileSync(deckFile, JSON.stringify({ ...manifest, scenes: [...manifest.scenes, "pinned"] }));
    const frames = {
      "pin-body": { x: 56, y: 58, w: 38, h: 26 },
      "pin-quote": { x: 58, y: 12, w: 36, h: 16 },
    };
    writeFileSync(
      join(deck, "scenes", "pinned.json"),
      JSON.stringify({
        schemaVersion: "0.2",
        id: "pinned",
        title: "Pinned",
        layout: "text-media",
        blocks: [
          { id: "pin-heading", type: "text", role: "heading", text: "A heading that stays in the template" },
          {
            id: "pin-body",
            type: "text",
            role: "body",
            text: "A paragraph pinned to the lower right.",
            frame: frames["pin-body"],
          },
          {
            id: "pin-quote",
            type: "text",
            role: "quote",
            text: "Pinned over the top right.",
            frame: frames["pin-quote"],
          },
        ],
      }),
    );
    const out = join(root, "pinned.pptx");
    await exported(deck, out);
    const pptx = await Pptx.open(out);
    const slide = pptx.slides.at(-1) as SlideInfo;
    const stage = { w: 1280 * EMU_PER_PX, h: 720 * EMU_PER_PX };
    const slack = 40 * EMU_PER_PX;
    for (const [id, frame] of Object.entries(frames)) {
      const shape = slide.shapes.find((candidate) => candidate.name === id) as ShapeInfo;
      expect(Math.abs(shape.x - (frame.x / 100) * stage.w), `${id} x`).toBeLessThanOrEqual(slack);
      expect(Math.abs(shape.y - (frame.y / 100) * stage.h), `${id} y`).toBeLessThanOrEqual(slack);
      expect(shape.w, `${id} width`).toBeLessThanOrEqual((frame.w / 100) * stage.w + 1);
      expect(shape.w, `${id} width`).toBeGreaterThan((frame.w / 100) * stage.w - slack * 2);
    }
    const body = slide.shapes.find((shape) => shape.name === "pin-body") as ShapeInfo;
    expect(body.text).toBe("A paragraph pinned to the lower right.");
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// What is already at the output path.
// ---------------------------------------------------------------------------------------------------------------------

describe("a file that is already there", () => {
  const folder = decks("demo");

  it("is replaced when Depthcue wrote it and nobody has changed it", async () => {
    const out = join(root, "deck.pptx");
    await exported(folder, out, "--no-notes");
    const before = readFileSync(out);
    const summary = await exported(folder, out);
    expect(summary.notes).toBe(true);
    // With the notes this time, so the file is not the same.
    expect(Buffer.compare(readFileSync(out), before)).not.toBe(0);
    expect(readdirSync(root)).toEqual(["deck.pptx"]);
  }, 120_000);

  it("is never replaced when Depthcue did not write it, and the file is left as it was", async () => {
    const out = join(root, "deck.pptx");
    writeFileSync(out, "a file somebody else made");
    const { code, errors, lines } = await exportPptx(folder, out);
    expect(code).toBe(2);
    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("exists and Depthcue did not write it, so nothing was written");
    expect(readFileSync(out, "utf8")).toBe("a file somebody else made");
    expect(readdirSync(root)).toEqual(["deck.pptx"]);
  }, 120_000);

  it("is never replaced when it was written by Depthcue and has been edited since", async () => {
    const out = join(root, "deck.pptx");
    await exported(folder, out);
    // A change made in PowerPoint: one of the slide's words.
    const zip = await JSZip.loadAsync(readFileSync(out));
    const slide = await (zip.file("ppt/slides/slide1.xml") as JSZip.JSZipObject).async("string");
    zip.file("ppt/slides/slide1.xml", slide.replace("Channel B now leads", "Channel B leads by a lot"));
    const edited = await zip.generateAsync({ type: "nodebuffer" });
    writeFileSync(out, edited);

    const { code, errors } = await exportPptx(folder, out);
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain(
      "has been changed since, in PowerPoint or by hand, so nothing was written",
    );
    expect(Buffer.compare(readFileSync(out), edited)).toBe(0);
    expect(readdirSync(root)).toEqual(["deck.pptx"]);
  }, 120_000);

  it("is looked at again before anything is written, in case it appeared while the browser ran", async () => {
    const out = join(root, "deck.pptx");
    // The browser starts after the first look and before the second, so a file written then is a file that appeared
    // while the export ran.
    hooks.onLaunch = () => writeFileSync(out, "arrived while the export ran");
    const { code, errors } = await exportPptx(folder, out);
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Depthcue did not write it, so nothing was written");
    expect(readFileSync(out, "utf8")).toBe("arrived while the export ran");
    // No half-written file is left beside it.
    expect(readdirSync(root)).toEqual(["deck.pptx"]);
  }, 120_000);
});

describe("the deck folder", () => {
  it("is not changed by the export", async () => {
    const deck = join(root, "deck");
    cpSync(decks("demo"), deck, { recursive: true });
    const listing = () => readdirSync(deck, { recursive: true }).map(String).sort();
    const before = listing();
    const contents = before.map((name) =>
      name.includes(".") ? readFileSync(join(deck, name)).toString("base64") : "",
    );
    await exported(deck, join(root, "out.pptx"));
    expect(listing()).toEqual(before);
    expect(
      before.map((name) => (name.includes(".") ? readFileSync(join(deck, name)).toString("base64") : "")),
    ).toEqual(contents);
  }, 120_000);
});
