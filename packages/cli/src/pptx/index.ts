/**
 * `depthcue export <deck> --format pptx`: the deck as a PowerPoint file whose text, tables and charts are PowerPoint's
 * own and can be edited there. The player draws each scene at full reveal in a headless browser; what it measured is
 * drawn as slides (`build.ts`), a branded deck gets its brand as the slide master and its templates as layouts
 * (`master.ts`), the faces it draws in are embedded (`fonts.ts`), and the file is tidied so the same deck gives the same
 * bytes and marked as Depthcue's (`package.ts`), so a later export may replace it and nothing else.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { type Diagnostic, type Doc, lookOf, type Scene } from "@depthcue/core";
import type { Browser } from "playwright-core";
import { openDeck } from "../deck-api.ts";
import { within as inside, realish } from "../export.ts";
import { launchBrowser } from "../render.ts";
import { builtPlayerDir, startServer } from "../serve.ts";
import { buildPresentation, type FontUse, type SlideReport } from "./build.ts";
import {
  applyNames,
  type FontReport,
  faceFiles,
  listFonts,
  matchFontTags,
  planFonts,
  scanUsage,
  type Usage,
} from "./fonts.ts";
import { applyMaster, applySceneBackgrounds, describeShape } from "./master.ts";
import { measureSlide, type SlideMeasure } from "./measure.ts";
import { finishPackage, inspectOutput, ownLabelFace } from "./package.ts";

export type { FontUse, SlideReport } from "./build.ts";
export type { FontReport } from "./fonts.ts";

/** One family the slides are set in: what it is used for, and which of its faces the file carries, once per family. */
export interface FontEntry extends FontUse {
  /** The name PowerPoint knows it by, when that is another one. */
  as?: string;
  /** The faces whose own files are in the file. Empty when none is. */
  embedded: string[];
  /** Why a face the slides draw, or the whole family, is not in the file, and anything else to know. */
  notes: string[];
}

export type PptxErrorCode =
  | "player-not-built"
  | "no-browser"
  | "render-failed"
  | "bad-out"
  | "out-in-deck"
  | "out-not-ours"
  | "out-edited"
  | "write-failed";

