import { describe, expect, it } from "vitest";
import {
  type ApplyFailure,
  type ApplyResult,
  applyOps,
  checkDeckFiles,
  checkFrames,
  checkScene,
  type Diagnostic,
  type Doc,
  explain,
  FRAME_MIN,
  type Frame,
  frameOf,
  hasFrames,
  OP_NAMES,
  revisionOf,
  SCHEMA_VERSION,
  type Scene,
} from "../src/index.ts";
import { demoDir, demoDoc, loadDir, scene } from "./helpers.ts";

const run = (doc: Doc, ops: unknown) => applyOps(doc, ops, revisionOf(doc));

function success(result: ApplyResult) {
  if (!result.ok)
    throw new Error(`expected success, got ${result.code}: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

function failure(result: ApplyResult): ApplyFailure {
  if (result.ok) throw new Error("expected the transaction to fail");
  return result;
}

const first = (diagnostics: Diagnostic[]): Diagnostic => {
  const found = diagnostics[0];
  if (!found) throw new Error("expected a diagnostic");
  return found;
};

const box: Frame = { x: 56, y: 14, w: 38, h: 44 };
const blockOf = (doc: Doc, sceneId: string, id: string) =>
  doc.scenes[sceneId]?.blocks.find((block) => block.id === id);

/** A 0.2 scene with one block of each kind, each pinned to `frame`. */
const pinned = (frame: unknown) =>
  scene({
    schemaVersion: "0.2",
    blocks: [
      { id: "a-text", type: "text", role: "body", text: "Words", frame },
      { id: "a-image", type: "image", asset: "assets/a.png", alt: "A picture", frame },
      { id: "a-chart", type: "bar-chart", data: [{ label: "A", value: 1 }], frame },
      { id: "a-clip", type: "clip", source: "assets/a.mp4", alt: "A clip", frame },
    ],
  });

describe("the schema versions", () => {
  it("accepts 0.1 and 0.2 and says which are allowed when given another", () => {
    expect(checkScene(scene({ schemaVersion: "0.1" }), "scenes/a.json")).toEqual([]);
    expect(checkScene(scene({ schemaVersion: "0.2" }), "scenes/a.json")).toEqual([]);
    const found = first(checkScene(scene({ schemaVersion: "0.3" }), "scenes/a.json"));
    expect(found).toMatchObject({ code: "bad-value", path: "/schemaVersion" });
    expect(found.fix).toContain("Use one of: 0.1, 0.2.");
  });

  it("writes 0.2 into a new scene", () => {
    expect(SCHEMA_VERSION).toBe("0.2");
  });

  it("keeps the demo deck, written for 0.1, valid and at 0.1", () => {
    expect(checkDeckFiles(loadDir(demoDir))).toEqual([]);
    expect(Object.values(demoDoc().scenes).map((each) => each.schemaVersion)).toEqual(["0.1", "0.1", "0.1"]);
  });
});

describe("a frame in the scene schema", () => {
  it("is allowed on every kind of block", () => {
    expect(checkScene(pinned(box), "scenes/a.json")).toEqual([]);
  });

  it("is optional", () => {
    expect(checkScene(scene({ schemaVersion: "0.2" }), "scenes/a.json")).toEqual([]);
  });

  it.each(["x", "y", "w", "h"] as const)("needs %s", (key) => {
    const { [key]: _left, ...rest } = box;
    const missing = first(checkScene(pinned(rest), "scenes/a.json"));
    expect(missing).toMatchObject({ code: "missing-property", path: "/blocks/0/frame" });
    expect(missing.message).toBe(`Missing "${key}".`);
  });

  it("needs no others", () => {
    const extra = first(checkScene(pinned({ ...box, rotate: 3 }), "scenes/a.json"));
    expect(extra).toMatchObject({ code: "unknown-property", path: "/blocks/0/frame/rotate" });
    expect(extra.fix).toBe("Allowed here: x, y, w, h.");
  });

  it("takes only numbers", () => {
    const found = first(checkScene(pinned({ ...box, x: "56" }), "scenes/a.json"));
    expect(found).toMatchObject({ code: "wrong-type", path: "/blocks/0/frame/x" });
  });

  it("keeps x and y within 0 to 100, and says what the numbers mean", () => {
    const low = first(checkScene(pinned({ ...box, x: -1 }), "scenes/a.json"));
    expect(low).toMatchObject({ code: "too-small", path: "/blocks/0/frame/x" });
    expect(low.message).toBe("-1 is below the minimum of 0.");
    expect(low.fix).toContain("percent of the slide");
    const high = first(checkScene(pinned({ ...box, y: 101 }), "scenes/a.json"));
    expect(high).toMatchObject({ code: "too-large", path: "/blocks/0/frame/y" });
    expect(high.message).toBe("101 is above the maximum of 100.");
  });

  it("keeps w and h from shrinking below the minimum a person can still grab", () => {
    expect(FRAME_MIN).toBe(5);
    const thin = first(checkScene(pinned({ ...box, w: 4.9 }), "scenes/a.json"));
    expect(thin).toMatchObject({ code: "too-small", path: "/blocks/0/frame/w" });
    expect(thin.fix).toContain("w and h from 5 to 100");
    const short = first(checkScene(pinned({ ...box, h: 4.9 }), "scenes/a.json"));
    expect(short).toMatchObject({ code: "too-small", path: "/blocks/0/frame/h" });
    expect(checkScene(pinned({ ...box, w: 5, h: 5 }), "scenes/a.json")).toEqual([]);
    expect(first(checkScene(pinned({ ...box, h: 100.5 }), "scenes/a.json")).code).toBe("too-large");
  });

  it("accepts a whole-slide frame and fractions", () => {
    expect(checkScene(pinned({ x: 0, y: 0, w: 100, h: 100 }), "scenes/a.json")).toEqual([]);
    expect(checkScene(pinned({ x: 12.5, y: 0.25, w: 33.3, h: 20.05 }), "scenes/a.json")).toEqual([]);
  });
});

describe("what the schema cannot state about a frame", () => {
  const check = (frame: Frame, version = "0.2") =>
    checkFrames(
      scene({
        schemaVersion: version,
        blocks: [{ id: "a-text", type: "text", role: "body", text: "Words", frame }],
      }) as unknown as Scene,
      "scenes/a.json",
    );

  it("lets a frame touch the edges of the slide", () => {
    expect(check({ x: 60, y: 50, w: 40, h: 50 })).toEqual([]);
  });

  it("forgives rounding past an edge but not a real overshoot", () => {
    expect(check({ x: 60.0001, y: 50, w: 40, h: 50 })).toEqual([]);
    expect(first(check({ x: 60.01, y: 50, w: 40, h: 50 })).code).toBe("frame-off-slide");
    expect(check({ x: 10, y: 50.0001, w: 40, h: 50 })).toEqual([]);
    expect(first(check({ x: 10, y: 50.01, w: 40, h: 50 })).code).toBe("frame-off-slide");
    expect(first(check({ x: 10, y: 50.5, w: 40, h: 50 })).code).toBe("frame-off-slide");
  });

  it("checks every block, not only the first", () => {
    const later = checkFrames(
      scene({
        schemaVersion: "0.2",
        blocks: [
          { id: "a-text", type: "text", role: "body", text: "Words", frame: box },
          { id: "b-text", type: "text", role: "body", text: "More", frame: { x: 70, y: 10, w: 40, h: 20 } },
        ],
      }) as unknown as Scene,
      "scenes/a.json",
    );
    expect(later.map((d) => d.path)).toEqual(["/blocks/1/frame/w"]);
  });

  it("says how far a frame runs past the right edge and what to change", () => {
    const found = first(check({ x: 70, y: 10, w: 40, h: 20 }));
    expect(found).toMatchObject({ code: "frame-off-slide", path: "/blocks/0/frame/w" });
    expect(found.message).toBe("The frame runs to 110% across; the slide ends at 100%.");
    expect(found.fix).toBe("Make w at most 30, or move x left.");
  });

  it("says how far a frame runs below the bottom edge and what to change", () => {
    const found = first(check({ x: 10, y: 80, w: 20, h: 25.5 }));
    expect(found).toMatchObject({ code: "frame-off-slide", path: "/blocks/0/frame/h" });
    expect(found.message).toBe("The frame runs to 105.5% down; the slide ends at 100%.");
    expect(found.fix).toBe("Make h at most 20, or move y up.");
  });

  it("reports both edges when a frame runs past both", () => {
    expect(check({ x: 90, y: 90, w: 20, h: 20 }).map((d) => d.path)).toEqual([
      "/blocks/0/frame/w",
      "/blocks/0/frame/h",
    ]);
  });

  it("refuses a frame in a scene that says 0.1, and says what to set", () => {
    const found = first(check(box, "0.1"));
    expect(found).toMatchObject({ code: "frame-needs-version", path: "/blocks/0/frame" });
    expect(found.fix).toBe('Set schemaVersion to "0.2", or remove the frame.');
  });

  it("is checked when a deck loads", () => {
    const files = loadDir(demoDir);
    const opening = JSON.parse(files.text["scenes/opening.json"] as string);
    opening.blocks[0].frame = { x: 80, y: 10, w: 30, h: 20 };
    opening.schemaVersion = "0.2";
    const found = checkDeckFiles({
      ...files,
      text: { ...files.text, "scenes/opening.json": JSON.stringify(opening) },
    });
    expect(found.map((d) => [d.file, d.code, d.path])).toEqual([
      ["scenes/opening.json", "frame-off-slide", "/blocks/0/frame/w"],
    ]);
  });
});

describe("reading a frame", () => {
  it("answers a block's frame, or undefined for one in a slot", () => {
    const doc = demoDoc();
    const block = blockOf(doc, "opening", "opening-title");
    if (!block) throw new Error("the demo should have opening-title");
    expect(frameOf(block)).toBeUndefined();
    expect(frameOf({ ...block, frame: box })).toEqual(box);
  });

  it("tells a scene with a pinned block from one without", () => {
    const doc = demoDoc();
    expect(hasFrames(doc.scenes.opening as Scene)).toBe(false);
    expect(hasFrames(pinned(box) as unknown as Scene)).toBe(true);
  });
});

describe("block.frame and block.unframe", () => {
  it("pins a block and leaves the rest of the deck alone", () => {
    const doc = demoDoc();
    const result = success(
      run(doc, [{ op: "block.frame", scene: "opening", id: "opening-title", frame: box }]),
    );
    expect(blockOf(result.doc, "opening", "opening-title")).toMatchObject({ frame: box });
    expect(result.changed).toEqual(["opening"]);
    expect(result.doc.scenes.demand).toBe(doc.scenes.demand);
    expect(blockOf(doc, "opening", "opening-title")).not.toHaveProperty("frame");
  });

  it("moves a frame that is already there", () => {
    const pinnedDoc = success(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-sub", frame: box }]),
    ).doc;
    const moved = { ...box, x: 10 };
    const result = success(
      run(pinnedDoc, [{ op: "block.frame", scene: "opening", id: "opening-sub", frame: moved }]),
    );
    expect(blockOf(result.doc, "opening", "opening-sub")).toMatchObject({ frame: moved });
  });

  it("says 0.2 in a scene written at 0.1 once it has a frame", () => {
    const result = success(
      run(demoDoc(), [{ op: "block.frame", scene: "method", id: "method-diagram", frame: box }]),
    );
    expect(result.doc.scenes.method?.schemaVersion).toBe("0.2");
    expect(result.doc.scenes.opening?.schemaVersion).toBe("0.1");
  });

  it("leaves the version of a scene with no frame alone, whatever else changes in it", () => {
    const result = success(
      run(demoDoc(), [
        { op: "block.set", scene: "opening", id: "opening-title", set: { text: "Changed" } },
        { op: "block.unframe", scene: "opening", id: "opening-sub" },
      ]),
    );
    expect(result.changed).toEqual(["opening"]);
    expect(result.doc.scenes.opening?.schemaVersion).toBe("0.1");
  });

  it("does not rewrite a scene the operations never touched, even one that already breaks the rule", () => {
    const doc = demoDoc();
    const opening = doc.scenes.opening as Scene;
    const hand: Doc = {
      ...doc,
      scenes: {
        ...doc.scenes,
        opening: {
          ...opening,
          blocks: [{ ...opening.blocks[0], frame: box }, ...opening.blocks.slice(1)],
        } as Scene,
      },
    };
    const result = success(
      run(hand, [{ op: "block.set", scene: "method", id: "method-heading", set: { text: "New" } }]),
    );
    expect(result.changed).toEqual(["method"]);
    expect(result.doc.scenes.opening).toBe(hand.scenes.opening);
    expect(result.doc.scenes.opening?.schemaVersion).toBe("0.1");
  });

  it("leaves 0.2 at 0.2 after the last frame is cleared", () => {
    const pinnedDoc = success(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-title", frame: box }]),
    ).doc;
    const result = success(run(pinnedDoc, [{ op: "block.unframe", scene: "opening", id: "opening-title" }]));
    expect(blockOf(result.doc, "opening", "opening-title")).not.toHaveProperty("frame");
    expect(result.doc.scenes.opening?.schemaVersion).toBe("0.2");
  });

  it("changes nothing when a frame is set to what it is, or cleared when there is none", () => {
    const pinnedDoc = success(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-title", frame: box }]),
    ).doc;
    expect(
      success(
        run(pinnedDoc, [{ op: "block.frame", scene: "opening", id: "opening-title", frame: { ...box } }]),
      ).changed,
    ).toEqual([]);
    expect(
      success(run(demoDoc(), [{ op: "block.unframe", scene: "opening", id: "opening-title" }])).changed,
    ).toEqual([]);
  });

  it("keeps a frame with its block through a move, and drops it with the block", () => {
    const pinnedDoc = success(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-sub", frame: box }]),
    ).doc;
    const moved = success(
      run(pinnedDoc, [{ op: "block.move", scene: "opening", id: "opening-sub", after: null }]),
    ).doc;
    expect(moved.scenes.opening?.blocks.map((block) => block.id)).toEqual(["opening-sub", "opening-title"]);
    expect(blockOf(moved, "opening", "opening-sub")).toMatchObject({ frame: box });

    const removed = success(run(moved, [{ op: "block.remove", scene: "opening", id: "opening-sub" }])).doc;
    expect(hasFrames(removed.scenes.opening as Scene)).toBe(false);
    const again = success(
      run(removed, [
        {
          op: "block.add",
          scene: "opening",
          block: { id: "opening-sub", type: "text", role: "body", text: "Back again" },
        },
      ]),
    ).doc;
    expect(blockOf(again, "opening", "opening-sub")).not.toHaveProperty("frame");
  });

  it("names the scene or block that does not exist, with the near miss", () => {
    const scene = failure(
      run(demoDoc(), [{ op: "block.frame", scene: "openin", id: "opening-title", frame: box }]),
    );
    expect(scene.diagnostics[0]).toMatchObject({ code: "unknown-scene", path: "/0/scene" });
    expect(scene.diagnostics[0]?.fix).toContain('Did you mean "opening"?');
    const block = failure(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-titel", frame: box }]),
    );
    expect(block.diagnostics[0]).toMatchObject({ code: "unknown-block", path: "/0/id" });
    expect(block.diagnostics[0]?.fix).toContain('Did you mean "opening-title"?');
    const part = failure(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-t", frame: box }]),
    );
    expect(part.diagnostics[0]).toMatchObject({ code: "unknown-block", path: "/0/id" });
    const unframe = failure(run(demoDoc(), [{ op: "block.unframe", scene: "opening", id: "nope-block" }]));
    expect(unframe.diagnostics[0]).toMatchObject({ code: "unknown-block", path: "/0/id" });
  });

  it("refuses a frame that is the wrong shape before anything is applied", () => {
    const small = failure(
      run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-title", frame: { ...box, w: 2 } }]),
    );
    expect(small.code).toBe("bad-op");
    expect(small.diagnostics[0]).toMatchObject({ code: "too-small", path: "/0/frame/w", file: "ops" });
    const missing = failure(run(demoDoc(), [{ op: "block.frame", scene: "opening", id: "opening-title" }]));
    expect(missing.diagnostics[0]).toMatchObject({ code: "missing-property", path: "/0" });
    expect(missing.diagnostics[0]?.message).toBe('Missing "frame".');
    const word = failure(
      run(demoDoc(), [
        { op: "block.frame", scene: "opening", id: "opening-title", frame: { ...box, y: "top" } },
      ]),
    );
    expect(word.diagnostics[0]).toMatchObject({ code: "wrong-type", path: "/0/frame/y" });
  });

  it("refuses a frame that runs off the slide, and keeps nothing", () => {
    const doc = demoDoc();
    const result = failure(
      run(doc, [
        { op: "block.frame", scene: "opening", id: "opening-title", frame: { x: 80, y: 10, w: 30, h: 20 } },
      ]),
    );
    expect(result.code).toBe("invalid-deck");
    expect(result.diagnostics[0]).toMatchObject({
      code: "frame-off-slide",
      file: "scenes/opening.json",
      path: "/blocks/0/frame/w",
    });
    expect(blockOf(doc, "opening", "opening-title")).not.toHaveProperty("frame");
  });
});

describe("a frame written some other way", () => {
  it("is set and cleared by block.set, as a property of the block", () => {
    const set = success(
      run(demoDoc(), [{ op: "block.set", scene: "opening", id: "opening-title", set: { frame: box } }]),
    );
    expect(blockOf(set.doc, "opening", "opening-title")).toMatchObject({ frame: box });
    expect(set.doc.scenes.opening?.schemaVersion).toBe("0.2");
    const cleared = success(
      run(set.doc, [{ op: "block.set", scene: "opening", id: "opening-title", set: { frame: null } }]),
    );
    expect(blockOf(cleared.doc, "opening", "opening-title")).not.toHaveProperty("frame");
  });

  it("comes in a new block, and in a new scene that says 0.1", () => {
    const added = success(
      run(demoDoc(), [
        {
          op: "block.add",
          scene: "method",
          block: { id: "method-note", type: "text", role: "caption", text: "Note", frame: box },
        },
      ]),
    );
    expect(added.doc.scenes.method?.schemaVersion).toBe("0.2");
    const fresh = success(
      run(demoDoc(), [
        {
          op: "scene.add",
          scene: {
            schemaVersion: "0.1",
            id: "next-steps",
            title: "Next steps",
            layout: "title",
            blocks: [{ id: "next-heading", type: "text", role: "heading", text: "Go", frame: box }],
          },
        },
      ]),
    );
    expect(fresh.doc.scenes["next-steps"]?.schemaVersion).toBe("0.2");
  });

  it("is refused when a frame is set to something the block shape does not allow", () => {
    const result = failure(
      run(demoDoc(), [
        { op: "block.set", scene: "opening", id: "opening-title", set: { frame: { ...box, z: 1 } } },
      ]),
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: "unknown-property",
      file: "scenes/opening.json",
      path: "/blocks/0/frame/z",
    });
  });
});

describe("explaining a number outside its range", () => {
  const error = (keyword: "minimum" | "maximum") => ({
    instancePath: "/size",
    schemaPath: `#/properties/size/${keyword}`,
    keyword,
    params: { limit: 3 },
  });

  it("gives a plain fix for a number that is not in a frame", () => {
    const low = first(explain([error("minimum")], { size: 1 }, {}, "scenes/a.json"));
    expect(low).toMatchObject({
      code: "too-small",
      message: "1 is below the minimum of 3.",
      fix: "Use 3 or more.",
    });
    const high = first(explain([error("maximum")], { size: 9 }, {}, "scenes/a.json"));
    expect(high).toMatchObject({
      code: "too-large",
      message: "9 is above the maximum of 3.",
      fix: "Use 3 or less.",
    });
  });
});

describe("the operations vocabulary", () => {
  it("lists the two frame operations after the nine that came before", () => {
    expect(OP_NAMES).toHaveLength(11);
    expect(OP_NAMES.slice(-2)).toEqual(["block.frame", "block.unframe"]);
  });
});
