import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assetsOf,
  cueMapPath,
  type Diagnostic,
  EXPORT_FORMAT,
  type ExportData,
  type Scene,
} from "@depthcue/core";
import { openDeck } from "./deck-api.ts";
import { builtStandaloneDir } from "./serve.ts";

/** Names the file in the exported folder that lists what the export wrote, so a later export can replace it. */
export const EXPORT_MARKER = ".depthcue-export";

export type ExportErrorCode = "player-not-built" | "out-in-deck" | "deck-in-out" | "out-not-empty";

/** The export could not run, as opposed to the deck having errors. The message says what to change. */
export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ExportRequest {
  folder: string;
  /** Where the page goes. Default: `<deck folder name>-export` in the current directory. */
  out?: string;
  /** Keep each scene's speaker notes in the page. Anyone with the folder can read them. Default true. */
  notes?: boolean;
  /** Replaces the folder the page's script and styles are copied from. For tests. */
  runtimeDir?: string;
}

export interface ExportSummary {
  out: string;
  index: string;
  scenes: number;
  /** Deck-relative assets copied, in path order. */
  assets: string[];
  /** Assets in the deck that no scene names, so they were left out. */
  skipped: string[];
  /** Cue maps embedded in the page, by deck-relative path. */
  cueMaps: string[];
  notes: boolean;
  files: number;
  bytes: number;
  /** Warnings the deck has. Errors stop the export, so these are all there is. */
  warnings: Diagnostic[];
}

export type ExportResult = { ok: true; summary: ExportSummary } | { ok: false; diagnostics: Diagnostic[] };

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** JSON for inside a script element: no `<` can start a closing tag or a comment. */
const embeddable = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

/** The page. The deck is in it, and the script that shows it sits beside it. */
function page(data: ExportData): string {
  return `<!doctype html>
<html lang="${escapeHtml(data.deck.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(data.deck.title)}</title>
<link rel="stylesheet" href="depthcue.css">
</head>
<body>
<div id="depthcue"></div>
<script type="application/json" id="depthcue-data">${embeddable(data)}</script>
<script src="depthcue.js"></script>
</body>
</html>
`;
}

const withoutNotes = (scene: Scene): Scene =>
  Object.fromEntries(Object.entries(scene).filter(([key]) => key !== "notes")) as Scene;

/** The path as the file system sees it, even when its last parts do not exist yet. */
function realish(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let here = absolute;
  while (!existsSync(here) && dirname(here) !== here) {
    missing.unshift(basename(here));
    here = dirname(here);
  }
  return join(realpathSync.native(here), ...missing);
}

const within = (parent: string, child: string) => {
  const way = relative(parent, child);
  return way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way);
};

/** A path a marker may list: relative, forward slashes, no way up and out. */
const safeListed = (path: unknown): path is string =>
  typeof path === "string" &&
  path !== "" &&
  !/[\\:]/.test(path) &&
  !path.split("/").some((part) => part === "" || part === "." || part === "..");

