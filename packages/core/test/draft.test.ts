import { describe, expect, it } from "vitest";
import {
  attachAutosave,
  createSession,
  DRAFT_FORMAT,
  type DraftStore,
  memoryDraftStore,
  type Op,
  recoverDraft,
  serializeDraft,
  type Timers,
} from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const title = (text: string): Op => ({
  op: "block.set",
  scene: "opening",
  id: "opening-title",
  set: { text },
});
const savedAt = new Date("2026-10-30T12:00:00Z");

function fakeTimers() {
  let next = 0;
  const jobs = new Map<number, () => void>();
  const timers: Timers = {
    set: (callback) => {
      jobs.set(++next, callback);
      return next;
    },
    clear: (handle) => {
      jobs.delete(handle as number);
    },
  };
  return {
    timers,
    fire() {
      const due = [...jobs.values()];
      jobs.clear();
      for (const job of due) job();
    },
    get pending() {
      return jobs.size;
    },
  };
}

describe("autosave", () => {
  it("writes a draft once, after the first unsaved change, however many edits follow", () => {
    const clock = fakeTimers();
    const store = memoryDraftStore();
    const session = createSession(demoDoc());
    attachAutosave(session, store, { timers: clock.timers, now: () => savedAt });
    session.apply([title("One")]);
    session.apply([title("Two")]);
    expect(store.text()).toBeNull();
    expect(clock.pending).toBe(1);
    clock.fire();
    expect(JSON.parse(store.text() as string)).toMatchObject({
      format: DRAFT_FORMAT,
      savedAt: "2026-10-30T12:00:00.000Z",
      rev: session.rev,
      savedRev: session.savedRev,
    });
  });

  it("clears the draft when the deck is saved, or when undo returns to the saved state", () => {
    const clock = fakeTimers();
    const store = memoryDraftStore();
    const session = createSession(demoDoc());
    attachAutosave(session, store, { timers: clock.timers });
    session.apply([title("One")]);
    clock.fire();
    expect(store.text()).not.toBeNull();
    session.markSaved();
    expect(store.text()).toBeNull();

    session.apply([title("Two")]);
    clock.fire();
    expect(store.text()).not.toBeNull();
    session.undo();
    expect(store.text()).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it("flushes on demand and stops listening when stopped", () => {
    const clock = fakeTimers();
    const store = memoryDraftStore();
    const session = createSession(demoDoc());
    const autosave = attachAutosave(session, store, { timers: clock.timers });
    session.apply([title("One")]);
    autosave.flush();
    expect(store.text()).not.toBeNull();
    expect(clock.pending).toBe(0);

    autosave.stop();
    session.apply([title("Two")]);
    expect(clock.pending).toBe(0);
  });

  it("keeps editing when the store fails, reports the error, and retries on the next change", () => {
    const clock = fakeTimers();
    let failing = true;
    const inner = memoryDraftStore();
    const store: DraftStore = {
      read: inner.read,
      clear: inner.clear,
      write: (text) => {
        if (failing) throw new Error("quota exceeded");
        inner.write(text);
      },
    };
    const errors: string[] = [];
    const session = createSession(demoDoc());
    const autosave = attachAutosave(session, store, {
      timers: clock.timers,
      onError: (error) => errors.push(error.message),
    });
    expect(session.apply([title("One")]).ok).toBe(true);
    clock.fire();
    expect(errors).toEqual(["quota exceeded"]);
    expect(autosave.lastError?.message).toBe("quota exceeded");

    failing = false;
    session.apply([title("Two")]);
    clock.fire();
    expect(inner.text()).not.toBeNull();
    expect(autosave.lastError).toBeUndefined();
  });
});

describe("crash recovery", () => {
  function crashedSession() {
    const store = memoryDraftStore();
    const session = createSession(demoDoc());
    const autosave = attachAutosave(session, store, { timers: fakeTimers().timers, now: () => savedAt });
    session.apply([title("Unsaved headline")]);
    session.apply([{ op: "scene.remove", id: "method" }]);
    autosave.flush();
    return { store, rev: session.rev };
  }

  it("brings back the unsaved work of a session that died", () => {
    const { store, rev } = crashedSession();
    const reopened = createSession(demoDoc());
    const found = recoverDraft(store, { assets: reopened.doc.assets, savedRev: reopened.savedRev });
    if (found.status !== "found") throw new Error(`expected a draft, got ${found.status}`);
    expect(found.rev).toBe(rev);
    expect(found.diskChanged).toBe(false);
    expect(found.savedAt).toBe("2026-10-30T12:00:00.000Z");

    reopened.reset(found.doc, { dirty: true });
    expect(reopened.rev).toBe(rev);
    expect(reopened.dirty).toBe(true);
    expect(reopened.doc.deck.scenes).toEqual(["opening", "demand"]);
  });

  it("does not touch the store, so the caller decides whether to discard", () => {
    const { store } = crashedSession();
    const before = store.text();
    recoverDraft(store, { assets: demoDoc().assets, savedRev: createSession(demoDoc()).savedRev });
    expect(store.text()).toBe(before);
  });

  it("warns when the saved files changed after the draft was written", () => {
    const { store } = crashedSession();
    const found = recoverDraft(store, { assets: demoDoc().assets, savedRev: "ffffffffffffffff" });
    expect(found).toMatchObject({ status: "found", diskChanged: true });
  });

  it("finds nothing when there is no draft", () => {
    expect(recoverDraft(memoryDraftStore(), { assets: new Set(), savedRev: "x" })).toEqual({
      status: "none",
    });
  });

  const recover = (text: string | null, read?: () => string | null) => {
    const store: DraftStore = { ...memoryDraftStore(text), ...(read ? { read } : {}) };
    return recoverDraft(store, { assets: demoDoc().assets, savedRev: "x" });
  };

  it("calls a cut-off, foreign or unreadable draft unusable instead of throwing", () => {
    const whole = serializeDraft(createSession(demoDoc()), savedAt);
    const bad = [
      whole.slice(0, whole.length - 20),
      "[]",
      '{"format":"other"}',
      '{"format":"depthcue-draft/1"}',
    ];
    for (const text of bad) expect(recover(text).status).toBe("unusable");
    const unreadable = recover(null, () => {
      throw new Error("disk gone");
    });
    expect(unreadable.status === "unusable" && unreadable.diagnostics[0]?.message).toContain("disk gone");
  });

  it("rejects a draft that was edited or that no longer validates", () => {
    const whole = JSON.parse(serializeDraft(createSession(demoDoc()), savedAt));
    const tampered = structuredClone(whole);
    tampered.scenes[0].notes = "changed by hand";
    const mismatch = recover(JSON.stringify(tampered));
    expect(mismatch.status === "unusable" && mismatch.diagnostics[0]?.message).toContain("its own revision");

    const invalid = structuredClone(whole);
    invalid.scenes[0].layout = "poster";
    const failed = recover(JSON.stringify(invalid));
    expect(failed.status === "unusable" && failed.diagnostics.map((d) => d.code)).toEqual([
      "bad-draft",
      "bad-value",
    ]);
  });
});
