// @vitest-environment happy-dom
import { createSession, type DraftStore, loadDoc, memoryDraftStore, serializeDraft } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

async function open(server = new FakeServer(), drafts: DraftStore = memoryDraftStore()) {
  const store = await openStore(server, () => drafts);
  return { server, drafts, store };
}

const edit = (store: EditorStore, text: string) => store.session.apply([retitle(text)]);

/** A draft as an earlier visit would have left it: the demo deck with a new headline, made on `savedRev`. */
function draftOf(server: FakeServer, headline: string, savedRev = server.rev) {
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("demo should load");
  const session = createSession(doc);
  session.apply([retitle(headline)]);
  const text = serializeDraft(
    { doc: session.doc, rev: session.rev, savedRev },
    new Date("2026-10-30T12:00:00Z"),
  );
  return memoryDraftStore(text);
}

describe("opening", () => {
  it("loads the deck from the server into a clean session", async () => {
    const { store, server } = await open();
    expect(store.session.rev).toBe(server.rev);
    expect(store.status).toMatchObject({ save: "saved", conflict: undefined, draft: undefined });
  });

  it("refuses a deck that does not validate", async () => {
    const server = new FakeServer();
    server.text["scenes/opening.json"] = "{ not json";
    await expect(openStore(server, () => memoryDraftStore())).rejects.toThrow();
  });

  it("asks for the draft by the deck's id", async () => {
    const ids: string[] = [];
    await openStore(new FakeServer(), (id) => {
      ids.push(id);
      return memoryDraftStore();
    });
    expect(ids).toEqual(["channel-demand"]);
  });
});

describe("saving", () => {
  it("sends the whole deck with the revision it started from, then reads as saved", async () => {
    const { store, server } = await open();
    const startedFrom = server.rev;
    edit(store, "A new headline");
    expect(store.status.save).toBe("dirty");
    await store.save();
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]?.baseRev).toBe(startedFrom);
    expect(Object.keys(server.saves[0]?.files ?? {}).sort()).toEqual(Object.keys(server.text).sort());
    expect(store.status.save).toBe("saved");
    expect(store.session.dirty).toBe(false);
    expect(server.rev).toBe(store.session.rev);
  });

  it("uses what the server answered as the new base, so the next save is not stale", async () => {
    const { store, server } = await open();
    edit(store, "One");
    await store.save();
    const afterFirst = server.rev;
    edit(store, "Two");
    await store.save();
    expect(server.saves[1]?.baseRev).toBe(afterFirst);
    expect(store.status.save).toBe("saved");
    expect(openingTitle(loadDoc({ text: server.text, assets: server.assets }).doc ?? ({} as never))).toBe(
      "Two",
    );
  });

  it("clears the draft once the files are saved", async () => {
    const { store, drafts } = await open();
    edit(store, "Drafted");
    store.flush();
    expect(drafts.read()).not.toBeNull();
    await store.save();
    expect(drafts.read()).toBeNull();
  });

  it("keeps edits made while a save was in flight as unsaved", async () => {
    const { store, server } = await open();
    edit(store, "First");
    server.duringSave = () => edit(store, "Second, typed during the save");
    await store.save();
    const afterFirst = server.rev;
    expect(store.session.dirty).toBe(true);
    expect(store.status.save).toBe("dirty");
    expect(openingTitle(store.session.doc)).toBe("Second, typed during the save");
    server.duringSave = undefined;
    await store.save();
    expect(store.status.save).toBe("saved");
    expect(server.saves.at(-1)?.baseRev).toBe(afterFirst);
    expect(server.rev).toBe(store.session.rev);
  });

  it("undoing back to what was saved leaves nothing to save", async () => {
    const { store } = await open();
    edit(store, "Temporary");
    expect(store.status.save).toBe("dirty");
    store.session.undo();
    expect(store.status.save).toBe("saved");
  });

  it("reports a rejection and stays unsaved", async () => {
    const { store, server } = await open();
    edit(store, "x");
    server.nextSave = {
      ok: false,
      kind: "rejected",
      message: "The deck does not pass validation.",
      diagnostics: [
        { code: "x", at: "scenes/opening.json/blocks/0/text", severity: "error", message: "Too short." },
      ],
    };
    await store.save();
    expect(store.status.save).toBe("error");
    expect(store.status.message).toContain("does not pass validation");
    expect(store.status.message).toContain("scenes/opening.json/blocks/0/text");
    expect(store.session.dirty).toBe(true);
  });

  it("survives the server being unreachable and can try again", async () => {
    const { store, server } = await open();
    edit(store, "x");
    server.nextSave = { ok: false, kind: "failed", message: "Could not reach the server.", diagnostics: [] };
    await store.save();
    expect(store.status.save).toBe("error");
    await store.save();
    expect(store.status.save).toBe("saved");
  });

  it("does not start a second save while one is running", async () => {
    const { store, server } = await open();
    edit(store, "x");
    await Promise.all([store.save(), store.save()]);
    expect(server.saves).toHaveLength(1);
  });
});

