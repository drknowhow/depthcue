import { describe, expect, it } from "vitest";
import {
  type Accepted,
  acceptChanges,
  applyOps,
  baselineOf,
  type Change,
  type Doc,
  describeChange,
  diffDocs,
  foldEdit,
  type Op,
  REVIEW_FILE,
  REVIEW_FORMAT,
  type Reverted,
  type ReviewFailure,
  readReview,
  recordAgentEdit,
  revertChanges,
  reviewChanges,
  reviewRevision,
  reviewToText,
  revisionOf,
  startReview,
} from "../src/index.ts";
import { moves } from "../src/review.ts";
import { demoDoc } from "./helpers.ts";

function edit(doc: Doc, ops: Op[]): Doc {
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(`the edit should apply: ${JSON.stringify(result.diagnostics)}`);
  return result.doc;
}

function accepted(result: Accepted | ReviewFailure): Accepted {
  if (!result.ok) throw new Error(`expected accept to work: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

function reverted(result: Reverted | ReviewFailure): Reverted {
  if (!result.ok) throw new Error(`expected revert to work: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

function refused(result: Accepted | Reverted | ReviewFailure): ReviewFailure {
  if (result.ok) throw new Error("expected the call to be refused");
  return result;
}

const ids = (changes: readonly { id: string }[]) => changes.map((change) => change.id);
const heading = (id: string, text = id): Op & { op: "block.add" } => ({
  op: "block.add",
  scene: "method",
  block: { id, type: "text", role: "body", text },
});
const newScene = (id: string) => ({
  id,
  title: id,
  layout: "title" as const,
  blocks: [{ id: `${id}-heading`, type: "text" as const, role: "heading" as const, text: id }],
});
/** The chart on the demand scene becomes a paragraph with the same id: the one way a block changes its type. */
const swapChart: Op[] = [
  { op: "block.remove", scene: "demand", id: "chart-demand" },
  {
    op: "block.add",
    scene: "demand",
    block: { id: "chart-demand", type: "text", role: "body", text: "Gone" },
  },
];

describe("the difference between two decks", () => {
  it("is empty for the same deck, however it was reached", () => {
    const doc = demoDoc();
    expect(diffDocs(doc, doc)).toEqual([]);
    const there = edit(doc, [{ op: "scene.set", id: "opening", set: { notes: "x" } }]);
    const back = edit(there, [
      { op: "scene.set", id: "opening", set: { notes: "Open with the answer, then show the evidence." } },
    ]);
    expect(diffDocs(doc, back)).toEqual([]);
  });

  it("compares values by what they hold, not by the object that holds them", () => {
    const base = demoDoc();
    const read = readReview(reviewToText(startReview(base)));
    if (!read.ok || read.review === undefined) throw new Error("the review should read back");
    // A deck read from its files has none of the objects the reviewed one has, and the same content.
    expect(reviewChanges(read.review, structuredClone(base))).toEqual([]);
    expect(diffDocs(structuredClone(base), base)).toEqual([]);
  });

  it("names a property of the deck, of a scene and of a block, with what it was and what it is", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "deck.set", set: { title: "Channel B leads" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
      { op: "block.set", scene: "opening", id: "opening-title", set: { text: "Channel B leads" } },
    ]);
    expect(diffDocs(base, now)).toEqual([
      {
        id: "deck/title",
        scope: "deck",
        kind: "changed",
        field: "title",
        before: "Why channel B now leads",
        after: "Channel B leads",
      },
      {
        id: "scene:opening/lead",
        scope: "scene",
        kind: "changed",
        scene: "opening",
        field: "lead",
        before: "human",
        after: "agent",
      },
      {
        id: "scene:opening/block:opening-title/text",
        scope: "block",
        kind: "changed",
        scene: "opening",
        block: "opening-title",
        field: "text",
        before: "Channel B now leads demand",
        after: "Channel B leads",
      },
    ]);
  });

  it("says added for a property that was set and removed for one that was cleared", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "scene.set", id: "opening", set: { notes: null } },
      { op: "scene.set", id: "method", set: { notes: "New" } },
    ]);
    const [cleared, set] = diffDocs(base, now);
    expect(cleared).toMatchObject({
      id: "scene:opening/notes",
      kind: "removed",
      before: "Open with the answer, then show the evidence.",
    });
    expect(cleared).not.toHaveProperty("after");
    expect(set).toMatchObject({ id: "scene:method/notes", kind: "added", after: "New" });
    expect(set).not.toHaveProperty("before");
  });

  it("takes a property as a whole: a chart's data is one change, not one per bar", () => {
    const base = demoDoc();
    const data = [
      { label: "Channel A", value: 30 },
      { label: "Channel B", value: 70 },
    ];
    const now = edit(base, [{ op: "block.set", scene: "demand", id: "chart-demand", set: { data } }]);
    const changes = diffDocs(base, now);
    expect(ids(changes)).toEqual(["scene:demand/block:chart-demand/data"]);
    expect(changes[0]?.after).toEqual(data);
  });

  it("lists a pinned frame as a property of its block", () => {
    const base = demoDoc();
    const frame = { x: 10, y: 10, w: 40, h: 30 };
    const pinned = edit(base, [{ op: "block.frame", scene: "method", id: "method-body", frame }]);
    expect(diffDocs(base, pinned)).toMatchObject([
      { id: "scene:method/block:method-body/frame", kind: "added", field: "frame", after: frame },
    ]);
    const freed = edit(pinned, [{ op: "block.unframe", scene: "method", id: "method-body" }]);
    expect(diffDocs(pinned, freed)).toMatchObject([
      { id: "scene:method/block:method-body/frame", kind: "removed", before: frame },
    ]);
  });

  it("does not count the schema version, which the tool sets, as a change", () => {
    const base = demoDoc();
    const pinned = edit(base, [
      { op: "block.frame", scene: "method", id: "method-body", frame: { x: 10, y: 10, w: 40, h: 30 } },
    ]);
    expect(pinned.scenes.method?.schemaVersion).not.toBe(base.scenes.method?.schemaVersion);
    expect(ids(diffDocs(base, pinned))).toEqual(["scene:method/block:method-body/frame"]);
  });

  it("gives a block that came or went whole, and a scene that came or went as one change", () => {
    const base = demoDoc();
    const withBlock = edit(base, [heading("method-extra")]);
    const [added] = diffDocs(base, withBlock);
    expect(added).toEqual({
      id: "scene:method/block:method-extra",
      scope: "block",
      kind: "added",
      scene: "method",
      block: "method-extra",
      after: { id: "method-extra", type: "text", role: "body", text: "method-extra" },
    });
    expect(diffDocs(withBlock, base)).toMatchObject([
      { id: "scene:method/block:method-extra", kind: "removed", before: added?.after },
    ]);

    const gone = edit(base, [{ op: "scene.remove", id: "method" }]);
    expect(ids(diffDocs(base, gone))).toEqual(["scene:method"]);
    expect(diffDocs(base, gone)[0]).toMatchObject({
      kind: "removed",
      scope: "scene",
      before: base.scenes.method,
    });
    const back = diffDocs(gone, base);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: "scene:method", kind: "added", after: base.scenes.method });
  });

  it("reports the order of what both decks have once, and an insertion does not reorder anything", () => {
    const base = demoDoc();
    const inserted = edit(base, [
      { op: "scene.add", scene: newScene("extra"), after: "opening" },
      heading("method-first"),
    ]);
    expect(ids(diffDocs(base, inserted))).toEqual(["scene:extra", "scene:method/block:method-first"]);

    const moved = edit(base, [
      { op: "scene.move", id: "method", after: null },
      { op: "block.move", scene: "method", id: "method-diagram", after: null },
    ]);
    expect(diffDocs(base, moved)).toEqual([
      {
        id: "deck/scenes",
        scope: "deck",
        kind: "moved",
        field: "scenes",
        before: ["opening", "demand", "method"],
        after: ["method", "opening", "demand"],
      },
      {
        id: "scene:method/blocks",
        scope: "scene",
        kind: "moved",
        scene: "method",
        field: "blocks",
        before: ["method-heading", "method-body", "method-diagram"],
        after: ["method-diagram", "method-heading", "method-body"],
      },
    ]);
  });

  it("treats a block whose type changed as one change, and not as a list of properties", () => {
    const base = demoDoc();
    const swapped = edit(base, swapChart);
    expect(diffDocs(base, swapped)).toEqual([
      {
        id: "scene:demand/block:chart-demand/type",
        scope: "block",
        kind: "changed",
        scene: "demand",
        block: "chart-demand",
        field: "type",
        before: "bar-chart",
        after: "text",
      },
    ]);
  });

  it("lists changes in a fixed order, deck first and removed scenes last", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "scene.remove", id: "opening" },
      { op: "scene.set", id: "method", set: { notes: "n" } },
      { op: "deck.set", set: { theme: "ink" } },
    ]);
    expect(ids(diffDocs(base, now))).toEqual(["deck/theme", "scene:method/notes", "scene:opening"]);
  });
});

