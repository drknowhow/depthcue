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
  BRAND_DIR,
  brandFilePath,
  cueMapPath,
  type DeckLook,
  type Diagnostic,
  deckAssetRefs,
  EXPORT_FORMAT,
  type ExportData,
  type FontPair,
  lookOf,
  pageLook,
  type Scene,
} from "@depthcue/core";
import { strictSvg } from "./brand/files.ts";
import { openDeck } from "./deck-api.ts";
import { builtFontsDir, builtStandaloneDir, isBrandFile } from "./serve.ts";

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
  /** Replaces the folder the deck's fonts are copied from: a stylesheet per font pair and the files they name. For tests. */
  fontsDir?: string;
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
  /** The brand files copied, deck-relative and in path order: its faces, the logo for the deck's theme and its template images. */
  brandFiles: string[];
  /**
   * The license texts copied beside the faces, export-relative and in path order: the `.txt` files that sit beside the
   * brand's font files, and the license of each built-in family the page's font pair uses. A page does not read them.
   */
  licenses: string[];
  /** The font pair the page carries. Only this pair's files are copied, so the page weighs what its deck uses. */
  fonts: FontPair;
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

/** Where the fonts sit in an export, and so what a page's stylesheet link for them says. */
const FONTS_DIR = "fonts";

/** The page. The deck is in it, and the script that shows it sits beside it. */
function page(data: ExportData, fonts: FontPair): string {
  return `<!doctype html>
<html lang="${escapeHtml(data.deck.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(data.deck.title)}</title>
<link rel="stylesheet" href="${FONTS_DIR}/${fonts}.css">
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

/** The license texts of the built-in families, by family, that the build writes beside the font files. */
const LICENSES_FILE = "licenses.json";

/**
 * The font files a pair's stylesheet names, which sit beside it, and the license text of each family it names. The build
 * writes the stylesheet from the font manifest, so a file it names that is not there, or a `url()` this does not read,
 * would leave a page with a font it cannot load. Both stop the export instead. So does a family with no license text:
 * the license asks to travel with the font, and an export without it would be wrong in a way nobody sees.
 */
function fontStylesheet(fontsDir: string, pair: FontPair): { files: string[]; licenses: string[] } {
  const sheet = join(fontsDir, `${pair}.css`);
  const missing = (what: string) =>
    new ExportError(
      "player-not-built",
      `The font ${what} is missing (${sheet}). Build the player first: pnpm build.`,
    );
  if (!existsSync(sheet)) throw missing(`stylesheet for "${pair}"`);
  const css = readFileSync(sheet, "utf8");
  const files = [...css.matchAll(/url\("([A-Za-z0-9._-]+\.woff2)"\)/g)].map((match) => match[1] as string);
  if (files.length === 0 || files.length !== (css.match(/url\(/g) ?? []).length) {
    throw new ExportError(
      "player-not-built",
      `${sheet} names a font file in a form the export does not read. Build the player again: pnpm build.`,
    );
  }
  for (const name of files) if (!existsSync(join(fontsDir, name))) throw missing(`file ${name}`);

  const listFile = join(fontsDir, LICENSES_FILE);
  let list: Record<string, unknown> = {};
  try {
    list = JSON.parse(readFileSync(listFile, "utf8")) as Record<string, unknown>;
  } catch {
    throw new ExportError(
      "player-not-built",
      `The font license list is missing or unreadable (${listFile}). Build the player again: pnpm build.`,
    );
  }
  const licenses = new Set<string>();
  for (const family of new Set(
    [...css.matchAll(/font-family:\s*"([^"]+)"/g)].map((match) => match[1] as string),
  )) {
    const name = Object.hasOwn(list, family) ? list[family] : undefined;
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(name)) {
      throw new ExportError(
        "player-not-built",
        `The font license list (${listFile}) has no license text for "${family}". Build the player again: pnpm build.`,
      );
    }
    if (!existsSync(join(fontsDir, name))) throw missing(`license text ${name}`);
    licenses.add(name);
  }
  return { files: [...new Set(files)].sort(), licenses: [...licenses].sort() };
}

const FONT_FILE = /\.(woff2|woff|ttf|otf)$/i;
/** A license text beside a font: a plain `.txt` name, which also keeps the marker's own rules about paths. */
const LICENSE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/i;

/** A brand file the export did not copy, though the page names it: the page will draw without it, so it is said. */
const notCopied = (
  path: string,
  why: string,
  fix = "Put the file itself in the brand folder, not a link to a file outside it, and export again.",
): Diagnostic => ({
  severity: "warning",
  code: "brand-file-not-copied",
  file: path,
  path: "",
  message: `${path} ${why}, so it was not copied into the export. The exported page still names it and will draw without it.`,
  fix,
});

/**
 * The brand files a deck draws with, deck-relative: the brand's faces, the logo for the deck's theme, and the images
 * its templates put behind a slide. Nothing else in the brand folder goes, such as brand.json, the templates or a
 * logo for the other theme, because a page does not read them. Only files the server would hand a page, that are
 * there and that stay inside the brand folder, are listed. One the page names that is left out, because it is a link
 * out of the brand folder, is not a file, or is an SVG the upload would refuse, comes back with a warning that names it.
 */
export function brandFilesOf(look: DeckLook, folder: string): { files: string[]; left: Diagnostic[] } {
  const wanted = new Set<string>();
  for (const face of [look.faces?.display, look.faces?.body, look.faces?.mono]) {
    for (const file of face?.files ?? []) wanted.add(file.path);
  }
  if (look.chrome?.logo) wanted.add(look.chrome.logo.path);
  for (const template of Object.values(look.templates)) {
    if (template.background?.image) wanted.add(brandFilePath(template.background.image));
  }
  const root = realish(join(folder, BRAND_DIR));
  const prefix = `${BRAND_DIR}/`;
  const files: string[] = [];
  const left: Diagnostic[] = [];
  for (const path of [...wanted].sort()) {
    // The same rule as the server's: a path it would not hand a page is not one the export copies.
    if (!path.startsWith(prefix) || !isBrandFile(path.slice(prefix.length))) {
      left.push(notCopied(path, "is not a path a page may read"));
      continue;
    }
    const file = join(folder, path);
    if (!existsSync(file) || !statSync(file).isFile()) {
      left.push(notCopied(path, "is not a file"));
    } else if (!within(root, realish(file))) {
      left.push(notCopied(path, "is a link to a file outside the brand folder"));
    } else {
      const problem = svgProblemOf(path, file);
      if (problem === undefined) files.push(path);
      else {
        left.push(
          notCopied(
            path,
            `is an SVG with ${problem}`,
            "Save the drawing as plain SVG that links only to places in itself, check it with depthcue brand add, and export again.",
          ),
        );
      }
    }
  }
  return { files, left };
}

/**
 * What the upload's check finds wrong with a brand SVG, or undefined for one it takes or a file that is no SVG. An SVG
 * reaches the brand folder by other ways than the upload, such as brand use or a hand copy, and an exported page may be
 * opened some other way than in Depthcue's player, so the export checks each one it would copy again.
 */
function svgProblemOf(path: string, file: string): string | undefined {
  if (!/\.svg$/i.test(path)) return undefined;
  const checked = strictSvg(new Uint8Array(readFileSync(file)));
  return "problem" in checked ? checked.problem : undefined;
}

/**
 * The license texts that sit beside the brand's font files: every `.txt` in a folder a copied font is in. They go to the
 * same place in the export and are not part of what a page reads, which is why the server does not hand them out.
 */
function brandLicensesOf(folder: string, copied: readonly string[]): { files: string[]; left: Diagnostic[] } {
  const root = realish(join(folder, BRAND_DIR));
  const files: string[] = [];
  const left: Diagnostic[] = [];
  for (const dir of new Set(copied.filter((path) => FONT_FILE.test(path)).map((path) => dirname(path)))) {
    const names = readdirSync(join(folder, dir)).filter((name) => LICENSE_TEXT.test(name));
    for (const name of names.sort()) {
      const path = `${dir}/${name}`;
      const file = join(folder, path);
      if (!statSync(file).isFile()) continue;
      if (within(root, realish(file))) files.push(path);
      else left.push(notCopied(path, "is a link to a file outside the brand folder"));
    }
  }
  return { files, left };
}

/** The path as the file system sees it, even when its last parts do not exist yet. */
export function realish(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let here = absolute;
  while (!existsSync(here) && dirname(here) !== here) {
    missing.unshift(basename(here));
    here = dirname(here);
  }
  return join(realpathSync.native(here), ...missing);
}

/** Whether `child` is `parent` or inside it, by path: both should have been through `realish`. */
export const within = (parent: string, child: string) => {
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
 * script and styles beside it, the one font pair the deck uses, only the assets a scene names, and the brand files it
 * draws with (its faces, the logo for its theme and its templates' images). Nothing is fetched, so it works from
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

  // How the deck looks is worked out here, once, and goes into the page, so the page needs no brand file to read it.
  // The look's font pair decides which stylesheet goes (a brand's faces load over it), and that stylesheet names the
  // files that go with it.
  const look = lookOf(doc);
  const fonts = look.fonts;
  const fontsDir = request.fontsDir ?? builtFontsDir();
  const fontSheet = fontStylesheet(fontsDir, fonts);

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
  const used = new Set([...scenes.flatMap(assetsOf), ...deckAssetRefs(doc.deck).map((ref) => ref.asset)]);
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
  // A voice-over's word times and step marks are read the same way: the page cannot fetch them from a file, so they go
  // into the page, and the audio beside them is copied as an ordinary asset.
  const wordFiles = new Set<string>();
  for (const scene of scenes) {
    const path = scene.voiceover?.words;
    if (!path || Object.hasOwn(files, path)) continue;
    try {
      files[path] = JSON.parse(readFileSync(join(request.folder, path), "utf8"));
      wordFiles.add(path);
    } catch {
      // Missing or not JSON: the captions are spread over the recording by the text and no mark moves the slide.
    }
  }
  cueMaps.sort();
  const assets = [...used].filter((path) => !wordFiles.has(path)).sort();
  const skipped = [...doc.assets].filter((path) => !used.has(path) && !Object.hasOwn(files, path)).sort();

  const brand = brandFilesOf(look, request.folder);
  const brandFiles = brand.files;
  const brandLicenses = brandLicensesOf(request.folder, brandFiles);
  // The page gets the look cut to what the player reads, so it does not carry the templates' hints or accepted kinds.
  const data: ExportData = { format: EXPORT_FORMAT, deck: doc.deck, scenes, files, look: pageLook(look) };
  const html = page(data, fonts);
  const fontPaths = [`${fonts}.css`, ...fontSheet.files, ...fontSheet.licenses].map(
    (name) => `${FONTS_DIR}/${name}`,
  );
  const licenses = [
    ...fontSheet.licenses.map((name) => `${FONTS_DIR}/${name}`),
    ...brandLicenses.files,
  ].sort();
  const writing = new Set([
    "index.html",
    ...runtimeFiles,
    ...fontPaths,
    ...assets,
    ...brandFiles,
    ...brandLicenses.files,
  ]);

  const stale = claim(outDir, writing);
  mkdirSync(outDir, { recursive: true });
  // The marker goes first, so an export that stops half-way can still be replaced by the next one.
  writeFileSync(
    join(outDir, EXPORT_MARKER),
    `${JSON.stringify({ format: EXPORT_FORMAT, files: [...writing].sort() }, null, 2)}\n`,
  );
  sweep(outDir, stale);

  let bytes = 0;
  for (const path of [...assets, ...brandFiles, ...brandLicenses.files]) {
    const to = join(outDir, path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(request.folder, path), to);
    bytes += statSync(to).size;
  }
  for (const name of runtimeFiles) {
    copyFileSync(join(runtime, name), join(outDir, name));
    bytes += statSync(join(outDir, name)).size;
  }
  mkdirSync(join(outDir, FONTS_DIR), { recursive: true });
  for (const name of [`${fonts}.css`, ...fontSheet.files, ...fontSheet.licenses]) {
    copyFileSync(join(fontsDir, name), join(outDir, FONTS_DIR, name));
    bytes += statSync(join(outDir, FONTS_DIR, name)).size;
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
      brandFiles,
      licenses,
      fonts,
      notes: keepNotes,
      files: writing.size,
      bytes,
      warnings: [...opened.diagnostics, ...brand.left, ...brandLicenses.left],
    },
  };
}
