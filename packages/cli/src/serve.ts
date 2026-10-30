import { createReadStream, existsSync, realpathSync, statSync, watch } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";

export interface ServeOptions {
  /** The deck folder: deck.json, scenes/, assets/. */
  folder: string;
  /** Directory holding the built player: app.js, player.css and any chunks. */
  playerDir: string;
  port: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

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
<div id="depthcue" data-deck="" data-live></div>
<script type="module" src="/_depthcue/app.js"></script>
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

function sendFile(request: IncomingMessage, response: ServerResponse, path: string, policy?: string) {
  const headers: Record<string, string> = {
    "Content-Type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(statSync(path).size),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (policy) headers["Content-Security-Policy"] = policy;
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
}

/**
 * Serves a deck folder and the built player on a loopback port. Only deck.json, scenes/*.json and assets/ are
 * reachable, never anything else in the folder. The Host header must name the loopback address, which stops a
 * web page from reaching the server through a rebound DNS name. Edits to the folder are pushed to open pages.
 */
export function startServer(options: ServeOptions): Promise<RunningServer> {
  const folder = realpathSync(resolve(options.folder));
  const playerDir = realpathSync(resolve(options.playerDir));
  const host = options.host ?? "127.0.0.1";
  const listeners = new Set<ServerResponse>();

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const named = (request.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(named)) return send(response, 403, "Unknown host.");
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, "Use GET.");

    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      return send(response, 400, "Bad path.");
    }

    if (path === "/" || path === "/index.html") {
      response.writeHead(200, {
        "Content-Type": TYPES[".html"] as string,
        "Content-Security-Policy": PAGE_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      return response.end(request.method === "HEAD" ? undefined : SHELL);
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
      resolveStart({
        port,
        url: `http://${host === "::1" ? "[::1]" : host}:${port}/`,
        close: () =>
          new Promise<void>((done) => {
            clearTimeout(pending);
            watcher.close();
            for (const client of listeners) client.end();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
