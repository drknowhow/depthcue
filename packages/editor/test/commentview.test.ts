import { type Comment, type Doc, isTask, loadDoc } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { anchorAt, countsOf, DEFAULT_ANCHOR, pinsOf, pointOf, stateOf } from "../src/commentview.ts";
import { FakeServer } from "./helpers.ts";

const server = new FakeServer();
const doc = loadDoc({ text: server.text, assets: server.assets }).doc as Doc;

const AT = "2026-11-01T10:00:00.000Z";
const said = (author: "you" | "agent") => ({ author, text: "a note", at: AT });
const make = (id: string, scene: string, block: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  scene,
  block,
  anchor: { x: 0.5, y: 0.5 },
  thread: [said("you")],
  resolved: false,
  ...extra,
});

describe("the state of a comment", () => {
  it("is open for a plain comment, and a task for an ask the agent has not answered", () => {
    expect(stateOf(make("c1", "method", "method-body"))).toBe("open");
    expect(stateOf(make("c2", "method", "method-body", { ask: true }))).toBe("task");
  });

  it("is answered once the agent has spoken last, and a task again when the person writes after it", () => {
    const asked = make("c1", "method", "method-body", { ask: true });
    const replied = { ...asked, thread: [said("you"), said("agent")] };
    expect(stateOf(replied)).toBe("answered");
    const again = { ...asked, thread: [said("you"), said("agent"), said("you")] };
    expect(stateOf(again)).toBe("task");
  });

  it("is resolved whatever else is true of it, and never a task", () => {
    const done = make("c1", "method", "method-body", { ask: true, resolved: true });
    expect(stateOf(done)).toBe("resolved");
    expect(isTask(done)).toBe(false);
  });

  it("does not call a reply from the agent on a plain comment an answer to an ask", () => {
    const talked = make("c1", "method", "method-body", { thread: [said("you"), said("agent")] });
    expect(stateOf(talked)).toBe("open");
  });
});

describe("the pins of a scene", () => {
  const comments = [
    make("c1", "method", "method-body"),
    make("c2", "opening", "opening-title"),
    make("c3", "method", "method-diagram", { resolved: true }),
    make("c4", "method", "method-heading", { ask: true }),
  ];

  it("numbers every comment of the scene in file order, so a resolved one keeps its number", () => {
    const shown = pinsOf(comments, doc, "method", true);
    expect(shown.map((view) => [view.comment.id, view.number])).toEqual([
      ["c1", 1],
      ["c3", 2],
      ["c4", 3],
    ]);
  });

  it("leaves the resolved ones out unless asked, and does not renumber the rest", () => {
    const shown = pinsOf(comments, doc, "method", false);
    expect(shown.map((view) => [view.comment.id, view.number])).toEqual([
      ["c1", 1],
      ["c4", 3],
    ]);
  });

  it("carries the state of each comment", () => {
    expect(pinsOf(comments, doc, "method", true).map((view) => view.state)).toEqual([
      "open",
      "resolved",
      "task",
    ]);
  });

  it("marks a comment whose block is gone, and keeps it on its scene", () => {
    const lost = [make("c1", "method", "nothing-here"), make("c2", "method", "method-body")];
    const shown = pinsOf(lost, doc, "method", false);
    expect(shown.map((view) => view.orphan)).toEqual([true, false]);
  });

  it("finds a comment on the claim of a scene", () => {
    const claim = [make("c1", "demand", "claim-shift")];
    expect(pinsOf(claim, doc, "demand", false)[0]?.orphan).toBe(false);
  });

  it("has nothing for a scene nobody commented on", () => {
    expect(pinsOf(comments, doc, "demand", true)).toEqual([]);
  });
});

describe("the counts", () => {
  it("counts open comments, the tasks among them, and the resolved ones apart", () => {
    const comments = [
      make("c1", "method", "method-body"),
      make("c2", "method", "method-body", { ask: true }),
      make("c3", "method", "method-body", { resolved: true }),
      make("c4", "opening", "opening-title", { ask: true, thread: [said("you"), said("agent")] }),
    ];
    const { total, byScene } = countsOf(comments, doc);
    expect(total).toEqual({ open: 3, tasks: 1, resolved: 1 });
    expect(byScene.get("method")).toEqual({ open: 2, tasks: 1, resolved: 1 });
    expect(byScene.get("opening")).toEqual({ open: 1, tasks: 0, resolved: 0 });
    expect(byScene.has("demand")).toBe(false);
  });

  it("leaves out a comment on a scene that is gone, because no pin or thumbnail shows it", () => {
    const comments = [make("c1", "removed-scene", "anything"), make("c2", "method", "method-body")];
    const { total, byScene } = countsOf(comments, doc);
    expect(total.open).toBe(1);
    expect([...byScene.keys()]).toEqual(["method"]);
  });

  it("still counts a comment whose block is gone but whose scene is not", () => {
    expect(countsOf([make("c1", "method", "nothing-here")], doc).total.open).toBe(1);
  });
});

describe("the anchor", () => {
  const box = { left: 100, top: 200, width: 400, height: 100 };

  it("is the fraction of the block a point falls at, from its top left", () => {
    expect(anchorAt({ x: 300, y: 250 }, box)).toEqual({ x: 0.5, y: 0.5 });
    expect(anchorAt({ x: 100, y: 200 }, box)).toEqual({ x: 0, y: 0 });
    expect(anchorAt({ x: 500, y: 300 }, box)).toEqual({ x: 1, y: 1 });
  });

  it("is kept to the block when the point is outside it", () => {
    expect(anchorAt({ x: 0, y: 1000 }, box)).toEqual({ x: 0, y: 1 });
    expect(anchorAt({ x: 9000, y: -50 }, box)).toEqual({ x: 1, y: 0 });
  });

  it("is rounded to thousandths, which is as fine as a person can point", () => {
    expect(anchorAt({ x: 100 + 400 / 3, y: 200 + 100 / 3 }, box)).toEqual({ x: 0.333, y: 0.333 });
  });

  it("is the middle of a block with no size, which has nothing to divide by", () => {
    expect(anchorAt({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("goes back to the point it came from, within a thousandth of the block", () => {
    const point = pointOf(anchorAt({ x: 321, y: 273 }, box), box);
    expect(Math.abs(point.x - 321)).toBeLessThanOrEqual(0.4);
    expect(Math.abs(point.y - 273)).toBeLessThanOrEqual(0.1);
  });

  it("follows a block that moved or grew, which is why it is kept as a fraction", () => {
    const where = { x: 0.25, y: 0.75 };
    expect(pointOf(where, box)).toEqual({ x: 200, y: 275 });
    expect(pointOf(where, { left: 0, top: 0, width: 800, height: 400 })).toEqual({ x: 200, y: 300 });
  });

  it("has a default in the upper right corner, off the words", () => {
    expect(DEFAULT_ANCHOR.x).toBeGreaterThan(0.5);
    expect(DEFAULT_ANCHOR.y).toBeLessThan(0.5);
  });
});
