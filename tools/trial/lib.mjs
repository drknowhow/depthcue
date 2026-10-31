// Shared pieces of the trial harness: a static server that compresses like a real host, a Chrome launcher, the
// network profile from docs/PLAN.md, the statistics, and a description of the machine the numbers came from.
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, platform, release, totalmem } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const repoPath = (relative) => join(root, relative);
const { chromium } = createRequire(repoPath("packages/cli/package.json"))("playwright-core");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".map": "application/json",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map", ".ttf"]);

/**
 * Serves a folder over loopback with Brotli on the text files, the way a static host does, so that the bytes on the
 * wire are the compressed sizes and the throttled network charges for those. Returns the origin and a close function.
 */
export async function serveFolder(folder) {
  const cache = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let relative = decodeURIComponent(url.pathname);
    if (relative.endsWith("/")) relative += "index.html";
    const file = normalize(join(folder, relative));
    if (!file.startsWith(normalize(folder) + sep) && file !== normalize(folder)) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    const type = extname(file).toLowerCase();
    const headers = {
      "Content-Type": TYPES[type] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    };
    if (COMPRESSIBLE.has(type) && /\bbr\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
      let packed = cache.get(file);
      if (!packed) {
        packed = brotliCompressSync(readFileSync(file), {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        });
        cache.set(file, packed);
      }
      response.writeHead(200, { ...headers, "Content-Encoding": "br", "Content-Length": packed.length });
      response.end(packed);
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": statSync(file).size });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A fresh headless Chrome. DEPTHCUE_BROWSER names another executable. */
export function launchChrome() {
  return chromium.launch(
    process.env.DEPTHCUE_BROWSER
      ? { executablePath: process.env.DEPTHCUE_BROWSER, headless: true }
      : { channel: "chrome", headless: true },
  );
}

/** The reference network from docs/PLAN.md: 10 Mbps down and up, 50 ms of latency. */
export const NETWORK = {
  offline: false,
  latency: 50,
  downloadThroughput: 1_250_000,
  uploadThroughput: 1_250_000,
};

export async function throttle(page, profile = NETWORK) {
  const session = await page.context().newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", profile);
  return session;
}

/** The nearest-rank percentile of a list of numbers. */
export function percentile(values, fraction) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

export const summary = (values) => ({
  n: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

/** Resident memory of a process, in bytes. */
export function residentBytes(pid) {
  if (platform() === "win32") {
    const row = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    const memory = row
      .trim()
      .split('","')[4]
      ?.replace(/[^0-9]/g, "");
    return memory ? Number(memory) * 1024 : Number.NaN;
  }
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = status.match(/VmRSS:\s+(\d+) kB/);
  return match ? Number(match[1]) * 1024 : Number.NaN;
}

/** What the numbers came from, without anything that names a person. */
export function describeMachine(chromeVersion) {
  const processors = cpus();
  const info = {
    cpu: processors[0]?.model.trim(),
    logicalCores: processors.length,
    memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    os: `${platform()} ${release()}`,
    node: process.version,
    chrome: chromeVersion,
  };
  if (platform() === "win32") {
    try {
      const gpu = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join '; '",
        ],
        { encoding: "utf8" },
      ).trim();
      info.gpu = gpu;
    } catch {
      info.gpu = "unknown";
    }
  }
  return info;
}
