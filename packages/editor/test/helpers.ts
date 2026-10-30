import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyOps, docToFiles, loadDoc, type Op, revisionOf } from "@depthcue/core";
import type { Api, DeckPayload, SaveResult } from "../src/api.ts";

// happy-dom replaces the global URL, so the path is built from dirname rather than from import.meta.url.
export const demoDir = resolve(import.meta.dirname, "../../../fixtures/decks/demo");

function readDemo(): { text: Record<string, string>; assets: string[] } {
  const text: Record<string, string> = { "deck.json": readFileSync(join(demoDir, "deck.json"), "utf8") };
  for (const name of readdirSync(join(demoDir, "scenes"))) {
    text[`scenes/${name}`] = readFileSync(join(demoDir, "scenes", name), "utf8");
  }
  return { text, assets: readdirSync(join(demoDir, "assets")).map((name) => `assets/${name}`) };
}

/** A stand-in for `depthcue edit`: it keeps the deck's files in memory and answers like the real server. */
export class FakeServer implements Api {
  text: Record<string, string>;
  assets: string[];
  saves: Array<{ files: Record<string, string>; baseRev: string }> = [];
  uploads: string[] = [];
  loads = 0;
  /** Makes the next save answer with this instead of running. */
  nextSave: SaveResult | undefined;
  /** Makes loadDeck throw while true, like a file caught half-written. */
  loadFails = false;
  /** Runs inside a save before it answers, so a test can change the world mid-request. */
  duringSave: (() => void) | undefined;
  /** Holds loadDeck's answer, which is read when the call is made, until this settles. */
  loadGate: Promise<void> | undefined;

  constructor() {
    const demo = readDemo();
    this.text = demo.text;
    this.assets = demo.assets;
  }

  get rev(): string {
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    return revisionOf(doc);
  }

  /** An edit made behind the editor's back, as an agent would make it. */
  external(ops: Op[]): string {
    const { doc } = loadDoc({ text: this.text, assets: this.assets });
    if (!doc) throw new Error("the fake server's deck should be valid");
    const result = applyOps(doc, ops, revisionOf(doc));
    if (!result.ok) throw new Error(`the external edit was refused: ${result.diagnostics[0]?.message}`);
    this.text = docToFiles(result.doc);
    return result.rev;
  }

  async loadDeck(): Promise<DeckPayload> {
    this.loads += 1;
    if (this.loadFails) throw new Error("scenes/opening.json: not valid JSON");
    const answer = { rev: this.rev, text: { ...this.text }, assets: [...this.assets], warnings: [] };
    await this.loadGate;
    return answer;
  }

  async save(files: Record<string, string>, baseRev: string): Promise<SaveResult> {
    this.saves.push({ files, baseRev });
    this.duringSave?.();
    if (this.nextSave) {
      const answer = this.nextSave;
      this.nextSave = undefined;
      return answer;
    }
    if (baseRev !== this.rev) {
      return { ok: false, kind: "stale", rev: this.rev, message: "The deck changed on disk." };
    }
    const loaded = loadDoc({ text: files, assets: this.assets });
    if (!loaded.doc) {
      return { ok: false, kind: "rejected", message: "Invalid.", diagnostics: [] };
    }
    this.text = docToFiles(loaded.doc);
    return { ok: true, rev: revisionOf(loaded.doc) };
  }

  async uploadAsset(_file: Blob, name: string): Promise<string> {
    const path = `assets/${name.toLowerCase().replace(/[^a-z0-9.]+/g, "-")}`;
    this.uploads.push(path);
    if (!this.assets.includes(path)) this.assets.push(path);
    return path;
  }
}

export const retitle = (text: string): Op => ({
  op: "block.set",
  scene: "opening",
  id: "opening-title",
  set: { text },
});

export const openingTitle = (doc: {
  scenes: Readonly<Record<string, { blocks: ReadonlyArray<unknown> }>>;
}) => {
  const block = doc.scenes.opening?.blocks.find(
    (candidate) => (candidate as { id: string }).id === "opening-title",
  );
  return (block as { text: string } | undefined)?.text;
};
