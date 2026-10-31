import { FRAME_MIN, type Frame, SAFE_MARGIN } from "@depthcue/core";

/** A box in pixels, as `getBoundingClientRect` gives it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** An arrow key moves a pinned block this far, in percent of the slide, and Shift moves it the larger step. */
export const NUDGE = 1;
export const NUDGE_BIG = 5;

const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * A frame kept on the slide: at least `FRAME_MIN` across, no larger than the slide, and placed so none of it runs
 * off. Each number is in tenths of a percent, which is finer than a pointer or a screen can tell apart.
 */
export function fitted(frame: Frame): Frame {
  const w = Math.min(100, Math.max(FRAME_MIN, tenth(frame.w)));
  const h = Math.min(100, Math.max(FRAME_MIN, tenth(frame.h)));
  return {
    x: tenth(Math.min(100 - w, Math.max(0, frame.x))),
    y: tenth(Math.min(100 - h, Math.max(0, frame.y))),
    w,
    h,
  };
}

/** The 16 by 9 slide inside the room a scene has: the largest such box, centered, as the player draws it. */
export function slideIn(room: Rect): Rect {
  const width = Math.min(room.width, (room.height * 16) / 9);
  const height = (width * 9) / 16;
  return {
    left: room.left + (room.width - width) / 2,
    top: room.top + (room.height - height) / 2,
    width,
    height,
  };
}

/**
 * The frame a block fills now, in percent of the slide, so pinning it changes nothing that is seen. Undefined when
 * either box has no size, which is what a block that is not laid out measures.
 */
export function frameOver(block: Rect, slide: Rect): Frame | undefined {
  if (block.width <= 0 || block.height <= 0 || slide.width <= 0 || slide.height <= 0) return undefined;
  return fitted({
    x: ((block.left - slide.left) / slide.width) * 100,
    y: ((block.top - slide.top) / slide.height) * 100,
    w: (block.width / slide.width) * 100,
    h: (block.height / slide.height) * 100,
  });
}

/** A frame moved by `dx` and `dy` percent of the slide, and kept on it. */
export function nudged(frame: Frame, dx: number, dy: number): Frame {
  return fitted({ ...frame, x: frame.x + dx, y: frame.y + dy });
}

export type Align = "left" | "center" | "right";

export const ALIGNS: readonly Align[] = ["left", "center", "right"];

/** A frame moved sideways to the left safe margin, the middle of the slide, or the right safe margin. */
export function aligned(frame: Frame, how: Align): Frame {
  const x =
    how === "left" ? SAFE_MARGIN : how === "right" ? 100 - SAFE_MARGIN - frame.w : (100 - frame.w) / 2;
  return fitted({ ...frame, x });
}
