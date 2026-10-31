import { FRAME_MIN, SAFE_MARGIN } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import {
  aligned,
  fitted,
  frameOver,
  NUDGE,
  NUDGE_BIG,
  nudged,
  resized,
  SNAP,
  slideIn,
  snapMove,
  snapResize,
  targetsOf,
} from "../src/pin.ts";

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("the slide inside a room", () => {
  it("is the room itself when the room is 16 by 9", () => {
    expect(slideIn(box(10, 20, 1600, 900))).toEqual(box(10, 20, 1600, 900));
  });

  it("is centered with bars at the sides in a wide room", () => {
    expect(slideIn(box(0, 0, 2000, 900))).toEqual(box(200, 0, 1600, 900));
  });

  it("is centered with bars above and below in a tall room", () => {
    expect(slideIn(box(0, 0, 800, 800))).toEqual(box(0, 175, 800, 450));
  });
});

describe("the frame a block fills", () => {
  const slide = box(100, 50, 1600, 900);

  it("is its box in percent of the slide", () => {
    expect(frameOver(box(260, 140, 640, 90), slide)).toEqual({ x: 10, y: 10, w: 40, h: 10 });
  });

  it("is kept to tenths of a percent", () => {
    expect(frameOver(box(100, 50, 533, 301), slide)).toEqual({ x: 0, y: 0, w: 33.3, h: 33.4 });
  });

  it("is kept on the slide when the block hangs over its edge", () => {
    expect(frameOver(box(-60, 800, 400, 400), slide)).toEqual({ x: 0, y: 55.6, w: 25, h: 44.4 });
    expect(frameOver(box(1500, 50, 400, 100), slide)).toEqual({ x: 75, y: 0, w: 25, h: 11.1 });
  });

  it("is at least as large as a frame may be", () => {
    expect(frameOver(box(100, 50, 4, 4), slide)).toEqual({ x: 0, y: 0, w: FRAME_MIN, h: FRAME_MIN });
  });

  it("is nothing for a box with no size, which is a block that is not laid out", () => {
    expect(frameOver(box(0, 0, 0, 0), slide)).toBeUndefined();
    expect(frameOver(box(120, 80, 300, 100), box(0, 0, 0, 0))).toBeUndefined();
  });
});

describe("a frame kept on the slide", () => {
  it("has its size limited before its place", () => {
    expect(fitted({ x: 90, y: 90, w: 30, h: 30 })).toEqual({ x: 70, y: 70, w: 30, h: 30 });
    expect(fitted({ x: 0, y: 0, w: 140, h: 2 })).toEqual({ x: 0, y: 0, w: 100, h: FRAME_MIN });
    expect(fitted({ x: 5, y: 5, w: 2, h: 140 })).toEqual({ x: 5, y: 0, w: FRAME_MIN, h: 100 });
  });

  it("is written without the noise of floating point", () => {
    expect(fitted({ x: 66.69999999999999, y: 0.1 + 0.2, w: 33.3, h: 20 })).toEqual({
      x: 66.7,
      y: 0.3,
      w: 33.3,
      h: 20,
    });
  });
});

describe("nudging", () => {
  const frame = { x: 10, y: 20, w: 30, h: 40 };

  it("moves by the step the keys name", () => {
    expect(nudged(frame, NUDGE, 0)).toEqual({ x: 11, y: 20, w: 30, h: 40 });
    expect(nudged(frame, 0, -NUDGE_BIG)).toEqual({ x: 10, y: 15, w: 30, h: 40 });
  });

  it("stops at the edges of the slide", () => {
    expect(nudged({ x: 0.5, y: 0, w: 30, h: 40 }, -NUDGE_BIG, -NUDGE_BIG)).toEqual({
      x: 0,
      y: 0,
      w: 30,
      h: 40,
    });
    expect(nudged({ x: 69.5, y: 59.5, w: 30, h: 40 }, NUDGE_BIG, NUDGE_BIG)).toEqual({
      x: 70,
      y: 60,
      w: 30,
      h: 40,
    });
  });
});

