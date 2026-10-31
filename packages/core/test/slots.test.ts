import { describe, expect, it } from "vitest";
import {
  applyOps,
  type Doc,
  type Placement,
  placeBlock,
  revisionOf,
  type Scene,
  slotOf,
  slotsOf,
} from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const text = (id: string, role: "heading" | "body" = "body") => ({ id, type: "text", role, text: id });
const chart = (id: string) => ({ id, type: "bar-chart", data: [{ label: "A", value: 1 }] });

const titleScene = {
  id: "t-title",
  title: "Title",
  layout: "title",
  blocks: [text("t-head", "heading"), text("t-one"), text("t-two")],
};
const claimScene = {
  id: "t-claim",
  title: "Claim",
  layout: "claim-evidence",
  summary: { id: "t-claim-text", text: "A claim", evidenceIds: ["c-proof"] },
  blocks: [text("c-proof"), text("c-aside"), chart("c-chart"), text("c-extra")],
};
const bareClaimScene = {
  id: "t-bare",
  title: "Bare",
  layout: "claim-evidence",
  blocks: [text("b-head", "heading"), text("b-one"), text("b-two")],
};
const claimWithHeadingScene = {
  id: "t-both",
  title: "Both",
  layout: "claim-evidence",
  summary: { id: "t-both-text", text: "A claim", evidenceIds: ["h-one"] },
  blocks: [text("h-head", "heading"), text("h-one"), text("h-two")],
};
const mediaScene = {
  id: "t-media",
  title: "Media",
  layout: "text-media",
  blocks: [text("m-text"), chart("m-chart"), text("m-more"), chart("m-other")],
};

/** The demo deck with these scenes added, so every move can be applied to a real, validated document. */
function deckWith(...scenes: object[]): Doc {
  const doc = demoDoc();
  const ops = scenes.map((scene) => ({ op: "scene.add", scene }));
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}

const doc = deckWith(titleScene, claimScene, bareClaimScene, claimWithHeadingScene, mediaScene);
const sceneOf = (id: string) => doc.scenes[id] as Scene;
const names = (scene: Scene) => Object.fromEntries(slotsOf(scene).map((slot) => [slot.name, slot.blocks]));

/** Moves a block and applies the result to `base`, which holds `scene`; the answer carries the new document. */
function applied(scene: Scene, to: Placement, id: string, base: Doc = doc) {
  const placed = placeBlock(scene, id, to);
  if (!placed.ok) throw new Error(placed.message);
  if (placed.ops.length === 0) return { ops: placed.ops, scene, doc: base };
  const result = applyOps(base, placed.ops, revisionOf(base));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { ops: placed.ops, scene: result.doc.scenes[scene.id] as Scene, doc: result.doc };
}

const refusal = (scene: Scene, id: string, to: Placement) => {
  const placed = placeBlock(scene, id, to);
  if (placed.ok) throw new Error("expected a refusal");
  return placed.message;
};

describe("the slots of a layout", () => {
  it("stacks a title scene's blocks in order", () => {
    expect(names(sceneOf("t-title"))).toEqual({ stack: ["t-head", "t-one", "t-two"] });
  });

  it("puts the blocks a claim cites under evidence and the rest under support", () => {
    expect(names(sceneOf("t-claim"))).toEqual({
      claim: [],
      evidence: ["c-proof"],
      support: ["c-aside", "c-chart", "c-extra"],
    });
  });

  it("keeps a heading with the claim while there is no claim", () => {
    expect(names(sceneOf("t-bare"))).toEqual({
      claim: ["b-head"],
      evidence: [],
      support: ["b-one", "b-two"],
    });
  });

  it("sends text one way and everything else the other", () => {
    expect(names(sceneOf("t-media"))).toEqual({
      text: ["m-text", "m-more"],
      media: ["m-chart", "m-other"],
    });
  });

  it("says which slot a block is in", () => {
    expect(slotOf(sceneOf("t-claim"), "c-chart")).toBe("support");
    expect(slotOf(sceneOf("t-claim"), "nope")).toBeUndefined();
  });

  it("agrees with the player about every block, on every demo scene", () => {
    for (const id of doc.deck.scenes) {
      const scene = sceneOf(id);
      const held = slotsOf(scene).flatMap((slot) => slot.blocks);
      expect([...held].sort()).toEqual(scene.blocks.map((block) => block.id).sort());
    }
  });
});

