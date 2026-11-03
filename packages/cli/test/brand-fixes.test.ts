import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importBrand } from "../src/brand-import/index.ts";
import {
  type ChartParts,
  type ChartPlaces,
  chartPlaces,
  layChart,
  overlaps,
  type Rect,
} from "../src/pptx/chartlayout.ts";
import {
  applyNames,
  type FaceFile,
  matchFontTags,
  planFonts,
  type Slot,
  type Usage,
} from "../src/pptx/fonts.ts";
import { unpackFont, writeSfnt } from "../src/pptx/sfnt.ts";
import { MASTER, SVG_NS, writeFixture } from "./brand-import-fixtures.ts";

/**
 * Step 9a's fixes that need no browser: each run's font tag says what kind of face it names, as the font list does; a
 * native chart's caption, legend and plot each get their own place; and a brand import refuses a logo whose SVG is a
 * megabyte of unclosed `url(` at once.
 */

/** How long each call to the SVG check took, inside a real import. */
const checks = vi.hoisted(() => ({ times: [] as number[] }));

vi.mock("../src/brand-import/svg.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/brand-import/svg.ts")>();
  return {
    ...original,
    svgProblem: (text: string) => {
      const started = performance.now();
      try {
        return original.svgProblem(text);
      } finally {
        checks.times.push(performance.now() - started);
      }
    },
  };
});

const brandFonts = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand/brand/fonts", import.meta.url));
const playerFonts = fileURLToPath(new URL("../../../brand/fonts", import.meta.url));
const harborRegular = join(brandFonts, "HarborSans-Regular.woff2");
const plexMono = join(playerFonts, "IBMPlexMono-Regular.ttf");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-fixes-"));
  checks.times.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const face = (family: string, file: string): FaceFile => ({
  family,
  weight: 400,
  italic: false,
  file,
  label: file.split(/[\\/]/).pop() as string,
});

const use = (slots: Slot[], text: string): Usage => ({
  slots: new Set(slots),
  chars: new Set([...text].map((character) => character.codePointAt(0) as number)),
});

/** A copy of a font whose OS/2 table says it may not be embedded. */
function locked(from: string, name: string): string {
  const font = unpackFont(new Uint8Array(readFileSync(from)));
  const os2 = (font.tables.get("OS/2") as Uint8Array).slice();
  new DataView(os2.buffer, os2.byteOffset).setUint16(8, 0x0002);
  font.tables.set("OS/2", os2);
  const file = join(root, name);
  writeFileSync(file, writeSfnt(font));
  return file;
}

/** A run as pptxgenjs writes it: a swiss latin face, and East Asian and complex-script faces of the same name. */
const pptxgenRun = (typeface: string) =>
  `<a:rPr lang="en-US" sz="2400" dirty="0"><a:latin typeface="${typeface}" pitchFamily="34" charset="0"/><a:ea typeface="${typeface}" pitchFamily="34" charset="-122"/><a:cs typeface="${typeface}" pitchFamily="34" charset="-120"/></a:rPr>`;

const fontTags = (xml: string) => xml.match(/<a:(?:latin|ea|cs)\b[^>]*\/>/g) ?? [];

// ---------------------------------------------------------------------------------------------------------------------
// Item 1: font tags.
// ---------------------------------------------------------------------------------------------------------------------