describe("files changed on disk", () => {
  it("takes the change in when there is nothing unsaved", async () => {
    const { store, server } = await open();
    server.external([retitle("Rewritten by an agent")]);
    await store.syncFromDisk();
    expect(openingTitle(store.session.doc)).toBe("Rewritten by an agent");
    expect(store.status.save).toBe("saved");
    expect(store.status.message).toContain("Updated from the files on disk");
    expect(store.session.canUndo).toBe(false);
  });

  it("flags a conflict instead of overwriting unsaved edits, and loses nothing", async () => {
    const { store, server } = await open();
    edit(store, "Mine");
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    expect(store.status.conflict).toEqual({ diskRev: server.rev });
    expect(store.status.save).toBe("error");
    expect(openingTitle(store.session.doc)).toBe("Mine");
    await store.save();
    expect(server.saves).toHaveLength(0);
  });

  it("refuses a save the server calls stale and then offers the same choice", async () => {
    const { store, server } = await open();
    edit(store, "Mine");
    server.external([retitle("Theirs")]);
    await store.save();
    expect(server.saves).toHaveLength(1);
    expect(store.status.conflict).toEqual({ diskRev: server.rev });
    expect(openingTitle(loadDoc({ text: server.text, assets: server.assets }).doc ?? ({} as never))).toBe(
      "Theirs",
    );
  });

  it("lets the visitor take the disk version", async () => {
    const { store, server, drafts } = await open();
    edit(store, "Mine");
    store.flush();
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    await store.takeDisk();
    expect(openingTitle(store.session.doc)).toBe("Theirs");
    expect(store.status).toMatchObject({ save: "saved", conflict: undefined });
    expect(drafts.read()).toBeNull();
  });

  it("lets the visitor keep theirs, and that save goes through against the new disk revision", async () => {
    const { store, server } = await open();
    edit(store, "Mine");
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    const diskNow = server.rev;
    await store.keepMine();
    expect(server.saves.at(-1)?.baseRev).toBe(diskNow);
    expect(store.status).toMatchObject({ save: "saved", conflict: undefined });
    expect(openingTitle(loadDoc({ text: server.text, assets: server.assets }).doc ?? ({} as never))).toBe(
      "Mine",
    );
  });

  it("is not fooled by its own save arriving back as a change event", async () => {
    const { store, server } = await open();
    edit(store, "Mine");
    // The file watcher reports the write before the save's answer has been processed.
    server.duringSave = () => {
      void store.syncFromDisk();
    };
    await store.save();
    expect(store.status.conflict).toBeUndefined();
    expect(store.status.save).toBe("saved");
  });

  it("throws away a read that a save overtook, instead of showing old files as new", async () => {
    const { store, server } = await open();
    let release: () => void = () => {};
    server.loadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const syncing = store.syncFromDisk(); // reads the files as they are now, then waits
    server.loadGate = undefined;
    edit(store, "Saved in the meantime");
    await store.save();
    release();
    await syncing;
    expect(openingTitle(store.session.doc)).toBe("Saved in the meantime");
    expect(store.status).toMatchObject({ save: "saved", conflict: undefined });
  });

  it("treats a disk change that equals the editor's own content as saved", async () => {
    const { store, server } = await open();
    edit(store, "Same text");
    server.external([retitle("Same text")]);
    await store.syncFromDisk();
    expect(store.status).toMatchObject({ save: "saved", conflict: undefined });
  });

  it("ignores a read that fails while the files are half-written, and recovers on the next one", async () => {
    const { store, server } = await open();
    server.external([retitle("Complete now")]);
    server.loadFails = true;
    await store.syncFromDisk();
    expect(openingTitle(store.session.doc)).not.toBe("Complete now");
    server.loadFails = false;
    await store.syncFromDisk();
    expect(openingTitle(store.session.doc)).toBe("Complete now");
  });

  it("makes a new image on disk usable without a reload", async () => {
    const { store, server } = await open();
    server.assets.push("assets/dropped-in.png");
    await store.syncFromDisk();
    const add = store.session.apply([
      {
        op: "block.add",
        scene: "opening",
        block: { id: "dropped", type: "image", asset: "assets/dropped-in.png", alt: "Dropped in" },
      },
    ]);
    expect(add.ok).toBe(true);
  });
});

