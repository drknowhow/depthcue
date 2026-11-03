import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir } from "../src/serve.ts";

/**
 * Step 9a's fixes to the PowerPoint export, against the real player in a real browser: every run names its face as the
 * font list does, a chart's caption, legend and plot each have their own place, and picture mode draws the same
 * pictures every time, with the processor busy.
 */

const decks = (name: string) => fileURLToPath(new URL(`../../../fixtures/decks/${name}`, import.meta.url));

let skipReason: string | undefined;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-fixes-e2e-"));
  try {
    if (!existsSync(join(builtPlayerDir(), "app.js")))
      throw new Error("The player is not built. Run pnpm build.");
    const browser = await launchBrowser();
    await browser.close();
  } catch (error) {
    // CI builds first and has Chrome, so it must not skip. A machine without either can run everything else.
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs the test only where a browser and the built player are, and says why it did not run elsewhere. */
const live = (name: string, test: () => Promise<void>, timeout: number) =>
  it(
    name,
    async (context) => {
      if (skipReason !== undefined) {
        console.warn(`Skipped: ${skipReason}`);
        return context.skip();
      }
      await test();
    },
    timeout,
  );

async function exportPptx(folder: string, out: string, ...flags: string[]) {
  const lines: string[] = [];
  const code = await run(["export", folder, "--format", "pptx", "--out", out, "--json", ...flags], {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  });
  if (code !== 0) throw new Error(`The export exited ${code}: ${lines.join("\n")}`);
}

async function unzip(file: string) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name]?.dir)
    .sort();
  const text = (name: string) => (zip.file(name) as JSZip.JSZipObject).async("string");
  const bytes = (name: string) => (zip.file(name) as JSZip.JSZipObject).async("uint8array");
  return { names, text, bytes };
}

/** Exports each deck once, the first time a test asks for it. */
const exports = new Map<string, Promise<Awaited<ReturnType<typeof unzip>>>>();
const exported = (deck: string) => {
  let found = exports.get(deck);
  if (!found) {
    const out = join(root, `${deck}.pptx`);
    found = exportPptx(decks(deck), out).then(() => unzip(out));
    exports.set(deck, found);
  }
  return found;
};

// ---------------------------------------------------------------------------------------------------------------------
// Item 1: every run's face as the font list names it.
// ---------------------------------------------------------------------------------------------------------------------

const RUN_PARTS = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;

describe("font tags", () => {
  live(
    "name each face in the slides, layouts and masters as the embedded font list does, with no other scripts' faces",
    async () => {
      const file = await exported("v0-4-brand");
      const presentation = await file.text("ppt/presentation.xml");
      const listed = new Map(
        [...presentation.matchAll(/<p:font typeface="([^"]*)"([^>]*?)\/>/g)].map((found) => [
          found[1] as string,
          found[2] as string,
        ]),
      );
      // The brand's sans (by its file's own name) and the built-in mono.
      expect([...listed.keys()].sort()).toEqual(["IBM Plex Mono", "Space Grotesk"]);
      let matched = 0;
      for (const name of file.names.filter((part) => RUN_PARTS.test(part))) {
        const xml = await file.text(name);
        expect(xml.match(/<a:(?:ea|cs) typeface="[^+][^"]*"[^>]*\/>/g) ?? [], name).toEqual([]);
        for (const tag of xml.match(/<a:latin\b[^>]*\/>/g) ?? []) {
          const typeface = /typeface="([^"]*)"/.exec(tag)?.[1] as string;
          if (typeface.startsWith("+")) continue;
          const attributes = listed.get(typeface);
          if (attributes === undefined) {
            expect(tag, name).toMatch(/^<a:latin typeface="[^"]*" pitchFamily="\d+" charset="\d+"\/>$/);
            continue;
          }
          expect(tag, name).toBe(`<a:latin typeface="${typeface}"${attributes}/>`);
          matched++;
        }
      }
      expect(matched).toBeGreaterThan(10);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Item 2: a chart's caption, legend and plot.
// ---------------------------------------------------------------------------------------------------------------------

interface Layout {
  x: number;
  y: number;
  w?: number;
  h?: number;
  target?: string;
}

function layoutOf(part: string | undefined): Layout | undefined {
  const layout = part && /<c:manualLayout>([\s\S]*?)<\/c:manualLayout>/.exec(part)?.[1];
  if (!layout) return undefined;
  const value = (name: string) => {
    const found = new RegExp(`<c:${name} val="([^"]*)"/>`).exec(layout)?.[1];
    return found === undefined ? undefined : Number(found);
  };
  const w = value("w");
  const h = value("h");
  const target = /<c:layoutTarget val="([^"]*)"/.exec(layout)?.[1];
  return {
    x: value("x") as number,
    y: value("y") as number,
    ...(w === undefined ? {} : { w }),
    ...(h === undefined ? {} : { h }),
    ...(target === undefined ? {} : { target }),
  };
}

/** The first text size a part of a chart names, in pixels. */
const sizeOf = (part: string) => (Number(/<a:defRPr\b[^>]*\bsz="(\d+)"/.exec(part)?.[1]) / 100) * (96 / 72);