describe("matchFontTags", () => {
  const entry = {
    typeface: "Space Grotesk",
    panose: "",
    pitchFamily: 2,
    charset: 0,
    faces: [{ slot: "regular" as const, part: 1 }],
  };
  const plex = {
    typeface: "IBM Plex Mono",
    panose: "020B0509050203000203",
    pitchFamily: 49,
    charset: 0,
    faces: [{ slot: "regular" as const, part: 2 }],
  };

  it("writes an embedded face's run as the font list names it, without East Asian or complex-script faces", () => {
    const xml = `<p:txBody><a:p><a:r>${pptxgenRun("Space Grotesk")}<a:t>One</a:t></a:r><a:r>${pptxgenRun("IBM Plex Mono")}<a:t>2</a:t></a:r></a:p></p:txBody>`;
    const out = matchFontTags(xml, { list: [entry, plex], others: new Map() }, new Set());
    expect(fontTags(out)).toEqual([
      '<a:latin typeface="Space Grotesk" pitchFamily="2" charset="0"/>',
      '<a:latin typeface="IBM Plex Mono" panose="020B0509050203000203" pitchFamily="49" charset="0"/>',
    ]);
    // Only the tags change.
    expect(out.replace(/<a:(?:latin|ea|cs)\b[^>]*\/>/g, "")).toBe(
      xml.replace(/<a:(?:latin|ea|cs)\b[^>]*\/>/g, ""),
    );
  });

  it("writes a face with a file that is not embedded from its file, and one with no file by what the page draws it as", () => {
    const xml = [pptxgenRun("Code Face"), pptxgenRun("Body Face"), pptxgenRun("Mono Face")].join("");
    const out = matchFontTags(
      xml,
      { list: [], others: new Map([["Code Face", { pitchFamily: 49, charset: 0 }]]) },
      new Set(["Mono Face"]),
    );
    expect(fontTags(out)).toEqual([
      '<a:latin typeface="Code Face" pitchFamily="49" charset="0"/>',
      '<a:latin typeface="Body Face" pitchFamily="2" charset="0"/>',
      '<a:latin typeface="Mono Face" pitchFamily="49" charset="0"/>',
    ]);
  });

  it("keeps the theme's fonts, and reads a name with markup in it", () => {
    const theme =
      '<a:defRPr><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>';
    const named = pptxgenRun("Fish &amp; Chips");
    const out = matchFontTags(
      `${theme}${named}`,
      { list: [{ ...entry, typeface: "Fish & Chips" }], others: new Map() },
      new Set(),
    );
    expect(fontTags(out)).toEqual([
      '<a:latin typeface="+mn-lt"/>',
      '<a:ea typeface="+mn-ea"/>',
      '<a:cs typeface="+mn-cs"/>',
      '<a:latin typeface="Fish &amp; Chips" pitchFamily="2" charset="0"/>',
    ]);
  });

  it("gives the same text for the same runs", () => {
    const xml = pptxgenRun("Space Grotesk").repeat(3);
    const fonts = { list: [entry], others: new Map() };
    expect(matchFontTags(xml, fonts, new Set())).toBe(matchFontTags(xml, fonts, new Set()));
  });
});