/** The export could not run, as opposed to the deck having errors. The message says what to change. */
export class PptxError extends Error {
  constructor(
    readonly code: PptxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** How the file is made: the same for the CLI, the live server and the MCP tool. */
export interface PptxOptions {
  /** Put each scene's speaker notes in the file. Anyone with the file can read them. Default true. */
  notes?: boolean;
  /** Each slide is one picture of the scene as the player draws it, 1920 by 1080, with its notes (`--pictures`). */
  pictures?: boolean;
  /** One slide for each step of a scene with build steps, from the scene as it opens to every step taken (`--steps`). */
  steps?: boolean;
  /** Every clip as its poster and a link, none embedded (`--posters`). */
  posters?: boolean;
}

export interface PptxRequest extends PptxOptions {
  folder: string;
  /** Where the file goes. Default: `<deck folder name>.pptx` in the current directory. */
  out?: string;
  /** Replaces the built player the scenes are drawn by. For tests. */
  playerDir?: string;
}

export interface PptxSummary {
  out: string;
  scenes: number;
  bytes: number;
  notes: boolean;
  pictures: boolean;
  steps: boolean;
  posters: boolean;
  /** The slide layouts, by name, in order: the blank one, then one per template. Empty for a deck with no brand. */
  layouts: string[];
  /** The families the file names, once each: what each is used for, which faces are embedded, why the rest are not. */
  fonts: FontEntry[];
  /** For each slide, in order, what had no PowerPoint form. */
  slides: SlideReport[];
  /** Things that hold for every slide. */
  deck: string[];
  /** Warnings the deck has. Errors stop the export, so these are all there is. */
  warnings: Diagnostic[];
}

export type PptxResult = { ok: true; summary: PptxSummary } | { ok: false; diagnostics: Diagnostic[] };

/** The file as bytes, and what it says, before anything is written. */
export type PptxBytes =
  | { ok: true; bytes: Buffer; summary: PptxSummary }
  | { ok: false; diagnostics: Diagnostic[] };

/** Nothing on the stage should move or fade while it is measured, and the controls are not part of the slide. */
const CLEAN_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.dc-controls { display: none !important; }
`;

/** The slide size in CSS pixels, which is the stage the player draws at: 13.333 by 7.5 inches. */
const STAGE = { width: 1280, height: 720 } as const;
/** A picture slide is the stage drawn at one and a half times: 1920 by 1080. */
const PICTURE_SCALE = 1.5;

/** What the player does between scenes and PowerPoint cannot be asked to do alike. */
const DECK_NOTES = [
  "Scene changes: the player moves between scenes with a slide-over; the slides change with no transition.",
] as const;

/** The deck's warnings that change what the file shows, said where they matter. */
const RAISED = new Set(["slot-empty", "face-without-files", "background-unmeasured"]);

/**
 * How long the page gets for the two things that wait on it, in milliseconds: the modules that hydrate after the scene
 * shows, and the measuring itself. Neither has a clock of its own, so a page that never settles would hold the export,
 * and the browser with it, for good. (A test shortens these; nothing else changes them.)
 */
export const LIMITS = { settle: 15_000, measure: 15_000 };

/**
 * The work, or a refusal when it has not finished in time. Whatever the work does later is no longer anyone's
 * business: closing the browser makes it fail, and that failure must not go unheard and take the process down.
 */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new PptxError("render-failed", `${what} within ${ms / 1000} seconds.`)),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** One slide's worth of drawing: the scene at a step, as measured, and as a picture in picture mode. */
interface Drawn {
  scene: Scene;
  measure: SlideMeasure;
  picture?: Uint8Array;
  step?: { at: number; of: number };
}

async function measureScene(
  browser: Browser,
  url: string,
  scene: string,
  step: number,
  picture: boolean,
): Promise<{ measure: SlideMeasure; picture?: Uint8Array }> {
  const context = await browser.newContext({
    viewport: { width: STAGE.width, height: STAGE.height },
    deviceScaleFactor: picture ? PICTURE_SCALE : 1,
    reducedMotion: "reduce",
    colorScheme: "light",
    bypassCSP: true,
    serviceWorkers: "block",
  });
  try {
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    await page.goto(`${url}#/${scene}${step > 0 ? `/${step}` : ""}`, { waitUntil: "load" });
    await page.addStyleTag({ content: CLEAN_CSS });
    try {
      await page.waitForSelector(`.dc-scene[data-scene="${scene}"]`, { timeout: 10_000 });
    } catch {
      throw new PptxError(
        "render-failed",
        `The player did not show scene "${scene}".${problems.length > 0 ? ` Page errors: ${problems.join("; ")}` : ""}`,
      );
    }
    // Modules hydrate a moment after the scene shows; measure the settled page.
    await within(
      page.evaluate(() => (window as { depthcue?: { settled(): Promise<void> } }).depthcue?.settled()),
      LIMITS.settle,
      `The player did not settle scene "${scene}"`,
    );
    const measure = await within(
      page.evaluate(measureSlide),
      LIMITS.measure,
      `The page did not finish measuring scene "${scene}"`,
    );
    if (!picture) return { measure };
    const shot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    return { measure, picture: new Uint8Array(shot) };
  } finally {
    await context.close();
  }
}

/**
 * Every slide's drawing, in deck order, in one browser: each scene at full reveal, or at each of its steps with
 * `--steps`.
 */
async function measureScenes(
  folder: string,
  doc: Doc,
  playerDir: string,
  options: PptxOptions,
): Promise<Drawn[]> {
  const server = await startServer({ folder, playerDir, port: 0 });
  let browser: Browser;
  try {
    // Rasterized on the GPU, a slide's edges come out a shade apart from one run to the next; on the CPU they are the
    // same every time, so the same deck gives the same pictures.
    browser = await launchBrowser(["--disable-gpu-rasterization"]);
  } catch (error) {
    await server.close();
    throw new PptxError("no-browser", (error as Error).message);
  }
  try {
    const drawn: Drawn[] = [];
    for (const id of doc.deck.scenes) {
      const scene = doc.scenes[id];
      if (!scene) throw new PptxError("render-failed", `The deck names scene "${id}" and it has no file.`);
      const steps = scene.steps?.length ?? 0;
      const shown = options.steps && steps > 0 ? [...Array(steps + 1).keys()] : [steps];
      for (const step of shown) {
        try {
          const found = await measureScene(browser, server.url, id, step, options.pictures === true);
          drawn.push({
            scene,
            measure: found.measure,
            ...(found.picture ? { picture: found.picture } : {}),
            ...(shown.length > 1 ? { step: { at: step, of: steps } } : {}),
          });
        } catch (error) {
          // A page that times out, or a player that drew no scene, is a render that failed like any other.
          if (error instanceof PptxError) throw error;
          throw new PptxError(
            "render-failed",
            `Scene "${id}" could not be measured: ${(error as Error).message}`,
          );
        }
      }
    }
    return drawn;
  } finally {
    await browser.close();
    await server.close();
  }
}

