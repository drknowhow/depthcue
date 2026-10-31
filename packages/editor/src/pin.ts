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

/** How close a block must come to a line, in percent of the slide, before it snaps to it. */
export const SNAP = 1.1;

/** A line on the slide, in percent across it (`x`) or down it (`y`). */
export interface Guide {
  axis: "x" | "y";
  at: number;
}

/** The lines a moving block can snap to on each axis. */
export interface Targets {
  x: readonly number[];
  y: readonly number[];
}

/** The slide's own edges, its safe margins and its middle, and the edges and middle of every other block. */
export function targetsOf(others: readonly Frame[]): Targets {
  const x = [0, SAFE_MARGIN, 50, 100 - SAFE_MARGIN, 100];
  const y = [0, SAFE_MARGIN, 50, 100 - SAFE_MARGIN, 100];
  for (const other of others) {
    x.push(other.x, other.x + other.w / 2, other.x + other.w);
    y.push(other.y, other.y + other.h / 2, other.y + other.h);
  }
  return { x, y };
}

/** The pair of a feature and a line that are closest, if they are within reach. */
function nearest(
  features: readonly number[],
  lines: readonly number[],
  within: number,
): { shift: number; at: number } | undefined {
  let best: { shift: number; at: number } | undefined;
  for (const feature of features) {
    for (const at of lines) {
      const shift = at - feature;
      if (Math.abs(shift) <= within && (best === undefined || Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, at };
      }
    }
  }
  return best;
}

/** A frame kept to tenths of a percent can miss a line it snapped to by this much. */
const KEPT = 0.1;

export interface Snapped {
  frame: Frame;
  /** The lines the frame now sits on, for drawing while it is being moved. */
  guides: Guide[];
}

/**
 * A frame moved to the nearest lines, one axis at a time. Its left, middle and right edges look for a vertical line,
 * and its top, middle and bottom for a horizontal one. A guide is reported only for a line the frame really ends up on.
 */
export function snapMove(frame: Frame, targets: Targets, within = SNAP): Snapped {
  const across = nearest([frame.x, frame.x + frame.w / 2, frame.x + frame.w], targets.x, within);
  const down = nearest([frame.y, frame.y + frame.h / 2, frame.y + frame.h], targets.y, within);
  const result = fitted({ ...frame, x: frame.x + (across?.shift ?? 0), y: frame.y + (down?.shift ?? 0) });
  const guides: Guide[] = [];
  if (
    across &&
    [result.x, result.x + result.w / 2, result.x + result.w].some((at) => Math.abs(at - across.at) <= KEPT)
  )
    guides.push({ axis: "x", at: across.at });
  if (
    down &&
    [result.y, result.y + result.h / 2, result.y + result.h].some((at) => Math.abs(at - down.at) <= KEPT)
  )
    guides.push({ axis: "y", at: down.at });
  return { frame: result, guides };
}

/** The corner of a frame that a handle sits on: north or south, then west or east. */
export type Corner = "nw" | "ne" | "se" | "sw";

export const CORNERS: readonly Corner[] = ["nw", "ne", "se", "sw"];

/**
 * A frame with one corner moved by `dx` and `dy` percent, and the opposite corner left where it was. The frame stays
 * on the slide and no smaller than `FRAME_MIN`.
 */
export function resized(frame: Frame, corner: Corner, dx: number, dy: number): Frame {
  const west = corner.endsWith("w");
  const north = corner.startsWith("n");
  let left = frame.x + (west ? dx : 0);
  let right = frame.x + frame.w + (west ? 0 : dx);
  let top = frame.y + (north ? dy : 0);
  let bottom = frame.y + frame.h + (north ? 0 : dy);
  left = Math.max(0, left);
  right = Math.min(100, right);
  top = Math.max(0, top);
  bottom = Math.min(100, bottom);
  if (right - left < FRAME_MIN) {
    if (west) left = right - FRAME_MIN;
    else right = left + FRAME_MIN;
  }
  if (bottom - top < FRAME_MIN) {
    if (north) top = bottom - FRAME_MIN;
    else bottom = top + FRAME_MIN;
  }
  return fitted({ x: left, y: top, w: right - left, h: bottom - top });
}

/** `resized`, with the two edges that move pulled onto the nearest lines. */
export function snapResize(
  frame: Frame,
  corner: Corner,
  dx: number,
  dy: number,
  targets: Targets,
  within = SNAP,
): Snapped {
  const west = corner.endsWith("w");
  const north = corner.startsWith("n");
  const across = nearest([west ? frame.x + dx : frame.x + frame.w + dx], targets.x, within);
  const down = nearest([north ? frame.y + dy : frame.y + frame.h + dy], targets.y, within);
  const result = resized(frame, corner, dx + (across?.shift ?? 0), dy + (down?.shift ?? 0));
  const guides: Guide[] = [];
  if (across && Math.abs((west ? result.x : result.x + result.w) - across.at) <= KEPT)
    guides.push({ axis: "x", at: across.at });
  if (down && Math.abs((north ? result.y : result.y + result.h) - down.at) <= KEPT)
    guides.push({ axis: "y", at: down.at });
  return { frame: result, guides };
}

export type Align = "left" | "center" | "right";

export const ALIGNS: readonly Align[] = ["left", "center", "right"];

/** A frame moved sideways to the left safe margin, the middle of the slide, or the right safe margin. */
export function aligned(frame: Frame, how: Align): Frame {
  const x =
    how === "left" ? SAFE_MARGIN : how === "right" ? 100 - SAFE_MARGIN - frame.w : (100 - frame.w) / 2;
  return fitted({ ...frame, x });
}
