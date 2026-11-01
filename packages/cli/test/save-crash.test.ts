// A save that stops after any of its file operations must leave a deck folder that loads with no errors. Each batch
// below is one transaction of operations; the save of it is cut short after every k-th write or removal, on a fresh copy
// each time, and the folder is loaded as it was left.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, type Doc, loadDoc, type Op, retemplate, revisionOf } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeckDir } from "../src/loader.ts";
import { RefusedSaveError, type SaveIo, saveDeckDir, writeAtomic } from "../src/save.ts";

const branded = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const plain = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copy(from: string): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-crash-"));
  temps.push(dir);
  cpSync(from, dir, { recursive: true });
  return dir;
}

function open(dir: string): Doc {
  const { doc, diagnostics } = loadDoc(loadDeckDir(dir));
  if (!doc) throw new Error(JSON.stringify(diagnostics));
  return doc;
}

function applied(doc: Doc, ops: Op[]): Doc {
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}

class Stop extends Error {}

/** Disk operations that do the first `limit` and then stop the save, as a process that dies there. */
function stoppingAfter(limit: number): SaveIo & { done: string[] } {
  const done: string[] = [];
  const once = (action: () => void, what: string) => {
    if (done.length === limit) throw new Stop(what);
    action();
    done.push(what);
  };
  return {
    done,
    write: (dir, path, text) => once(() => writeAtomic(dir, path, text), `write ${path}`),
    remove: (dir, path) => once(() => rmSync(join(dir, path), { force: true }), `remove ${path}`),
  };
}

const errorsIn = (dir: string) => loadDoc(loadDeckDir(dir)).diagnostics.filter((d) => d.severity === "error");

/**
 * Runs the batch on a copy of `from` (after `setup`, saved whole), stopping the save after each number of operations
 * in turn. Returns the operations of the whole save, for the test to check what it covered.
 */
function crashEverywhere(from: string, batch: (doc: Doc) => Op[], setup: Op[] = []): string[] {
  const prepare = (): { dir: string; before: Doc; after: Doc } => {
    const dir = copy(from);
    if (setup.length > 0) {
      const start = open(dir);
      saveDeckDir(dir, start, applied(start, setup));
    }
    const before = open(dir);
    return { dir, before, after: applied(before, batch(before)) };
  };
  const whole = prepare();
  const all = stoppingAfter(Number.POSITIVE_INFINITY);
  saveDeckDir(whole.dir, whole.before, whole.after, all);
  expect(revisionOf(open(whole.dir))).toBe(revisionOf(whole.after));
  for (let k = 0; k < all.done.length; k++) {
    const { dir, before, after } = prepare();
    const io = stoppingAfter(k);
    expect(() => saveDeckDir(dir, before, after, io)).toThrow(Stop);
    expect(errorsIn(dir), `stopped after ${k}: ${io.done.join(", ")}`).toEqual([]);
  }
  return all.done;
}

const LOUD: Op = { op: "style.set", id: "loud", style: { name: "Loud", for: ["heading"], case: "upper" } };
const SOLO: Op = {
  op: "template.set",
  id: "solo",
  template: {
    name: "Solo",
    description: "A heading over its text.",
    slots: [
      {
        id: "head",
        role: "subtitle",
        frame: { x: 8, y: 8, w: 84, h: 24 },
        accepts: ["caption", "heading"],
        max: 2,
        hint: "The point.",
      },
      {
        id: "text",
        role: "body",
        frame: { x: 8, y: 36, w: 84, h: 56 },
        accepts: ["body", "quote"],
        max: 2,
        hint: "What backs it.",
      },
    ],
  },
};

