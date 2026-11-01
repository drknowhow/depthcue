import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { builtStandaloneDir } from "../src/serve.ts";

// A machine with no Chrome or Edge, whatever this one has: the browser cannot be started.
vi.mock("../src/render.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/render.ts")>();
  return {
    ...original,
    launchBrowser: async () => {
      throw new original.RenderError(
        "No browser could be started. Install Chrome or Edge, or set DEPTHCUE_BROWSER to a Chromium executable.\nChrome: not found",
      );
    },
  };
});

const v01 = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;
let deck: string;

beforeEach(() => {
  if (!existsSync(join(builtStandaloneDir(), "depthcue.js"))) {
    throw new Error("The player is not built. Run pnpm build.");
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-nobrowser-"));
  deck = join(root, "deck");
  cpSync(v01, deck, { recursive: true });
});

afterEach(() => {
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

describe("export --format pptx on a machine with no browser", () => {
  it("says so in plain words, exits 2, and writes nothing", async () => {
    const out = join(root, "out.pptx");
    const { io, lines, errors } = capture();
    const code = await run(["export", deck, "--format", "pptx", "--out", out], io);
    expect(code).toBe(2);
    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("No browser could be started. Install Chrome or Edge");
    expect(errors[0]).toContain("DEPTHCUE_BROWSER");
    // A message to act on, not a stack trace.
    expect(errors[0]).not.toMatch(/\bat .*\.ts:\d+/);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(root)).toEqual(["deck"]);
  });

  it("says the same as JSON on stdout with --json", async () => {
    const { io, lines, errors } = capture();
    const code = await run(
      ["export", deck, "--format", "pptx", "--out", join(root, "out.pptx"), "--json"],
      io,
    );
    expect(code).toBe(2);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: false, code: "no-browser" });
  });

  it("still exports the folder, which needs no browser", async () => {
    const { io, lines } = capture();
    const out = join(root, "site");
    const code = await run(["export", deck, "--out", out], io);
    expect(code).toBe(0);
    expect(lines[0]).toBe(`Exported 3 scenes to ${out}`);
  });
});
