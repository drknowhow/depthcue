import { memoryDraftStore, type Review } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewBook } from "../src/reviewbook.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

let server: FakeServer;
let store: EditorStore;

const TITLE = "scene:opening/block:opening-title/text";
const BODY = "scene:method/block:method-body/text";

const retext = (scene: string, id: string, text: string) => ({
  op: "block.set" as const,
  scene,
  id,
  set: { text },
});
const method = (text: string) => retext("method", "method-body", text);
/** The text of a block in a deck or a review, which both hold their scenes by id. */
const textIn = (
  source: { scenes: Readonly<Record<string, { blocks: ReadonlyArray<unknown> }>> } | undefined,
  scene: string,
  id: string,
): string | undefined => {
  const blocks = source?.scenes[scene]?.blocks ?? [];
  return (blocks.find((block) => (block as { id: string }).id === id) as { text: string } | undefined)?.text;
};
const methodText = () => textIn(store.session.doc, "method", "method-body");
const idsOf = () => store.review.changes().map((change) => change.id);

/** The agent changes the deck through its tools, and the editor, which was open, takes it in. */
async function agentEdits(...edits: Parameters<FakeServer["agentEdit"]>[0][]) {
  for (const ops of edits) server.agentEdit(ops);
  await store.syncFromDisk();
  await store.review.sync();
}

beforeEach(async () => {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  await store.review.sync();
});

afterEach(() => store.dispose());

describe("reading", () => {
  it("is not ready until the first read has finished, and lists nothing before it", async () => {
    store.dispose();
    let release = () => {};
    server.reviewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    store = await openStore(server, () => memoryDraftStore());
    expect(store.review.state).toEqual({ review: undefined, problem: undefined, ready: false });
    expect(store.review.changes()).toEqual([]);
    release();
    await vi.waitFor(() => expect(store.review.state.ready).toBe(true));
  });

  it("has no review and no changes until somebody starts one", () => {
    expect(store.review.state).toEqual({ review: undefined, problem: undefined, ready: true });
    expect(store.review.changes()).toEqual([]);
  });

  it("lists what the agent changed, marked as the agent's, with what it was and what it is", async () => {
    const before = openingTitle(store.session.doc);
    await agentEdits([retitle("A better title")]);
    expect(store.review.changes()).toMatchObject([
      { id: TITLE, by: "agent", kind: "changed", before, after: "A better title" },
    ]);
  });

  it("marks a change nobody made through the agent's tools as outside", async () => {
    await agentEdits([retitle("Agent title")]);
    server.external([method("Hand edit")]);
    await store.syncFromDisk();
    expect(store.review.changes().map((change) => [change.id, change.by])).toEqual([
      [TITLE, "agent"],
      [BODY, "outside"],
    ]);
  });

  it("says why when the file cannot be read, lists nothing and writes nothing over it", async () => {
    server.reviewBroken = "review.json is not valid JSON.";
    await store.review.sync();
    expect(store.review.state).toMatchObject({
      problem: "review.json is not valid JSON.",
      review: undefined,
    });
    expect(store.review.changes()).toEqual([]);
    expect(await store.review.accept("all")).toEqual({
      ok: false,
      message: "review.json is not valid JSON.",
    });
    expect(server.reviewSaves).toEqual([]);
  });

  it("lists what the agent changed again when it is read after the editor was told", async () => {
    await agentEdits([retitle("First")]);
    expect(idsOf()).toEqual([TITLE]);
    server.agentEdit([method("Second")]);
    await store.syncFromDisk();
    await store.review.sync();
    expect(idsOf()).toEqual([TITLE, BODY]);
  });
});

describe("the person's own edits", () => {
  it("are not listed while they wait to be saved", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([method("My edit")]);
    expect(idsOf()).toEqual([TITLE]);
  });

  it("leave the agent's change over the same text out of the list at once, as saving will", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([retitle("Mine instead")]);
    expect(idsOf()).toEqual([]);
    await store.save();
    await store.review.sync();
    expect(idsOf()).toEqual([]);
    expect(server.review?.agent).toEqual([]);
  });

  it("stay out of the list once saved, and leave the agent's change in it", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([method("My edit")]);
    await store.save();
    await store.review.sync();
    expect(idsOf()).toEqual([TITLE]);
    expect(server.review?.agent).toEqual([TITLE]);
  });
});

