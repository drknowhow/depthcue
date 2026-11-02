// Brand files in the deck's revision: what changed and what did not. Decks without brand files keep the revision they
// had before files counted, and a review or an editor draft written before then still loads, with nothing lost.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  type Doc,
  docToFiles,
  loadDoc,
  memoryDraftStore,
  type Op,
  REVIEW_FILE,
  recoverDraft,
  reviewToText,
  revisionOf,
  serializeDraft,
  startReview,
} from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { type RunningServer, startServer } from "../src/serve.ts";

const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));
const HARBOR_BOLD = readFileSync(join(decks, "v0-4-brand/brand/fonts/HarborSans-Bold.woff2"));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-rev-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

function copyDeck(name: string, as = name): string {
  const dir = join(root, as);
  cpSync(join(decks, name), dir, { recursive: true });
  return dir;
}

function docOf(dir: string): Doc {
  const loaded = loadDoc(loadDeckDir(dir));
  if (!loaded.doc) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.doc;
}

/** The deck as the code before this step saw it: no brand file in its revision. */
const withoutFiles = (doc: Doc): Doc => {
  const { brandHashes: _hashes, ...rest } = doc;
  return rest;
};

/** The deck as saved, as the editor tells recoverDraft about it. */
const savedAs = (doc: Doc) => ({
  assets: doc.assets,
  ...(doc.brandFiles === undefined ? {} : { brandFiles: doc.brandFiles }),
  savedRev: revisionOf(doc),
});