describe("planFonts", () => {
  it("keeps the pitch and family of a family whose file may not be embedded, from that file, for its runs", () => {
    const code = locked(plexMono, "locked-mono.ttf");
    const fonts = planFonts(
      new Map([
        ["Code Face", use(["regular"], "abc")],
        ["Harbor Sans", use(["regular"], "abc")],
        ["Nowhere", use(["regular"], "abc")],
      ]),
      new Map([
        ["Code Face", [face("Code Face", code)]],
        ["Harbor Sans", [face("Harbor Sans", harborRegular)]],
      ]),
    );
    // Plex Mono's PANOSE says it is a fixed-pitch modern face; the locked copy is not embedded, and keeps saying so.
    expect(fonts.list.map((entry) => entry.typeface)).toEqual(["Space Grotesk"]);
    expect(fonts.others).toEqual(new Map([["Code Face", { pitchFamily: 49, charset: 0 }]]));

    // As the export does it: the deck's names become the files' own, then the tags follow the list.
    const xml = [pptxgenRun("Harbor Sans"), pptxgenRun("Code Face"), pptxgenRun("Nowhere")].join("");
    const out = matchFontTags(applyNames(xml, fonts), fonts, new Set());
    expect(fontTags(out)).toEqual([
      '<a:latin typeface="Space Grotesk" pitchFamily="2" charset="0"/>',
      '<a:latin typeface="Code Face" pitchFamily="49" charset="0"/>',
      '<a:latin typeface="Nowhere" pitchFamily="2" charset="0"/>',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Item 2: a chart's caption, legend and plot.
// ---------------------------------------------------------------------------------------------------------------------

const frame = { x: 100, y: 50, w: 600, h: 400 };
const caption = { x: 100, y: 50, w: 280, h: 22 };
/** The plot as a page draws it under its caption, before anything gives way. */
const wholePlot = { x: 100, y: 70, w: 600, h: 380 };
const area = (rect: Rect) => rect.w * rect.h;

/** The places that are set, in a fixed order. */
const boxes = (places: ChartPlaces) =>
  [places.title, places.legend, places.plot].filter((rect): rect is Rect => rect !== undefined);

/** Smaller by a millionth of the frame on each side, for the sums of rounded edges. */
const inset = (rect: Rect): Rect => ({
  x: rect.x + 1e-6,
  y: rect.y + 1e-6,
  w: rect.w - 2e-6,
  h: rect.h - 2e-6,
});

function expectApart(places: ChartPlaces) {
  const all = boxes(places);
  for (const [at, one] of all.entries()) {
    for (const other of all.slice(at + 1))
      expect(overlaps(inset(one), other), JSON.stringify(places)).toBe(false);
    // Inside the frame.
    expect(one.x).toBeGreaterThanOrEqual(0);
    expect(one.y).toBeGreaterThanOrEqual(0);
    expect(one.x + one.w).toBeLessThanOrEqual(1.0001);
    expect(one.y + one.h).toBeLessThanOrEqual(1.0001);
  }
}

describe("chartPlaces", () => {
  // Where a legend can be beside the plot, each drawn over the plot's edge, and the step 8 slide's: on the caption.
  it.each<[string, ChartParts["legend"]]>([
    ["above the plot", { x: 100, y: 64, w: 320, h: 20 }],
    ["right of the plot", { x: 580, y: 200, w: 120, h: 60 }],
    ["below the plot", { x: 200, y: 420, w: 300, h: 24 }],
    ["left of the plot", { x: 100, y: 200, w: 110, h: 60 }],
    ["on the caption", { x: 100, y: 60, w: 400, h: 20 }],
  ])("gives the caption, a legend %s and the plot each its own place", (_, legend) => {
    const places = chartPlaces({ frame, title: caption, legend, plot: wholePlot });
    expectApart(places);
    expect(places.title).toEqual({ x: 0, y: 0, w: 0.4667, h: 0.055 });
    // The plot gives way to the legend on one side only, and keeps most of the frame.
    expect(area(places.plot)).toBeGreaterThan(0.6);
    expect(places.legend && area(places.legend)).toBeGreaterThan(0);
  });

  it("leaves room for the value axis's title beside the plot, and none below it but for a scatter", () => {
    const places = chartPlaces({ frame, plot: wholePlot, axisRoom: { left: 30, bottom: 0 } });
    expect(places.plot).toEqual({ x: 0.05, y: 0.05, w: 0.95, h: 0.95 });
    const scatter = chartPlaces({ frame, plot: wholePlot, axisRoom: { left: 30, bottom: 20 } });
    expect(scatter.plot).toEqual({ x: 0.05, y: 0.05, w: 0.95, h: 0.9 });
  });

  it("keeps a part drawn past the frame inside it", () => {
    const places = chartPlaces({ frame, plot: { x: 80, y: 40, w: 700, h: 500 } });
    expect(places.plot).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

/** The title's, legend's and plot area's manual layouts in a chart part, as places. */
function placesOf(xml: string) {
  const read = (part: string | undefined) => {
    const layout = part && /<c:manualLayout>([\s\S]*?)<\/c:manualLayout>/.exec(part)?.[1];
    if (!layout) return undefined;
    const value = (name: string) => {
      const found = new RegExp(`<c:${name} val="([^"]*)"/>`).exec(layout)?.[1];
      return found === undefined ? undefined : Number(found);
    };
    return {
      x: value("x"),
      y: value("y"),
      w: value("w"),
      h: value("h"),
      target: /<c:layoutTarget val="([^"]*)"/.exec(layout)?.[1],
    };
  };
  return {
    title: read(/<c:title>[\s\S]*?<\/c:title>/.exec(xml)?.[0]),
    legend: read(/<c:legend>[\s\S]*?<\/c:legend>/.exec(xml)?.[0]),
    plot: read(/<c:plotArea>\s*(?:<c:layout\/>|<c:layout>[\s\S]*?<\/c:layout>)/.exec(xml)?.[0]),
  };
}

describe("layChart", () => {
  /** A chart part as pptxgenjs writes one with a title placed by `titlePos` and a legend at the top. */
  const written = (legendPos: string) =>
    `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Ships</a:t></a:r></a:p></c:rich></c:tx><c:layout><c:manualLayout><c:xMode val="edge"/><c:yMode val="edge"/><c:x val="0.0128"/><c:y val="0.0640521701388889"/></c:manualLayout></c:layout><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart/><c:catAx/><c:valAx/></c:plotArea><c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;

  it.each(["t", "r", "b", "l"])(
    "writes each part where it was placed, with the legend at %s",
    (legendPos) => {
      const places = chartPlaces({
        frame,
        title: caption,
        legend: { x: 100, y: 64, w: 320, h: 20 },
        plot: wholePlot,
      });
      const out = layChart(written(legendPos), places);
      const read = placesOf(out);
      expect(read.title).toEqual({
        x: places.title?.x,
        y: places.title?.y,
        w: undefined,
        h: undefined,
        target: undefined,
      });
      expect(read.legend).toEqual({
        x: places.legend?.x,
        y: places.legend?.y,
        w: undefined,
        h: undefined,
        target: undefined,
      });
      expect(read.plot).toEqual({ ...places.plot, target: "outer" });
      // The legend keeps its side, and the part keeps the order the schema gives its elements.
      expect(out).toContain(`<c:legendPos val="${legendPos}"/><c:layout>`);
      expect(out.lastIndexOf("</c:layout><c:overlay")).toBeGreaterThan(out.indexOf("<c:legendPos"));
      expect(out.match(/<c:layout\b/g)).toHaveLength(3);
    },
  );

  it("writes only the plot area when the chart has no title or legend", () => {
    const bare = `<c:chartSpace><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:pieChart/></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
    const out = layChart(bare, { plot: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } });
    expect(placesOf(out)).toEqual({
      title: undefined,
      legend: undefined,
      plot: { x: 0.1, y: 0.2, w: 0.5, h: 0.6, target: "outer" },
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Item 8: a hostile logo SVG in a .pptx.
// ---------------------------------------------------------------------------------------------------------------------

describe("brand import of a .pptx whose logo is a megabyte of unclosed url(", () => {
  const MEGABYTE = 1024 * 1024;
  /** An SVG of exactly a megabyte around `inside`, padded with a comment. */
  const svgOf = (inside: string) => {
    const head = `<svg ${SVG_NS}>${inside}<!--`;
    const tail = "--></svg>";
    return new TextEncoder().encode(
      `${head}${" ".repeat(Math.max(0, MEGABYTE - head.length - tail.length))}${tail}`,
    );
  };

  it.each([
    ["a fill", `<rect fill="${"url(".repeat(262_000)}"/>`, /url\(\) this cannot read/],
    ["a style attribute", `<rect style="${"url(".repeat(262_000)}"/>`, /a style longer than 64 KB/],
    ["a style sheet", `<style>${"url(".repeat(262_000)}</style>`, /a style longer than 64 KB/],
    [
      "a style sheet just under the limit",
      `<style>${"url(".repeat(16_000)}</style>`,
      /url\(\) this cannot read/,
    ],
  ])("refuses it in %s in under 100 ms, and imports the rest", async (_, inside, problem) => {
    const bytes = svgOf(inside);
    expect(bytes.length).toBe(MEGABYTE);
    const { file, out } = await writeFixture(root, {
      kind: "pptx",
      master: [
        ...MASTER.filter((shape) => shape.kind !== "pic"),
        { kind: "pic", name: "Logo", frame: { x: 90, y: 5, w: 5, h: 9 }, media: "logo.svg" },
      ],
      media: { "logo.svg": bytes },
    });
    const result = await importBrand({ file, out });
    if (!result.ok) throw new Error(`The import failed: ${result.code}: ${result.message}`);
    expect(result.report.logo).toBeNull();
    const why = result.report.left.find(
      (item) => item.what === 'The picture "Logo" on the slide master',
    )?.why;
    expect(why).toMatch(/its SVG has .*, which a logo may not$/);
    expect(why).toMatch(problem);
    // The one check of the logo's text, timed inside the import.
    expect(checks.times).toHaveLength(1);
    expect(checks.times[0]).toBeLessThan(100);
    expect(JSON.parse(readFileSync(join(out, "brand.json"), "utf8")).logos).toBeUndefined();
  });
});
