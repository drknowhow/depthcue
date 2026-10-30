import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DeckFiles } from "@depthcue/core";

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

/** Reads deck.json and scenes/*.json as text and lists every file under assets/. */
export function loadDeckDir(dir: string): DeckFiles {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${dir} is not a directory.`);
  }
  const text: Record<string, string> = {};
  const assets: string[] = [];
  for (const full of walk(dir)) {
    const path = posix(dir, full);
    if (path === "deck.json" || (path.startsWith("scenes/") && path.endsWith(".json"))) {
      text[path] = readFileSync(full, "utf8");
    } else if (path.startsWith("assets/")) {
      assets.push(path);
    }
  }
  return { text, assets };
}
