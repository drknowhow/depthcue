import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { builtStandaloneDir } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let root: string;
let deck: string;

beforeEach(() => {
  // The command copies the player's built script, so the player has to be built, as for the other e2e tests.
  if (!existsSync(join(builtStandaloneDir(), "depthcue.js"))) {
    throw new Error("The player is not built. Run pnpm build.");
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-export-cmd-"));
  deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line) },
  };
}

const out = () => join(root, "out");
const exportIt = (...args: string[]) => {
  const { io, lines, errors } = capture();
  const code = run(["export", ...args], io) as number;
  return { code, lines, errors, text: lines.join("\n") };
};

describe("depthcue export", () => {
  it("writes the folder and says what is in it and how to open it", () => {
    const { code, lines } = exportIt(deck, "--out", out());
    expect(code).toBe(0);
    expect(lines[0]).toBe(`Exported 3 scenes to ${out()}`);
    expect(lines[1]).toBe(`  open ${join(out(), "index.html")}`);
    const written = ["assets/method.svg", "assets/report.csv", "depthcue.css", "depthcue.js", "index.html"]
      .map((path) => statSync(join(out(), path)).size)
      .reduce((a, b) => a + b);
    expect(lines[2]).toBe(`  5 files, ${(written / 1024).toFixed(1)} KB: 2 assets, 0 cue maps, notes kept`);
    expect(lines).toHaveLength(3);
    expect(existsSync(join(out(), "index.html"))).toBe(true);
    expect(readFileSync(join(out(), "depthcue.js"), "utf8")).toBe(
      readFileSync(join(builtStandaloneDir(), "depthcue.js"), "utf8"),
    );
  });

  it("leaves the notes out with --no-notes, and says so", () => {
    const { code, lines } = exportIt(deck, "--no-notes", "--out", out());
    expect(code).toBe(0);
    expect(lines[2]).toContain("notes left out");
    expect(readFileSync(join(out(), "index.html"), "utf8")).not.toContain("Pause on the chart");
  });

  it("takes --out written with an equals sign, and the flags in any order", () => {
    const { code } = exportIt("--no-notes", `--out=${out()}`, deck);
    expect(code).toBe(0);
    expect(existsSync(join(out(), "index.html"))).toBe(true);
  });

  it("writes <deck folder name>-export in the current directory by default", () => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const { code, lines } = exportIt(deck);
    expect(code).toBe(0);
    expect(lines[0]).toBe(`Exported 3 scenes to ${join(root, "deck-export")}`);
    expect(existsSync(join(root, "deck-export", "index.html"))).toBe(true);
  });

  it("uses a singular word for one scene and one asset, and names what it left out", () => {
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    writeFileSync(join(deck, "deck.json"), JSON.stringify({ ...manifest, scenes: ["method"] }));
    for (const gone of ["opening", "demand"]) rmSync(join(deck, "scenes", `${gone}.json`));
    writeFileSync(join(deck, "assets", "z.png"), "x");
    const { code, lines } = exportIt(deck, "--out", out());
    expect(code).toBe(0);
    expect(lines[0]).toContain("Exported 1 scene to");
    expect(lines[2]).toMatch(/: 1 asset, 0 cue maps, notes kept$/);
    expect(lines[3]).toBe("  left out because no scene names them: assets/report.csv, assets/z.png");
  });

  it("counts a cue map in the line, in the singular", () => {
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    writeFileSync(join(deck, "deck.json"), JSON.stringify({ ...manifest, scenes: ["movie"] }));
    for (const gone of ["opening", "demand", "method"]) rmSync(join(deck, "scenes", `${gone}.json`));
    writeFileSync(
      join(deck, "scenes", "movie.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "movie",
        title: "A clip",
        layout: "text-media",
        blocks: [
          { id: "movie-heading", type: "text", role: "heading", text: "In motion" },
          { id: "movie-clip", type: "clip", source: "assets/intro.mp4", alt: "x" },
        ],
      }),
    );
    writeFileSync(join(deck, "assets", "intro.mp4"), "video");
    writeFileSync(join(deck, "assets", "intro.cues.json"), JSON.stringify({ cues: [] }));
    const { lines } = exportIt(deck, "--out", out());
    expect(lines[2]).toMatch(/: 1 asset, 1 cue map, notes kept$/);
  });

  it("prints a deck's warnings and still exports", () => {
    writeFileSync(
      join(deck, "scenes", "extra.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "extra",
        title: "Extra",
        layout: "title",
        blocks: [{ id: "extra-title", type: "text", role: "heading", text: "Extra" }],
      }),
    );
    const { code, lines } = exportIt(deck, "--out", out());
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^scenes\/extra\.json {2}warning {2}This scene file is not listed/);
    expect(lines[1]).toMatch(/^ {2}fix: /);
    expect(lines[2]).toBe(`Exported 3 scenes to ${out()}`);
  });

  it("writes nothing and exits 1 for a deck with errors, listing them", () => {
    writeFileSync(join(deck, "scenes", "method.json"), "{ not json");
    const { code, lines } = exportIt(deck, "--out", out());
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith("scenes/method.json"))).toBe(true);
    expect(lines.at(-2)).toMatch(/^\d+ errors?, \d+ warnings?$/);
    expect(lines.at(-1)).toBe("Nothing was exported. Fix the errors and run it again.");
    expect(existsSync(out())).toBe(false);
  });

  it("exits 2 and says what to change when the folder cannot be used", () => {
    const { code, errors, lines } = exportIt(deck, "--out", join(deck, "site"));
    expect(code).toBe(2);
    expect(errors).toEqual([
      `${join(deck, "site")} is inside the deck folder. Pick a folder outside it for --out.`,
    ]);
    expect(lines).toEqual([]);
  });

  it("exits 2 for a folder that is not there", () => {
    const { code, errors } = exportIt(join(root, "nothing"), "--out", out());
    expect(code).toBe(2);
    expect(errors[0]).toContain("is not a directory");
  });

  it("says the same with --json, on stderr, and prints no JSON", () => {
    const { code, errors, lines } = exportIt(join(root, "nothing"), "--out", out(), "--json");
    expect(code).toBe(2);
    expect(errors[0]).toContain("is not a directory");
    expect(lines).toEqual([]);
  });

  it("refuses a folder it did not make, leaves it alone, and exits 2", () => {
    mkdirSync(out());
    writeFileSync(join(out(), "keep.txt"), "x");
    const { code, errors } = exportIt(deck, "--out", out());
    expect(code).toBe(2);
    expect(errors[0]).toContain("was not made by depthcue export");
    expect(readdirSync(out())).toEqual(["keep.txt"]);
  });

  it("replaces its own earlier export", () => {
    expect(exportIt(deck, "--out", out()).code).toBe(0);
    expect(exportIt(deck, "--out", out(), "--no-notes").code).toBe(0);
    expect(readFileSync(join(out(), "index.html"), "utf8")).not.toContain("Pause on the chart");
  });
});

