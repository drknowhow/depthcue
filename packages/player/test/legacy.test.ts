// @vitest-environment happy-dom
// A deck written before brands has no brand to draw. The server now sends it a look all the same (the built-in theme, no
// face, no chrome, no template it uses), and the page must come out as it did when it was sent none: the same DOM for every
// scene of every old fixture. The pixels are the render check's to compare (packages/cli/test/brand-player-e2e.test.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Deck, loadDoc, lookOf, type Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { renderScene } from "../src/scene.ts";
import { applyLook } from "../src/style.ts";

const decks = resolve(import.meta.dirname, "../../../fixtures/decks");

function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .replaceAll("\\", "/"),
    );
}

function open(name: string) {
  const dir = join(decks, name);
  const all = filesOf(dir);
  const text: Record<string, string> = {};
  for (const path of all) {
    if (path === "deck.json" || (path.startsWith("scenes/") && path.endsWith(".json"))) {
      text[path] = readFileSync(join(dir, path), "utf8");
    }
  }
  const loaded = loadDoc({ text, assets: all.filter((path) => path.startsWith("assets/")) });
  if (!loaded.doc) throw new Error(`${name} does not load: ${JSON.stringify(loaded.diagnostics)}`);
  return loaded.doc;
}

describe.each(["v0-1", "v0-2", "v0-3", "demo", "charts"])("the old deck %s", (name) => {
  const doc = open(name);
  const look = lookOf(doc);

  it("has nothing of a brand in its look", () => {
    expect(look.faces).toBeUndefined();
    expect(look.chrome).toBeUndefined();
    expect(look.chart).toEqual([]);
    expect(look.styles).toEqual({});
    expect(look.templates).toEqual({});
  });

  it("is drawn as the same DOM with the look as without it, in every scene and at every step", () => {
    const deck = doc.deck as Deck;
    deck.scenes.forEach((id, index) => {
      const scene = doc.scenes[id] as Scene;
      const options = { assetBase: ".", number: index + 1 };
      const before = renderScene(scene, options).outerHTML;
      const after = renderScene(scene, { ...options, look }).outerHTML;
      expect(after, `${name}/${id}`).toBe(before);
    });
  });

  it("sets the theme's colors on the page and nothing a brand adds: no face, no chart colors", () => {
    const page = document.createElement("div");
    applyLook(page, look);
    const names = (page.getAttribute("style") ?? "").match(/--dc-[a-z-]+(?=:)/g) ?? [];
    expect(names).toEqual(expect.arrayContaining(["--dc-bg", "--dc-text", "--dc-action", "--dc-evidence"]));
    expect(names.filter((property) => /^--dc-(chart-|face-|display-weight)/.test(property))).toEqual([]);
  });
});
