import { describe, expect, it } from "vitest";
import {
  type ApplyFailure,
  type ApplyResult,
  applyOps,
  type Doc,
  type Op,
  revisionOf,
} from "../src/index.ts";
import { demoDoc } from "./helpers.ts";

const run = (doc: Doc, ops: unknown) => applyOps(doc, ops, revisionOf(doc));

function failure(result: ApplyResult): ApplyFailure {
  if (result.ok) throw new Error("expected the transaction to fail");
  return result;
}

function success(result: ApplyResult) {
  if (!result.ok)
    throw new Error(`expected success, got ${result.code}: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

const newScene = {
  id: "next-steps",
  title: "Next steps",
  layout: "title",
  blocks: [{ id: "next-heading", type: "text", role: "heading", text: "Check the numbers" }],
};

describe("a successful transaction", () => {
  it("returns a new document and leaves the old one alone", () => {
    const doc = demoDoc();
    const before = JSON.stringify([doc.deck, doc.scenes]);
    const result = success(
      run(doc, [
        { op: "block.set", scene: "opening", id: "opening-title", set: { text: "Channel B leads" } },
      ]),
    );
    expect(JSON.stringify([doc.deck, doc.scenes])).toBe(before);
    expect(result.rev).not.toBe(result.prevRev);
    expect(result.rev).toBe(revisionOf(result.doc));
    expect(result.changed).toEqual(["opening"]);
    expect(result.deckChanged).toBe(false);
  });

  it("shares every scene it did not touch", () => {
    const doc = demoDoc();
    const result = success(run(doc, [{ op: "scene.set", id: "opening", set: { notes: "x" } }]));
    expect(result.doc.scenes.demand).toBe(doc.scenes.demand);
    expect(result.doc.scenes.method).toBe(doc.scenes.method);
    expect(result.doc.scenes.opening).not.toBe(doc.scenes.opening);
  });

  it("reports no change when the content is identical", () => {
    const doc = demoDoc();
    const result = success(
      run(doc, [{ op: "scene.set", id: "opening", set: { title: "Why channel B now leads" } }]),
    );
    expect(result.rev).toBe(result.prevRev);
    expect(result.changed).toEqual([]);
  });

  it("deletes an optional property when the value is null", () => {
    const result = success(
      run(demoDoc(), [{ op: "scene.set", id: "opening", set: { lead: null, notes: null } }]),
    );
    expect(result.doc.scenes.opening).not.toHaveProperty("lead");
    expect(result.doc.scenes.opening).not.toHaveProperty("notes");
  });

  it("may pass through an invalid state, because only the result is checked", () => {
    const ops: Op[] = [
      { op: "block.remove", scene: "demand", id: "chart-demand" },
      { op: "scene.set", id: "demand", set: { summary: null, steps: null } },
      {
        op: "block.add",
        scene: "demand",
        block: { id: "note", type: "text", role: "body", text: "No chart." },
      },
    ];
    expect(success(run(demoDoc(), ops)).doc.scenes.demand?.blocks.map((b) => b.id)).toEqual(["note"]);
  });
});

describe("a rejected transaction", () => {
  it("rejects a stale revision without merging", () => {
    const doc = demoDoc();
    const stale = failure(applyOps(doc, [{ op: "scene.remove", id: "method" }], "0123456789abcdef"));
    expect(stale.code).toBe("stale-revision");
    expect(stale.rev).toBe(revisionOf(doc));
    expect(stale.diagnostics[0]?.message).toContain("0123456789abcdef");
    expect(stale.diagnostics[0]?.fix).toBe(
      "Read the deck again, then redo the edit against the new revision.",
    );
  });

  it("applies nothing when a later operation is bad", () => {
    const doc = demoDoc();
    const result = failure(
      run(doc, [
        { op: "scene.set", id: "opening", set: { notes: "changed" } },
        { op: "block.remove", scene: "opening", id: "no-such-block" },
      ]),
    );
    expect(result.code).toBe("bad-op");
    expect(result.diagnostics[0]).toMatchObject({ file: "ops", path: "/1/id", code: "unknown-block" });
    expect(doc.scenes.opening).not.toHaveProperty("notes", "changed");
  });

  it("rejects a result that is not a valid deck, pointing at the file and path", () => {
    const result = failure(
      run(demoDoc(), [
        { op: "block.set", scene: "opening", id: "opening-title", set: { text: "x".repeat(120) } },
      ]),
    );
    expect(result.code).toBe("invalid-deck");
    expect(result.diagnostics[0]).toMatchObject({
      file: "scenes/opening.json",
      path: "/blocks/0/text",
      code: "too-long",
    });
  });

  it("rejects removing a block that other content still points at", () => {
    const note = { id: "note", type: "text", role: "body", text: "Instead." };
    const result = failure(
      run(demoDoc(), [
        { op: "block.add", scene: "demand", block: note },
        { op: "block.remove", scene: "demand", id: "chart-demand" },
      ]),
    );
    expect(result.code).toBe("invalid-deck");
    expect(result.diagnostics.map((d) => d.code)).toContain("unknown-reference");
  });

  it("rejects an image whose asset is not in the folder", () => {
    const block = { id: "pic", type: "image", asset: "assets/missing.png", alt: "x" };
    const result = failure(run(demoDoc(), [{ op: "block.add", scene: "method", block }]));
    expect(result.diagnostics[0]).toMatchObject({ code: "missing-asset", path: "/blocks/3/asset" });
  });

  it("rejects removing the last scene", () => {
    const doc = demoDoc();
    const ops = doc.deck.scenes.map((id) => ({ op: "scene.remove", id }));
    expect(failure(run(doc, ops)).diagnostics.map((d) => d.code)).toContain("too-few");
  });
});

describe("operation shapes", () => {
  it("rejects input that is not a list of operations", () => {
    expect(failure(run(demoDoc(), { op: "scene.remove" })).code).toBe("bad-op");
    expect(failure(run(demoDoc(), [])).diagnostics[0]?.code).toBe("too-few");
  });

  it("suggests the near miss for a misspelt operation and lists the rest for a stranger", () => {
    const near = failure(run(demoDoc(), [{ op: "scene.sett", id: "opening", set: { notes: "x" } }]));
    expect(near.diagnostics[0]).toMatchObject({ code: "bad-value", path: "/0/op" });
    expect(near.diagnostics[0]?.fix).toContain('Did you mean "scene.set"?');
    const far = failure(run(demoDoc(), [{ op: "slide.explode" }]));
    expect(far.diagnostics[0]?.fix).toBe(
      "Use one of: deck.set, scene.add, scene.remove, scene.move, scene.set, scene.upgrade, block.add, block.remove, block.move, block.set, block.frame, block.unframe, brand.set, style.set, template.set, slot.add, slot.set, slot.rename, slot.remove.",
    );
  });

  it("names a missing operation or field", () => {
    expect(failure(run(demoDoc(), [{ id: "opening" }])).diagnostics[0]).toMatchObject({
      code: "missing-property",
      message: 'Missing "op".',
    });
    expect(failure(run(demoDoc(), [{ op: "scene.move", id: "opening" }])).diagnostics[0]).toMatchObject({
      code: "missing-property",
      message: 'Missing "after".',
    });
  });

  it("refuses to change what has its own operation", () => {
    const rename = failure(run(demoDoc(), [{ op: "scene.set", id: "opening", set: { id: "intro" } }]));
    expect(rename.diagnostics[0]).toMatchObject({ code: "forbidden-property", path: "/0/set/id" });
    const blocks = failure(run(demoDoc(), [{ op: "scene.set", id: "opening", set: { blocks: [] } }]));
    expect(blocks.diagnostics[0]?.fix).toContain("block.add");
    const type = failure(
      run(demoDoc(), [{ op: "block.set", scene: "opening", id: "opening-title", set: { type: "image" } }]),
    );
    expect(type.diagnostics[0]).toMatchObject({ code: "forbidden-property", path: "/0/set/type" });
    expect(
      failure(run(demoDoc(), [{ op: "deck.set", set: { scenes: ["opening"] } }])).diagnostics[0]?.fix,
    ).toBe("Use scene.add, scene.remove and scene.move.");
  });

  it("suggests the near miss for an unknown scene or block", () => {
    const scene = failure(run(demoDoc(), [{ op: "scene.remove", id: "opning" }]));
    expect(scene.diagnostics[0]?.fix).toContain('Did you mean "opening"?');
    const block = failure(run(demoDoc(), [{ op: "block.remove", scene: "opening", id: "opening-titel" }]));
    expect(block.diagnostics[0]?.fix).toContain('Did you mean "opening-title"?');
  });

  it("treats scene ids as data, not as property names", () => {
    expect(failure(run(demoDoc(), [{ op: "scene.remove", id: "constructor" }])).diagnostics[0]?.code).toBe(
      "unknown-scene",
    );
    const poisoned = failure(run(demoDoc(), [{ op: "scene.add", scene: { ...newScene, id: "__proto__" } }]));
    expect(poisoned.diagnostics[0]).toMatchObject({ code: "bad-format", path: "/0/scene/id" });
  });
});

describe("scenes", () => {
  it("adds at the end by default, at the start for null, and after a named scene", () => {
    const order = (after?: string | null) =>
      success(
        run(demoDoc(), [{ op: "scene.add", scene: newScene, ...(after === undefined ? {} : { after }) }]),
      ).doc.deck.scenes;
    expect(order()).toEqual(["opening", "demand", "method", "next-steps"]);
    expect(order(null)).toEqual(["next-steps", "opening", "demand", "method"]);
    expect(order("opening")).toEqual(["opening", "next-steps", "demand", "method"]);
  });

  it("fills in the schema version", () => {
    const result = success(run(demoDoc(), [{ op: "scene.add", scene: newScene }]));
    expect(result.doc.scenes["next-steps"]?.schemaVersion).toBe("0.4");
    expect(result.changed).toEqual(["next-steps"]);
    expect(result.deckChanged).toBe(true);
  });

  it("rejects a duplicate scene id and a missing one", () => {
    const duplicate = failure(run(demoDoc(), [{ op: "scene.add", scene: { ...newScene, id: "opening" } }]));
    expect(duplicate.diagnostics[0]).toMatchObject({ code: "duplicate-id" });
    const { id: _id, ...noId } = newScene;
    expect(failure(run(demoDoc(), [{ op: "scene.add", scene: noId }])).diagnostics[0]?.code).toBe(
      "missing-property",
    );
  });

  it("moves and removes", () => {
    const moved = success(run(demoDoc(), [{ op: "scene.move", id: "method", after: null }]));
    expect(moved.doc.deck.scenes).toEqual(["method", "opening", "demand"]);
    expect(moved.changed).toEqual([]);
    expect(moved.deckChanged).toBe(true);
    const removed = success(run(demoDoc(), [{ op: "scene.remove", id: "method" }]));
    expect(removed.removed).toEqual(["method"]);
    expect(removed.doc.scenes).not.toHaveProperty("method");
  });

  it("will not place a scene after itself", () => {
    const result = failure(run(demoDoc(), [{ op: "scene.move", id: "demand", after: "demand" }]));
    expect(result.diagnostics[0]).toMatchObject({ code: "bad-position", path: "/0/after" });
  });
});

describe("blocks and the deck", () => {
  it("adds, moves and removes blocks by id", () => {
    const text = { id: "extra", type: "text", role: "body", text: "More." };
    const added = success(
      run(demoDoc(), [{ op: "block.add", scene: "opening", block: text, after: "opening-title" }]),
    );
    expect(added.doc.scenes.opening?.blocks.map((b) => b.id)).toEqual([
      "opening-title",
      "extra",
      "opening-sub",
    ]);
    const moved = success(run(added.doc, [{ op: "block.move", scene: "opening", id: "extra", after: null }]));
    expect(moved.doc.scenes.opening?.blocks.map((b) => b.id)).toEqual([
      "extra",
      "opening-title",
      "opening-sub",
    ]);
    const removed = success(run(moved.doc, [{ op: "block.remove", scene: "opening", id: "extra" }]));
    expect(removed.doc.scenes.opening?.blocks.map((b) => b.id)).toEqual(["opening-title", "opening-sub"]);
  });

  it("rejects a block id already used in the scene", () => {
    const block = { id: "opening-title", type: "text", role: "body", text: "Again." };
    expect(
      failure(run(demoDoc(), [{ op: "block.add", scene: "opening", block }])).diagnostics[0],
    ).toMatchObject({
      code: "duplicate-id",
    });
  });

  it("sets deck properties and rejects a bad value on the result", () => {
    expect(success(run(demoDoc(), [{ op: "deck.set", set: { theme: "ink" } }])).doc.deck.theme).toBe("ink");
    const bad = failure(run(demoDoc(), [{ op: "deck.set", set: { theme: "neon" } }]));
    expect(bad.diagnostics[0]).toMatchObject({ file: "deck.json", path: "/theme", code: "bad-value" });
  });

  it("records what a deck needs from a module: off, or a version", () => {
    const set = success(
      run(demoDoc(), [{ op: "deck.set", set: { modules: { chart: "off", kinescript: "1.2" } } }]),
    );
    expect(set.doc.deck.modules).toEqual({ chart: "off", kinescript: "1.2" });
    expect(set.deckChanged).toBe(true);
    const cleared = success(run(set.doc, [{ op: "deck.set", set: { modules: null } }]));
    expect(cleared.doc.deck.modules).toBeUndefined();
  });

  it("rejects a module setting that is not off or a version", () => {
    for (const setting of ["latest", "^1", "1.2.3.4", "", "Off"]) {
      const bad = failure(run(demoDoc(), [{ op: "deck.set", set: { modules: { chart: setting } } }]));
      expect(bad.diagnostics[0], setting).toMatchObject({
        file: "deck.json",
        path: "/modules/chart",
        code: "bad-format",
        fix: expect.stringContaining("off"),
      });
    }
    for (const setting of ["off", "1", "1.2", "1.2.3", "0.1"]) {
      expect(run(demoDoc(), [{ op: "deck.set", set: { modules: { chart: setting } } }]).ok, setting).toBe(
        true,
      );
    }
  });
});
