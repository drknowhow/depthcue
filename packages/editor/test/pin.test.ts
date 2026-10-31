import { FRAME_MIN, SAFE_MARGIN } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { aligned, fitted, frameOver, NUDGE, NUDGE_BIG, nudged, slideIn } from "../src/pin.ts";

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