describe("accept", () => {
  it("copies the change into the reviewed deck against the revision it read, and stops listing it", async () => {
    await agentEdits([retitle("Agent title"), method("Agent body")]);
    const rev = server.reviewRev;
    expect(await store.review.accept([TITLE])).toEqual({ ok: true });
    expect(server.reviewSaves).toHaveLength(1);
    expect(server.reviewSaves[0]?.baseRev).toBe(rev);
    expect(idsOf()).toEqual([BODY]);
    expect(server.review?.agent).toEqual([BODY]);
    expect(textIn(server.review, "opening", "opening-title")).toBe("Agent title");
  });

  it("accepts every change on the list at once", async () => {
    await agentEdits([retitle("Agent title")], [method("Agent body")]);
    expect(await store.review.accept("all")).toEqual({ ok: true });
    expect(idsOf()).toEqual([]);
    expect(server.review?.agent).toEqual([]);
  });

  it("leaves out an edit that is still waiting to be saved, which is the person's and is folded in when saved", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([method("My edit")]);
    expect(await store.review.accept("all")).toEqual({ ok: true });
    expect(textIn(server.review, "method", "method-body")).not.toBe("My edit");
    await store.save();
    await store.review.sync();
    expect(idsOf()).toEqual([]);
  });

  it("is undone with the history, and done again with a redo, while the review is as the accept left it", async () => {
    await agentEdits([retitle("Agent title")]);
    const asFound = structuredClone(server.review);
    await store.review.accept([TITLE]);
    const accepted = structuredClone(server.review);
    expect(store.history.canUndo).toBe(true);
    expect(store.session.canUndo).toBe(false);

    expect(await store.history.undo()).toBeUndefined();
    expect(server.review).toEqual(asFound);
    expect(idsOf()).toEqual([TITLE]);
    expect(store.history.canRedo).toBe(true);

    expect(await store.history.redo()).toBeUndefined();
    expect(server.review).toEqual(accepted);
    expect(idsOf()).toEqual([]);
  });

  it("refuses to undo when the review moved on since, and leaves what the agent wrote there", async () => {
    await agentEdits([retitle("Agent title")]);
    await store.review.accept([TITLE]);
    // Somebody marks another change in review.json, without the deck changing, so the editor does not start over.
    server.review = { ...(server.review as Review), agent: [BODY] };
    await store.review.sync();
    const written = structuredClone(server.review);
    const problem = await store.history.undo();
    expect(problem).toMatch(/review changed since this was accepted/);
    expect(server.review).toEqual(written);
    // The step is forgotten, so the next undo is an edit's again, and it is not stuck behind it.
    expect(store.history.canUndo).toBe(false);
  });

  it("is forgotten when the agent writes the deck again, because the editor then loads the files anew", async () => {
    await agentEdits([retitle("Agent title")]);
    await store.review.accept([TITLE]);
    await agentEdits([method("Later agent edit")]);
    expect(store.history.canUndo).toBe(false);
  });

  it("reads the review again and chooses again on top of it when the agent wrote in between", async () => {
    await agentEdits([retitle("Agent title")]);
    const first = server.reviewRev;
    server.duringReviewSave = () => {
      server.duringReviewSave = undefined;
      server.agentEdit([method("Agent body")]);
    };
    expect(await store.review.accept([TITLE])).toEqual({ ok: true });
    expect(server.reviewSaves).toHaveLength(2);
    expect(server.reviewSaves[0]?.baseRev).toBe(first);
    expect(server.reviewSaves[1]?.baseRev).not.toBe(first);
  });

  it("gives up after one more try and says why", async () => {
    await agentEdits([retitle("Agent title")]);
    server.nextReviewSave = { ok: false, kind: "stale", rev: "x", message: "The review changed on disk." };
    server.duringReviewSave = () => {
      server.duringReviewSave = () => {
        server.duringReviewSave = undefined;
        server.nextReviewSave = { ok: false, kind: "stale", rev: "y", message: "The review changed again." };
      };
    };
    const result = await store.review.accept([TITLE]);
    expect(result).toEqual({ ok: false, message: "The review changed again." });
    expect(idsOf()).toEqual([TITLE]);
  });

  it("says what the server refused, and keeps the change on the list", async () => {
    await agentEdits([retitle("Agent title")]);
    server.nextReviewSave = { ok: false, kind: "rejected", message: "review.json is not valid." };
    expect(await store.review.accept([TITLE])).toEqual({ ok: false, message: "review.json is not valid." });
    expect(idsOf()).toEqual([TITLE]);
  });

  it("refuses a change that is not on the list, and says which, without writing", async () => {
    await agentEdits([retitle("Agent title")]);
    const result = await store.review.accept(["scene:nope"]);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('There is no change "scene:nope"');
    expect(server.reviewSaves).toEqual([]);
  });

  it("with nothing chosen writes nothing and leaves nothing to undo", async () => {
    await agentEdits([retitle("Agent title")]);
    expect(await store.review.accept([])).toEqual({ ok: true });
    expect(store.history.canUndo).toBe(false);
  });

  it("is refused while the files changed on disk under unsaved edits", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([method("My edit")]);
    server.external([retext("method", "method-body", "Someone else")]);
    await store.syncFromDisk();
    expect(store.status.conflict).toBeDefined();
    const result = await store.review.accept("all");
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain("changed on disk");
    expect(server.reviewSaves).toEqual([]);
    expect(store.review.revert("all")).toMatchObject({ ok: false });
  });

  it("is refused while there is no review to answer", async () => {
    store.session.apply([method("My edit")]);
    expect(await store.review.accept("all")).toEqual({
      ok: false,
      message: "There is no review to accept changes in.",
    });
    expect(store.review.revert("all")).toEqual({
      ok: false,
      message: "There is no review to revert changes in.",
    });
  });

  it("throws away a read that a write overtook, so the file as it was does not come back", async () => {
    await agentEdits([retitle("Agent title")]);
    let release = () => {};
    server.reviewGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = store.review.sync(); // answered with the file as it is now, but only after the accept
    server.reviewGate = undefined;
    expect(await store.review.accept([TITLE])).toEqual({ ok: true });
    release();
    await reading;
    expect(idsOf()).toEqual([]);
    expect(store.review.state.review?.agent).toEqual([]);
  });

  it("waits for an earlier accept before it starts, so two answers are not sent at once", async () => {
    await agentEdits([retitle("Agent title")], [method("Agent body")]);
    const both = Promise.all([store.review.accept([TITLE]), store.review.accept([BODY])]);
    expect(await both).toEqual([{ ok: true }, { ok: true }]);
    expect(server.reviewSaves).toHaveLength(2);
    expect(idsOf()).toEqual([]);
  });
});

