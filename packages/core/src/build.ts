import type { Op } from "./apply.ts";
import type { Placed } from "./slots.ts";
import type { Scene } from "./types.ts";

type Step = NonNullable<Scene["steps"]>[number];

/** The most steps a scene holds. The schema says so too. */
export const STEPS_MAX = 24;

/** Where a part of a scene appears: from the start, at a step counted from 1, or at a step of its own added last. */
export type BuildTarget = "start" | "new" | number;

/** One part of a scene that a step can reveal, and the step that shows it. */
export interface BuildEntry {
  id: string;
  /** The step, counted from 1, whose press reveals this part. Undefined when it is there from the start. */
  step: number | undefined;
}

/** The claim and every block, in reading order: the parts a step can reveal. */
export const revealable = (scene: Scene): string[] => [
  ...(scene.summary ? [scene.summary.id] : []),
  ...scene.blocks.map((block) => block.id),
];

/**
 * The order the scene builds in: for each part a step can reveal, the step that shows it. A part some steps name more
 * than once appears at the first of them, which is when the audience first sees it.
 */
export function buildOf(scene: Scene): BuildEntry[] {
  const steps = scene.steps ?? [];
  return revealable(scene).map((id) => {
    const at = steps.findIndex((step) => step.reveal.includes(id));
    return { id, step: at < 0 ? undefined : at + 1 };
  });
}

/** A step id that no part of the scene uses: the scene's id, then "-step" and a number. */
function freshStepId(scene: Scene): string {
  const taken = new Set<string>([
    ...(scene.summary ? [scene.summary.id] : []),
    ...scene.blocks.map((block) => block.id),
    ...(scene.sources ?? []).map((source) => source.id),
    ...(scene.steps ?? []).map((step) => step.id),
  ]);
  for (let n = (scene.steps?.length ?? 0) + 1; ; n += 1) {
    const tail = `-step-${n}`;
    const id = `${scene.id.slice(0, 64 - tail.length)}${tail}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The operation that moves one part of a scene to another point of its build: from the start, to a step that is there
 * (counted as it is now), or to a new step after the last. A part goes to one step only, so it leaves the one it was
 * in, and a step it leaves empty goes with it and the steps after it count one less. Putting a part where it already
 * is changes nothing, and is `ok` with no operations.
 */
export function placeInBuild(scene: Scene, id: string, to: BuildTarget): Placed {
  if (!revealable(scene).includes(id)) {
    return { ok: false, message: `There is nothing called "${id}" on this scene for a step to reveal.` };
  }
  const steps = scene.steps ?? [];
  if (typeof to === "number" && (!Number.isInteger(to) || to < 1 || to > steps.length)) {
    return { ok: false, message: `This scene has no step ${to}.` };
  }
  const next: Step[] = steps
    .map((step, index) => {
      if (to !== index + 1) return { ...step, reveal: step.reveal.filter((entry) => entry !== id) };
      return step.reveal.includes(id) ? step : { ...step, reveal: [...step.reveal, id] };
    })
    .filter((step) => step.reveal.length > 0);
  if (to === "new") {
    const holders = steps.filter((step) => step.reveal.includes(id));
    // Alone in the last step already: a new step after it would be the same build under another id.
    const last = steps[steps.length - 1];
    if (holders.length === 1 && holders[0] === last && last?.reveal.length === 1)
      return { ok: true, ops: [] };
    if (next.length >= STEPS_MAX) {
      return {
        ok: false,
        message: `A scene holds at most ${STEPS_MAX} steps. Put this with an existing step.`,
      };
    }
    next.push({ id: freshStepId(scene), reveal: [id] });
  }
  const unchanged = JSON.stringify(next) === JSON.stringify(steps);
  const op: Op = { op: "scene.set", id: scene.id, set: { steps: next.length > 0 ? next : null } };
  return { ok: true, ops: unchanged ? [] : [op] };
}
