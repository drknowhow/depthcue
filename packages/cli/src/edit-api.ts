import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CUE_MAP_FORMAT,
  type Cue,
  type CueMap,
  checkCues,
  commentsRevision,
  cueMapPath,
  type Diagnostic,
  loadDoc,
  type Review,
  readCueMap,
  readReview,
  reviewRevision,
  revisionOf,
} from "@depthcue/core";
import { applyCommentsToFolder, readFolderComments } from "./comments-api.ts";
import { openDeck } from "./deck-api.ts";
import type { LayoutChecker } from "./edit-layout.ts";
import { crossOrigin, isRecord, readBody, sameToken, send, TooLarge } from "./http.ts";
import { loadDeckDir } from "./loader.ts";
import { loadReviewDir, recordPersonWrite, saveReviewDir } from "./review-file.ts";
import { ChangedOnDiskError, saveDeckDir } from "./save.ts";

export interface EditContext {
  /** The deck folder, already resolved to its real path. */
  folder: string;
  /** Secret the editor page was given. Every call must send it, so another web page cannot drive the editor. */
  token: string;
  /** The origins the editor page can have, for the same-origin check. Read per request: the port is known only after listening. */
  origins: () => readonly string[];
  /** Renders a scene to find its layout problems. Without it the editor is told that none can be made. */
  layout?: LayoutChecker;
}

export const MAX_SAVE_BYTES = 8 * 1024 * 1024;
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;

const plain = (d: Diagnostic) => ({
  code: d.code,
  at: `${d.file}${d.path}`,
  severity: d.severity,
  message: d.message,
  ...(d.fix === undefined ? {} : { fix: d.fix }),
});

/**
 * A page on another origin can send a request to a loopback server, so every call has to prove it came from the
 * editor page: the secret in its header, a same-origin Origin or Sec-Fetch-Site when the browser sends one, and
 * a custom header that would force a CORS preflight, which this server never answers.
 */
function authorized(request: IncomingMessage, ctx: EditContext): string | undefined {
  if (!sameToken(request.headers["x-depthcue-token"] as string | undefined, ctx.token)) {
    return "Missing or wrong editor token. Reload the editor page.";
  }
  return crossOrigin(request, ctx.origins());
}

const SAVEABLE = /^(deck\.json|scenes\/[^/\\]+\.json)$/;

/** The change ids a save says are still the agent's. Anything that is not a short list of short strings is ignored. */
export const keptAgent = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length <= 400).slice(0, 500)
    : [];

async function save(request: IncomingMessage, response: ServerResponse, ctx: EditContext) {
  if (!String(request.headers["content-type"]).startsWith("application/json")) {
    return send(response, 415, { error: "bad-request", message: "Send application/json." });
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, MAX_SAVE_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof TooLarge) {
      return send(response, 413, {
        error: "too-large",
        message: "The deck is too large to save in one request.",
      });
    }
    return send(response, 400, { error: "bad-request", message: "The body is not valid JSON." });
  }
  if (!isRecord(body) || typeof body.baseRev !== "string" || !isRecord(body.files)) {
    return send(response, 400, {
      error: "bad-request",
      message:
        "Send { baseRev: string, files: { 'deck.json': string, 'scenes/<id>.json': string }, force?: boolean }.",
    });
  }
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(body.files)) {
    if (!SAVEABLE.test(path) || typeof text !== "string") {
      return send(response, 400, {
        error: "bad-request",
        message: `"${path}" is not a file the editor may write. Only deck.json and scenes/<id>.json.`,
      });
    }
    files[path] = text;
  }

  const onDisk = loadDeckDir(ctx.folder);
  const current = loadDoc(onDisk);
  if (!current.doc) {
    return send(response, 422, {
      error: "deck-has-errors",
      message: "The deck on disk has errors, so nothing was written. Fix the files first.",
      diagnostics: current.diagnostics.filter((d) => d.severity === "error").map(plain),
    });
  }
  const diskRev = revisionOf(current.doc);
  if (body.force !== true && diskRev !== body.baseRev) {
    return send(response, 409, {
      error: "stale",
      message: "The deck changed on disk after the editor loaded it. Nothing was written.",
      rev: diskRev,
    });
  }
  const next = loadDoc({ text: files, assets: onDisk.assets });
  if (!next.doc) {
    return send(response, 422, {
      error: "invalid",
      message: "The deck does not pass validation, so nothing was written.",
      diagnostics: next.diagnostics.filter((d) => d.severity === "error").map(plain),
    });
  }
  try {
    const written = saveDeckDir(ctx.folder, current.doc, next.doc);
    // What the person changed is theirs: it goes into the reviewed deck, so it is never listed as the agent's. The
    // editor names the changes a person reverted and then undid, which come back as the agent's.
    recordPersonWrite(ctx.folder, current.doc, next.doc, keptAgent(body.keepAgent));
    return send(response, 200, { rev: revisionOf(next.doc), written });
  } catch (error) {
    if (error instanceof ChangedOnDiskError) {
      return send(response, 409, { error: "stale", message: error.message, rev: diskRev });
    }
    throw error;
  }
}

