import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { type Diagnostic, loadDoc, revisionOf } from "@depthcue/core";
import { openDeck } from "./deck-api.ts";
import { loadDeckDir } from "./loader.ts";
import { ChangedOnDiskError, saveDeckDir } from "./save.ts";

export interface EditContext {
  /** The deck folder, already resolved to its real path. */
  folder: string;
  /** Secret the editor page was given. Every call must send it, so another web page cannot drive the editor. */
  token: string;
  /** The origins the editor page can have, for the same-origin check. Read per request: the port is known only after listening. */
  origins: () => readonly string[];
}

export const MAX_SAVE_BYTES = 8 * 1024 * 1024;
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
};

const plain = (d: Diagnostic) => ({
  code: d.code,
  at: `${d.file}${d.path}`,
  severity: d.severity,
  message: d.message,
  ...(d.fix === undefined ? {} : { fix: d.fix }),
});

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A page on another origin can send a request to a loopback server, so every call has to prove it came from the
 * editor page: the secret in its header, a same-origin Origin or Sec-Fetch-Site when the browser sends one, and
 * a custom header that would force a CORS preflight, which this server never answers.
 */
function authorized(request: IncomingMessage, ctx: EditContext): string | undefined {
  if (!sameToken(request.headers["x-depthcue-token"] as string | undefined, ctx.token)) {
    return "Missing or wrong editor token. Reload the editor page.";
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !ctx.origins().includes(origin)) return "Cross-origin request refused.";
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return "Cross-origin request refused.";
  return undefined;
}

class TooLarge extends Error {}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new TooLarge());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SAVEABLE = /^(deck\.json|scenes\/[^/\\]+\.json)$/;

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
    } else {
      send(response, 404, { error: "not-found", message: "There is no such editor call." });
    }
  } catch (error) {
    send(response, 500, { error: "server", message: (error as Error).message });
  }
  return true;
}