/** Turns what is at the output path into a refusal, or nothing when Depthcue may write there. */
async function checkOutput(out: string): Promise<void> {
  try {
    if (statSync(out).isDirectory()) {
      throw new PptxError("bad-out", `${out} is a folder. Name the file: --out ${join(out, "deck.pptx")}`);
    }
  } catch (error) {
    if (error instanceof PptxError) throw error;
  }
  const found = await inspectOutput(out);
  if (found === "foreign") {
    throw new PptxError(
      "out-not-ours",
      `${out} exists and Depthcue did not write it, so nothing was written. Choose another name with --out, or move that file away.`,
    );
  }
  if (found === "edited") {
    throw new PptxError(
      "out-edited",
      `${out} was written by Depthcue and has been changed since, in PowerPoint or by hand, so nothing was written. Choose another name with --out, or delete that file to export again.`,
    );
  }
}

/** The file a deck exports to when the caller names none: `<deck folder name>.pptx` in the current directory. */
export const defaultOut = (folder: string) => resolve(`${basename(resolve(folder))}.pptx`);

function outPath(out: string): string {
  const path = resolve(out);
  if (extname(path).toLowerCase() !== ".pptx") {
    throw new PptxError("bad-out", `${path} does not end in .pptx. Name the file with --out <name>.pptx.`);
  }
  return path;
}

/** The built player the scenes are drawn by, or a refusal that says to build it. */
function playerOf(request: PptxRequest): string {
  const dir = request.playerDir ?? builtPlayerDir();
  for (const name of ["app.js", "player.css"]) {
    if (!existsSync(join(dir, name))) {
      throw new PptxError(
        "player-not-built",
        `The player is not built (${join(dir, name)} is missing), and the export draws every scene with it. Build it first: pnpm build.`,
      );
    }
  }
  return dir;
}

/** The parts whose runs name their faces: slides, layouts and masters. */
const RUN_PARTS = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

/** The slides' and charts' runs, by family: which faces and characters each draws, for the fonts to embed. */
function usageOf(parts: Map<string, Uint8Array>): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  const names = [...parts.keys()].sort();
  for (const name of names) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) scanUsage(decode(parts.get(name) as Uint8Array), usage);
    else if (/^ppt\/charts\/chart\d+\.xml$/.test(name))
      scanUsage(ownLabelFace(decode(parts.get(name) as Uint8Array)), usage, true);
  }
  return usage;
}

/** Each family once, from what the slides use it for and what the fonts step did with it, in name order. */
function fontEntries(uses: readonly FontUse[], reports: readonly FontReport[]): FontEntry[] {
  const byFamily = new Map<string, FontEntry>();
  const entry = (family: string) => {
    const known = byFamily.get(family);
    if (known) return known;
    const made: FontEntry = { family, roles: [], embedded: [], notes: [] };
    byFamily.set(family, made);
    return made;
  };
  for (const use of uses) {
    const found = entry(use.family);
    found.roles = [...new Set([...found.roles, ...use.roles])].sort();
  }
  for (const report of reports) {
    const found = entry(report.family);
    if (report.as !== undefined) found.as = report.as;
    found.embedded = [...new Set([...found.embedded, ...report.embedded])];
    found.notes = [...new Set([...found.notes, ...report.notes])];
  }
  return [...byFamily.values()].sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
}

type Opened = Extract<ReturnType<typeof openDeck>, { ok: true }>;

/**
 * The PowerPoint file for a deck, as bytes, with its report: nothing is written anywhere. `out` is where the file will
 * be, which a link to a file in the deck is written relative to, so the same deck and `out` give the same bytes.
 */
export async function renderPptx(request: PptxRequest & { out: string }): Promise<PptxBytes> {
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  return render(opened, request);
}