describe("moving a block", () => {
  it("reorders inside a slot, as one block.move", () => {
    const { ops, scene } = applied(sceneOf("t-title"), { slot: "stack", after: null }, "t-two");
    expect(ops).toEqual([{ op: "block.move", scene: "t-title", id: "t-two", after: null }]);
    expect(names(scene).stack).toEqual(["t-two", "t-head", "t-one"]);
  });

  it("puts a block after a named sibling of its slot", () => {
    const { scene } = applied(sceneOf("t-title"), { slot: "stack", after: "t-two" }, "t-head");
    expect(names(scene).stack).toEqual(["t-one", "t-two", "t-head"]);
  });

  it("puts a block at the end of its slot when no sibling is named", () => {
    const { scene } = applied(sceneOf("t-title"), { slot: "stack" }, "t-head");
    expect(names(scene).stack).toEqual(["t-one", "t-two", "t-head"]);
  });

  it("changes nothing when the block is dropped where it already is", () => {
    const first = applied(sceneOf("t-title"), { slot: "stack", after: null }, "t-head");
    expect(first.ops).toEqual([]);
    const last = applied(sceneOf("t-title"), { slot: "stack" }, "t-two");
    expect(last.ops).toEqual([]);
    const same = applied(sceneOf("t-title"), { slot: "stack", after: "t-head" }, "t-one");
    expect(same.ops).toEqual([]);
  });

  it("adds a block to the evidence when it moves there, and keeps the rest", () => {
    const { ops, scene } = applied(sceneOf("t-claim"), { slot: "evidence" }, "c-chart");
    expect(ops.at(-1)).toEqual({
      op: "scene.set",
      id: "t-claim",
      set: { summary: { id: "t-claim-text", text: "A claim", evidenceIds: ["c-proof", "c-chart"] } },
    });
    expect(names(scene)).toEqual({
      claim: [],
      evidence: ["c-proof", "c-chart"],
      support: ["c-aside", "c-extra"],
    });
  });

  it("moves into the evidence next to a block that is already there", () => {
    const { scene } = applied(sceneOf("t-claim"), { slot: "evidence", after: null }, "c-extra");
    expect(names(scene).evidence).toEqual(["c-extra", "c-proof"]);
  });

  it("takes a block out of the evidence when it moves to support", () => {
    const { scene } = applied(sceneOf("t-claim"), { slot: "support", after: "c-aside" }, "c-proof");
    expect(names(scene)).toEqual({
      claim: [],
      evidence: [],
      support: ["c-aside", "c-proof", "c-chart", "c-extra"],
    });
    expect(scene.summary?.evidenceIds).toEqual([]);
  });

  it("moves into a slot that has nothing in it without disturbing the reading order", () => {
    const emptied = applied(sceneOf("t-claim"), { slot: "support", after: "c-aside" }, "c-proof");
    expect(names(emptied.scene).evidence).toEqual([]);
    const order = emptied.scene.blocks.map((block) => block.id);
    const { ops, scene } = applied(emptied.scene, { slot: "evidence" }, "c-chart", emptied.doc);
    expect(ops.map((op) => op.op)).toEqual(["scene.set"]);
    expect(scene.blocks.map((block) => block.id)).toEqual(order);
    expect(names(scene).evidence).toEqual(["c-chart"]);
  });

  it("reorders inside the media slot without touching the text", () => {
    const { scene } = applied(sceneOf("t-media"), { slot: "media", after: null }, "m-other");
    expect(names(scene)).toEqual({ text: ["m-text", "m-more"], media: ["m-other", "m-chart"] });
    expect(scene.blocks.map((block) => block.id)).toEqual(["m-text", "m-other", "m-chart", "m-more"]);
  });

  it("keeps the reading order of the other slot when a block goes to the end of its own", () => {
    const { scene } = applied(sceneOf("t-media"), { slot: "text" }, "m-text");
    expect(scene.blocks.map((block) => block.id)).toEqual(["m-chart", "m-more", "m-text", "m-other"]);
  });

  it("keeps a heading under support once there is a claim, because the player draws it there", () => {
    expect(names(sceneOf("t-both"))).toEqual({
      claim: [],
      evidence: ["h-one"],
      support: ["h-head", "h-two"],
    });
  });
});

