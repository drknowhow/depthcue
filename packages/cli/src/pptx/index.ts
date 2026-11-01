/**
 * `depthcue export <deck> --format pptx`: the deck as a PowerPoint file whose text, tables and charts are PowerPoint's
 * own and can be edited there. The player draws each scene at full reveal in a headless browser; what it measured is
 * drawn as slides (`build.ts`), and the file is tidied so the same deck gives the same bytes and marked as Depthcue's
 * (`package.ts`), so a later export may replace it and nothing else.
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Diagnostic, Doc } from "@depthcue/core";
import type { Browser } from "playwright-core";
import { openDeck } from "../deck-api.ts";
import { launchBrowser, RenderError } from "../render.ts";
import { builtPlayerDir, startServer } from "../serve.ts";
import { buildPresentation, type FontUse, type SlideReport } from "./build.ts";
import { measureSlide, type SlideMeasure } from "./measure.ts";
import { finishPackage, inspectOutput } from "./package.ts";

export type { FontUse, SlideReport } from "./build.ts";

export type PptxErrorCode =
  | "player-not-built"
  | "no-browser"
  | "render-failed"
  | "bad-out"
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

export interface PptxRequest {
  folder: string;
  /** Where the file goes. Default: `<deck folder name>.pptx` in the current directory. */
  out?: string;
  /** Put each scene's speaker notes in the file. Anyone with the file can read them. Default true. */
  notes?: boolean;
}

export interface PptxSummary {
  out: string;
  scenes: number;
  bytes: number;
  notes: boolean;
  /** The families the file names, and what each is used for: what a viewer needs installed to see it as drawn. */
  fonts: FontUse[];
  /** For each slide, in order, what had no PowerPoint form. */
  slides: SlideReport[];
  /** Things that hold for every slide. */
  deck: string[];
  /** Warnings the deck has. Errors stop the export, so these are all there is. */
  warnings: Diagnostic[];
}

export type PptxResult = { ok: true; summary: PptxSummary } | { ok: false; diagnostics: Diagnostic[] };

/** Nothing on the stage should move or fade while it is measured, and the controls are not part of the slide. */
const CLEAN_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.dc-controls { display: none !important; }
`;

/** The slide size in CSS pixels, which is the stage the player draws at: 13.333 by 7.5 inches. */
const STAGE = { width: 1280, height: 720 } as const;

/** What the player does between scenes and PowerPoint cannot be asked to do alike. */
const DECK_NOTES = [
  "Scene changes: the player moves between scenes with a slide-over; the slides change with no transition.",
] as const;

async function measureScene(
  browser: Browser,
  url: string,
  scene: string,
  steps: number,
): Promise<SlideMeasure> {
  const context = await browser.newContext({
    viewport: { width: STAGE.width, height: STAGE.height },
    deviceScaleFactor: 1,
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
    await page.goto(`${url}#/${scene}${steps > 0 ? `/${steps}` : ""}`, { waitUntil: "load" });
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
    await page.evaluate(() => (window as { depthcue?: { settled(): Promise<void> } }).depthcue?.settled());
    return await page.evaluate(measureSlide);
  } finally {
    await context.close();
  }
}

/** Every scene at full reveal, in deck order, in one browser. */
async function measureScenes(folder: string, doc: Doc): Promise<SlideMeasure[]> {
  const server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    await server.close();
    if (error instanceof RenderError) throw new PptxError("no-browser", error.message);
    throw error;
  }
  try {
    const measures: SlideMeasure[] = [];
    for (const id of doc.deck.scenes) {
      const scene = doc.scenes[id];
      if (!scene) throw new PptxError("render-failed", `The deck names scene "${id}" and it has no file.`);
      measures.push(await measureScene(browser, server.url, id, scene.steps?.length ?? 0));
    }
    return measures;
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

export async function exportPptx(request: PptxRequest): Promise<PptxResult> {
  const notes = request.notes ?? true;
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  const { doc } = opened;

  const out = resolve(request.out ?? `${basename(resolve(request.folder))}.pptx`);
  if (extname(out).toLowerCase() !== ".pptx") {
    throw new PptxError("bad-out", `${out} does not end in .pptx. Name the file with --out <name>.pptx.`);
  }
  // Refuse before the browser starts: a refused export should cost nothing.
  await checkOutput(out);

  const measures = await measureScenes(request.folder, doc);
  const { numberText } = await import("@depthcue/player");
  const { styleOf } = await import("@depthcue/core");
  const scenes = doc.deck.scenes.map((id) => doc.scenes[id]).filter((scene) => scene !== undefined);
  const built = await buildPresentation({
    deck: doc.deck,
    style: styleOf(doc.deck),
    scenes,
    measures,
    folder: request.folder,
    notes,
    numberText,
  });
  const bytes = await finishPackage(built.raw, { headers: built.headers });

  // The folder may have gained a file while the browser ran, so look again before replacing anything.
  await checkOutput(out);
  const temporary = `${out}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(temporary, bytes);
    renameSync(temporary, out);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new PptxError(
      "write-failed",
      `Could not write ${out}: ${(error as Error).message}. If it is open in PowerPoint, close it and run the export again.`,
    );
  }
  return {
    ok: true,
    summary: {
      out,
      scenes: scenes.length,
      bytes: bytes.length,
      notes,
      fonts: built.fonts,
      slides: built.slides,
      deck: [...DECK_NOTES],
      warnings: opened.diagnostics,
    },
  };
}