describe("a save stopped after any file operation", () => {
  it("leaves a deck that loads, for a new template and a scene moved onto it", () => {
    const done = crashEverywhere(branded, (doc) => [
      SOLO,
      ...retemplate(applied(doc, [SOLO]), "context", { template: "solo" }).ops,
    ]);
    expect(done).toEqual(["write brand/templates/solo.json", "write scenes/context.json"]);
  });

  it("leaves a deck that loads, for a new style and a block that uses it", () => {
    const done = crashEverywhere(branded, () => [
      LOUD,
      { op: "block.set", scene: "context", id: "context-heading", set: { style: "loud" } },
    ]);
    expect(done).toEqual(["write brand/brand.json", "write scenes/context.json"]);
  });

  it("leaves a deck that loads, for a brand made on a deck without one, with a template", () => {
    const done = crashEverywhere(plain, () => [{ op: "brand.set", set: { id: "acme", name: "Acme" } }, SOLO]);
    expect(done).toEqual(["write brand/brand.json", "write brand/templates/solo.json", "write deck.json"]);
  });

  it("leaves a deck that loads, for the brand taken off with its scenes moved off it", () => {
    const done = crashEverywhere(branded, (doc) => [
      ...retemplate(doc, "welcome", { template: "section" }).ops,
      ...retemplate(doc, "growth", { layout: "text-media" }).ops,
      { op: "block.set", scene: "context", id: "context-kicker", set: { style: null } },
      { op: "block.set", scene: "context", id: "context-body", set: { style: null } },
      { op: "brand.set", set: null },
    ]);
    expect(done.slice(-4)).toEqual([
      "write deck.json",
      "remove brand/templates/chart-and-note.json",
      "remove brand/templates/cover.json",
      "remove brand/brand.json",
    ]);
  });

  it("leaves a deck that loads, for a template removed and its scene moved off it", () => {
    const done = crashEverywhere(branded, (doc) => [
      ...retemplate(doc, "growth", { template: "two-column" }).ops,
      { op: "template.set", id: "chart-and-note", template: null },
    ]);
    expect(done).toEqual(["write scenes/growth.json", "remove brand/templates/chart-and-note.json"]);
  });

  it("leaves a deck that loads, for a template and the style its slot names removed together", () => {
    const done = crashEverywhere(branded, (doc) => [
      ...retemplate(doc, "growth", { template: "two-column" }).ops,
      { op: "block.set", scene: "context", id: "context-body", set: { style: null } },
      { op: "template.set", id: "chart-and-note", template: null },
      { op: "style.set", id: "quiet-panel", style: null },
    ]);
    // The template names the style in a slot, so it goes before brand.json loses the style.
    expect(done).toEqual([
      "write scenes/context.json",
      "write scenes/growth.json",
      "remove brand/templates/chart-and-note.json",
      "write brand/brand.json",
    ]);
  });

  it("leaves a deck that loads, for built-in styles hidden while a template that names one is removed", () => {
    const template = JSON.parse(readFileSync(join(branded, "brand/templates/chart-and-note.json"), "utf8"));
    const slots = template.slots.map((slot: { style?: string }) =>
      slot.style === "quiet-panel" ? { ...slot, style: "callout" } : slot,
    );
    const done = crashEverywhere(
      branded,
      (doc) => [
        ...retemplate(doc, "growth", { template: "two-column" }).ops,
        { op: "block.set", scene: "context", id: "context-quote", set: { style: null } },
        { op: "template.set", id: "chart-and-note", template: null },
        { op: "brand.set", set: { hideBuiltIn: ["styles"] } },
      ],
      [{ op: "template.set", id: "chart-and-note", template: { ...template, slots } }],
    );
    expect(done.slice(-2)).toEqual(["remove brand/templates/chart-and-note.json", "write brand/brand.json"]);
  });

  it("leaves a deck that loads, for a style removed with the block that used it", () => {
    const done = crashEverywhere(branded, () => [
      { op: "block.set", scene: "context", id: "context-kicker", set: { style: null } },
      { op: "style.set", id: "kicker", style: null },
    ]);
    // brand.json as it was still has the style, so it is written once, after the scene.
    expect(done).toEqual(["write scenes/context.json", "write brand/brand.json"]);
  });

  it("leaves a deck that loads, for one style added and another removed in the same batch", () => {
    const done = crashEverywhere(branded, () => [
      LOUD,
      { op: "block.set", scene: "context", id: "context-heading", set: { style: "loud" } },
      { op: "block.set", scene: "context", id: "context-kicker", set: { style: null } },
      { op: "style.set", id: "kicker", style: null },
    ]);
    expect(done).toEqual(["write brand/brand.json", "write scenes/context.json", "write brand/brand.json"]);
  });

  it("leaves a deck that loads, for one of 24 styles replaced by a new one", () => {
    // The fixture has two styles; 22 more puts the brand at its limit.
    const many: Op[] = Array.from({ length: 22 }, (_, i) => ({
      op: "style.set",
      id: `s-${i}`,
      style: { name: `S${i}`, for: ["body"] },
    }));
    const done = crashEverywhere(
      branded,
      () => [
        { op: "style.set", id: "s-0", style: null },
        { op: "style.set", id: "s-new", style: { name: "New", for: ["body"] } },
      ],
      many,
    );
    // No scene or template names s-0, so brand.json is not first written with all 25.
    expect(done).toEqual(["write brand/brand.json"]);
  });

  it("leaves a deck that loads, for built-in styles hidden once no block uses them", () => {
    const done = crashEverywhere(branded, () => [
      { op: "block.set", scene: "context", id: "context-quote", set: { style: null } },
      { op: "brand.set", set: { hideBuiltIn: ["styles"] } },
    ]);
    expect(done).toEqual(["write scenes/context.json", "write brand/brand.json"]);
  });

  it("leaves a deck that loads, for a brand locked while deck.json gives up its own fonts", () => {
    const done = crashEverywhere(
      branded,
      () => [
        { op: "deck.set", set: { fonts: null } },
        { op: "brand.set", set: { lock: true } },
      ],
      [{ op: "deck.set", set: { fonts: "classic" } }],
    );
    expect(done).toEqual(["write deck.json", "write brand/brand.json"]);
  });
});

