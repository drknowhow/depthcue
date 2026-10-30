import { closest } from "./diagnostics.ts";
import type { Diagnostic, Scene } from "./types.ts";

type Kind = "summary" | "block" | "source" | "step";

function unknownTarget(
  file: string,
  path: string,
  target: string,
  what: string,
  options: readonly string[],
): Diagnostic {
  const guess = closest(target, options);
  const list = options.length ? `Use one of: ${options.join(", ")}.` : `This scene has no ${what} yet.`;
  return {
    severity: "error",
    code: "unknown-reference",
    file,
    path,
    message: `"${target}" is not a ${what} in this scene.`,
    fix: guess ? `Did you mean "${guess}"? ${list}` : list,
  };
}

/**
 * Facts the schema cannot state: ids are unique across a scene's summary, blocks, sources and steps, and
 * every reference points at something that exists. Expects a scene that already passed the structure check.
 */
export function checkReferences(scene: Scene, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const owners = new Map<string, { kind: Kind; path: string }>();
  const claim = (id: string, kind: Kind, path: string) => {
    const first = owners.get(id);
    if (!first) {
      owners.set(id, { kind, path });
      return;
    }
    out.push({
      severity: "error",
      code: "duplicate-id",
      file,
      path,
      message: `"${id}" is already used by the ${first.kind} at ${first.path}.`,
      fix: "Give it an id that is unique within the scene.",
    });
  };

  if (scene.summary) claim(scene.summary.id, "summary", "/summary/id");
  scene.blocks.forEach((block, i) => {
    claim(block.id, "block", `/blocks/${i}/id`);
  });
  scene.sources?.forEach((source, i) => {
    claim(source.id, "source", `/sources/${i}/id`);
  });
  scene.steps?.forEach((step, i) => {
    claim(step.id, "step", `/steps/${i}/id`);
  });

  const blockIds = scene.blocks.map((block) => block.id);
  const sourceIds = scene.sources?.map((source) => source.id) ?? [];
  const revealable = scene.summary ? [scene.summary.id, ...blockIds] : blockIds;

  scene.summary?.evidenceIds.forEach((target, i) => {
    if (!blockIds.includes(target)) {
      out.push(unknownTarget(file, `/summary/evidenceIds/${i}`, target, "block", blockIds));
    }
  });
  scene.blocks.forEach((block, i) => {
    block.sourceIds?.forEach((target, j) => {
      if (!sourceIds.includes(target)) {
        out.push(unknownTarget(file, `/blocks/${i}/sourceIds/${j}`, target, "source", sourceIds));
      }
    });
  });
  scene.steps?.forEach((step, i) => {
    step.reveal.forEach((target, j) => {
      if (!revealable.includes(target)) {
        out.push(unknownTarget(file, `/steps/${i}/reveal/${j}`, target, "block or summary", revealable));
      }
    });
  });
  return out;
}
