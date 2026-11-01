import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { type EditContext, handleEditApi } from "./edit-api.ts";
import { createLayoutChecker, type LayoutChecker } from "./edit-layout.ts";
import { createLeaseRelay, RELAY_PREFIX } from "./lease-relay.ts";

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
};

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
  let boundPort = 0;

  const origins = () =>
    LOOPBACK_NAMES.map((name) => `http://${name === "::1" ? "[::1]" : name}:${boundPort}`);
  const layout = token === undefined ? undefined : (options.layout ?? createLayoutChecker(folder));
  const edit: EditContext | undefined =
    token === undefined ? undefined : { folder, token, origins, ...(layout ? { layout } : {}) };
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
      request.on("close", () => listeners.delete(response));
      // A page that has the lease says so, and is the one an agent's calls go to.
      if (url.searchParams.get("lease") === "1") relay.attach(response);
      return undefined;
    }

    if (path.startsWith("/_depthcue/")) {
      const file = inside(playerDir, path.slice("/_depthcue/".length));
      return file ? sendFile(request, response, file) : send(response, 404, "Not found.");
    }

    // Each kind of file is resolved inside its own root, so "/assets/../notes.txt" cannot reach a sibling file.
    let file: string | undefined;
    if (path === "/deck.json") file = inside(folder, "deck.json");
    else if (/^\/scenes\/[^/]+\.json$/.test(path))
      file = inside(join(folder, "scenes"), path.slice("/scenes/".length));
    else if (path.startsWith("/assets/"))
      file = inside(join(folder, "assets"), path.slice("/assets/".length));
    return file ? sendFile(request, response, file, FILE_POLICY) : send(response, 404, "Not found.");
  };

  const server: Server = createServer(handle);

  let pending: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(folder, { recursive: true }, (_event, name) => {
    const changed = String(name ?? "").replaceAll("\\", "/");
    if (changed.endsWith(".tmp")) return;
    if (changed !== "deck.json" && !changed.startsWith("scenes/") && !changed.startsWith("assets/")) return;
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
            relay.close();
            watcher.close();
            for (const client of listeners) client.end();
            // A render under way finishes first, so the browser it holds is not left running.
            const rendering = layout?.close() ?? Promise.resolve();
            server.close(() => void rendering.finally(done));
            // A call that is waiting gets its answer first ("the server is shutting down"), not a reset.
            setImmediate(() => server.closeAllConnections());
          }),
      });
    });
  });
}
