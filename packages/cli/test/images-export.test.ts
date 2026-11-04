// The offline export (`depthcue export`) copies the files the scenes name. A scene's background is one of them: with
// nothing else naming its picture, the picture still has to be in the folder, and the page has to find it there.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { builtStandaloneDir } from "../src/serve.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/decks/images", import.meta.url));

let root: string;
let deck: string;

beforeEach(() => {
  if (!existsSync(join(builtStandaloneDir(), "depthcue.js"))) {
    throw new Error("The player is not built. Run pnpm build.");
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-images-export-"));
  deck = join(root, "deck");
  cpSync(fixture, deck, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function exportIt(...args: string[]) {
  const lines: string[] = [];
  const code = run(["export", ...args], { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code: code as number, lines };
}

describe("depthcue export of a deck with a scene background", () => {
  it("copies the background's file when it is the only thing that names it, and leaves an unnamed file out", () => {
    // One scene, whose only picture is its background; a second file that no scene names.
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    writeFileSync(join(deck, "deck.json"), JSON.stringify({ ...manifest, scenes: ["background"] }));
    writeFileSync(join(deck, "assets", "unused.png"), readFileSync(join(deck, "assets", "grid.png")));
    const out = join(root, "out");
    const { code, lines } = exportIt(deck, "--out", out);
    expect(code).toBe(0);
    expect(existsSync(join(out, "assets", "grid.png"))).toBe(true);
    expect(existsSync(join(out, "assets", "unused.png"))).toBe(false);
    expect(lines.join("\n")).toContain("left out because no scene names them: assets/unused.png");
    // The page carries the scene with its background, which the player draws from ./assets/ beside the page.
    const page = readFileSync(join(out, "index.html"), "utf8");
    expect(page).toContain('"background"');
    expect(page).toContain("assets/grid.png");
  });

  it("copies the picture of a block and of a background once, and every scene's pictures in a whole deck", () => {
    const out = join(root, "all");
    const { code, lines } = exportIt(deck, "--out", out);
    expect(code).toBe(0);
    expect(existsSync(join(out, "assets", "grid.png"))).toBe(true);
    expect(lines.join("\n")).toContain("1 asset,");
  });
});