describe("describing a change", () => {
  const base = demoDoc();
  const now = edit(base, [
    { op: "deck.set", set: { title: "T" } },
    { op: "scene.set", id: "opening", set: { notes: null } },
    { op: "scene.move", id: "method", after: null },
    { op: "block.move", scene: "method", id: "method-diagram", after: null },
    { op: "block.set", scene: "method", id: "method-body", set: { text: "x" } },
    heading("method-extra"),
    { op: "block.remove", scene: "method", id: "method-heading" },
    { op: "scene.remove", id: "demand" },
  ]);

  it("says it the same way for every kind", () => {
    expect(diffDocs(base, now).map(describeChange)).toEqual([
      "Deck title changed",
      "Scene order changed",
      'Block order in scene "method" changed',
      'Text of block "method-body" in scene "method" changed',
      'Block "method-extra" in scene "method" added',
      'Block "method-heading" in scene "method" removed',
      'Notes of scene "opening" removed',
      'Scene "demand" removed',
    ]);
  });
});

describe("the review file", () => {
  it("starts from a deck: its content, its revision and nobody to answer for", () => {
    const doc = demoDoc();
    const review = startReview(doc);
    expect(review).toMatchObject({ format: REVIEW_FORMAT, rev: revisionOf(doc), agent: [] });
    expect(Object.keys(review.scenes)).toEqual(doc.deck.scenes);
    expect(reviewChanges(review, doc)).toEqual([]);
    expect(REVIEW_FILE).toBe("review.json");
  });

  it("is read back as it was written", () => {
    const review = startReview(demoDoc(), ["deck/title"]);
    const read = readReview(reviewToText(review));
    expect(read).toEqual({ ok: true, review });
    expect(reviewToText(review).endsWith("}\n")).toBe(true);
  });

  it("is no review at all when there is no file", () => {
    expect(readReview(undefined)).toEqual({ ok: true, review: undefined });
  });

  it("changes its revision when anything in it changes, the list of the agent's changes too", () => {
    const review = startReview(demoDoc());
    expect(reviewRevision(review)).toMatch(/^[0-9a-f]{16}$/);
    expect(reviewRevision({ ...review, agent: ["deck/title"] })).not.toBe(reviewRevision(review));
    expect(reviewRevision(structuredClone(review))).toBe(reviewRevision(review));
  });

  const text = () => reviewToText(startReview(demoDoc()));
  // biome-ignore lint/suspicious/noExplicitAny: a hand edit of parsed JSON, which has no type to give it
  const change = (edit: (data: Record<string, any>) => void) => {
    const data = JSON.parse(text());
    edit(data);
    return JSON.stringify(data);
  };
  const problems = (source: string) => {
    const read = readReview(source);
    if (read.ok) throw new Error("expected the file to be refused");
    return read.diagnostics;
  };

  it("is refused whole when it is not JSON, and says to start over", () => {
    expect(problems("{ nope")[0]).toMatchObject({
      code: "json-parse",
      file: REVIEW_FILE,
      fix: expect.stringContaining("Delete review.json"),
    });
  });

  it("is refused for another format, a missing part or a bad list of changes", () => {
    expect(problems(change((d) => (d.format = "depthcue-review/9")))[0]?.code).toBe("bad-format");
    expect(problems(change((d) => delete d.deck))[0]?.code).toBe("bad-shape");
    expect(problems(change((d) => delete d.rev))[0]?.code).toBe("bad-shape");
    expect(problems(change((d) => (d.agent = [1])))[0]).toMatchObject({ code: "bad-shape", path: "/agent" });
    expect(problems(change((d) => delete d.agent))[0]?.code).toBe("bad-shape");
    expect(problems("[]")[0]?.code).toBe("bad-format");
  });

  it("is refused when the deck in it is not a valid deck, and the path says where", () => {
    expect(problems(change((d) => (d.deck.theme = "neon")))[0]).toMatchObject({
      file: REVIEW_FILE,
      path: expect.stringMatching(/^\/deck\//),
    });
    expect(problems(change((d) => (d.scenes.opening.layout = "nope")))[0]).toMatchObject({
      file: REVIEW_FILE,
      path: expect.stringMatching(/^\/scenes\/opening\//),
    });
  });

  it("is refused when a scene is listed and missing, or kept and not listed", () => {
    expect(problems(change((d) => delete d.scenes.demand))[0]).toMatchObject({
      code: "missing-scene",
      path: "/scenes/demand",
    });
    expect(
      problems(
        change((d) => {
          d.scenes.extra = { ...d.scenes.opening, id: "extra" };
        }),
      )[0],
    ).toMatchObject({ code: "unlisted-scene", path: "/scenes/extra" });
  });

  it("is refused when the deck in it is not the one its revision names: it was edited by hand", () => {
    expect(problems(change((d) => (d.deck.title = "Edited by hand")))[0]).toMatchObject({
      code: "rev-mismatch",
      path: "/rev",
    });
  });

  it("does not need the files of the images it names: they may have been deleted since", () => {
    const review = startReview(demoDoc());
    expect(readReview(reviewToText(review)).ok).toBe(true);
    const base = baselineOf(review, new Set());
    expect(base.assets.has("assets/method.svg")).toBe(true);
    expect(base.assets.has("assets/report.csv")).toBe(true);
  });
});

describe("accepting a change", () => {
  it("copies that change into the reviewed deck and no other", () => {
    const base = demoDoc();
    const review = startReview(base);
    const now = edit(base, [
      { op: "deck.set", set: { title: "Channel B leads" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
      { op: "block.set", scene: "opening", id: "opening-title", set: { text: "Channel B leads" } },
    ]);
    const result = accepted(acceptChanges(review, now, ["scene:opening/lead"]));
    expect(result.accepted).toEqual(["scene:opening/lead"]);
    expect(ids(reviewChanges(result.review, now))).toEqual([
      "deck/title",
      "scene:opening/block:opening-title/text",
    ]);
    expect(result.review.scenes.opening?.lead).toBe("agent");
    expect(result.review.deck.title).toBe("Why channel B now leads");
    expect(result.review.rev).toBe(revisionOf(baselineOf(result.review, now.assets)));
    expect(review.deck.title).toBe("Why channel B now leads");
  });

  it("brings in a new block where it stands, and a new scene too", () => {
    const base = demoDoc();
    const now = edit(base, [
      heading("method-extra"),
      { op: "block.move", scene: "method", id: "method-extra", after: "method-heading" },
      { op: "scene.add", scene: newScene("extra"), after: "opening" },
    ]);
    const first = accepted(acceptChanges(startReview(base), now, ["scene:extra"]));
    expect(first.review.deck.scenes).toEqual(["opening", "extra", "demand", "method"]);
    const second = accepted(acceptChanges(first.review, now, ["scene:method/block:method-extra"]));
    expect(second.review.scenes.method?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-extra",
      "method-body",
      "method-diagram",
    ]);
    expect(reviewChanges(second.review, now)).toEqual([]);
  });

  it("brings in a new order", () => {
    const base = demoDoc();
    const now = edit(base, [{ op: "scene.move", id: "method", after: null }]);
    const result = accepted(acceptChanges(startReview(base), now, ["deck/scenes"]));
    expect(result.review.deck.scenes).toEqual(["method", "opening", "demand"]);
  });

  it("makes the reviewed deck the current one for all", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "deck.set", set: { title: "T" } },
      { op: "scene.remove", id: "demand" },
    ]);
    const result = accepted(acceptChanges(startReview(base, ["deck/title"]), now, "all"));
    expect(result.accepted).toEqual(["deck/title", "scene:demand"]);
    expect(result.review).toEqual(startReview(now));
    expect(result.review.agent).toEqual([]);
  });

  it("accepts nothing when asked for nothing", () => {
    const base = demoDoc();
    const review = startReview(base);
    expect(accepted(acceptChanges(review, base, []))).toEqual({ ok: true, review, accepted: [] });
  });

  it("forgets an accepted change from the agent's list and keeps the rest", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "deck.set", set: { title: "T" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
    ]);
    const review = startReview(base, ["deck/title", "scene:opening/lead", "scene:gone"]);
    const result = accepted(acceptChanges(review, now, ["deck/title"]));
    expect(result.review.agent).toEqual(["scene:opening/lead"]);
  });

  it("refuses an id that is not a change and accepts nothing, with a guess at what was meant", () => {
    const base = demoDoc();
    const now = edit(base, [{ op: "deck.set", set: { title: "T" } }]);
    const failure = refused(acceptChanges(startReview(base), now, ["deck/title", "deck/titel"]));
    expect(failure).toMatchObject({ code: "unknown-change", unknown: ["deck/titel"] });
    expect(failure.diagnostics[0]?.fix).toContain('Did you mean "deck/title"?');
  });

  it("refuses a change that could not stand alone, and says why", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "block.add", scene: "demand", block: { id: "extra", type: "text", role: "body", text: "More" } },
      {
        op: "scene.set",
        id: "demand",
        set: {
          steps: [
            { id: "show-claim", reveal: ["claim-shift"] },
            { id: "show-evidence", reveal: ["chart-demand"] },
            { id: "show-extra", reveal: ["extra"] },
          ],
        },
      },
    ]);
    const review = startReview(base);
    const alone = refused(acceptChanges(review, now, ["scene:demand/steps"]));
    expect(alone.code).toBe("invalid-deck");
    expect(alone.diagnostics.some((d) => d.severity === "error")).toBe(true);
    const together = accepted(acceptChanges(review, now, ["scene:demand/steps", "scene:demand/block:extra"]));
    expect(reviewChanges(together.review, now)).toEqual([]);
  });
});

