import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BRAND_DIR, BRAND_FILE, type DeckFiles, templateIdOf } from "@depthcue/core";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function posix(dir: string, full: string): string {
  return relative(dir, full).split(sep).join("/");
}

/**
 * Reads deck.json, scenes/*.json, and the brand's brand.json and templates/*.json as text, lists every file under
 * assets/, and lists the brand folder's other files, its fonts, logos and images.
 */
export function loadDeckDir(dir: string): DeckFiles {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory.`);
  }
  const text: Record<string, string> = {};
  const assets: string[] = [];
  const brandFiles: string[] = [];
  for (const full of walk(dir)) {
    const path = posix(dir, full);
    if (path === "deck.json" || (path.startsWith("scenes/") && path.endsWith(".json"))) {
      text[path] = readFileSync(full, "utf8");
    } else if (path.startsWith("assets/")) {
      assets.push(path);
    } else if (path === BRAND_FILE || templateIdOf(path) !== undefined) {
      text[path] = readFileSync(full, "utf8");
    } else if (path.startsWith(`${BRAND_DIR}/`) && !path.endsWith(".json")) {
      brandFiles.push(path);
    }
  }
  return brandFiles.length > 0 ? { text, assets, brandFiles } : { text, assets };
}