describe("depthcue export --json", () => {
  it("prints what was written as JSON", () => {
    const { code, lines } = exportIt(deck, "--out", out(), "--json");
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0] as string);
    expect(result).toMatchObject({
      ok: true,
      errors: 0,
      warnings: 0,
      out: out(),
      index: join(out(), "index.html"),
      scenes: 3,
      assets: ["assets/method.svg", "assets/report.csv"],
      skipped: [],
      cueMaps: [],
      notes: true,
      files: 5,
      diagnostics: [],
    });
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("carries warnings as diagnostics", () => {
    writeFileSync(
      join(deck, "scenes", "extra.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "extra",
        title: "Extra",
        layout: "title",
        blocks: [{ id: "extra-title", type: "text", role: "heading", text: "Extra" }],
      }),
    );
    const result = JSON.parse(exportIt(deck, "--out", out(), "--json").lines[0] as string);
    expect(result.ok).toBe(true);
    expect(result.warnings).toBe(1);
    expect(result.diagnostics.map((d: { code: string }) => d.code)).toEqual(["orphan-scene-file"]);
  });

  it("reports a deck with errors as JSON and exits 1", () => {
    writeFileSync(join(deck, "scenes", "method.json"), "{ not json");
    const { code, lines } = exportIt(deck, "--out", out(), "--json");
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0] as string);
    expect(result).toMatchObject({ ok: false, code: "deck-invalid" });
    expect(result.errors).toBeGreaterThan(0);
    expect(existsSync(out())).toBe(false);
  });

  it("reports a folder that cannot be used as JSON on stdout and exits 2", () => {
    const { code, lines, errors } = exportIt(deck, "--out", join(deck, "site"), "--json");
    expect(code).toBe(2);
    expect(errors).toEqual([]);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ok: false,
      code: "out-in-deck",
      message: `${join(deck, "site")} is inside the deck folder. Pick a folder outside it for --out.`,
    });
  });
});

describe("how export is called", () => {
  // These calls are refused before anything is written. If a refusal stopped working, the export would run with
  // its default folder in the current directory, so the current directory is a temporary one that is checked.
  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(() => {
    expect(readdirSync(root)).toEqual(["deck"]);
  });

  const usage = (args: string[]) => {
    const { io, errors, lines } = capture();
    const code = run(args, io) as number;
    return { code, text: errors.join("\n"), lines };
  };

  it("needs a deck folder", () => {
    const { code, text } = usage(["export"]);
    expect(code).toBe(2);
    expect(text).toContain("depthcue export <deck-folder> [--out <dir>] [--no-notes] [--json]");
  });

  it("takes no second argument", () => {
    expect(usage(["export", deck, "ops.json"]).code).toBe(2);
    expect(usage(["export", deck, "a", "b"]).text).toContain("Unexpected argument b.");
  });

  it("takes none of the flags that belong to other commands", () => {
    for (const flag of [
      ["--step", "1"],
      ["--width", "800"],
      ["--height", "600"],
      ["--port", "4000"],
      ["--base-rev", "abc"],
      ["--name", "x"],
      ["--quality", "draft"],
    ]) {
      expect(usage(["export", deck, ...flag]).code).toBe(2);
    }
  });

  it("keeps --no-notes for export alone", () => {
    for (const command of [
      ["check", deck],
      ["rev", deck],
      ["serve", deck],
      ["render", deck],
      ["apply", deck, "ops.json", "--base-rev", "x"],
    ]) {
      const { code, text } = usage([...command, "--no-notes"]);
      expect(code).toBe(2);
      expect(text).toContain("--no-notes belongs to export.");
    }
  });

  it("is the only command that takes --out besides render", () => {
    for (const command of [
      ["check", deck],
      ["rev", deck],
      ["serve", deck],
    ]) {
      expect(usage([...command, "--out", out()]).code).toBe(2);
    }
  });

  it("is in the usage text with what it does", () => {
    const { text } = usage([]);
    expect(text).toContain("export Writes a folder that opens by double-click");
    expect(text).toContain("--no-notes leaves them out");
  });
});