describe("drafts", () => {
  it("brings back unsaved work from an earlier visit and says so", async () => {
    const server = new FakeServer();
    const { store } = await open(server, draftOf(server, "From last time"));
    expect(openingTitle(store.session.doc)).toBe("From last time");
    expect(store.status.save).toBe("dirty");
    expect(store.status.draft?.kind).toBe("restored");
  });

  it("holds a draft made against older files until the visitor chooses", async () => {
    const server = new FakeServer();
    const drafts = draftOf(server, "From last time", "0000000000000000");
    const { store } = await open(server, drafts);
    expect(openingTitle(store.session.doc)).not.toBe("From last time");
    expect(store.status.draft?.kind).toBe("stale");
    store.dismissNotice();
    expect(store.status.draft?.kind).toBe("stale");
    store.useDraft();
    expect(openingTitle(store.session.doc)).toBe("From last time");
    expect(store.status).toMatchObject({ save: "dirty", draft: undefined });
  });

  it("drops a held draft when the visitor starts editing instead", async () => {
    const server = new FakeServer();
    const { store } = await open(server, draftOf(server, "Old", "0000000000000000"));
    edit(store, "New work");
    expect(store.status.draft).toBeUndefined();
    store.useDraft();
    expect(openingTitle(store.session.doc)).toBe("New work");
  });

  it("discards a restored draft and goes back to the files", async () => {
    const server = new FakeServer();
    const drafts = draftOf(server, "From last time");
    const { store } = await open(server, drafts);
    await store.discardDraft();
    expect(openingTitle(store.session.doc)).not.toBe("From last time");
    expect(store.status).toMatchObject({ save: "saved", draft: undefined });
    expect(drafts.read()).toBeNull();
  });

  it("removes a draft it cannot use and tells the visitor why", async () => {
    const drafts = memoryDraftStore('{"format":"depthcue-draft/1","deck":');
    const { store } = await open(new FakeServer(), drafts);
    expect(store.status.draft?.kind).toBe("unusable");
    expect(drafts.read()).toBeNull();
    expect(store.status.save).toBe("saved");
  });

  it("keeps editing when the browser will not keep a draft", async () => {
    const blocked: DraftStore = {
      read: () => null,
      write: () => {
        throw new Error("Storage is blocked");
      },
      clear: () => {},
    };
    const { store } = await open(new FakeServer(), blocked);
    edit(store, "Still works");
    store.flush();
    expect(store.status.message).toContain("Storage is blocked");
    expect(openingTitle(store.session.doc)).toBe("Still works");
    await store.save();
    expect(store.status.save).toBe("saved");
  });
});

describe("images", () => {
  it("uploads, then lets a block use the new file", async () => {
    const { store, server } = await open();
    const asset = await store.upload(new File([new Uint8Array([1, 2, 3])], "New Photo.png"));
    expect(asset).toBe("assets/new-photo.png");
    expect(server.uploads).toEqual([asset]);
    const add = store.session.apply([
      { op: "block.add", scene: "opening", block: { id: "photo", type: "image", asset, alt: "A photo" } },
    ]);
    expect(add.ok).toBe(true);
    expect(store.session.dirty).toBe(true);
  });
});