describe("revert", () => {
  it("puts the text back as it was when reviewed, as one edit that Undo takes back", async () => {
    const was = methodText();
    await agentEdits([method("Agent body")]);
    expect(store.review.revert([BODY])).toEqual({ ok: true });
    expect(methodText()).toBe(was);
    expect(idsOf()).toEqual([]);
    expect(store.session.dirty).toBe(true);
    expect(await store.history.undo()).toBeUndefined();
    expect(methodText()).toBe("Agent body");
    expect(store.review.changes()).toMatchObject([{ id: BODY, by: "agent" }]);
    expect(await store.history.redo()).toBeUndefined();
    expect(methodText()).toBe(was);
  });

  it("reverts every change on the list, and not an edit of the person's that waits to be saved", async () => {
    const was = methodText();
    await agentEdits([retitle("Agent title")], [method("Agent body")]);
    store.session.apply([retext("opening", "opening-sub", "My own")]);
    expect(store.review.revert("all")).toEqual({ ok: true });
    expect(methodText()).toBe(was);
    expect(openingTitle(store.session.doc)).not.toBe("Agent title");
    expect(textIn(store.session.doc, "opening", "opening-sub")).toBe("My own");
  });

  it("says what the deck refused when it will not take the old values back, and leaves nothing to undo", async () => {
    await agentEdits([method("Agent body")]);
    const refusal = {
      ok: false,
      diagnostics: [
        {
          code: "x",
          severity: "error",
          at: "scenes/method.json",
          message: "Not allowed.",
          fix: "Use another.",
        },
      ],
    };
    const refusing = new Proxy(store.session, {
      get: (target, key) => (key === "apply" ? () => refusal : Reflect.get(target, key)),
    });
    const book = createReviewBook(server, refusing, store.history, () => store.session.doc);
    await book.sync();
    expect(book.revert([BODY])).toEqual({ ok: false, message: "Not allowed. Use another." });
    expect(store.history.canUndo).toBe(false);
    book.dispose();
  });

  it("refuses a change that is not on the list and leaves the deck as it is", async () => {
    await agentEdits([retitle("Agent title")]);
    const doc = store.session.doc;
    const result = store.review.revert(["scene:nope"]);
    expect(result).toMatchObject({ ok: false });
    expect(store.session.doc).toBe(doc);
  });

  it("keeps the change the agent's when it is reverted, saved, and then undone, and the save says so", async () => {
    await agentEdits([method("Agent body")]);
    store.review.revert([BODY]);
    await store.save(); // the revert is on disk, so the review has let go of the change
    await store.review.sync();
    expect(server.review?.agent).toEqual([]);
    await store.history.undo();
    expect(store.review.changes()).toMatchObject([{ id: BODY, by: "agent" }]);
    expect(store.review.keepAgent()).toEqual([BODY]);

    await store.save();
    expect(server.saves.at(-1)?.options).toEqual({ keepAgent: [BODY] });
    await store.review.sync();
    expect(server.review?.agent).toEqual([BODY]);
    expect(store.review.changes()).toMatchObject([{ id: BODY, by: "agent" }]);
  });

  it("stops keeping a change the person changed again afterwards", async () => {
    await agentEdits([method("Agent body")]);
    store.review.revert([BODY]);
    await store.save();
    await store.review.sync();
    await store.history.undo();
    expect(store.review.keepAgent()).toEqual([BODY]);
    store.session.apply([method("Mine now")]);
    expect(store.review.keepAgent()).toEqual([]);
  });

  it("stops keeping it when it is reverted again", async () => {
    await agentEdits([method("Agent body")]);
    store.review.revert([BODY]);
    await store.save();
    await store.review.sync();
    await store.history.undo();
    await store.history.redo();
    expect(store.review.keepAgent()).toEqual([]);
    // Typing the agent's words again is then the person's own edit, not the agent's change coming back.
    store.session.apply([method("Agent body")]);
    expect(store.review.keepAgent()).toEqual([]);
    expect(idsOf()).toEqual([]);
  });

  it("keeps only what was reverted, and not the agent's other changes", async () => {
    await agentEdits([retitle("Agent title")], [method("Agent body")]);
    store.review.revert([BODY]);
    await store.history.undo();
    expect(store.review.keepAgent()).toEqual([BODY]);
  });

  it("lists the change as the agent's at once when it comes back, for whatever redraws as the deck changes", async () => {
    await agentEdits([method("Agent body")]);
    store.review.revert([BODY]);
    await store.save();
    await store.review.sync();
    // The page looks at the list each time the deck changes, which is before the undo has said what came back.
    const seen: string[][] = [];
    store.session.subscribe(() => seen.push(idsOf()));
    await store.history.undo();
    expect(idsOf()).toEqual([BODY]);
    expect(store.review.changes()).toMatchObject([{ id: BODY, by: "agent" }]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("does not take a change the person edited again for the one that came back", async () => {
    await agentEdits([method("Agent body")]);
    store.review.revert([BODY]);
    await store.save();
    await store.review.sync();
    await store.history.undo();
    store.session.apply([method("Mine now")]);
    expect(idsOf()).toEqual([]);
  });

  it("with nothing chosen changes nothing and leaves nothing to undo", async () => {
    await agentEdits([method("Agent body")]);
    expect(store.review.revert([])).toEqual({ ok: true });
    expect(store.history.canUndo).toBe(false);
    expect(store.session.dirty).toBe(false);
    expect(methodText()).toBe("Agent body");
  });

  it("sends no hint with a save when nothing was reverted", async () => {
    await agentEdits([method("Agent body")]);
    store.session.apply([retitle("My edit")]);
    await store.save();
    expect(server.saves.at(-1)?.options).toBeUndefined();
  });
});

describe("after a save", () => {
  it("reads the review again, because the server copied the person's edits into it", async () => {
    await agentEdits([retitle("Agent title")]);
    const loads = server.reviewLoads;
    store.session.apply([method("My edit")]);
    await store.save();
    expect(server.reviewLoads).toBeGreaterThan(loads);
  });

  it("starts over when the files are loaded again, because the steps were about the ones that went", async () => {
    await agentEdits([retitle("Agent title")]);
    await store.review.accept([TITLE]);
    expect(store.history.canUndo).toBe(true);
    await store.takeDisk();
    expect(store.history.canUndo).toBe(false);
  });

  it("remembers what the save wrote, so taking an edit back afterwards is still the person's own", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([method("My edit")]);
    await store.save();
    await store.review.sync();
    expect(idsOf()).toEqual([TITLE]);
    await store.history.undo(); // the files now hold "My edit" and the deck no longer does
    expect(store.session.dirty).toBe(true);
    expect(idsOf()).toEqual([TITLE]);
  });

  it("lists an edit that the files came to hold as well, because it is no longer waiting to be saved", async () => {
    await agentEdits([retitle("Agent title")]);
    store.session.apply([method("Same")]);
    server.external([method("Same")]);
    await store.syncFromDisk();
    expect(store.session.dirty).toBe(false);
    expect(store.review.changes().map((change) => [change.id, change.by])).toEqual([
      [TITLE, "agent"],
      [BODY, "outside"],
    ]);
  });
});