describe("swapping two blocks", () => {
  it("trades places inside a slot", () => {
    const { scene } = applied(sceneOf("t-title"), { swap: "t-two" }, "t-head");
    expect(names(scene).stack).toEqual(["t-two", "t-one", "t-head"]);
  });

  it("is one move when the two are neighbours", () => {
    const { ops } = applied(sceneOf("t-title"), { swap: "t-one" }, "t-head");
    expect(ops).toEqual([{ op: "block.move", scene: "t-title", id: "t-one", after: null }]);
  });

  it("trades evidence for support, and each is cited as the other was", () => {
    const { scene } = applied(sceneOf("t-claim"), { swap: "c-chart" }, "c-proof");
    expect(names(scene)).toEqual({
      claim: [],
      evidence: ["c-chart"],
      support: ["c-aside", "c-proof", "c-extra"],
    });
    expect(scene.blocks.map((block) => block.id)).toEqual(["c-chart", "c-aside", "c-proof", "c-extra"]);
  });

  it("works the same from the other side", () => {
    const { scene } = applied(sceneOf("t-claim"), { swap: "c-proof" }, "c-extra");
    expect(names(scene)).toEqual({
      claim: [],
      evidence: ["c-extra"],
      support: ["c-aside", "c-chart", "c-proof"],
    });
  });

  it("changes nothing for a block swapped with itself", () => {
    expect(applied(sceneOf("t-title"), { swap: "t-one" }, "t-one").ops).toEqual([]);
  });

  it("leaves no evidence change when both blocks are cited", () => {
    const both = applied(sceneOf("t-claim"), { slot: "evidence" }, "c-aside");
    const { ops } = applied(both.scene, { swap: "c-aside" }, "c-proof", both.doc);
    expect(ops.every((op) => op.op === "block.move")).toBe(true);
  });
});

describe("what is turned away", () => {
  it("keeps text out of the media slot and media out of the text slot", () => {
    expect(refusal(sceneOf("t-media"), "m-text", { slot: "media" })).toMatch(/Text goes in the text area/);
    expect(refusal(sceneOf("t-media"), "m-chart", { slot: "text" })).toMatch(/Only text goes/);
    expect(refusal(sceneOf("t-media"), "m-text", { swap: "m-chart" })).toMatch(/text area/);
  });

  it("keeps blocks out of the claim area, and a heading in it", () => {
    expect(refusal(sceneOf("t-claim"), "c-aside", { slot: "claim" })).toMatch(/claim area/);
    expect(refusal(sceneOf("t-bare"), "b-head", { slot: "support" })).toMatch(/stays with the claim/);
    expect(refusal(sceneOf("t-bare"), "b-one", { swap: "b-head" })).toMatch(/claim area/);
  });

  it("asks for a claim before evidence", () => {
    expect(refusal(sceneOf("t-bare"), "b-one", { slot: "evidence" })).toMatch(/Add a claim first/);
  });

  it("refuses a slot the layout does not have", () => {
    expect(refusal(sceneOf("t-title"), "t-one", { slot: "media" })).toMatch(/no such area/);
  });

  it("refuses ids that are not in the scene", () => {
    expect(refusal(sceneOf("t-title"), "nope", { slot: "stack" })).toMatch(/no block "nope"/);
    expect(refusal(sceneOf("t-title"), "t-one", { swap: "nope" })).toMatch(/no block "nope"/);
    expect(refusal(sceneOf("t-title"), "t-one", { slot: "stack", after: "nope" })).toMatch(
      /not in the slide area/,
    );
  });

  it("refuses a sibling from another slot", () => {
    expect(refusal(sceneOf("t-claim"), "c-aside", { slot: "evidence", after: "c-chart" })).toMatch(
      /not in the evidence area/,
    );
  });
});

describe("every move that is allowed", () => {
  const every = (scene: Scene): Array<{ id: string; to: Placement }> => {
    const out: Array<{ id: string; to: Placement }> = [];
    for (const { id } of scene.blocks) {
      for (const other of scene.blocks) out.push({ id, to: { swap: other.id } });
      for (const slot of slotsOf(scene)) {
        out.push({ id, to: { slot: slot.name } }, { id, to: { slot: slot.name, after: null } });
        for (const after of slot.blocks) out.push({ id, to: { slot: slot.name, after } });
      }
    }
    return out;
  };

  for (const id of ["t-title", "t-claim", "t-bare", "t-both", "t-media"]) {
    it(`leaves ${id} a valid deck, with the block where it was sent`, () => {
      const scene = sceneOf(id);
      let allowed = 0;
      for (const { id: block, to } of every(scene)) {
        const placed = placeBlock(scene, block, to);
        if (!placed.ok) continue;
        allowed += 1;
        if (placed.ops.length === 0) continue;
        const result = applyOps(doc, placed.ops, revisionOf(doc));
        if (!result.ok)
          throw new Error(`${block} ${JSON.stringify(to)}: ${JSON.stringify(result.diagnostics)}`);
        const next = result.doc.scenes[id] as Scene;
        expect(next.blocks.map((entry) => entry.id).sort()).toEqual(
          scene.blocks.map((entry) => entry.id).sort(),
        );
        if ("slot" in to) expect(slotOf(next, block)).toBe(to.slot);
        else {
          expect(slotOf(next, block)).toBe(slotOf(scene, to.swap));
          expect(slotOf(next, to.swap)).toBe(slotOf(scene, block));
        }
      }
      expect(allowed).toBeGreaterThan(0);
    });
  }
});