describe("a brand made, stopped before deck.json, and saved again", () => {
  const ACME: Op = { op: "brand.set", set: { id: "acme", name: "Acme" } };

  /** A copy of the plain deck where a save of `ops` stopped after `limit` operations. */
  function stopped(ops: Op[], limit: number): string {
    const dir = copy(plain);
    const before = open(dir);
    expect(() => saveDeckDir(dir, before, applied(before, ops), stoppingAfter(limit))).toThrow(Stop);
    return dir;
  }

  const refusedFiles = (dir: string, ops: Op[]): string[] => {
    const before = open(dir);
    try {
      saveDeckDir(dir, before, applied(before, ops));
    } catch (error) {
      if (!(error instanceof RefusedSaveError)) throw error;
      return error.diagnostics.map((d) => `${d.code} ${d.file}`);
    }
    return [];
  };

  it("goes ahead when the files left are the ones the save writes, with the same text", () => {
    for (const limit of [1, 2]) {
      const dir = stopped([ACME, SOLO], limit);
      expect(refusedFiles(dir, [ACME, SOLO])).toEqual([]);
      const doc = open(dir);
      expect(doc.brand?.name).toBe("Acme");
      expect(Object.keys(doc.templates ?? {})).toEqual(["solo"]);
    }
  });

  it("still refuses a file left with other text, or one the save does not write", () => {
    const renamed: Op = { op: "brand.set", set: { id: "acme", name: "Acme Co" } };
    expect(refusedFiles(stopped([ACME], 1), [renamed])).toEqual(["leftover-brand-file brand/brand.json"]);
    expect(refusedFiles(stopped([ACME, SOLO], 2), [ACME])).toEqual([
      "leftover-brand-file brand/templates/solo.json",
    ]);
  });
});
