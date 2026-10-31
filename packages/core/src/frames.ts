import type { Block, Diagnostic, Scene } from "./types.ts";

export { FRAME_MIN } from "./schema.ts";

/** Where a pinned block sits: left, top, width and height in percent of a 16 by 9 slide. */
export type Frame = NonNullable<Block["frame"]>;

/** Rounding slack, so a frame the editor snapped to the right edge is not refused for 100.0000000001. */
const SLACK = 0.001;

/** The frame a block is pinned to, or undefined for a block in its layout's slot. */
export const frameOf = (block: Block): Frame | undefined => block.frame;

/** True when the scene has a pinned block. */
export const hasFrames = (scene: Scene): boolean => scene.blocks.some((block) => block.frame !== undefined);

/**
 * Facts about frames the schema cannot state: a frame lies on the slide, and only a scene that declares
 * schema 0.2 has any. Expects a scene that already passed the structure check.
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
    if (frame.x + frame.w > 100 + SLACK) {
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
      out.push({
        severity: "error",
        code: "frame-off-slide",
        file,
        path: `/blocks/${i}/frame/h`,
        message: `The frame runs to ${round(frame.y + frame.h)}% down; the slide ends at 100%.`,
        fix: `Make h at most ${round(100 - frame.y)}, or move y up.`,
      });
    }
  });
  return out;
}

const round = (value: number): number => Math.round(value * 100) / 100;
