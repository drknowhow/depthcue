import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { COMMENTS_FILE, pageLook, REVIEW_FILE } from "@depthcue/core";
import { type EditContext, handleEditApi } from "./edit-api.ts";
import { createLayoutChecker, type LayoutChecker } from "./edit-layout.ts";
import { crossOrigin, isRecord, readBody, sameToken, send as sendJson, TooLarge } from "./http.ts";
import { createLeaseRelay, RELAY_PREFIX } from "./lease-relay.ts";
import { loadDeckDir } from "./loader.ts";
import { lookOfFiles } from "./look.ts";
import type { PptxOptions } from "./pptx/index.ts";

export interface ServeOptions {
  /** The deck folder: deck.json, scenes/, assets/. */
  folder: string;
  /** Directory holding the built player: app.js, player.css and any chunks. */
  playerDir: string;
  port: number;
  host?: string;
  /** Replaces how long a lease call waits for the page. For tests. */
  leaseWaitMs?: Parameters<typeof createLeaseRelay>[0]["waitMs"];
  /**
   * Directory holding the built editor. When set the server is in edit mode: `/` is the editor, the player moves
   * to `/present`, and the token-protected write calls under `/_depthcue/api/` are answered.
   */
  editorDir?: string;
  /** Answers the editor's layout questions. By default a render in a headless browser, started when first asked. */
  layout?: LayoutChecker;
}

export interface RunningServer {
  url: string;
  port: number;
  /** The secret the editor page sends with every write call; only set in edit mode. */
  token: string | undefined;
  /** The secret an agent sends with its lease calls. */
  agentToken: string;
  close(): Promise<void>;
}

/** The directory holding the built player, found through the player package so it works from any install. */
export function builtPlayerDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@depthcue/player/package.json")), "dist");
}

/** The directory holding the single-script build of the player that an exported page loads. */
export function builtStandaloneDir(): string {
  return join(builtPlayerDir(), "standalone");
}

/**
 * The directory holding the deck fonts: a stylesheet for each font pair, `all.css` with every pair, and the files they
 * name. The pages the server shows link `all.css`; an export copies one pair's stylesheet and its files.
 */
export function builtFontsDir(): string {
  return join(builtPlayerDir(), "fonts");
}

/** The directory holding the built editor, found through the editor package. */
export function builtEditorDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@depthcue/editor/package.json")), "dist");
}

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "::1"];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".csv": "text/csv; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/**
 * The brand files a page may read, by path under brand/: its fonts, its logos and its images. The server answers only
 * these, and the export copies only these, so the two cannot disagree about what a page can reach.
 */
const BRAND_FILES =
  /^(fonts\/.+\.(woff2|woff|ttf|otf)|logos\/.+\.(svg|png)|images\/.+\.(jpg|jpeg|png|webp|svg))$/i;

/**
 * Whether a path under brand/ (decoded, as the server sees it, or as brand.json names it) is a file a page may read:
 * one of the kinds above, in its own subfolder, with no way up or sideways in it. A path is decoded before it gets here,
 * so "images/..%2fnotes.png" arrives as "images/../notes.png" and would stay inside brand/ yet leave the subfolder the
 * kinds are tied to; a `.` or `..` part, an empty part, a backslash (a separator on Windows) or a NUL refuses it.
 */