describe("reverting a change", () => {
  it("runs operations on the current deck, so the result is a new revision on top of it", () => {
    const base = demoDoc();
    const review = startReview(base);
    const now = edit(base, [
      { op: "deck.set", set: { title: "Channel B leads" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
    ]);
    const result = reverted(revertChanges(review, now, ["deck/title"]));
    expect(result.prevRev).toBe(revisionOf(now));
    expect(result.rev).toBe(revisionOf(result.doc));
    expect(result.rev).not.toBe(result.prevRev);
    expect(result.rev).not.toBe(review.rev);
    expect(result.reverted).toEqual(["deck/title"]);
    expect(result.doc.deck.title).toBe("Why channel B now leads");
    expect(result.doc.scenes.opening?.lead).toBe("agent");
    expect(result.deckChanged).toBe(true);
    expect(now.deck.title).toBe("Channel B leads");
  });

  it("leaves the reviewed deck as it was and forgets only the change that is gone", () => {
    const base = demoDoc();
    const review = startReview(base, ["deck/title", "scene:opening/lead"]);
    const now = edit(base, [
      { op: "deck.set", set: { title: "T" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
    ]);
    const result = reverted(revertChanges(review, now, ["deck/title"]));
    expect(result.review.agent).toEqual(["scene:opening/lead"]);
    expect(result.review.rev).toBe(review.rev);
    expect(result.review.deck).toBe(review.deck);
  });

  it("puts back what was cleared, and clears what was set", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "scene.set", id: "opening", set: { notes: null } },
      { op: "scene.set", id: "method", set: { notes: "New" } },
    ]);
    const result = reverted(revertChanges(startReview(base), now, "all"));
    expect(result.doc.scenes.opening?.notes).toBe("Open with the answer, then show the evidence.");
    expect(result.doc.scenes.method).not.toHaveProperty("notes");
    expect(reviewChanges(result.review, result.doc)).toEqual([]);
  });

  it("puts a removed block back where it stood, and takes an added block out", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "block.remove", scene: "method", id: "method-body" },
      heading("method-extra"),
    ]);
    const review = startReview(base);
    const back = reverted(revertChanges(review, now, ["scene:method/block:method-body"]));
    expect(back.doc.scenes.method?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
      "method-extra",
    ]);
    const out = reverted(revertChanges(review, now, ["scene:method/block:method-extra"]));
    expect(out.doc.scenes.method?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-diagram",
    ]);
  });

  it("brings a removed scene back in its place, and removes one that was added", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "scene.remove", id: "demand" },
      { op: "scene.add", scene: newScene("extra"), after: null },
    ]);
    const review = startReview(base);
    const back = reverted(revertChanges(review, now, ["scene:demand"]));
    expect(back.doc.deck.scenes).toEqual(["extra", "opening", "demand", "method"]);
    expect(back.doc.scenes.demand).toEqual(base.scenes.demand);
    const out = reverted(revertChanges(review, now, ["scene:extra"]));
    expect(out.doc.deck.scenes).toEqual(["opening", "method"]);
    expect(out.removed).toEqual(["extra"]);
  });

  it("puts a removed block back after the nearest block that is still there", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "block.remove", scene: "method", id: "method-body" },
      { op: "block.remove", scene: "method", id: "method-diagram" },
    ]);
    const back = reverted(revertChanges(startReview(base), now, ["scene:method/block:method-diagram"]));
    expect(back.doc.scenes.method?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-diagram",
    ]);
  });

  it("puts a removed scene back after the nearest scene that is still there", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "scene.remove", id: "opening" },
      { op: "scene.remove", id: "demand" },
    ]);
    const back = reverted(revertChanges(startReview(base), now, ["scene:demand"]));
    expect(back.doc.deck.scenes).toEqual(["demand", "method"]);
  });

  it("does the same whichever order the ids are given in, and names each one once", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "deck.set", set: { title: "T" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
    ]);
    const asked = ["scene:opening/lead", "deck/title", "scene:opening/lead"];
    expect(reverted(revertChanges(startReview(base), now, asked)).reverted).toEqual([
      "deck/title",
      "scene:opening/lead",
    ]);
    expect(accepted(acceptChanges(startReview(base), now, asked)).accepted).toEqual([
      "deck/title",
      "scene:opening/lead",
    ]);
  });

  it("puts the order back with the fewest moves", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "scene.move", id: "method", after: null },
      { op: "block.move", scene: "method", id: "method-heading", after: "method-diagram" },
    ]);
    const result = reverted(revertChanges(startReview(base), now, ["deck/scenes", "scene:method/blocks"]));
    expect(result.doc.deck.scenes).toEqual(["opening", "demand", "method"]);
    expect(result.doc.scenes.method?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
    ]);
  });

  it("moves only what is out of order, to just after the one before it", () => {
    expect(moves(["a", "b", "c", "d"], ["a", "b", "c", "d"])).toEqual([]);
    expect(moves(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual([{ id: "a", after: "d" }]);
    expect(moves(["a", "b", "c", "d"], ["d", "a", "b", "c"])).toEqual([{ id: "d", after: null }]);
    expect(moves(["a", "b", "c", "d"], ["b", "a", "d", "c"])).toHaveLength(2);
    // An id only one of the lists has is not moved, and does not count as out of order.
    expect(moves(["a", "x", "b"], ["b", "a", "y"])).toEqual([{ id: "b", after: null }]);
  });

  it("puts a block back as the type it was", () => {
    const base = demoDoc();
    const now = edit(base, swapChart);
    const result = reverted(revertChanges(startReview(base), now, ["scene:demand/block:chart-demand/type"]));
    expect(result.doc.scenes.demand?.blocks).toEqual(base.scenes.demand?.blocks);
  });

  it("puts back a frame, and upgrades nothing it need not", () => {
    const base = demoDoc();
    const frame = { x: 10, y: 10, w: 40, h: 30 };
    const now = edit(base, [{ op: "block.frame", scene: "method", id: "method-body", frame }]);
    const result = reverted(revertChanges(startReview(base), now, "all"));
    expect(result.doc.scenes.method?.blocks[1]).not.toHaveProperty("frame");
    expect(reviewChanges(result.review, result.doc)).toEqual([]);
  });

  it("puts everything back for all, leaving the deck as it was reviewed", () => {
    const base = demoDoc();
    const now = edit(base, [
      { op: "deck.set", set: { title: "T", theme: "ink" } },
      { op: "scene.move", id: "method", after: null },
      { op: "block.remove", scene: "method", id: "method-body" },
      heading("method-extra"),
      { op: "scene.set", id: "opening", set: { notes: null } },
    ]);
    const result = reverted(revertChanges(startReview(base), now, "all"));
    expect(diffDocs(base, result.doc)).toEqual([]);
    expect(result.rev).toBe(revisionOf(base));
    expect(result.reverted).toHaveLength(diffDocs(base, now).length);
  });

  it("does nothing, and says so, for all when there is nothing to put back", () => {
    const base = demoDoc();
    const result = reverted(revertChanges(startReview(base), base, "all"));
    expect(result).toMatchObject({ reverted: [], changed: [], removed: [], rev: revisionOf(base) });
    expect(result.prevRev).toBe(result.rev);
    expect(result.doc).toBe(base);
  });

  it("refuses an id that is not a change, and a change that would leave a deck that is not valid", () => {
    const base = demoDoc();
    const now = edit(base, [{ op: "block.remove", scene: "method", id: "method-diagram" }]);
    const review = startReview(base);
    expect(refused(revertChanges(review, now, ["scene:method"]))).toMatchObject({
      code: "unknown-change",
      unknown: ["scene:method"],
    });
    // The picture's file was deleted after the agent removed its block, so putting the block back would point at nothing.
    const missing: Doc = {
      ...now,
      assets: new Set([...now.assets].filter((a) => a !== "assets/method.svg")),
    };
    const failure = refused(revertChanges(review, missing, ["scene:method/block:method-diagram"]));
    expect(failure.code).toBe("invalid-deck");
    expect(failure.diagnostics.map((d) => d.code)).toContain("missing-asset");
  });
});