/** `renderPptx` for a deck already opened. */
async function render(opened: Opened, request: PptxRequest & { out: string }): Promise<PptxBytes> {
  const notes = request.notes ?? true;
  const pictures = request.pictures === true;
  const steps = request.steps === true;
  const posters = request.posters === true;
  const { doc } = opened;
  const out = outPath(request.out);
  const playerDir = playerOf(request);

  const drawn = await measureScenes(request.folder, doc, playerDir, { pictures, steps });
  const { numberText } = await import("@depthcue/player");
  const { styleOf } = await import("@depthcue/core");
  const look = lookOf(doc);
  const scenes = drawn.map((entry) => entry.scene);
  const measures = drawn.map((entry) => entry.measure);
  const branded = doc.brand !== undefined;
  const master = branded || pictures;
  const built = await buildPresentation({
    deck: doc.deck,
    style: styleOf(doc.deck, doc.brand),
    scenes,
    measures,
    folder: request.folder,
    out,
    notes,
    numberText,
    master,
    posters,
    ...(pictures ? { pictures: drawn.map((entry) => entry.picture) } : {}),
    ...(steps ? { steps: drawn.map((entry) => entry.step) } : {}),
  });

  let layouts: string[] = [];
  let embedded: FontReport[] = [];
  const numbers = scenes.map((scene) => doc.deck.scenes.indexOf(scene.id) + 1);
  const bytes = await finishPackage(built.raw, {
    headers: built.headers,
    charts: built.charts,
    edit: (parts) => {
      if (master) layouts = applyMaster(parts, { look, scenes, measures, pictures, numbers }).layouts;
      applySceneBackgrounds(parts, { look, scenes, measures, pictures });
      built.alts.forEach((alts, at) => {
        const name = `ppt/slides/slide${at + 1}.xml`;
        const slide = parts.get(name);
        if (!slide || Object.keys(alts).length === 0) return;
        let xml = decode(slide);
        for (const [shape, text] of Object.entries(alts)) xml = describeShape(xml, shape, text);
        parts.set(name, encode(xml));
      });
      // The faces the slides draw in, embedded, and the slides naming each by the name PowerPoint knows it by.
      const fonts = planFonts(usageOf(parts), faceFiles(look, request.folder, join(playerDir, "fonts")));
      embedded = fonts.report;
      const mono = new Set(
        [...measures.map((measure) => measure.fonts.mono), look.faces?.mono?.family]
          .filter((family): family is string => family !== undefined)
          .map((family) => fonts.rename.get(family) ?? family),
      );
      for (const [name, part] of parts) {
        if (!name.endsWith(".xml")) continue;
        const xml = applyNames(decode(part), fonts);
        parts.set(name, encode(RUN_PARTS.test(name) ? matchFontTags(xml, fonts, mono) : xml));
      }
      for (const font of fonts.parts) parts.set(font.name, font.bytes);
      const listed = listFonts(
        decode(parts.get("ppt/presentation.xml") as Uint8Array),
        decode(parts.get("ppt/_rels/presentation.xml.rels") as Uint8Array),
        decode(parts.get("[Content_Types].xml") as Uint8Array),
        fonts,
      );
      parts.set("ppt/presentation.xml", encode(listed.presentation));
      parts.set("ppt/_rels/presentation.xml.rels", encode(listed.rels));
      parts.set("[Content_Types].xml", encode(listed.types));
    },
  });

  // The deck's warnings that change what the file shows: an empty slot on its slides, the rest for the whole deck.
  const raised = opened.diagnostics.filter((d) => d.severity === "warning" && RAISED.has(d.code));
  built.slides.forEach((slide) => {
    for (const d of raised) {
      if (d.code === "slot-empty" && d.file === `scenes/${slide.scene}.json`) {
        slide.left.push(
          `${d.message} The slide has nothing there; its layout keeps the slot's placeholder (slot-empty).`,
        );
      }
    }
  });
  const deck: string[] = [...DECK_NOTES];
  for (const d of raised) {
    if (d.code === "face-without-files") {
      deck.push(`${d.message} The file cannot embed it either (face-without-files).`);
    } else if (d.code === "background-unmeasured") {
      deck.push(
        `${d.file}: ${d.message} Run depthcue render to measure it before you trust the slides (background-unmeasured).`,
      );
    }
  }
  if (steps && look.chrome?.number && built.slides.some((slide) => slide.step !== undefined)) {
    deck.push(
      "Slide numbers: with one slide per step, PowerPoint numbers every slide, so a scene's steps do not share its number as they do in the player.",
    );
  }
  return {
    ok: true,
    bytes,
    summary: {
      out,
      scenes: doc.deck.scenes.length,
      bytes: bytes.length,
      notes,
      pictures,
      steps,
      posters,
      layouts,
      fonts: fontEntries(built.fonts, embedded),
      slides: built.slides,
      deck,
      warnings: opened.diagnostics,
    },
  };
}

/** Writes the PowerPoint file for a deck, replacing only a file an earlier export wrote and nobody has changed. */
export async function exportPptx(request: PptxRequest): Promise<PptxResult> {
  // A deck with errors is reported before anything else is looked at.
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  const out = outPath(request.out ?? defaultOut(request.folder));
  // The file would be one of the deck's own, and a later check or export would find it there: refused, as the folder
  // export refuses a folder inside the deck.
  if (inside(realish(request.folder), realish(out))) {
    throw new PptxError(
      "out-in-deck",
      `${out} is inside the deck folder. Pick a place outside it for --out.`,
    );
  }
  // Refuse before the browser starts: a refused export should cost nothing.
  await checkOutput(out);
  playerOf(request);

  const result = await render(opened, { ...request, out });
  if (!result.ok) return result;

  // The folder may have gained a file while the browser ran, so look again before replacing anything.
  await checkOutput(out);
  const temporary = `${out}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(temporary, result.bytes);
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new PptxError(
      "write-failed",
      `Could not write ${out}: ${(error as Error).message}. If it is open in PowerPoint, close it and run the export again.`,
    );
  }
  return { ok: true, summary: result.summary };
}
