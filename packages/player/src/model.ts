import type { Scene } from "@depthcue/core";

/** Where the audience is: a scene and how many of its steps have been shown. Step 0 shows none of them. */
export interface Position {
  scene: number;
  step: number;
}

export type Route = { kind: "scene"; position: Position } | { kind: "read" };

export const stepCount = (scene: Scene): number => scene.steps?.length ?? 0;

/** Ids that some step reveals. Anything not listed is on screen from the start. */
export function gatedIds(scene: Scene): Set<string> {
  const ids = new Set<string>();
  for (const step of scene.steps ?? []) for (const id of step.reveal) ids.add(id);
  return ids;
}

/** Ids shown once `step` steps have been taken. */
export function revealedIds(scene: Scene, step: number): Set<string> {
  const ids = new Set<string>();
  for (const entry of (scene.steps ?? []).slice(0, step)) for (const id of entry.reveal) ids.add(id);
  return ids;
}

export function clampPosition(scenes: readonly Scene[], at: Position): Position {
  const scene = Math.min(Math.max(at.scene, 0), scenes.length - 1);
  const target = scenes[scene];
  const step = Math.min(Math.max(at.step, 0), target ? stepCount(target) : 0);
  return { scene, step };
}

/** One step forward: the next reveal, else the first state of the next scene. Null at the very end. */
export function nextPosition(scenes: readonly Scene[], at: Position): Position | null {
  const scene = scenes[at.scene];
  if (!scene) return null;
  if (at.step < stepCount(scene)) return { scene: at.scene, step: at.step + 1 };
  return at.scene + 1 < scenes.length ? { scene: at.scene + 1, step: 0 } : null;
}

/** One step back. Going back into a scene lands on its fully revealed state. Null at the very start. */
export function previousPosition(scenes: readonly Scene[], at: Position): Position | null {
  if (at.step > 0) return { scene: at.scene, step: at.step - 1 };
  const before = scenes[at.scene - 1];
  return before ? { scene: at.scene - 1, step: stepCount(before) } : null;
}

export function samePosition(a: Position, b: Position): boolean {
  return a.scene === b.scene && a.step === b.step;
}

/** Fraction of the deck shown, from 0 at the first state to 1 at the last. */
export function progress(scenes: readonly Scene[], at: Position): number {
  let total = 0;
  let done = 0;
  scenes.forEach((scene, index) => {
    const span = 1 + stepCount(scene);
    total += span;
    if (index < at.scene) done += span;
    else if (index === at.scene) done += 1 + at.step;
  });
  return total <= 1 ? 1 : (done - 1) / (total - 1);
}

export function formatRoute(scenes: readonly Scene[], route: Route): string {
  if (route.kind === "read") return "#/read";
  const scene = scenes[route.position.scene];
  if (!scene) return "#/";
  return route.position.step > 0 ? `#/${scene.id}/${route.position.step}` : `#/${scene.id}`;
}

/** Reads `#/read`, `#/<scene>` or `#/<scene>/<step>`. Returns null for anything else, including an unknown scene. */
export function parseRoute(scenes: readonly Scene[], hash: string): Route | null {
  const [head, second] = hash.replace(/^#\/?/, "").split("/");
  if (head === "read") return { kind: "read" };
  const index = scenes.findIndex((scene) => scene.id === head);
  if (index < 0) return null;
  const step = second === undefined ? 0 : Number(second);
  if (!Number.isInteger(step)) return null;
  return { kind: "scene", position: clampPosition(scenes, { scene: index, step }) };
}