describe("who made a change", () => {
  it("marks what the agent changed, and what nobody can account for as outside", () => {
    const base = demoDoc();
    const review = startReview(base, ["deck/title"]);
    const now = edit(base, [
      { op: "deck.set", set: { title: "T" } },
      { op: "scene.set", id: "opening", set: { lead: "agent" } },
    ]);
    expect(reviewChanges(review, now).map((change: Change) => [change.id, change.by])).toEqual([
      ["deck/title", "agent"],
      ["scene:opening/lead", "outside"],
    ]);
  });

  it("marks every change an agent edit made or touched, and keeps the marks it did not touch", () => {
    const base = demoDoc();
    const byHand = edit(base, [{ op: "scene.set", id: "opening", set: { lead: "agent" } }]);
    const review = startReview(base);
    const firstEdit = edit(byHand, [{ op: "deck.set", set: { title: "T" } }]);
    const one = recordAgentEdit(review, byHand, firstEdit);
    expect(one.agent).toEqual(["deck/title"]);
    const secondEdit = edit(firstEdit, [{ op: "deck.set", set: { title: "U" } }]);
    const two = recordAgentEdit(one, firstEdit, secondEdit);
    expect(two.agent).toEqual(["deck/title"]);
    const thirdEdit = edit(secondEdit, [{ op: "scene.set", id: "opening", set: { lead: "human" } }]);
    // The agent set the lead back to what it was, so there is nothing left to answer for there.
    expect(recordAgentEdit(two, secondEdit, thirdEdit).agent).toEqual(["deck/title"]);
    expect(reviewChanges(two, secondEdit).map((c) => c.by)).toEqual(["agent", "outside"]);
  });

  it("marks a change the agent makes to a property somebody else had already changed", () => {
    const base = demoDoc();
    const byHand = edit(base, [{ op: "deck.set", set: { title: "Mine" } }]);
    const review = startReview(base);
    expect(reviewChanges(review, byHand).map((c) => [c.id, c.by])).toEqual([["deck/title", "outside"]]);
    const overwritten = edit(byHand, [{ op: "deck.set", set: { title: "Theirs" } }]);
    const marked = recordAgentEdit(review, byHand, overwritten);
    expect(marked.agent).toEqual(["deck/title"]);
    expect(reviewChanges(marked, overwritten).map((c) => [c.id, c.by])).toEqual([["deck/title", "agent"]]);
  });

  it("forgets the agent's change when the agent undoes it", () => {
    const base = demoDoc();
    const review = startReview(base);
    const changed = edit(base, [{ op: "deck.set", set: { title: "T" } }]);
    const marked = recordAgentEdit(review, base, changed);
    const undone = edit(changed, [{ op: "deck.set", set: { title: "Why channel B now leads" } }]);
    expect(recordAgentEdit(marked, changed, undone).agent).toEqual([]);
  });

  it("marks a change to a scene the agent added as the scene, not one change per property", () => {
    const base = demoDoc();
    const review = startReview(base);
    const added = edit(base, [{ op: "scene.add", scene: newScene("extra") }]);
    const marked = recordAgentEdit(review, base, added);
    const retitled = edit(added, [{ op: "scene.set", id: "extra", set: { title: "Other" } }]);
    expect(recordAgentEdit(marked, added, retitled).agent).toEqual(["scene:extra"]);
  });

  it("folds a person's edit into the reviewed deck so that it is nobody's change", () => {
    const base = demoDoc();
    const agentEdit = edit(base, [{ op: "deck.set", set: { title: "T" } }]);
    const review = recordAgentEdit(startReview(base), base, agentEdit);
    const person = edit(agentEdit, [
      { op: "scene.set", id: "opening", set: { notes: "Mine" } },
      { op: "block.set", scene: "method", id: "method-body", set: { text: "Mine too" } },
    ]);
    const folded = foldEdit(review, agentEdit, person);
    expect(reviewChanges(folded, person).map((c) => [c.id, c.by])).toEqual([["deck/title", "agent"]]);
    expect(folded.scenes.opening?.notes).toBe("Mine");
    expect(folded.rev).toBe(revisionOf(baselineOf(folded, person.assets)));
  });

  it("folds in a person's edit of what the agent changed: the person has the last word", () => {
    const base = demoDoc();
    const agentEdit = edit(base, [{ op: "deck.set", set: { title: "Agent's" } }]);
    const review = recordAgentEdit(startReview(base), base, agentEdit);
    const person = edit(agentEdit, [{ op: "deck.set", set: { title: "Person's" } }]);
    const folded = foldEdit(review, agentEdit, person);
    expect(reviewChanges(folded, person)).toEqual([]);
    expect(folded.agent).toEqual([]);
  });

  it("leaves an edit inside something the agent added with the thing it is in", () => {
    const base = demoDoc();
    const agentEdit = edit(base, [
      {
        op: "scene.add",
        scene: {
          id: "extra",
          title: "Extra",
          layout: "title",
          blocks: [{ id: "extra-heading", type: "text", role: "heading", text: "Hi" }],
        },
      },
    ]);
    const review = recordAgentEdit(startReview(base), base, agentEdit);
    const person = edit(agentEdit, [
      { op: "block.set", scene: "extra", id: "extra-heading", set: { text: "Hello" } },
    ]);
    const folded = foldEdit(review, agentEdit, person);
    expect(reviewChanges(folded, person).map((c) => [c.id, c.by])).toEqual([["scene:extra", "agent"]]);
    expect(folded.deck.scenes).toEqual(base.deck.scenes);
  });

  it("folds in what a person removed, including what the agent had changed", () => {
    const base = demoDoc();
    const agentEdit = edit(base, [
      { op: "block.set", scene: "method", id: "method-body", set: { text: "Agent's" } },
    ]);
    const review = recordAgentEdit(startReview(base), base, agentEdit);
    const person = edit(agentEdit, [{ op: "block.remove", scene: "method", id: "method-body" }]);
    const folded = foldEdit(review, agentEdit, person);
    expect(reviewChanges(folded, person)).toEqual([]);
    expect(folded.scenes.method?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-diagram",
    ]);
  });
});