/** Each chart in a file: its part, and its frame on its slide in pixels. */
async function chartsOf(file: Awaited<ReturnType<typeof unzip>>) {
  const charts: Array<{ name: string; xml: string; w: number; h: number }> = [];
  for (const slide of file.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
    const xml = await file.text(slide);
    const rels = await file.text(slide.replace("slides/", "slides/_rels/").replace(/\.xml$/, ".xml.rels"));
    for (const frame of xml.match(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g) ?? []) {
      const id = /<c:chart [^>]*r:id="([^"]*)"/.exec(frame)?.[1];
      if (!id) continue;
      const target = new RegExp(`Id="${id}"[^>]*Target="(?:/ppt|\\.\\.)/charts/([^"]*)"`).exec(rels)?.[1];
      const size = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(frame);
      const name = `ppt/charts/${target}`;
      charts.push({
        name,
        xml: await file.text(name),
        w: Number(size?.[1]) / 9525,
        h: Number(size?.[2]) / 9525,
      });
    }
  }
  return charts;
}

/** A thousandth of the frame, for edges the writer rounds. */
const EDGE = 0.001;

describe("native charts", () => {
  it.each([
    ["v0-4-brand", 1],
    ["charts", 8],
  ])(
    "give each chart's caption, legend and plot their own place in %s",
    async (deck, count) => {
      if (skipReason !== undefined) return;
      const charts = await chartsOf(await exported(deck));
      expect(charts).toHaveLength(count);
      const sides = new Set<string>();
      for (const chart of charts) {
        const at = (what: string) => `${deck} ${chart.name}: ${what}`;
        const titlePart = /<c:title>[\s\S]*?<\/c:title>/.exec(chart.xml)?.[0];
        const legendPart = /<c:legend>[\s\S]*?<\/c:legend>/.exec(chart.xml)?.[0];
        const plot = layoutOf(
          /<c:plotArea>\s*(?:<c:layout\/>|<c:layout>[\s\S]*?<\/c:layout>)/.exec(chart.xml)?.[0],
        );
        expect(plot?.target, at("plot")).toBe("outer");
        const box = plot as Required<Layout>;
        expect(box.w * box.h, at("plot area")).toBeGreaterThan(0.3);
        expect(box.x + box.w, at("plot right")).toBeLessThanOrEqual(1 + EDGE);
        expect(box.y + box.h, at("plot bottom")).toBeLessThanOrEqual(1 + EDGE);
        /** Where the next part down may start: below the caption, then below a legend above the plot. */
        let free = 0;
        if (titlePart) {
          const title = layoutOf(titlePart);
          expect(title, at("caption")).toBeDefined();
          free = (title as Layout).y + sizeOf(titlePart) / chart.h;
        }
        if (legendPart) {
          const side = /<c:legendPos val="([^"]*)"/.exec(legendPart)?.[1] as string;
          sides.add(side);
          const legend = layoutOf(legendPart);
          expect(legend, at("legend")).toBeDefined();
          const corner = legend as Layout;
          if (side === "t") {
            expect(corner.y, at("legend under the caption")).toBeGreaterThanOrEqual(free - EDGE);
            free = corner.y + sizeOf(legendPart) / chart.h;
          } else {
            expect(side, at("legend side")).toBe("r");
            expect(corner.x, at("legend right of the plot")).toBeGreaterThanOrEqual(box.x + box.w - EDGE);
            expect(corner.y, at("legend under the caption")).toBeGreaterThanOrEqual(free - EDGE);
          }
        }
        expect(box.y, at("plot under the caption and legend")).toBeGreaterThanOrEqual(free - EDGE);
      }
      if (deck === "charts") expect([...sides].sort()).toEqual(["r", "t"]);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Item 5: picture mode's bytes.
// ---------------------------------------------------------------------------------------------------------------------

/** Keeps `count` threads busy until the returned function is called. */
function busy(count: number): () => Promise<void> {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const code = `const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData);
let x = 0;
while (Atomics.load(flag, 0) === 0) for (let i = 0; i < 100000; i++) x = Math.sqrt(x + i);`;
  const workers = Array.from(
    { length: count },
    () => new Worker(code, { eval: true, workerData: flag.buffer }),
  );
  return async () => {
    Atomics.store(flag, 0, 1);
    await Promise.all(workers.map((worker) => worker.terminate()));
  };
}

describe("picture mode", () => {
  live(
    "draws a slide's picture the same on every run, with the processor busy",
    async () => {
      // The content-range deck's chart slide, alone, which came out a shade apart from one run to the next.
      const folder = join(root, "data-deck");
      cpSync(decks("v0-3"), folder, { recursive: true });
      const deck = JSON.parse(readFileSync(join(folder, "deck.json"), "utf8"));
      deck.scenes = ["data"];
      writeFileSync(join(folder, "deck.json"), `${JSON.stringify(deck, null, 2)}\n`);
      const pictures = new Map<string, number>();
      const stop = busy(Math.max(1, Math.floor(availableParallelism() / 2)));
      try {
        for (let at = 0; at < 8; at++) {
          const out = join(root, `data-${at}.pptx`);
          await exportPptx(folder, out, "--pictures");
          const file = await unzip(out);
          const media = file.names.filter((name) => name.startsWith("ppt/media/"));
          expect(media.length).toBeGreaterThan(0);
          const hash = createHash("sha256");
          for (const name of media) hash.update(name).update(await file.bytes(name));
          const key = hash.digest("hex");
          pictures.set(key, (pictures.get(key) ?? 0) + 1);
        }
      } finally {
        await stop();
      }
      expect([...pictures.values()]).toEqual([8]);
    },
    240_000,
  );
});
