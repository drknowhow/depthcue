import { createHash } from "node:crypto";
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  BRAND_DIR,
  BRAND_FILE,
  type DeckFiles,
  FONT_FILE_PATTERN,
  IMAGE_FILE_PATTERN,
  isTemplateFile,
  LOGO_FILE_PATTERN,
} from "@depthcue/core";

/**
 * The brand files a brand.json can name, by path under brand/: only these change how the deck looks, so only these
 * count in the revision. A licence beside the fonts, the brand use record, or a thumbnail cache a file manager drops
 * into images/ is listed but not hashed.
 */
const NAMEABLE = [FONT_FILE_PATTERN, LOGO_FILE_PATTERN, IMAGE_FILE_PATTERN].map(
  (pattern) => new RegExp(pattern),
);
export const isNameableBrandFile = (relative: string): boolean =>
  NAMEABLE.some((pattern) => pattern.test(relative));

function walk(dir: string): Array<[string, Stats]> {
  const out: Array<[string, Stats]> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push([full, stat]);
  }
  return out;
}

function posix(dir: string, full: string): string {
  return relative(dir, full).split(sep).join("/");
}

/** Hashes of files by full path, each with what the file looked like when it was read. */
const hashes = new Map<string, { seen: string; hash: string }>();
/** Far more brand files than a server opens at once; past it the cache starts again rather than grow. */
const MAX_HASHES = 4096;
/** Longer than the coarsest tick a file's times move in: FAT's two seconds. */
const SETTLED_MS = 3000;

/**
 * The sha256 of a file, as 64 hex characters. It is read again only when its size, its modified or changed time, or its
 * inode is not what they were at the last read, so a deck's fonts are hashed once per change, not once per request.
 *
 * The key must hold all four. Size and modified time alone miss a file rewritten in place with other bytes of the same
 * length and its modified time set back, as a copy that keeps times does: only its change time differs. A file
 * replaced by a rename, as every write here is, has a new inode.
 *
 * Even all four miss a second change within the same tick of the file system's clock, which on Windows is up to 16 ms
 * (two seconds for a modified time on FAT). So, as git does for a file it calls racily clean, the hash of a file whose
 * times are that recent is not kept: it is read again on each call until the file has settled. `now` is when the file
 * is read, a parameter only so a test can read as if later.
 */
export function fileHash(full: string, stat: Stats = statSync(full), now = Date.now()): string {
  const path = resolve(full);
  const seen = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const known = hashes.get(path);
  if (known?.seen === seen) return known.hash;
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (now - Math.max(stat.mtimeMs, stat.ctimeMs) > SETTLED_MS) {
    if (hashes.size >= MAX_HASHES) hashes.clear();
    hashes.set(path, { seen, hash });
  } else hashes.delete(path);
  return hash;
}

/** The brand files' hashes a load read, by path from the deck folder, as `text` carries them. */
export function brandHashEntries(files: DeckFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of files.brandFiles ?? []) {
    const hash = files.text[path];
    if (hash !== undefined) out[path] = hash;
  }
  return out;
}

/**
 * Reads deck.json, scenes/*.json, and the brand's brand.json and templates/*.json as text, lists every file under
 * assets/, and lists the brand folder's other files. Its fonts, logos and images that a brand.json could name also get
 * the sha256 of their bytes in `text`, under their path, which is how the revision counts them.
 */
export function loadDeckDir(dir: string): DeckFiles {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory.`);
  }
  const text: Record<string, string> = {};
  const assets: string[] = [];
  const brandFiles: string[] = [];
  for (const [full, stat] of walk(dir)) {
    const path = posix(dir, full);
    if (path === "deck.json" || (path.startsWith("scenes/") && path.endsWith(".json"))) {
      text[path] = readFileSync(full, "utf8");
    } else if (path.startsWith("assets/")) {
      assets.push(path);
    } else if (path === BRAND_FILE || isTemplateFile(path)) {
      // Every JSON file of the templates folder is read, so the check can refuse one not named for a template id.
      text[path] = readFileSync(full, "utf8");
    } else if (path.startsWith(`${BRAND_DIR}/`) && !path.endsWith(".json")) {
      brandFiles.push(path);
      if (isNameableBrandFile(path.slice(BRAND_DIR.length + 1))) text[path] = fileHash(full, stat);
    }
  }
  return brandFiles.length > 0 ? { text, assets, brandFiles } : { text, assets };
}
