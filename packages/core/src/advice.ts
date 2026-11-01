import { checkFrames } from "./frames.ts";
import type { Block, Diagnostic, Scene } from "./types.ts";

const stem = (path: string) => path.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

/**
 * The alt text a new image or clip starts with: the words of its file's name, which describe nothing. The server adds
 * a hash of eight hex digits to the name of an upload, and that is not a word.
 */
export const placeholderAlt = (path: string): string =>
  stem(path)
    .replace(/-[0-9a-f]{8}$/, "")
    .replace(/[-_]+/g, " ")
    .trim() || "untitled";

/** True for an image or clip whose alt text is still the name of its file, so nobody has described it yet. */
export function hasPlaceholderAlt(block: Block): boolean {
  if (block.type === "image") return block.alt === placeholderAlt(block.asset);
  if (block.type === "clip") return block.alt === placeholderAlt(block.source);
  return false;
}

/**
 * Advice about content the schema cannot judge, as warnings: an image or clip nobody has described, and a chart whose
 * numbers cite nothing. Neither stops a deck from loading or presenting. Expects a scene that passed the structure check.
 */
export function checkContent(scene: Scene, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  scene.blocks.forEach((block, i) => {
    if (hasPlaceholderAlt(block)) {
      out.push({
        severity: "warning",
        code: "alt-is-filename",
        file,
        path: `/blocks/${i}/alt`,
        message: `The alt text "${(block as { alt: string }).alt}" is the name of the file, so it does not describe the ${block.type}.`,
        fix: "Write what the picture shows, for someone who cannot see it.",
      });
    }
    if ((block.type === "bar-chart" || block.type === "chart") && (block.sourceIds ?? []).length === 0) {
      out.push({
        severity: "warning",
        code: "missing-source",
        file,
        path: `/blocks/${i}`,
        message: `The chart "${block.id}" does not say where its numbers come from.`,
        fix: 'Add a source to the scene, and list its id in the chart\'s "sourceIds".',
      });
    }
  });
  return out;
}

/** What a person should look at in a scene, from the document alone: the warnings that `depthcue check` gives for it. */
export const adviceOf = (scene: Scene, file: string): Diagnostic[] =>
  [...checkFrames(scene, file), ...checkContent(scene, file)].filter((d) => d.severity === "warning");
