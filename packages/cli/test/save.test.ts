import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, loadDoc, revisionOf } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadDeckDir } from "../src/loader.ts";
import { ChangedOnDiskError, saveDeckDir } from "../src/save.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyDeck(): string {
  const dir = mkdtempSync(join(tmpdir(), "depthcue-save-"));
  temps.push(dir);
  cpSync(demo, dir, { recursive: true });
  return dir;
}

function open(dir: string) {
  const { doc } = loadDoc(loadDeckDir(dir));
  if (!doc) throw new Error("the demo deck should load");
  return doc;
}

describe("saveDeckDir", () => {
  it("writes nothing when nothing changed", () => {
    const dir = copyDeck();
    const doc = open(dir);
    expect(saveDeckDir(dir, doc, doc)).toEqual([]);
  });

  it("writes the manifest after the scenes it lists, and removals last", () => {
    const dir = copyDeck();
    const doc = open(dir);
    const scene = {
      id: "next-steps",
      title: "Next steps",
      layout: "title",
      blocks: [{ id: "next-heading", type: "text", role: "heading", text: "Check the numbers" }],
    };
    const result = applyOps(
      doc,
      [
        { op: "scene.add", scene },
        { op: "scene.remove", id: "method" },
      ],
      revisionOf(doc),
    );
    if (!result.ok) throw new Error("the edit should apply");
    expect(saveDeckDir(dir, doc, result.doc)).toEqual([
      "scenes/next-steps.json",
      "deck.json",
      "scenes/method.json",
    ]);
    expect(existsSync(join(dir, "scenes", "method.json"))).toBe(false);
  });

  it("refuses to overwrite a deck that was edited by hand since it was read", () => {
    const dir = copyDeck();
    const doc = open(dir);
    const result = applyOps(
      doc,
      [{ op: "scene.set", id: "opening", set: { notes: "mine" } }],
      revisionOf(doc),
    );
    if (!result.ok) throw new Error("the edit should apply");

    const handEdited = JSON.parse(readFileSync(join(dir, "scenes", "demand.json"), "utf8"));
    handEdited.notes = "someone else";
    writeFileSync(join(dir, "scenes", "demand.json"), JSON.stringify(handEdited));

    expect(() => saveDeckDir(dir, doc, result.doc)).toThrow(ChangedOnDiskError);
    expect(readFileSync(join(dir, "scenes", "opening.json"), "utf8")).not.toContain("mine");
  });
});