const opsFile = (ops: unknown[]): string => {
  const file = join(root, `ops-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(ops));
  return file;
};

describe("the revision", () => {
  it("is the same as before for every deck without brand files", async () => {
    // Measured with the code at 410e021, before brand files counted.
    const before: Record<string, string> = {
      "v0-1": "ec4e0cd5c59ef06a",
      "v0-2": "5ba3679835bdb955",
      "v0-3": "b2c39f24e9089ee9",
      demo: "eb9d45889adffe19",
      charts: "468152e3f5f8027b",
    };
    for (const [name, rev] of Object.entries(before)) {
      expect(revisionOf(docOf(join(decks, name))), name).toBe(rev);
      expect((await cli("rev", join(decks, name))).out, name).toBe(rev);
    }
  });

  it("is the same as before for a branded deck with no brand files, and its licence text never counts", () => {
    const dir = copyDeck("v0-4-brand", "nofiles");
    rmSync(join(dir, "brand/fonts/HarborSans-Bold.woff2"));
    rmSync(join(dir, "brand/fonts/HarborSans-Regular.woff2"));
    rmSync(join(dir, "brand/logos"), { recursive: true });
    const brand = JSON.parse(readFileSync(join(dir, "brand/brand.json"), "utf8"));
    delete brand.fonts;
    delete brand.logos;
    delete brand.chrome.logo;
    writeFileSync(join(dir, "brand/brand.json"), `${JSON.stringify(brand, null, 2)}\n`);
    expect(revisionOf(docOf(dir))).toBe("3b25c7e19e33f331");
    writeFileSync(join(dir, "brand/fonts/OFL.txt"), "Another licence.\n");
    writeFileSync(join(dir, "brand/.depthcue-brand-use"), "{}\n");
    expect(revisionOf(docOf(dir))).toBe("3b25c7e19e33f331");
  });

  it("counts the files of a deck with a brand, and only theirs", () => {
    // Before: 325c6bcdb08ac4a2 and d35e78e6dc040fbb, which the decks' JSON alone still gives.
    expect(revisionOf(withoutFiles(docOf(join(decks, "v0-4-brand"))))).toBe("325c6bcdb08ac4a2");
    expect(revisionOf(withoutFiles(docOf(join(decks, "tidewell-press"))))).toBe("d35e78e6dc040fbb");
    expect(revisionOf(docOf(join(decks, "v0-4-brand")))).toBe("3615e932844d6f4a");
    expect(revisionOf(docOf(join(decks, "tidewell-press")))).toBe("253f1a61dd25dc7c");
    // A brand folder in a deck that has no brand.json is not the deck's brand: its files do not count.
    const dir = copyDeck("v0-3");
    cpSync(join(decks, "v0-4-brand/brand/fonts"), join(dir, "brand/fonts"), { recursive: true });
    expect(revisionOf(docOf(dir))).toBe("b2c39f24e9089ee9");
  });

  it("changes when a font is replaced on disk with other bytes, and back when it is put back", () => {
    const dir = copyDeck("tidewell-press");
    const font = join(dir, "brand/fonts/TidewellText-Bold.woff2");
    const original = readFileSync(font);
    writeFileSync(font, HARBOR_BOLD);
    expect(revisionOf(docOf(dir))).not.toBe("253f1a61dd25dc7c");
    writeFileSync(font, original);
    expect(revisionOf(docOf(dir))).toBe("253f1a61dd25dc7c");
  });
});

describe("work saved before brand files counted", () => {
  it("an old review.json loads with no change to review, and records the next edit with the files", async () => {
    const dir = copyDeck("tidewell-press");
    const old = startReview(withoutFiles(docOf(dir)));
    expect(old.rev).toBe("d35e78e6dc040fbb");
    expect(old.files).toBeUndefined();
    writeFileSync(join(dir, REVIEW_FILE), reviewToText(old));

    const listed = JSON.parse((await cli("diff", dir, "--json")).out);
    expect(listed.changes).toEqual([]);

    const applied = await cli(
      "apply",
      dir,
      opsFile([{ op: "deck.set", set: { title: "A new title" } }]),
      "--base-rev",
      revisionOf(docOf(dir)),
    );
    expect(applied.code, applied.err).toBe(0);
    const after = JSON.parse((await cli("diff", dir, "--json")).out);
    expect(after.changes.map((change: { id: string; by: string }) => [change.id, change.by])).toEqual([
      ["deck/title", "agent"],
    ]);
    const review = JSON.parse(readFileSync(join(dir, REVIEW_FILE), "utf8"));
    expect(Object.keys(review.files).sort()).toEqual([
      "brand/fonts/TidewellDisplay-Italic.woff2",
      "brand/fonts/TidewellDisplay-Regular.woff2",
      "brand/fonts/TidewellText-Bold.woff2",
      "brand/fonts/TidewellText-Regular.woff2",
      "brand/logos/tidewell-dark.svg",
      "brand/logos/tidewell-light.svg",
    ]);
    // The reviewed deck is the one before the edit, with its files: what the person reverts to.
    const reverted = await cli("diff", dir, "revert", "--all");
    expect(reverted.code, reverted.err).toBe(0);
    expect(revisionOf(docOf(dir))).toBe("253f1a61dd25dc7c");
  });

  it("an old review with the agent's change still pending keeps it, to accept or revert", async () => {
    const dir = copyDeck("v0-4-brand");
    const old = startReview(withoutFiles(docOf(dir)), ["deck/title"]);
    writeFileSync(join(dir, REVIEW_FILE), reviewToText(old));
    const deck = JSON.parse(readFileSync(join(dir, "deck.json"), "utf8"));
    writeFileSync(
      join(dir, "deck.json"),
      `${JSON.stringify({ ...deck, title: "The agent's title" }, null, 2)}\n`,
    );

    const listed = JSON.parse((await cli("diff", dir, "--json")).out);
    expect(listed.changes.map((change: { id: string; by: string }) => [change.id, change.by])).toEqual([
      ["deck/title", "agent"],
    ]);
    expect((await cli("diff", dir, "revert", "deck/title")).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "deck.json"), "utf8")).title).toBe(deck.title);
    expect(revisionOf(docOf(dir))).toBe("3615e932844d6f4a");
  });

  it("an old editor draft recovers with no warning, and warns when the deck changed by hand since", () => {
    const dir = copyDeck("v0-4-brand");
    const saved = docOf(dir);
    // The draft the editor wrote before: revisions without the files, and no files in it.
    const old = withoutFiles(saved);
    const edited = applyOps(old, [{ op: "deck.set", set: { title: "Draft title" } }], revisionOf(old));
    if (!edited.ok) throw new Error(JSON.stringify(edited.diagnostics));
    const text = serializeDraft(
      { doc: edited.doc, rev: revisionOf(edited.doc), savedRev: revisionOf(old) },
      new Date("2026-10-01T00:00:00Z"),
    );
    const draft = JSON.parse(text);
    delete draft.files;
    expect(draft.savedRev).toBe("325c6bcdb08ac4a2");
    const store = memoryDraftStore(JSON.stringify(draft));
    const found = recoverDraft(store, savedAs(saved));
    expect(found).toMatchObject({ status: "found", diskChanged: false, rev: draft.rev });
    if (found.status !== "found") return;
    expect(found.doc.deck.title).toBe("Draft title");
    expect(found.doc.brandHashes).toEqual(saved.brandHashes);

    // A hand edit to the saved deck since the draft is still noticed.
    const deck = JSON.parse(readFileSync(join(dir, "deck.json"), "utf8"));
    writeFileSync(join(dir, "deck.json"), `${JSON.stringify({ ...deck, title: "By hand" }, null, 2)}\n`);
    expect(recoverDraft(store, savedAs(docOf(dir)))).toMatchObject({ status: "found", diskChanged: true });
  });

  it("a new draft warns when a brand file was replaced on disk since", () => {
    const dir = copyDeck("v0-4-brand");
    const saved = docOf(dir);
    const edited = applyOps(saved, [{ op: "deck.set", set: { title: "Draft title" } }], revisionOf(saved));
    if (!edited.ok) throw new Error(JSON.stringify(edited.diagnostics));
    const store = memoryDraftStore(
      serializeDraft(
        { doc: edited.doc, rev: revisionOf(edited.doc), savedRev: revisionOf(saved) },
        new Date(),
      ),
    );
    writeFileSync(join(dir, "brand/logos/harbor.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(recoverDraft(store, savedAs(docOf(dir)))).toMatchObject({ status: "found", diskChanged: true });
  });
});

describe("a brand file replaced by the agent", () => {
  it("is a change in review, which revert leaves and accept takes", async () => {
    const dir = copyDeck("tidewell-press");
    const font = join(root, "TidewellText-Bold.woff2");
    writeFileSync(font, HARBOR_BOLD);
    const rev = revisionOf(docOf(dir));
    const refused = await cli("brand", "add", font, dir, "--kind", "font", "--json");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({
      error: "exists",
      existing: "fonts/TidewellText-Bold.woff2",
    });
    const replaced = await cli(
      "brand",
      "add",
      font,
      dir,
      "--kind",
      "font",
      "--replace",
      "--base-rev",
      rev,
      "--json",
    );
    expect(replaced.code, replaced.err).toBe(0);
    expect(JSON.parse(replaced.out)).toMatchObject({
      replaced: true,
      prevRev: rev,
      rev: revisionOf(docOf(dir)),
    });

    const listed = JSON.parse((await cli("diff", dir, "--json")).out);
    expect(listed.changes).toMatchObject([
      { id: "deck/file:fonts/TidewellText-Bold.woff2", by: "agent", kind: "changed" },
    ]);
    const reverted = JSON.parse((await cli("diff", dir, "revert", "--all", "--json")).out);
    expect(reverted.reverted).toEqual([]);
    expect(reverted.left.map((left: { id: string }) => left.id)).toEqual([
      "deck/file:fonts/TidewellText-Bold.woff2",
    ]);
    expect(readFileSync(join(dir, "brand/fonts/TidewellText-Bold.woff2")).equals(HARBOR_BOLD)).toBe(true);
    expect((await cli("diff", dir, "accept", "--all")).code).toBe(0);
    expect(JSON.parse((await cli("diff", dir, "--json")).out).changes).toEqual([]);
  });
});

describe("slot operations", () => {
  let server: RunningServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("write the same files through apply as through the editor's save", async () => {
    const ops: Op[] = [
      { op: "slot.rename", template: "cover", id: "kicker", to: "label" },
      { op: "slot.set", template: "cover", id: "label", set: { hint: "A word or two above the title." } },
    ];
    const byApply = copyDeck("v0-4-brand", "by-apply");
    const bySave = copyDeck("v0-4-brand", "by-save");
    const applied = await cli("apply", byApply, opsFile(ops), "--base-rev", revisionOf(docOf(byApply)));
    expect(applied.code, applied.err).toBe(0);

    const playerDir = join(root, "player");
    const editorDir = join(root, "editor");
    mkdirSync(playerDir);
    mkdirSync(editorDir);
    writeFileSync(join(playerDir, "app.js"), "export {};");
    writeFileSync(join(editorDir, "editor.js"), "export {};");
    writeFileSync(join(editorDir, "editor.css"), "body{}");
    server = await startServer({ folder: bySave, playerDir, editorDir, port: 0 });
    const before = docOf(bySave);
    const edited = applyOps(before, ops, revisionOf(before));
    if (!edited.ok) throw new Error(JSON.stringify(edited.diagnostics));
    const files = docToFiles(edited.doc);
    const response = await fetch(`http://127.0.0.1:${server.port}/_depthcue/api/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Depthcue-Token": server.token as string },
      body: JSON.stringify({ baseRev: revisionOf(before), files }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).rev).toBe(revisionOf(docOf(byApply)));
    for (const path of ["deck.json", "brand/templates/cover.json", "scenes/welcome.json"]) {
      expect(readFileSync(join(bySave, path), "utf8"), path).toBe(readFileSync(join(byApply, path), "utf8"));
    }
  });
});
