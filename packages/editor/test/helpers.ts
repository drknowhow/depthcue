import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  applyOps,
  type Cue,
  checkCues,
  cueMapPath,
  docToFiles,
  loadDoc,
  type Op,
  revisionOf,
} from "@depthcue/core";
import type { Api, ClipSize, CueList, DeckPayload, SaveResult } from "../src/api.ts";

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
  /** Cue maps by video path, as `depthcue clip build` or the editor left them. */
  cueMaps: Record<string, { duration: number; width: number; height: number; cues: Cue[] }> = {};
  /** Videos whose cue file is there but is not a cue map. */
  brokenCues = new Set<string>();
  cueLoads: string[] = [];
  cueSaves: Array<{ source: string; cues: Cue[]; clip: ClipSize | undefined }> = [];
  /** Makes loadCues throw while true, like a server that cannot be reached. */
  cueLoadFails = false;
  /** Makes the next saveCues refuse with this message. */
  nextCueSaveFails: string | undefined;
  /** Holds loadCues' answers, which are read when the call is made, until this settles. */
  cueGate: Promise<void> | undefined;

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

  async loadCues(source: string): Promise<CueList> {
    this.cueLoads.push(source);
    if (this.cueLoadFails) throw new Error("The server could not be reached.");
    const map = this.cueMaps[source];
    const answer: CueList = this.brokenCues.has(source)
      ? { state: "broken", cues: [] }
      : map
        ? { state: "ok", cues: structuredClone(map.cues), duration: map.duration }
        : { state: "none", cues: [] };
    await this.cueGate;
    return answer;
  }

  async saveCues(source: string, cues: readonly Cue[], clip?: ClipSize) {
    this.cueSaves.push({ source, cues: structuredClone([...cues]), clip });
    if (this.nextCueSaveFails !== undefined) {
      const message = this.nextCueSaveFails;
      this.nextCueSaveFails = undefined;
      throw new Error(message);
    }
    if (this.brokenCues.has(source)) throw new Error("That is not a cue map the editor can read.");
    const size = this.cueMaps[source] ?? clip;
    if (!size)
      throw new Error("This clip has no cue map yet. Send its duration, width and height to start one.");
    const checked = checkCues(cues, size.duration);
    if (!checked.ok) throw new Error(checked.message);
    const { duration, width, height } = size;
    this.cueMaps[source] = { duration, width, height, cues: checked.cues };
    // The real server lists every file under assets/, so the cue map shows up in the next read of the deck.
    if (!this.assets.includes(cueMapPath(source))) this.assets.push(cueMapPath(source));
    return { cues: structuredClone(checked.cues), duration };
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