function deck(response: ServerResponse, ctx: EditContext) {
  const opened = openDeck(ctx.folder);
  if (!opened.ok) {
    return send(response, 422, {
      error: "deck-has-errors",
      message: "The deck has errors. Fix the files, then reload. `depthcue check` lists them.",
      diagnostics: opened.diagnostics.filter((d) => d.severity === "error").map(plain),
    });
  }
  const files = loadDeckDir(ctx.folder);
  return send(response, 200, {
    rev: revisionOf(opened.doc),
    text: files.text,
    assets: files.assets,
    warnings: opened.diagnostics.filter((d) => d.severity === "warning").map(plain),
  });
}

type ImageKind = "png" | "jpg" | "gif" | "webp" | "svg";

/** The image type from the bytes themselves; the file name and the declared type are not trusted. */
export function sniffImage(bytes: Buffer): ImageKind | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")))
    return "gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  const head = bytes.subarray(0, 2048).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    const all = bytes.toString("utf8").toLowerCase();
    // An image shown in <img> cannot run script, but an exported deck may be opened some other way. Keep it inert.
    if (/<script|<foreignobject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object/.test(all))
      return undefined;
    return "svg";
  }
  return undefined;
}

const EXTENSION: Record<ImageKind, string> = { png: "png", jpg: "jpg", gif: "gif", webp: "webp", svg: "svg" };

/** A safe file name from what the visitor called it: lower case letters, digits and hyphens. */
export function assetName(original: string, kind: ImageKind, bytes: Buffer): string {
  const stem =
    original
      .replace(/\.[A-Za-z0-9]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image";
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return `${stem}-${hash}.${EXTENSION[kind]}`;
}

async function uploadAsset(request: IncomingMessage, response: ServerResponse, url: URL, ctx: EditContext) {
  let bytes: Buffer;
  try {
    bytes = await readBody(request, MAX_ASSET_BYTES);
  } catch (error) {
    if (error instanceof TooLarge) {
      return send(response, 413, { error: "too-large", message: "Images can be up to 15 MB." });
    }
    return send(response, 400, { error: "bad-request", message: "The upload was interrupted." });
  }
  const kind = sniffImage(bytes);
  if (!kind) {
    return send(response, 415, {
      error: "unsupported",
      message: "Only PNG, JPEG, GIF, WebP and plain SVG images can be added. SVG with script is refused.",
    });
  }
  const name = assetName(url.searchParams.get("name") ?? "image", kind, bytes);
  const dir = join(ctx.folder, "assets");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  if (!existsSync(target)) {
    const temporary = `${target}.depthcue-${process.pid}.tmp`;
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
  }
  return send(response, 200, { asset: `assets/${name}`, kind, bytes: bytes.length });
}

export const MAX_CUES_BYTES = 256 * 1024;

/** A video the deck holds, named the way a clip block names it. One segment under assets/, so no path can climb out. */
const CLIP_FILE = /^assets\/[^/\\]+\.(mp4|webm)$/i;

/** The path of a clip's cue map on disk, or why the editor may not keep one for what was asked about. */
function cueFileFor(
  source: unknown,
  ctx: EditContext,
): { source: string; file: string } | { message: string } {
  if (typeof source !== "string" || !CLIP_FILE.test(source)) {
    return { message: "Name a video of the deck, such as assets/intro.mp4." };
  }
  if (!existsSync(join(ctx.folder, ...source.split("/")))) {
    return { message: `There is no ${source} in the deck.` };
  }
  return { source, file: join(ctx.folder, ...cueMapPath(source).split("/")) };
}

type CueFile =
  | { state: "none" }
  /** A file is there that is not a cue map the player would take. It is never overwritten. */
  | { state: "broken" }
  | { state: "ok"; map: CueMap; raw: Record<string, unknown> };

function readCueFile(file: string): CueFile {
  if (!existsSync(file)) return { state: "none" };
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const map = readCueMap(raw);
    return map && isRecord(raw) ? { state: "ok", map, raw } : { state: "broken" };
  } catch {
    return { state: "broken" };
  }
}