/** What an earlier export wrote into `out`, or undefined when the folder is not one. */
function readMarker(out: string): string[] | undefined {
  try {
    const marker = JSON.parse(readFileSync(join(out, EXPORT_MARKER), "utf8")) as {
      format?: unknown;
      files?: unknown;
    };
    if (marker.format !== EXPORT_FORMAT || !Array.isArray(marker.files)) return undefined;
    return marker.files.every(safeListed) ? (marker.files as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks that `out` can take the export, before anything is written or removed. A new or empty folder is fine.
 * A folder with files in it has to be an earlier export, and then only the files that export wrote are replaced.
 * Returns what the earlier export wrote that this one will not.
 */
function claim(out: string, writing: ReadonlySet<string>): string[] {
  if (!existsSync(out)) return [];
  if (!statSync(out).isDirectory()) {
    throw new ExportError("out-not-empty", `${out} is a file. Pick a folder for --out.`);
  }
  if (readdirSync(out).length === 0) return [];
  const earlier = readMarker(out);
  if (!earlier) {
    throw new ExportError(
      "out-not-empty",
      `${out} has files in it and was not made by depthcue export. Pick another --out, or empty it first.`,
    );
  }
  const mine = new Set(earlier);
  for (const path of writing) {
    if (existsSync(join(out, path)) && !mine.has(path)) {
      throw new ExportError(
        "out-not-empty",
        `${join(out, path)} exists and the earlier export did not write it. Move it, or pick another --out.`,
      );
    }
  }
  return earlier.filter((path) => !writing.has(path));
}

/** Removes what an earlier export wrote that this one does not, and the folders that leaves empty. */
function sweep(out: string, stale: readonly string[]) {
  for (const path of stale) {
    rmSync(join(out, path), { force: true });
    for (let dir = dirname(join(out, path)); dir !== out && within(out, dir); dir = dirname(dir)) {
      if (!existsSync(dir) || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    }
  }
}

/**
 * Exports a deck folder as a folder that opens by double-click: `index.html` with the deck inside it, the
 * script and styles beside it, and only the assets a scene names. Nothing is fetched, so it works from
 * `file://`, from a USB stick, and with no network. A deck with errors writes nothing.
 */
export function exportDeck(request: ExportRequest): ExportResult {
  const opened = openDeck(request.folder);
  if (!opened.ok) return { ok: false, diagnostics: opened.diagnostics };
  const { doc } = opened;
  const keepNotes = request.notes ?? true;

  const runtime = request.runtimeDir ?? builtStandaloneDir();
  const runtimeFiles = ["depthcue.css", "depthcue.js"] as const;
  for (const name of runtimeFiles) {
    if (!existsSync(join(runtime, name))) {
      throw new ExportError(
        "player-not-built",
        `The exported page's script is missing (${join(runtime, name)}). Build the player first: pnpm build.`,
      );
    }
  }

  const out = resolve(request.out ?? `${basename(resolve(request.folder))}-export`);
  const deckDir = realish(request.folder);
  const outDir = realish(out);
  if (within(deckDir, outDir)) {
    throw new ExportError(
      "out-in-deck",
      `${out} is inside the deck folder. Pick a folder outside it for --out.`,
    );
  }
  if (within(outDir, deckDir)) {
    throw new ExportError("deck-in-out", `The deck folder is inside ${out}. Pick another folder for --out.`);
  }

  const scenes = doc.deck.scenes.map((id) => {
    const scene = doc.scenes[id] as Scene;
    return keepNotes ? scene : withoutNotes(scene);
  });
  const used = new Set(scenes.flatMap(assetsOf));
  // A clip's cue map sits beside its video. The page reads it from its own data, so it is embedded, not copied.
  const files: Record<string, unknown> = {};
  const cueMaps: string[] = [];
  for (const scene of scenes) {
    for (const block of scene.blocks) {
      if (block.type !== "clip") continue;
      const path = cueMapPath(block.source);
      if (Object.hasOwn(files, path)) continue;
      try {
        files[path] = JSON.parse(readFileSync(join(request.folder, path), "utf8"));
        cueMaps.push(path);
      } catch {
        // No cue map, or one that is not JSON: the player shows the clip without chips from either, so this changes nothing.
      }
    }
  }
  cueMaps.sort();
  const assets = [...used].sort();
  const skipped = [...doc.assets].filter((path) => !used.has(path) && !Object.hasOwn(files, path)).sort();

  const data: ExportData = { format: EXPORT_FORMAT, deck: doc.deck, scenes, files };
  const html = page(data);
  const writing = new Set(["index.html", ...runtimeFiles, ...assets]);

  const stale = claim(outDir, writing);
  mkdirSync(outDir, { recursive: true });
  // The marker goes first, so an export that stops half-way can still be replaced by the next one.
  writeFileSync(
    join(outDir, EXPORT_MARKER),
    `${JSON.stringify({ format: EXPORT_FORMAT, files: [...writing].sort() }, null, 2)}\n`,
  );
  sweep(outDir, stale);

  let bytes = 0;
  for (const path of assets) {
    const to = join(outDir, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(request.folder, path), to);
    bytes += statSync(to).size;
  }
  for (const name of runtimeFiles) {
    copyFileSync(join(runtime, name), join(outDir, name));
    bytes += statSync(join(outDir, name)).size;
  }
  writeFileSync(join(outDir, "index.html"), html);
  bytes += Buffer.byteLength(html);

  return {
    ok: true,
    summary: {
      out,
      index: join(out, "index.html"),
      scenes: scenes.length,
      assets,
      skipped,
      cueMaps,
      notes: keepNotes,
      files: writing.size,
      bytes,
      warnings: opened.diagnostics,
    },
  };
}
