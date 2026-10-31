import type { Block, Diagnostic, Scene } from "./types.ts";

export { FRAME_MIN } from "./schema.ts";

/** Where a pinned block sits: left, top, width and height in percent of a 16 by 9 slide. */
export type Frame = NonNullable<Block["frame"]>;

/** Rounding slack, so a frame the editor snapped to the right edge is not refused for 100.0000000001. */
const SLACK = 0.001;

/** Percent of the slide that text and chart labels keep clear at every edge, where a projector may cut them off. */
export const SAFE_MARGIN = 4;

/** A picture or a clip may run to the edge of the slide on purpose, so it is not held to the margin. */
const mayBleed = (block: Block): boolean => block.type === "image" || block.type === "clip";

/** The frame a block is pinned to, or undefined for a block in its layout's slot. */
export const frameOf = (block: Block): Frame | undefined => block.frame;

/** True when the scene has a pinned block. */
export const hasFrames = (scene: Scene): boolean => scene.blocks.some((block) => block.frame !== undefined);

/**
 * Facts about frames the schema cannot state: a frame lies on the slide, and only a scene that declares
 * schema 0.2 has any. A frame that holds text and reaches into the safe margin is a warning, not an error: a
 * person may want it there. Expects a scene that already passed the structure check.
 */
export function checkFrames(scene: Scene, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  scene.blocks.forEach((block, i) => {
    const frame = block.frame;
    if (!frame) return;
    if (scene.schemaVersion === "0.1") {
      out.push({
        severity: "error",
        code: "frame-needs-version",
        file,
        path: `/blocks/${i}/frame`,
        message: 'Schema 0.1 has no frames, but this scene says schemaVersion "0.1".',
        fix: 'Set schemaVersion to "0.2", or remove the frame.',
      });
    }
    let offSlide = false;
    if (frame.x + frame.w > 100 + SLACK) {
      offSlide = true;
      out.push({
        severity: "error",
        code: "frame-off-slide",
        file,
        path: `/blocks/${i}/frame/w`,
        message: `The frame runs to ${round(frame.x + frame.w)}% across; the slide ends at 100%.`,
        fix: `Make w at most ${round(100 - frame.x)}, or move x left.`,
      });
    }
    if (frame.y + frame.h > 100 + SLACK) {
      offSlide = true;
      out.push({
        severity: "error",
        code: "frame-off-slide",
        file,
        path: `/blocks/${i}/frame/h`,
        message: `The frame runs to ${round(frame.y + frame.h)}% down; the slide ends at 100%.`,
        fix: `Make h at most ${round(100 - frame.y)}, or move y up.`,
      });
    }
    if (offSlide || mayBleed(block)) return;
    const edges = [
      frame.x < SAFE_MARGIN - SLACK ? "left" : "",
      frame.y < SAFE_MARGIN - SLACK ? "top" : "",
      frame.x + frame.w > 100 - SAFE_MARGIN + SLACK ? "right" : "",
      frame.y + frame.h > 100 - SAFE_MARGIN + SLACK ? "bottom" : "",
    ].filter(Boolean);
    if (edges.length > 0) {
      out.push({
        severity: "warning",
        code: "frame-outside-safe-area",
        file,
        path: `/blocks/${i}/frame`,
        message: `The frame reaches into the ${SAFE_MARGIN}% margin at the ${listOf(edges)} of the slide, where a projector can cut it off.`,
        fix: `Keep x and y at ${SAFE_MARGIN} or more, and x + w and y + h at ${100 - SAFE_MARGIN} or less. Leave it as it is if the block should touch the edge.`,
      });
    }
  });
  return out;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** "left", "left and top", "left, top and right". */
const listOf = (items: string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