describe("the lines a block snaps to", () => {
  it("are the slide's edges, margins and middle when nothing else is pinned", () => {
    const { x, y } = targetsOf([]);
    expect([...x].sort((a, b) => a - b)).toEqual([0, SAFE_MARGIN, 50, 100 - SAFE_MARGIN, 100]);
    expect([...y].sort((a, b) => a - b)).toEqual([0, SAFE_MARGIN, 50, 100 - SAFE_MARGIN, 100]);
  });

  it("also include the edges and middle of every other block", () => {
    const { x, y } = targetsOf([{ x: 10, y: 20, w: 30, h: 40 }]);
    expect(x).toEqual(expect.arrayContaining([10, 25, 40]));
    expect(y).toEqual(expect.arrayContaining([20, 40, 60]));
  });
});

describe("moving with snapping", () => {
  const targets = targetsOf([{ x: 60, y: 10, w: 30, h: 20 }]);

  it("pulls a nearby edge onto a line and reports the guide", () => {
    const { frame, guides } = snapMove({ x: 4.8, y: 33, w: 20, h: 10 }, targets);
    expect(frame).toEqual({ x: SAFE_MARGIN, y: 33, w: 20, h: 10 });
    expect(guides).toEqual([{ axis: "x", at: SAFE_MARGIN }]);
  });

  it("looks at the middle of the block as well as its edges", () => {
    const { frame, guides } = snapMove({ x: 39.5, y: 30, w: 20, h: 10 }, targets);
    expect(frame.x).toBe(40);
    expect(guides).toContainEqual({ axis: "x", at: 50 });
  });

  it("snaps each axis on its own", () => {
    const { frame, guides } = snapMove({ x: 4.5, y: 44.4, w: 20, h: 10 }, targets);
    expect(frame).toEqual({ x: SAFE_MARGIN, y: 45, w: 20, h: 10 });
    expect(guides).toHaveLength(2);
  });

  it("leaves a block alone when no line is close", () => {
    const frame = { x: 20, y: 33, w: 20, h: 10 };
    expect(snapMove(frame, targets)).toEqual({ frame, guides: [] });
  });

  it("takes the nearest of two lines", () => {
    const { frame } = snapMove({ x: 50.9, y: 30, w: 10, h: 10 }, targets);
    expect(frame.x).toBe(50);
  });

  it("reaches 1.1 percent of the slide by default, and no further", () => {
    expect(SNAP).toBe(1.1);
    expect(snapMove({ x: 5.1, y: 33, w: 20, h: 10 }, targets).frame.x).toBe(SAFE_MARGIN);
    expect(snapMove({ x: 5.2, y: 33, w: 20, h: 10 }, targets).frame.x).toBe(5.2);
  });

  it("takes the nearer of two lines that are both in reach", () => {
    const close = { x: [50, 50.8], y: [] };
    expect(snapMove({ x: 50.6, y: 33, w: 10, h: 10 }, close).frame.x).toBe(50.8);
    expect(snapMove({ x: 50.2, y: 33, w: 10, h: 10 }, close).frame.x).toBe(50);
  });

  it("snaps a distance exactly as far as it may reach", () => {
    expect(snapMove({ x: 5, y: 33, w: 20, h: 10 }, targets, 1).frame.x).toBe(SAFE_MARGIN);
  });

  it("reaches as far as the distance it is given and no further", () => {
    const frame = { x: 6, y: 30, w: 20, h: 10 };
    expect(snapMove(frame, targets, 1).frame.x).toBe(6);
    expect(snapMove(frame, targets, 2.5).frame.x).toBe(SAFE_MARGIN);
  });

  it("does not report a guide for a line the block was pushed off by the slide's edge", () => {
    const { frame, guides } = snapMove({ x: 96.5, y: 33, w: 20, h: 10 }, targets);
    expect(frame.x).toBe(80);
    expect(guides.filter((g) => g.axis === "x")).toEqual([]);
  });

  it("does not report a guide for a line the block was pushed off by the slide's bottom", () => {
    const { frame, guides } = snapMove({ x: 20, y: 96.5, w: 20, h: 10 }, targets);
    expect(frame.y).toBe(90);
    expect(guides).toEqual([]);
  });
});