function loadCues(response: ServerResponse, url: URL, ctx: EditContext) {
  const named = cueFileFor(url.searchParams.get("source"), ctx);
  if ("message" in named) return send(response, 400, { error: "bad-request", message: named.message });
  const found = readCueFile(named.file);
  return send(
    response,
    200,
    found.state === "ok"
      ? { state: "ok", cues: found.map.cues, duration: found.map.duration }
      : { state: found.state, cues: [] as Cue[] },
  );
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Keeps a clip's cues. The editor sends the whole list and the server checks it the way the player will read it. An
 * existing map keeps everything but its cues, so the build record that lets `depthcue clip build` skip an unchanged
 * clip survives. A clip that was never built has no map, and the editor sends what it measured from the video.
 */
async function saveCues(request: IncomingMessage, response: ServerResponse, ctx: EditContext) {
  if (!String(request.headers["content-type"]).startsWith("application/json")) {
    return send(response, 415, { error: "bad-request", message: "Send application/json." });
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, MAX_CUES_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof TooLarge) {
      return send(response, 413, { error: "too-large", message: "The cues are too large to save." });
    }
    return send(response, 400, { error: "bad-request", message: "The body is not valid JSON." });
  }
  if (!isRecord(body)) {
    return send(response, 400, {
      error: "bad-request",
      message: "Send { source: string, cues: Cue[], clip?: { duration, width, height } }.",
    });
  }
  const named = cueFileFor(body.source, ctx);
  if ("message" in named) return send(response, 400, { error: "bad-request", message: named.message });

  const found = readCueFile(named.file);
  if (found.state === "broken") {
    return send(response, 422, {
      error: "broken",
      message: `${cueMapPath(named.source)} is not a cue map the editor can read, so it was left alone. Fix or remove that file first.`,
    });
  }
  const measured = isRecord(body.clip) ? body.clip : {};
  if (
    found.state === "none" &&
    !(positive(measured.duration) && positive(measured.width) && positive(measured.height))
  ) {
    return send(response, 422, {
      error: "needs-clip",
      message: "This clip has no cue map yet. Send its duration, width and height to start one.",
    });
  }
  const duration = found.state === "ok" ? found.map.duration : (measured.duration as number);
  const checked = checkCues(body.cues, duration);
  if (!checked.ok) return send(response, 422, { error: "invalid", message: checked.message });

  const next =
    found.state === "ok"
      ? { ...found.raw, cues: checked.cues }
      : {
          format: CUE_MAP_FORMAT,
          source: named.source,
          duration,
          width: measured.width,
          height: measured.height,
          // A video that was not built here has no frame rate on record. Nothing reads it, but the format wants one.
          fps: 30,
          cues: checked.cues,
        };
  const temporary = `${named.file}.depthcue-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, named.file);
  return send(response, 200, { cues: checked.cues, duration });
}

/**
 * The layout problems of one scene, from the files on disk. The editor asks after a save settles, so what it gets is
 * what a render of the saved deck shows. A machine with no browser answers `available: false`, and the editor then
 * lists only the problems it can find without one.
 */
async function layout(response: ServerResponse, url: URL, ctx: EditContext) {
  const scene = url.searchParams.get("scene") ?? "";
  const opened = openDeck(ctx.folder);
  if (opened.ok && !opened.doc.scenes[scene]) {
    return send(response, 404, { error: "not-found", message: `There is no scene "${scene}" in the deck.` });
  }
  if (!ctx.layout || !opened.ok) {
    return send(response, 200, {
      available: false,
      message: opened.ok ? "This server does not check the layout." : "The deck on disk has errors.",
    });
  }
  const answer = await ctx.layout.check(scene);
  return send(
    response,
    200,
    answer.available ? { available: true, diagnostics: answer.diagnostics.map(plain) } : answer,
  );
}

export const MAX_COMMENT_OPS_BYTES = 64 * 1024;

/**
 * The comments beside the deck, every one of them: the editor decides which to show. `rev` is the revision to name as
 * `baseRev` in the next change. A comments file that is not valid is reported and left alone, so a hand edit survives.
 */
function loadComments(response: ServerResponse, ctx: EditContext) {
  const read = readFolderComments(ctx.folder);
  if (!read.ok) {
    return send(response, 422, {
      error: read.code,
      message:
        read.code === "unreadable-comments"
          ? "comments.json is not valid, so the editor shows no comments and will not change the file. Fix it by hand."
          : "The deck has errors, so its comments cannot be read. `depthcue check` lists them.",
      diagnostics: read.diagnostics.map(plain),
    });
  }
  return send(response, 200, { rev: commentsRevision(read.file), comments: read.file.comments });
}

/**
 * Applies comment operations for the editor, all or none, against the revision the editor read. It is the same
 * `applyCommentsToFolder` that `deck_comment` and `depthcue comments apply` run, so a comment written here is read by
 * an agent exactly as one it wrote itself. On success the answer carries the new file, so the editor needs no second read.
 */
async function applyComments(request: IncomingMessage, response: ServerResponse, ctx: EditContext) {
  if (!String(request.headers["content-type"]).startsWith("application/json")) {
    return send(response, 415, { error: "bad-request", message: "Send application/json." });
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, MAX_COMMENT_OPS_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof TooLarge) {
      return send(response, 413, {
        error: "too-large",
        message: "That change to the comments is too large.",
      });
    }
    return send(response, 400, { error: "bad-request", message: "The body is not valid JSON." });
  }
  if (!isRecord(body) || typeof body.baseRev !== "string" || !Array.isArray(body.ops)) {
    return send(response, 400, {
      error: "bad-request",
      message: "Send { baseRev: string, ops: CommentOp[] }.",
    });
  }
  const outcome = applyCommentsToFolder(ctx.folder, body.ops, body.baseRev);
  if (outcome.ok) {
    const fresh = readFolderComments(ctx.folder);
    if (!fresh.ok)
      return send(response, 500, { error: "server", message: "The comments could not be read back." });
    return send(response, 200, {
      rev: outcome.rev,
      comments: fresh.file.comments,
      changed: outcome.changed,
      removed: outcome.removed,
    });
  }
  const stale = outcome.code === "stale-revision" || outcome.code === "changed-on-disk";
  return send(response, stale ? 409 : 422, {
    error: stale ? "stale" : outcome.code,
    message: outcome.hint,
    ...(outcome.rev === undefined ? {} : { rev: outcome.rev }),
    diagnostics: outcome.diagnostics.map(plain),
  });
}

/** The revision the editor names as `baseRev` when there is no review.json, so a first write is checked too. */
export const NO_REVIEW = "none";

const revisionOfReview = (review: Review | undefined): string =>
  review === undefined ? NO_REVIEW : reviewRevision(review);

/**
 * The review beside the deck: the deck as it was last reviewed and the ids of the changes the agent made. The editor
 * works out the changes itself, against the deck it has open, so unsaved edits and undo are counted. A review file
 * that is not valid is reported and left alone, so a hand edit survives.
 */
function loadReview(response: ServerResponse, ctx: EditContext) {
  const read = loadReviewDir(ctx.folder);
  if (!read.ok) {
    return send(response, 422, {
      error: "unreadable-review",
      message:
        "review.json is not valid, so the editor lists no changes and will not change the file. Delete it to start a new review.",
      diagnostics: read.diagnostics.map(plain),
    });
  }
  return send(response, 200, { rev: revisionOfReview(read.review), review: read.review ?? null });
}

/**
 * Replaces the review for the editor, against the revision it read: an accept moves the reviewed deck on, and undoing
 * one puts the earlier review back. The file is checked as it is on every read, so nothing that would not read back
 * is written. Reverting is not here: it is an edit of the deck, which the editor makes and saves like any other.
 */
async function replaceReview(request: IncomingMessage, response: ServerResponse, ctx: EditContext) {
  if (!String(request.headers["content-type"]).startsWith("application/json")) {
    return send(response, 415, { error: "bad-request", message: "Send application/json." });
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, MAX_SAVE_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof TooLarge) {
      return send(response, 413, { error: "too-large", message: "The review is too large to save." });
    }
    return send(response, 400, { error: "bad-request", message: "The body is not valid JSON." });
  }
  if (!isRecord(body) || typeof body.baseRev !== "string" || !isRecord(body.review)) {
    return send(response, 400, {
      error: "bad-request",
      message: "Send { baseRev: string, review: Review }.",
    });
  }
  const checked = readReview(JSON.stringify(body.review));
  if (!checked.ok || checked.review === undefined) {
    return send(response, 422, {
      error: "invalid",
      message: "That is not a review the editor may write, so nothing was written.",
      diagnostics: (checked.ok ? [] : checked.diagnostics).map(plain),
    });
  }
  const current = loadReviewDir(ctx.folder);
  if (!current.ok) {
    return send(response, 422, {
      error: "unreadable-review",
      message: "review.json is not valid, so it was left alone. Delete it to start a new review.",
      diagnostics: current.diagnostics.map(plain),
    });
  }
  const rev = revisionOfReview(current.review);
  if (rev !== body.baseRev) {
    return send(response, 409, {
      error: "stale",
      message: "The review changed on disk after the editor read it. Nothing was written.",
      rev,
    });
  }
  try {
    saveReviewDir(ctx.folder, current.review, checked.review);
  } catch (error) {
    if (error instanceof ChangedOnDiskError) {
      return send(response, 409, { error: "stale", message: error.message, rev });
    }
    throw error;
  }
  return send(response, 200, { rev: reviewRevision(checked.review), review: checked.review });
}

/** Handles `/_depthcue/api/*`. Returns false when the path is not an edit API path. */
export async function handleEditApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: EditContext,
): Promise<boolean> {
  const route = url.pathname;
  if (!route.startsWith("/_depthcue/api/")) return false;

  const refusal = authorized(request, ctx);
  if (refusal) {
    send(response, 403, { error: "forbidden", message: refusal });
    return true;
  }
  try {
    if (route === "/_depthcue/api/deck" && request.method === "GET") deck(response, ctx);
    else if (route === "/_depthcue/api/save" && request.method === "POST") await save(request, response, ctx);
    else if (route === "/_depthcue/api/asset" && request.method === "POST") {
      await uploadAsset(request, response, url, ctx);
    } else if (route === "/_depthcue/api/cues" && request.method === "GET") loadCues(response, url, ctx);
    else if (route === "/_depthcue/api/cues" && request.method === "POST")
      await saveCues(request, response, ctx);
    else if (route === "/_depthcue/api/layout" && request.method === "GET") await layout(response, url, ctx);
    else if (route === "/_depthcue/api/comments" && request.method === "GET") loadComments(response, ctx);
    else if (route === "/_depthcue/api/comments" && request.method === "POST")
      await applyComments(request, response, ctx);
    else if (route === "/_depthcue/api/review" && request.method === "GET") loadReview(response, ctx);
    else if (route === "/_depthcue/api/review" && request.method === "POST")
      await replaceReview(request, response, ctx);
    else {
      send(response, 404, { error: "not-found", message: "There is no such editor call." });
    }
  } catch (error) {
    send(response, 500, { error: "server", message: (error as Error).message });
  }
  return true;
}
