import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeckFiles, type Doc, loadDoc } from "../src/index.ts";

// The old sample deck: three scenes, all schema 0.1. Tests read this copy, so the sample deck in
// fixtures/decks/demo can show new features without moving them.
export const demoDir = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** A deck folder as the CLI's loader reads it: JSON as text, assets listed, and a brand's other files listed. */
export function loadDir(dir: string): DeckFiles {
  const text: Record<string, string> = {};
  const assets: string[] = [];
  const brandFiles: string[] = [];
  for (const full of walk(dir)) {
    const path = relative(dir, full).split(sep).join("/");
    if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
    else if (path.startsWith("brand/")) brandFiles.push(path);
    else assets.push(path);
  }
  return brandFiles.length > 0 ? { text, assets, brandFiles } : { text, assets };
}

/** The branded fixture deck: a brand of its own, two templates, two styles, and a layout scene and two template ones. */
export const brandDir = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));

export function brandDoc(): Doc {
  const { doc, diagnostics } = loadDoc(loadDir(brandDir));
  if (!doc) throw new Error(`the branded deck should load: ${JSON.stringify(diagnostics)}`);
  return doc;
}

export function scene(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "0.1",
    id: "demo-scene",
    title: "Demo",
    layout: "title",
    blocks: [{ id: "demo-heading", type: "text", role: "heading", text: "Hello" }],
    ...overrides,
  };
}

export function demoDoc(): Doc {
  const { doc } = loadDoc(loadDir(demoDir));
  if (!doc) throw new Error("the demo deck should load");
  return doc;
}