/** A small seeded generator, so a failing run can be played again from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEdits(seed: number, steps: number): Doc {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  let doc = demoDoc();
  for (let step = 0; step < steps; step++) {
    if (doc.deck.scenes.length === 0) break;
    const sceneId = pick(doc.deck.scenes);
    const blocks = doc.scenes[sceneId]?.blocks ?? [];
    const block = blocks.length > 0 ? pick(blocks) : undefined;
    const n = `${seed}-${step}`;
    // A place in a list: the start, the end (no `after` at all) or after one of the ids.
    const place = (ids: readonly string[]): { after?: string | null } => {
      const at = pick<string | null | "end">([null, "end", ...ids]);
      return at === "end" ? {} : { after: at };
    };
    const options: Op[] = [
      { op: "deck.set", set: { title: `Title ${n}` } },
      { op: "scene.set", id: sceneId, set: { notes: next() < 0.3 ? null : `Notes ${n}` } },
      { op: "scene.set", id: sceneId, set: { title: `Scene ${n}` } },
      {
        op: "block.add",
        scene: sceneId,
        block: { id: `b-${n}`, type: "text", role: "body", text: n },
        ...place(blocks.map((b) => b.id)),
      },
      { op: "scene.add", scene: newScene(`s-${n}`), ...place(doc.deck.scenes) },
      { op: "scene.remove", id: sceneId },
      { op: "scene.move", id: sceneId, after: pick<string | null>([null, ...doc.deck.scenes]) },
    ];
    if (block) {
      options.push(
        { op: "block.remove", scene: sceneId, id: block.id },
        {
          op: "block.move",
          scene: sceneId,
          id: block.id,
          after: pick<string | null>([null, ...blocks.map((b) => b.id)]),
        },
        {
          op: "block.frame",
          scene: sceneId,
          id: block.id,
          frame: { x: 10, y: 10, w: 30 + Math.floor(next() * 20), h: 25 },
        },
        { op: "block.unframe", scene: sceneId, id: block.id },
      );
      if (block.type === "text")
        options.push({ op: "block.set", scene: sceneId, id: block.id, set: { text: `Text ${n}` } });
    }
    const result = applyOps(doc, [pick(options)], revisionOf(doc));
    if (result.ok) doc = result.doc;
  }
  return doc;
}

describe("any run of edits", () => {
  const seeds = Array.from({ length: 150 }, (_, i) => i + 1);

  it("is put back exactly by reverting every change, and is accepted whole by accepting every change", () => {
    let withChanges = 0;
    for (const seed of seeds) {
      const base = demoDoc();
      const now = randomEdits(seed, 14);
      const review = startReview(base);
      const changes = diffDocs(base, now);
      if (changes.length > 0) withChanges++;

      const back = revertChanges(review, now, ids(changes));
      expect(back.ok, `seed ${seed}: revert all ${JSON.stringify(changes.map((c) => c.id))}`).toBe(true);
      if (back.ok) expect(diffDocs(base, back.doc), `seed ${seed}: reverted`).toEqual([]);

      const taken = acceptChanges(review, now, ids(changes));
      expect(taken.ok, `seed ${seed}: accept all`).toBe(true);
      if (taken.ok) {
        expect(reviewChanges(taken.review, now), `seed ${seed}: accepted`).toEqual([]);
        expect(taken.review.rev).toBe(revisionOf(baselineOf(taken.review, now.assets)));
      }
    }
    // The runs must have something to review, or the checks above prove nothing.
    expect(withChanges).toBeGreaterThan(100);
  });

  it("gives, for one change at a time, a deck with that change gone and no change that was not there", () => {
    let tried = 0;
    let refusedCount = 0;
    for (const seed of seeds) {
      const base = demoDoc();
      const now = randomEdits(seed, 14);
      const review = startReview(base);
      const before = ids(diffDocs(base, now));
      for (const id of before) {
        const left = before.filter((other) => other !== id);
        const back = revertChanges(review, now, [id]);
        const taken = acceptChanges(review, now, [id]);
        tried++;
        if (back.ok) {
          const after = ids(diffDocs(base, back.doc));
          expect(after, `seed ${seed}: reverting ${id}`).not.toContain(id);
          expect(
            after.every((other) => left.includes(other)),
            `seed ${seed}: reverting ${id} left ${JSON.stringify(after)} of ${JSON.stringify(before)}`,
          ).toBe(true);
        } else refusedCount++;
        if (taken.ok) {
          const after = ids(reviewChanges(taken.review, now));
          expect(after, `seed ${seed}: accepting ${id}`).not.toContain(id);
          expect(
            after.every((other) => left.includes(other)),
            `seed ${seed}: accepting ${id} left ${JSON.stringify(after)} of ${JSON.stringify(before)}`,
          ).toBe(true);
        } else refusedCount++;
      }
    }
    expect(tried).toBeGreaterThan(300);
    // A change refused because it cannot stand alone is allowed, but most can.
    expect(refusedCount).toBeLessThan(tried);
  });

  it("is the same deck whichever way the changes are reviewed: revert half, accept the rest", () => {
    for (const seed of seeds) {
      const base = demoDoc();
      const now = randomEdits(seed, 14);
      const all = ids(diffDocs(base, now));
      const half = all.filter((_, i) => i % 2 === 0);
      const rest = all.filter((_, i) => i % 2 === 1);
      const review = startReview(base);
      const taken = acceptChanges(review, now, rest);
      if (!taken.ok) continue;
      const back = revertChanges(taken.review, now, half);
      if (!back.ok) continue;
      // What was accepted stays; what was reverted is gone. Nothing is left to review.
      expect(reviewChanges(back.review, back.doc), `seed ${seed}`).toEqual([]);
    }
  });
});
