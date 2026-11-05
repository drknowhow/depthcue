/**
 * The PDF and the zipped page the editor's Export button makes. Both are made from the deck on disk and returned as
 * bytes, and nothing is written outside a temporary folder that is removed afterwards.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { type Comment, type CommentsFile, type Diagnostic, type Doc, isOrphan } from "@depthcue/core";
import JSZip from "jszip";
import type { Browser } from "playwright-core";
import { loadCommentsDir } from "./comments-file.ts";
import { openDeck } from "./deck-api.ts";
import { exportDeck } from "./export.ts";
import { launchBrowser } from "./render.ts";
import { builtPlayerDir, startServer } from "./serve.ts";

export type PageErrorCode =
  | "no-browser"
  | "render-failed"
  | "player-not-built"
  | "bad-comments"
  | "no-ffmpeg";

export class PageExportError extends Error {
  readonly code: PageErrorCode;
  constructor(code: PageErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PageOptions {
  /** Include each scene's speaker notes. Default true. */
  notes?: boolean;
  /** Include the deck's comments. Default false. */
  comments?: boolean;
  /** Replaces the built player. For tests. */
  playerDir?: string;
}

export type PageResult =
  | { ok: true; bytes: Buffer; summary: { scenes: number; notes: boolean; comments: number | undefined } }
  | { ok: false; diagnostics: Diagnostic[] };

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The comments beside the deck. A file that is not valid is a refusal: leaving it out would drop what was asked for. */
function commentsOf(folder: string): CommentsFile {
  const read = loadCommentsDir(folder);
  if (read.file === null) {
    throw new PageExportError(
      "bad-comments",
      `The comments file cannot be read, so it cannot go in the export: ${read.diagnostics
        .map((diagnostic) => diagnostic.message)
        .join("; ")}`,
    );
  }
  return read.file;
}

const STYLE = `
@page { size: 13.333in 7.5in; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, "Segoe UI", sans-serif; color: #1c1c1e; }
.slide { width: 13.333in; height: 7.5in; break-after: page; overflow: hidden; }
.slide img { display: block; width: 100%; height: 100%; }
.pages { padding: 0.6in 0.8in; }
.pages h1 { font-size: 24px; margin: 0 0 18px; }
.pages h2 { font-size: 16px; margin: 22px 0 6px; break-after: avoid; }
.pages h3 { font-size: 13px; margin: 14px 0 4px; color: #555; break-after: avoid; }
.pages p { margin: 0 0 8px; white-space: pre-wrap; }
.thread { border-left: 3px solid #bbb; padding-left: 10px; margin: 6px 0 12px; break-inside: avoid; }
.thread.resolved { opacity: 0.65; }
.who { font-weight: 600; }
.at { color: #777; font-size: 12px; }
.tag { font-size: 12px; color: #777; }
`;

const whoOf = (author: string) => (author === "agent" ? "Agent" : "You");

function threadHtml(comment: Comment): string {
  const messages = comment.thread
    .map(
      (message) =>
        `<p><span class="who">${whoOf(message.author)}</span> <span class="at">${escapeHtml(message.at)}</span><br>${escapeHtml(message.text)}</p>`,
    )
    .join("");
  return `<div class="thread${comment.resolved ? " resolved" : ""}"><span class="tag">${escapeHtml(comment.block)}${comment.resolved ? ", resolved" : ""}</span>${messages}</div>`;
}

/**
 * Speaker notes and comments as readable sections, one for each scene in deck order. A comment on something the deck
 * no longer has comes last, under its own heading. Empty when there is nothing to show.
 */
export function notesAndComments(
  doc: Doc,
  file: CommentsFile | undefined,
  options: { notes: boolean },
): string {
  const sections: string[] = [];
  doc.deck.scenes.forEach((id, at) => {
    const scene = doc.scenes[id];
    if (!scene) return;
    const notes = options.notes && scene.notes ? scene.notes : undefined;
    const comments = file?.comments.filter((comment) => comment.scene === id) ?? [];
    if (notes === undefined && comments.length === 0) return;
    sections.push(
      `<h2>${at + 1}. ${escapeHtml(scene.title)}</h2>`,
      ...(notes === undefined ? [] : ["<h3>Speaker notes</h3>", `<p>${escapeHtml(notes)}</p>`]),
      ...(comments.length === 0 ? [] : ["<h3>Comments</h3>", ...comments.map(threadHtml)]),
    );
  });
  const lost = file?.comments.filter((comment) => isOrphan(comment, doc) && !doc.scenes[comment.scene]) ?? [];
  if (lost.length > 0) sections.push("<h2>On slides that are gone</h2>", ...lost.map(threadHtml));
  return sections.join("\n");
}

