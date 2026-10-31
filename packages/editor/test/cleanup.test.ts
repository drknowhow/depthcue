import { applyOps, type Doc, loadDoc, type Op, revisionOf, type Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import {
  afterWhenDropping,
  afterWhenMoving,
  removeBlock,
  removeClaim,
  removeSource,
} from "../src/cleanup.ts";
import { FakeServer } from "./helpers.ts";

function demo(): Doc {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  return doc;
}

const scene = (doc: Doc, id: string) => doc.scenes[id] as Scene;

/** Applies the operations and fails the test, with the core's own message, if the deck would not be valid. */
function apply(doc: Doc, ops: Op[]): Doc {
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.doc;
}

describe("removeBlock", () => {
  it("is refused when it would leave a scene with no blocks, instead of leaving dangling references", () => {
    const doc = demo();
    const result = applyOps(doc, removeBlock(scene(doc, "demand"), "chart-demand"), revisionOf(doc));
    expect(result.ok).toBe(false);
  });

  it("cleans every reference when the scene has other blocks to keep", () => {
    let doc = demo();
    doc = apply(doc, [
      {
        op: "block.add",
        scene: "demand",
        block: { id: "extra-note", type: "text", role: "body", text: "More." },
      },
      {
        op: "scene.set",
        id: "demand",
        set: {
          summary: {
            id: "claim-shift",
            text: "Channel B now leads, 60 to 40.",
            evidenceIds: ["chart-demand", "extra-note"],
          },
          steps: [
            { id: "show-claim", reveal: ["claim-shift"] },
            { id: "show-evidence", reveal: ["chart-demand", "extra-note"] },
            { id: "show-chart-only", reveal: ["chart-demand"] },
          ],
        },
      },
    ]);
    const ops = removeBlock(scene(doc, "demand"), "chart-demand");
    const after = scene(apply(doc, ops), "demand");
    expect(after.blocks.map((block) => block.id)).toEqual(["extra-note"]);
    expect(after.summary?.evidenceIds).toEqual(["extra-note"]);
    // A step left revealing nothing is dropped; one that still reveals something stays.
    expect(after.steps).toEqual([
      { id: "show-claim", reveal: ["claim-shift"] },
      { id: "show-evidence", reveal: ["extra-note"] },
    ]);
  });

  it("drops the steps property altogether when no step is left", () => {
    let doc = demo();
    doc = apply(doc, [
      {
        op: "block.add",
        scene: "demand",
        block: { id: "extra-note", type: "text", role: "body", text: "More." },
      },
      { op: "scene.set", id: "demand", set: { steps: [{ id: "only-step", reveal: ["chart-demand"] }] } },
    ]);
    const after = scene(apply(doc, removeBlock(scene(doc, "demand"), "chart-demand")), "demand");
    expect(after.steps).toBeUndefined();
  });

  it("is a single operation when nothing points at the block", () => {
    const doc = demo();
    expect(removeBlock(scene(doc, "opening"), "opening-sub")).toEqual([
      { op: "block.remove", scene: "opening", id: "opening-sub" },
    ]);
  });
});

describe("removeClaim", () => {
  it("removes the claim and the step that revealed it, and keeps the other steps", () => {
    const doc = demo();
    const after = scene(apply(doc, removeClaim(scene(doc, "demand"))), "demand");
    expect(after.summary).toBeUndefined();
    expect(after.steps).toEqual([{ id: "show-evidence", reveal: ["chart-demand"] }]);
  });

  it("has nothing to do for a scene without a claim", () => {
    expect(removeClaim(scene(demo(), "opening"))).toEqual([]);
  });
});

describe("removeSource", () => {
  it("removes the source and the citations of it on blocks", () => {
    const doc = demo();
    const after = scene(apply(doc, removeSource(scene(doc, "demand"), "source-report")), "demand");
    expect(after.sources).toBeUndefined();
    expect(after.blocks[0] && "sourceIds" in after.blocks[0]).toBe(false);
  });

  it("keeps the other sources and the other citations", () => {
    let doc = demo();
    doc = apply(doc, [
      {
        op: "scene.set",
        id: "demand",
        set: {
          sources: [
            { id: "source-report", title: "Quarterly order snapshot", asset: "assets/report.csv" },
            { id: "source-two", title: "Second" },
          ],
        },
      },
      {
        op: "block.set",
        scene: "demand",
        id: "chart-demand",
        set: { sourceIds: ["source-report", "source-two"] },
      },
    ]);
    const after = scene(apply(doc, removeSource(scene(doc, "demand"), "source-report")), "demand");
    expect(after.sources?.map((source) => source.id)).toEqual(["source-two"]);
    const chart = after.blocks[0];
    expect(chart && "sourceIds" in chart && chart.sourceIds).toEqual(["source-two"]);
  });
});

/** Where an item ends up when it is put after `after` (null for the start), as the core's move does. */
function place(ids: readonly string[], id: string, after: string | null): string[] {
  const rest = ids.filter((candidate) => candidate !== id);
  const at = after === null ? 0 : rest.indexOf(after) + 1;
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

describe("afterWhenMoving", () => {
  const ids = ["a", "b", "c", "d"];

  it("swaps an item with its neighbour, for every item and both directions", () => {
    for (const [index, id] of ids.entries()) {
      for (const direction of [-1, 1] as const) {
        const other = index + direction;
        const after = afterWhenMoving(ids, id, direction);
        if (other < 0 || other >= ids.length) {
          expect(after).toBeUndefined();
        } else {
          const swapped = [...ids];
          [swapped[index], swapped[other]] = [swapped[other] as string, swapped[index] as string];
          expect(place(ids, id, after as string | null)).toEqual(swapped);
        }
      }
    }
  });

  it("has no move for an item that is not in the list", () => {
    expect(afterWhenMoving(ids, "z", 1)).toBeUndefined();
    expect(afterWhenMoving(ids, "z", -1)).toBeUndefined();
  });

  it("moves the first item up to nowhere, and puts the second at the start by naming null", () => {
    expect(afterWhenMoving(ids, "a", -1)).toBeUndefined();
    expect(afterWhenMoving(ids, "b", -1)).toBeNull();
  });
});

describe("afterWhenDropping", () => {
  const ids = ["a", "b", "c", "d"];

  it("lands an item before the target on its upper half and after it on its lower half", () => {
    for (const id of ids) {
      for (const over of ids.filter((candidate) => candidate !== id)) {
        for (const half of ["upper", "lower"] as const) {
          const rest = ids.filter((candidate) => candidate !== id);
          const at = rest.indexOf(over) + (half === "lower" ? 1 : 0);
          const intended = [...rest.slice(0, at), id, ...rest.slice(at)];
          const after = afterWhenDropping(ids, id, over, half);
          if (after === undefined) {
            expect(intended).toEqual(ids);
          } else {
            expect(place(ids, id, after)).toEqual(intended);
          }
        }
      }
    }
  });

  it("does nothing when an item is dropped on itself or on something unknown", () => {
    expect(afterWhenDropping(ids, "b", "b", "upper")).toBeUndefined();
    expect(afterWhenDropping(ids, "b", "b", "lower")).toBeUndefined();
    expect(afterWhenDropping(ids, "b", "zzz", "lower")).toBeUndefined();
  });

  it("does nothing when the drop would leave the order as it was", () => {
    expect(afterWhenDropping(ids, "a", "b", "upper")).toBeUndefined();
    expect(afterWhenDropping(ids, "c", "d", "upper")).toBeUndefined();
    expect(afterWhenDropping(ids, "b", "a", "lower")).toBeUndefined();
  });

  it("names null to put an item first", () => {
    expect(afterWhenDropping(ids, "d", "a", "upper")).toBeNull();
  });
});
