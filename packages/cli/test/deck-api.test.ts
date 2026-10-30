import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { revisionOf } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { applyToFolder, getOutline, getScene, openDeck } from "../src/deck-api.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyDeck(): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-api-"));
  temps.push(dir);
  cpSync(demo, dir, { recursive: true });
  return dir;
}

function open(folder: string) {
  const opened = openDeck(folder);
  if (!opened.ok) throw new Error("the demo deck should open");
  return opened.doc;
}

describe("getOutline", () => {
  it("lists scenes with a revision, in deck order", () => {
    const doc = open(demo);
    const outline = getOutline(doc);
    expect(outline.rev).toBe(revisionOf(doc));
    expect(outline.scenes.map((scene) => scene.id)).toEqual(["opening", "demand", "method"]);
    expect(outline.scenes[1]).toEqual({
      id: "demand",
      title: "Demand is shifting",
      layout: "claim-evidence",
      lead: "agent",
      blocks: 1,
      steps: 2,
    });
  });

  it("adds block lists and per-scene revisions when detailed", () => {
    const detailed = getOutline(open(demo), "detailed").scenes[1];
    expect(detailed).toMatchObject({
      summary: "Channel B now leads, 60 to 40.",
      blockList: [{ id: "chart-demand", type: "bar-chart" }],
      hasNotes: true,
      hasReading: true,
    });
    expect(String((detailed as { rev: string }).rev)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("getScene", () => {
  it("returns the scene with the deck revision to edit against", () => {
    const doc = open(demo);
    const result = getScene(doc, "demand");
    if (!result.ok) throw new Error(result.message);
    expect(result.rev).toBe(revisionOf(doc));
    expect(result.scene.id).toBe("demand");
    expect(result.assets).toBeUndefined();
    const detailed = getScene(doc, "demand", "detailed");
    expect(detailed.ok && detailed.assets).toContain("assets/report.csv");
  });

  it("names the scenes and a likely match when the id is wrong", () => {
    const result = getScene(open(demo), "Demand");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Did you mean "demand"?');
      expect(result.message).toContain("opening, demand, method");
    }
  });
});

describe("applyToFolder", () => {
  const rename = (title = "A new title") => [{ op: "deck.set", set: { title } }];

  it("writes an accepted edit and returns the new revision", () => {
    const folder = copyDeck();
    const before = revisionOf(open(folder));
    const outcome = applyToFolder(folder, rename(), before);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prevRev).toBe(before);
    expect(outcome.rev).toBe(revisionOf(open(folder)));
    expect(outcome.written).toEqual(["deck.json"]);
    expect(JSON.parse(readFileSync(join(folder, "deck.json"), "utf8")).title).toBe("A new title");
  });

  it("rejects a stale revision, leaves the files alone and says what to do", () => {
    const folder = copyDeck();
    const before = readFileSync(join(folder, "deck.json"), "utf8");
    const outcome = applyToFolder(folder, rename(), "0000000000000000");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("stale-revision");
    expect(outcome.rev).toBe(revisionOf(open(folder)));
    expect(outcome.hint).toContain(`base_rev "${outcome.rev}"`);
    expect(outcome.hint).toContain("deck_get");
    expect(readFileSync(join(folder, "deck.json"), "utf8")).toBe(before);
  });

  it("rejects a bad operation with the reason and writes nothing", () => {
    const folder = copyDeck();
    const rev = revisionOf(open(folder));
    const outcome = applyToFolder(folder, [{ op: "scene.remove", id: "missing" }], rev);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("bad-op");
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
    expect(outcome.hint).toContain("Nothing was applied");
    expect(revisionOf(open(folder))).toBe(rev);
  });

  it("refuses a deck folder that has errors before touching it", () => {
    const folder = copyDeck();
    writeFileSync(join(folder, "deck.json"), "{ not json");
    const outcome = applyToFolder(folder, [], "x");
    expect(outcome).toMatchObject({ ok: false, code: "unreadable-deck" });
  });
});
