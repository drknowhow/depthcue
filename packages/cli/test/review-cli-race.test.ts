import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_FILE } from "@depthcue/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";

// A folder that moves between a read and a write cannot be staged from outside, so the writes fail once on cue.
const hooks = vi.hoisted(() => ({ fail: undefined as "deck" | "review" | undefined }));

vi.mock("../src/save.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/save.ts")>();
  return {
    ...real,
    saveDeckDir: (...args: Parameters<typeof real.saveDeckDir>) => {
      if (hooks.fail === "deck") {
        hooks.fail = undefined;
        throw new real.ChangedOnDiskError("The deck moved.");
      }
      return real.saveDeckDir(...args);
    },
  };
});

vi.mock("../src/review-file.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/review-file.ts")>();
  const { ChangedOnDiskError } = await import("../src/save.ts");
  return {
    ...real,
    saveReviewDir: (...args: Parameters<typeof real.saveReviewDir>) => {
      if (hooks.fail === "review") {
        hooks.fail = undefined;
        throw new ChangedOnDiskError("The review moved.");
      }
      return real.saveReviewDir(...args);
    },
  };
});

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  hooks.fail = undefined;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
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

/** A deck the agent has retitled through `depthcue apply`, so it has a review with one change. */
function editedDeck(): string {
  const root = mkdtempSync(join(tmpdir(), "depthcue-review-race-"));
  temps.push(root);
  const dir = join(root, "deck");
  cpSync(demo, dir, { recursive: true });
  const rev = capture();
  run(["rev", dir], rev.io);
  const ops = join(root, "ops.json");
  writeFileSync(ops, JSON.stringify([{ op: "deck.set", set: { title: "Retitled" } }]));
  const done = capture();
  expect(run(["apply", dir, ops, "--base-rev", rev.lines[0] as string], done.io)).toBe(0);
  return dir;
}

const text = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("depthcue diff when the folder moves under it", () => {
  it("accepts nothing and exits 3 when the review moved while it was written", () => {
    const dir = editedDeck();
    const before = text(dir, REVIEW_FILE);
    hooks.fail = "review";
    const out = capture();
    expect(run(["diff", dir, "accept", "--all"], out.io)).toBe(3);
    expect(out.errors.join("\n")).toContain("changed-on-disk");
    expect(text(dir, REVIEW_FILE)).toBe(before);
  });

  it("reverts nothing and exits 3 when the deck moved while it was written", () => {
    const dir = editedDeck();
    const deck = text(dir, "deck.json");
    hooks.fail = "deck";
    const out = capture();
    expect(run(["diff", dir, "revert", "--all"], out.io)).toBe(3);
    expect(out.errors.join("\n")).toContain("changed-on-disk");
    expect(text(dir, "deck.json")).toBe(deck);
  });

  it("says so in JSON too, with the same exit", () => {
    const dir = editedDeck();
    hooks.fail = "deck";
    const out = capture();
    expect(run(["diff", dir, "revert", "--all", "--json"], out.io)).toBe(3);
    expect(JSON.parse(out.lines.join("\n"))).toMatchObject({ ok: false, code: "changed-on-disk" });
  });

  it("exits 1, not 3, for a refusal that is not a moved folder", () => {
    const dir = editedDeck();
    const out = capture();
    expect(run(["diff", dir, "revert", "deck/titel"], out.io)).toBe(1);
    expect(out.errors.join("\n")).toContain("unknown-change");
  });
});
