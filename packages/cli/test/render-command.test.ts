import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { revisionOf } from "@depthcue/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyToFolder, openDeck } from "../src/deck-api.ts";
import { run } from "../src/index.ts";
import { launchBrowser } from "../src/render.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const temps: string[] = [];
let hasBrowser = false;

beforeAll(async () => {
  try {
    await (await launchBrowser()).close();
    hasBrowser = true;
  } catch (error) {
    if (process.env.CI) throw error;
    console.warn(`Skipped: ${(error as Error).message}`);
  }
}, 60_000);

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyDeck(): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-cmd-"));
  temps.push(dir);
  cpSync(demo, dir, { recursive: true });
  return dir;
}

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, lines, errors };
}

describe("depthcue render", () => {
  it("renders every scene, writes a PNG for each and exits 0", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const out = join(copyDeck(), "..", `shots-${Date.now()}`);
    temps.push(out);
    const { code, lines } = await cli("render", demo, "--out", out);
    expect(code).toBe(0);
    for (const id of ["opening", "demand", "method"]) {
      expect(existsSync(join(out, `${id}.png`))).toBe(true);
      expect(lines.some((line) => line.startsWith("ok") && line.includes(id))).toBe(true);
    }
    expect(lines.at(-1)).toBe("3 scenes rendered, 0 errors, 0 warnings");
  }, 60_000);

  it("renders one scene at a size, without writing files when --out is left out", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const { code, lines } = await cli(
      "render",
      demo,
      "demand",
      "--width",
      "1920",
      "--height",
      "1080",
      "--step",
      "1",
    );
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("1 scene rendered, 0 errors, 0 warnings");
  }, 60_000);

  it("exits 1 and prints the repair order for a scene that overflows", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const folder = copyDeck();
    const opened = openDeck(folder);
    if (!opened.ok) throw new Error("the deck should open");
    const body = (n: number) => ({
      id: `body-${n}`,
      type: "text",
      role: "body",
      text: Array.from({ length: 80 }, (_, i) => `word${i}`).join(" "),
    });
    const added = applyToFolder(
      folder,
      [
        {
          op: "scene.add",
          scene: {
            id: "crowded",
            title: "Crowded",
            layout: "text-media",
            blocks: [1, 2, 3, 4, 5, 6].map(body),
          },
        },
      ],
      revisionOf(opened.doc),
    );
    expect(added.ok).toBe(true);
    const { code, lines } = await cli("render", folder, "crowded");
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^FAIL crowded/);
    expect(lines.join("\n")).toMatch(/error\s+The scene is \d+px taller/);
    expect(lines.join("\n")).toContain("fix: Shorten the text first");
    expect(lines.at(-1)).toMatch(/^1 scene rendered, [1-9]\d* errors?, 0 warnings$/);
  }, 60_000);

  it("prints one JSON document with --json", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const { code, lines } = await cli("render", demo, "--json");
    expect(code).toBe(0);
    const report = JSON.parse(lines.join("\n"));
    expect(report).toMatchObject({ ok: true, errors: 0 });
    expect(report.scenes.map((row: { scene: string }) => row.scene)).toEqual(["opening", "demand", "method"]);
  }, 60_000);

  it("exits 2 and names the scenes for a scene that does not exist", async ({ skip }) => {
    if (!hasBrowser) return skip();
    const { code, errors } = await cli("render", demo, "nope");
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/no scene "nope".*opening, demand, method/);
  }, 60_000);
});

describe("render arguments", () => {
  it.each([
    [["render", demo, "--step", "x"], "--step needs a whole number"],
    [["render", demo, "--width", "10"], "--width needs a whole number"],
    [["render", demo, "--height", "99999"], "--height needs a whole number"],
    [["render", demo, "--base-rev", "abc"], "Usage:"],
    [["check", demo, "--out", "somewhere"], "Usage:"],
    [["serve", demo, "--width", "800"], "Usage:"],
    [["render"], "Usage:"],
  ])("rejects %j", async (args, message) => {
    const { code, errors } = await cli(...args);
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain(message);
  });

  it("still reads the existing commands the same way", async () => {
    expect((await cli("check", demo)).code).toBe(0);
    expect((await cli("rev", demo)).lines[0]).toMatch(/^[0-9a-f]{16}$/);
    const file = join(copyDeck(), "unused.json");
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(demo, "deck.json"), "utf8")).toContain("channel-demand");
  });
});