/** A page of its own for the notes and comments. */
function standalone(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}: notes and comments</title><style>${STYLE}.pages { max-width: 46rem; margin: 0 auto; }</style></head>
<body><main class="pages"><h1>${escapeHtml(title)}</h1>${body}</main></body></html>
`;
}

const STAGE = { width: 1280, height: 720 } as const;
const PDF_SCALE = 1.5;
const CLEAN_CSS = `
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.dc-controls { display: none !important; }
`;

/** Each scene at full reveal as a picture, in deck order. */
async function pictures(folder: string, doc: Doc, playerDir: string): Promise<Buffer[]> {
  const server = await startServer({ folder, playerDir, port: 0 });
  let browser: Browser;
  try {
    browser = await launchBrowser(["--disable-gpu-rasterization"]);
  } catch (error) {
    await server.close();
    throw new PageExportError("no-browser", (error as Error).message);
  }
  try {
    const shots: Buffer[] = [];
    for (const id of doc.deck.scenes) {
      const steps = doc.scenes[id]?.steps?.length ?? 0;
      const context = await browser.newContext({
        viewport: STAGE,
        deviceScaleFactor: PDF_SCALE,
        reducedMotion: "reduce",
        colorScheme: "light",
        bypassCSP: true,
        serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        await page.goto(`${server.url}#/${id}${steps > 0 ? `/${steps}` : ""}`, { waitUntil: "load" });
        await page.addStyleTag({ content: CLEAN_CSS });
        try {
          await page.waitForSelector(`.dc-scene[data-scene="${id}"]`, { timeout: 10_000 });
        } catch {
          throw new PageExportError("render-failed", `The player did not show scene "${id}".`);
        }
        await Promise.race([
          page.evaluate(() => (window as { depthcue?: { settled(): Promise<void> } }).depthcue?.settled()),
          new Promise((resolve) => setTimeout(resolve, 15_000)),
        ]);
        shots.push(await page.screenshot({ type: "png", animations: "disabled", caret: "hide" }));
      } finally {
        await context.close();
      }
    }
    return shots;
  } finally {
    await browser.close();
    await server.close();
  }
}

/** A PDF of the deck: a page for each scene as the player draws it, then the notes and comments asked for. */
export async function renderPdf(request: { folder: string } & PageOptions): Promise<PageResult> {
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  const { doc } = opened;
  const notes = request.notes ?? true;
  const file = request.comments === true ? commentsOf(request.folder) : undefined;
  const playerDir = request.playerDir ?? builtPlayerDir();
  const shots = await pictures(request.folder, doc, playerDir);
  const back = notesAndComments(doc, file, { notes });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.deck.title)}</title><style>${STYLE}</style></head><body>${shots
    .map(
      (shot, at) =>
        `<div class="slide"><img alt="${escapeHtml(doc.scenes[doc.deck.scenes[at] as string]?.title ?? "")}" src="data:image/png;base64,${shot.toString("base64")}"></div>`,
    )
    .join("")}${back ? `<main class="pages"><h1>Notes and comments</h1>${back}</main>` : ""}</body></html>`;
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (error) {
    throw new PageExportError("no-browser", (error as Error).message);
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    return {
      ok: true,
      bytes: Buffer.from(bytes),
      summary: { scenes: shots.length, notes, comments: file?.comments.length },
    };
  } finally {
    await browser.close();
  }
}

function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? filesUnder(root, path)
      : [relative(root, path).split(sep).join("/")];
  });
}

/**
 * The offline page (what `depthcue export` writes to a folder) as one zip, so a browser can save it. With comments it
 * also holds `comments.html`, the notes and comments as a readable page, and `comments.json`, the file itself; the
 * deck's own page never carries them.
 */
export async function renderHtmlZip(request: { folder: string } & PageOptions): Promise<PageResult> {
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  const { doc } = opened;
  const notes = request.notes ?? true;
  const file = request.comments === true ? commentsOf(request.folder) : undefined;
  const work = mkdtempSync(join(tmpdir(), "depthcue-html-"));
  try {
    const name = `${basename(request.folder.replace(/[\\/]+$/, ""))}-export`;
    const out = join(work, name);
    const result = exportDeck({ folder: request.folder, out, notes });
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics };
    const zip = new JSZip();
    const date = new Date("2026-01-01T00:00:00Z");
    for (const path of filesUnder(out).sort()) {
      zip.file(`${name}/${path}`, readFileSync(join(out, path)), { date });
    }
    if (file) {
      zip.file(
        `${name}/comments.html`,
        standalone(doc.deck.title, notesAndComments(doc, file, { notes: false }) || "<p>No comments.</p>"),
        { date },
      );
      zip.file(`${name}/comments.json`, `${JSON.stringify(file, null, 2)}\n`, { date });
    }
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
      ok: true,
      bytes,
      summary: { scenes: doc.deck.scenes.length, notes, comments: file?.comments.length },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