export function isBrandFile(relative: string): boolean {
  return (
    BRAND_FILES.test(relative) &&
    !relative.includes("\\") &&
    !relative.includes("\0") &&
    !relative.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='5' fill='%23FF633F'/%3E%3C/svg%3E";

const SHELL = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Depthcue</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/_depthcue/fonts/all.css">
<link rel="stylesheet" href="/_depthcue/player.css">
</head>
<body>
<div id="depthcue" data-deck="" data-live data-lease data-presenter></div>
<script type="module" src="/_depthcue/app.js"></script>
</body>
</html>
`;

const editorShell = (token: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="depthcue-token" content="${token}">
<title>Depthcue editor</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/_depthcue/fonts/all.css">
<link rel="stylesheet" href="/_depthcue/editor/editor.css">
</head>
<body>
<div id="depthcue-editor"></div>
<script type="module" src="/_depthcue/editor/editor.js"></script>
</body>
</html>
`;

const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// An SVG opened as a page could run script; sandboxing makes a direct visit as inert as an <img>.
const FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** The file under `root` for a URL path, or undefined when it escapes `root`, does not exist or is not a file. */
function inside(root: string, relative: string): string | undefined {
  if (relative.includes("\0")) return undefined;
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  if (!existsSync(target) || !statSync(target).isFile()) return undefined;
  const real = realpathSync(target);
  const realRoot = realpathSync(root);
  return real.startsWith(realRoot + sep) ? real : undefined;
}

function send(response: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

/**
 * The bytes a `Range` header asks for. It is undefined when the header should be ignored: absent, not one range of
 * the form `bytes=first-last`, `bytes=first-` or `bytes=-count`, or a last byte before the first. A browser seeks in a
 * video by asking for a range, and plays no further than what it has read when the answer is the whole file.
 */
function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const count = Number(last);
    if (count === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - count), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

function sendFile(request: IncomingMessage, response: ServerResponse, path: string, policy?: string) {
  const size = statSync(path).size;
  const headers: Record<string, string> = {
    "Content-Type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (policy) headers["Content-Security-Policy"] = policy;
  const range = byteRange(request.headers.range, size);
  if (range === "unsatisfiable") {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": "0" });
    response.end();
    return;
  }
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
  } else {
    headers["Content-Length"] = String(size);
  }
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(path, range);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

/** The live server's PowerPoint export: the open deck's file, as `depthcue export --format pptx` makes it. */
export const PPTX_ROUTE = "/_depthcue/api/export.pptx";
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PPTX_STATUS: Record<string, number> = { "no-browser": 503 };

/**
 * Where the endpoint's file is said to be, which the links to the deck's files are written relative to: beside the
 * deck folder, as `depthcue export <deck> --format pptx --out <that path>` would put it, so both give the same bytes.
 */
export const pptxOutOf = (folder: string) => join(dirname(folder), `${basename(folder)}.pptx`);

/**
 * A file name as an RFC 8187 `filename*` value: percent-encoded UTF-8, `'`, `(`, `)` and `*` included, which
 * `encodeURIComponent` leaves as they are and the header's grammar does not allow there.
 */
export const extValue = (name: string) =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${(char.codePointAt(0) as number).toString(16).toUpperCase()}`,
  );

/** The export's switches from a request body: the CLI's, by the same names, each true or false. */
function pptxOptions(body: unknown): PptxOptions | string {
  if (!isRecord(body)) return 'Send the options as a JSON object, such as {"notes": false}.';
  const options: PptxOptions = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "notes" && key !== "pictures" && key !== "steps" && key !== "posters") {
      return `There is no option "${key}". The options are notes, pictures, steps and posters.`;
    }
    if (typeof value !== "boolean") return `"${key}" takes true or false.`;
    options[key] = value;
  }
  return options;
}

/**
 * Answers the PowerPoint export call: the same token and origin checks as the editor's other calls, a POST with the
 * options as JSON, and the file in the response. Nothing is written anywhere. One export runs at a time per server.
 */
async function pptxCall(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: EditContext,
  playerDir: string,
  queue: { last: Promise<unknown> },
): Promise<void> {
  const refusal = sameToken(request.headers["x-depthcue-token"] as string | undefined, ctx.token)
    ? crossOrigin(request, ctx.origins())
    : "Missing or wrong editor token. Reload the editor page.";
  if (refusal) return sendJson(response, 403, { error: "forbidden", message: refusal });
  if (request.method !== "POST") return sendJson(response, 405, { error: "method", message: "Use POST." });
  // As the other write calls: the options come as JSON, and an empty body is no options.
  if (!String(request.headers["content-type"]).startsWith("application/json")) {
    return sendJson(response, 415, { error: "bad-request", message: "Send application/json." });
  }
  let options: PptxOptions | string;
  try {
    const body = await readBody(request, 4096);
    options = pptxOptions(body.length === 0 ? {} : JSON.parse(body.toString("utf8")));
  } catch (error) {
    if (error instanceof TooLarge) {
      return sendJson(response, 413, { error: "too-large", message: "The options are at most 4 KB." });
    }
    options = "The body is not valid JSON.";
  }
  if (typeof options === "string") return sendJson(response, 400, { error: "bad-request", message: options });
  const chosen = options;
  const job = queue.last.then(async () => {
    const { renderPptx } = await import("./pptx/index.ts");
    return renderPptx({ folder: ctx.folder, out: pptxOutOf(ctx.folder), playerDir, ...chosen });
  });
  queue.last = job.catch(() => undefined);
  try {
    const result = await job;
    if (!result.ok) {
      return sendJson(response, 422, {
        error: "deck-invalid",
        message: "The deck has errors, so there is no file. Fix them and export again.",
        diagnostics: result.diagnostics,
      });
    }
    const name = basename(ctx.folder);
    const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_");
    response.writeHead(200, {
      "Content-Type": PPTX_TYPE,
      "Content-Length": String(result.bytes.length),
      "Content-Disposition": `attachment; filename="${ascii}.pptx"; filename*=UTF-8''${extValue(name)}.pptx`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(result.bytes);
  } catch (error) {
    const { PptxError } = await import("./pptx/index.ts");
    if (error instanceof PptxError) {
      return sendJson(response, PPTX_STATUS[error.code] ?? 500, {
        error: error.code,
        message: error.message,
      });
    }
    return sendJson(response, 500, { error: "server", message: (error as Error).message });
  }
}

/**
 * Serves a deck folder and the built player on a loopback port. Only deck.json, scenes/*.json and assets/ are
 * reachable, never anything else in the folder. The Host header must name the loopback address, which stops a
 * web page from reaching the server through a rebound DNS name. Edits to the folder are pushed to open pages.
 */
export function startServer(options: ServeOptions): Promise<RunningServer> {
  const folder = realpathSync(resolve(options.folder));
  const playerDir = realpathSync(resolve(options.playerDir));
  const editorDir = options.editorDir === undefined ? undefined : realpathSync(resolve(options.editorDir));
  const token = editorDir === undefined ? undefined : randomBytes(24).toString("base64url");
  const agentToken = randomBytes(24).toString("base64url");
  const host = options.host ?? "127.0.0.1";
  const listeners = new Set<ServerResponse>();
  /** The editor pages, which ask to hear about comments too. The deck and presenter windows are never in here. */
  const commentListeners = new Set<ServerResponse>();
  /** The editor pages again, for the review. A page opened with `?comments=1` and `?review=1` is in both. */
  const reviewListeners = new Set<ServerResponse>();
  let boundPort = 0;
  /** The last look.json that could be built, as text, for the moments when the folder's own cannot be. */
  let lastLook: string | undefined;

  const origins = () =>
    LOOPBACK_NAMES.map((name) => `http://${name === "::1" ? "[::1]" : name}:${boundPort}`);
  const layout = token === undefined ? undefined : (options.layout ?? createLayoutChecker(folder));
  const edit: EditContext | undefined =
    token === undefined ? undefined : { folder, token, origins, ...(layout ? { layout } : {}) };
  /** The PowerPoint exports, one after another: each starts a browser. */
  const exports = { last: Promise.resolve() as Promise<unknown> };
  const relay = createLeaseRelay({
    token: agentToken,
    origins,
    ...(options.leaseWaitMs ? { waitMs: options.leaseWaitMs } : {}),
  });

  const page = (request: IncomingMessage, response: ServerResponse, html: string) => {
    response.writeHead(200, {
      "Content-Type": TYPES[".html"] as string,
      "Content-Security-Policy": PAGE_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    return response.end(request.method === "HEAD" ? undefined : html);
  };

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const named = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!LOOPBACK_NAMES.includes(named)) return send(response, 403, "Unknown host.");

    let url: URL;
    let path: string;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
      path = decodeURIComponent(url.pathname);
    } catch {
      return send(response, 400, "Bad path.");
    }

    // The PowerPoint file of the open deck, sent and never written: guarded as the write calls are.
    if (edit && url.pathname === PPTX_ROUTE) {
      void pptxCall(request, response, edit, playerDir, exports);
      return undefined;
    }
    // The write calls check their own methods, token and origin; everything else stays read-only. The route is
    // taken from the normalised path, so "/_depthcue/api/../x" is never mistaken for an API call.
    if (edit && url.pathname.startsWith("/_depthcue/api/")) {
      void handleEditApi(request, response, url, edit).then((handled) => {
        if (!handled) send(response, 404, "Not found.");
      });
      return undefined;
    }
    // The agent's lease calls and the page's answers. Each checks its own method, secret and origin.
    if (url.pathname.startsWith(RELAY_PREFIX)) {
      void relay.handle(request, response, url);
      return undefined;
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, "Use GET.");

    if (path === "/" || path === "/index.html") {
      return page(request, response, token === undefined ? SHELL : editorShell(token));
    }
    if (edit && (path === "/present" || path === "/present/")) return page(request, response, SHELL);

    if (editorDir && path.startsWith("/_depthcue/editor/")) {
      const file = inside(editorDir, path.slice("/_depthcue/editor/".length));
      return file ? sendFile(request, response, file) : send(response, 404, "Not found.");
    }

    if (path === "/_depthcue/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      response.write("retry: 1000\n\n");
      listeners.add(response);
      if (edit && url.searchParams.get("comments") === "1") commentListeners.add(response);
      if (edit && url.searchParams.get("review") === "1") reviewListeners.add(response);
      request.on("close", () => {
        listeners.delete(response);
        commentListeners.delete(response);
        reviewListeners.delete(response);
      });
      // A page that has the lease says so, and is the one an agent's calls go to.
      if (url.searchParams.get("lease") === "1") relay.attach(response);
      return undefined;
    }

    if (path.startsWith("/_depthcue/")) {
      const file = inside(playerDir, path.slice("/_depthcue/".length));
      return file ? sendFile(request, response, file) : send(response, 404, "Not found.");
    }

    // How the deck looks, worked out here from its brand so the page needs no brand file and knows no built-in
    // template, and cut to what the page reads. A scene with an error does not take it away: the look is built from a
    // sound deck.json and brand alone. While either is broken, as in the middle of an edit, the last look that was
    // good is served, so the cover and section slides keep their brand. A deck that never had one has none: the page
    // draws it from deck.json alone, as before.
    if (path === "/look.json") {
      try {
        const look = lookOfFiles(loadDeckDir(folder));
        if (look) lastLook = JSON.stringify(pageLook(look));
      } catch {
        // The folder could not be read just now; the last good look stands.
      }
      return lastLook === undefined
        ? send(response, 404, "Not found.")
        : send(response, 200, lastLook, TYPES[".json"]);
    }

    // Each kind of file is resolved inside its own root, so "/assets/../notes.txt" cannot reach a sibling file.
    let file: string | undefined;
    if (path === "/deck.json") file = inside(folder, "deck.json");
    else if (/^\/scenes\/[^/]+\.json$/.test(path))
      file = inside(join(folder, "scenes"), path.slice("/scenes/".length));
    else if (path.startsWith("/assets/"))
      file = inside(join(folder, "assets"), path.slice("/assets/".length));
    // Only the brand's fonts, logos and images; never brand.json or its templates, which are for the tools.
    else if (path.startsWith("/brand/") && isBrandFile(path.slice("/brand/".length)))
      file = inside(join(folder, "brand"), path.slice("/brand/".length));
    return file ? sendFile(request, response, file, FILE_POLICY) : send(response, 404, "Not found.");
  };

  const server: Server = createServer(handle);

  let pending: ReturnType<typeof setTimeout> | undefined;
  let pendingComments: ReturnType<typeof setTimeout> | undefined;
  let pendingReview: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(folder, { recursive: true }, (_event, name) => {
    const changed = String(name ?? "").replaceAll("\\", "/");
    if (changed.endsWith(".tmp")) return;
    // The same for the review: no page reloads, and only an editor that asked is told.
    if (changed === REVIEW_FILE) {
      clearTimeout(pendingReview);
      pendingReview = setTimeout(() => {
        for (const client of reviewListeners) client.write("event: review\ndata: {}\n\n");
      }, 60);
      return;
    }
    // A change to the comments reloads no page. The editor is told on its own event, and nothing else hears it.
    if (changed === COMMENTS_FILE) {
      clearTimeout(pendingComments);
      pendingComments = setTimeout(() => {
        for (const client of commentListeners) client.write("event: comments\ndata: {}\n\n");
      }, 60);
      return;
    }
    if (
      changed !== "deck.json" &&
      !changed.startsWith("scenes/") &&
      !changed.startsWith("assets/") &&
      !changed.startsWith("brand/")
    ) {
      return;
    }
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const client of listeners) client.write("event: change\ndata: {}\n\n");
    }, 60);
  });

  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      const { port } = server.address() as AddressInfo;
      boundPort = port;
      resolveStart({
        port,
        token,
        agentToken,
        url: `http://${host === "::1" ? "[::1]" : host}:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            clearTimeout(pending);
            clearTimeout(pendingComments);
            clearTimeout(pendingReview);
            relay.close();
            watcher.close();
            for (const client of listeners) client.end();
            // A render under way finishes first, so the browser it holds is not left running.
            const rendering = Promise.all([layout?.close(), exports.last]);
            server.close(() => void rendering.finally(done));
            // A call that is waiting gets its answer first ("the server is shutting down"), not a reset.
            setImmediate(() => server.closeAllConnections());
          }),
      });
    });
  });
}