describe("resizing from a corner", () => {
  const frame = { x: 20, y: 20, w: 40, h: 30 };

  it("moves that corner and keeps the opposite one where it was", () => {
    expect(resized(frame, "se", 10, 5)).toEqual({ x: 20, y: 20, w: 50, h: 35 });
    expect(resized(frame, "nw", -5, -10)).toEqual({ x: 15, y: 10, w: 45, h: 40 });
    expect(resized(frame, "ne", 10, -10)).toEqual({ x: 20, y: 10, w: 50, h: 40 });
    expect(resized(frame, "sw", -10, 10)).toEqual({ x: 10, y: 20, w: 50, h: 40 });
  });

  it("stops at the smallest size, with the opposite corner still fixed", () => {
    expect(resized(frame, "se", -100, -100)).toEqual({ x: 20, y: 20, w: FRAME_MIN, h: FRAME_MIN });
    expect(resized(frame, "nw", 100, 100)).toEqual({ x: 55, y: 45, w: FRAME_MIN, h: FRAME_MIN });
  });

  it("stops at the edges of the slide", () => {
    expect(resized(frame, "se", 100, 100)).toEqual({ x: 20, y: 20, w: 80, h: 80 });
    expect(resized(frame, "nw", -100, -100)).toEqual({ x: 0, y: 0, w: 60, h: 50 });
  });
});

describe("resizing with snapping", () => {
  const targets = targetsOf([]);
  const frame = { x: 20, y: 20, w: 40, h: 30 };

  it("pulls the moving edges onto lines and reports guides", () => {
    const { frame: out, guides } = snapResize(frame, "se", 39.5, 49.6, targets);
    expect(out).toEqual({ x: 20, y: 20, w: 80, h: 80 });
    expect(guides).toEqual([
      { axis: "x", at: 100 },
      { axis: "y", at: 100 },
    ]);
  });

  it("looks only at the edges that move", () => {
    const { frame: out } = snapResize({ x: 4.5, y: 20, w: 40, h: 30 }, "se", 10, 0, targets);
    expect(out.x).toBe(4.5);
  });

  it("snaps the left edge for a west corner", () => {
    const { frame: out, guides } = snapResize(frame, "nw", -15.5, 0, targets);
    expect(out.x).toBe(SAFE_MARGIN);
    expect(guides).toContainEqual({ axis: "x", at: SAFE_MARGIN });
  });

  it("leaves a resize alone when no line is close", () => {
    expect(snapResize(frame, "se", 3, 3, targets)).toEqual({
      frame: { x: 20, y: 20, w: 43, h: 33 },
      guides: [],
    });
  });

  it("does not report a guide for a right edge held back by the smallest size", () => {
    const { frame: out, guides } = snapResize({ x: 0, y: 20, w: 40, h: 30 }, "se", -35.5, 3, targets);
    expect(out.w).toBe(FRAME_MIN);
    expect(guides).toEqual([]);
  });

  it("does not report a guide for a bottom edge held back by the smallest size", () => {
    const { frame: out, guides } = snapResize({ x: 20, y: 0, w: 40, h: 30 }, "se", 3, -25.5, targets);
    expect(out.h).toBe(FRAME_MIN);
    expect(guides).toEqual([]);
  });

  it("does not report a guide for a left edge held back by the smallest size", () => {
    const { frame: out, guides } = snapResize({ x: 60, y: 20, w: 35, h: 30 }, "nw", 35.7, 0, targets);
    expect(out).toEqual({ x: 90, y: 20, w: FRAME_MIN, h: 30 });
    expect(guides).toEqual([]);
  });
});

describe("aligning", () => {
  const frame = { x: 20, y: 30, w: 40, h: 10 };

  it("lines up on the left margin, the middle and the right margin", () => {
    expect(aligned(frame, "left")).toEqual({ x: SAFE_MARGIN, y: 30, w: 40, h: 10 });
    expect(aligned(frame, "center")).toEqual({ x: 30, y: 30, w: 40, h: 10 });
    expect(aligned(frame, "right")).toEqual({ x: 100 - SAFE_MARGIN - 40, y: 30, w: 40, h: 10 });
  });

  it("keeps a frame wider than the margins allow on the slide", () => {
    expect(aligned({ x: 0, y: 0, w: 98, h: 10 }, "right")).toEqual({ x: 0, y: 0, w: 98, h: 10 });
  });
});
