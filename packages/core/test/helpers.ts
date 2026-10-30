import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeckFiles } from "../src/index.ts";

export const demoDir = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

export function loadDir(dir: string): DeckFiles {
  const text: Record<string, string> = {};
  const assets: string[] = [];
  for (const full of walk(dir)) {
    const path = relative(dir, full).split(sep).join("/");
    if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
    else assets.push(path);
  }
  return { text, assets };
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
