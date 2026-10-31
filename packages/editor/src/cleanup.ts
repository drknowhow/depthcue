import type { Op, Scene, SceneChanges } from "@depthcue/core";

/*
 * Removing something from a scene must also remove what points at it, or the deck stops validating. These
 * build the whole change as one list of operations, so it is applied, undone and rejected as one.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The steps with `id` taken out of what they reveal; a step that would reveal nothing is dropped. */
function withoutReveal(steps: Scene["steps"], id: string): Scene["steps"] {
  return steps
    ?.map((step) => ({ ...step, reveal: step.reveal.filter((target) => target !== id) }))
    .filter((step) => step.reveal.length > 0);
}

export function removeBlock(scene: Scene, blockId: string): Op[] {
  const ops: Op[] = [{ op: "block.remove", scene: scene.id, id: blockId }];
  const set: SceneChanges = {};
  const steps = withoutReveal(scene.steps, blockId);
  if (!same(steps, scene.steps)) set.steps = steps?.length ? steps : null;
  const summary = scene.summary;
  if (summary?.evidenceIds.includes(blockId)) {
    set.summary = { ...summary, evidenceIds: summary.evidenceIds.filter((target) => target !== blockId) };
  }
  if (Object.keys(set).length > 0) ops.push({ op: "scene.set", id: scene.id, set });
  return ops;
}

export function removeClaim(scene: Scene): Op[] {
  if (!scene.summary) return [];
  const set: SceneChanges = { summary: null };
  const steps = withoutReveal(scene.steps, scene.summary.id);
  if (!same(steps, scene.steps)) set.steps = steps?.length ? steps : null;
  return [{ op: "scene.set", id: scene.id, set }];
}

export function removeSource(scene: Scene, sourceId: string): Op[] {
  const ops: Op[] = [];
  for (const block of scene.blocks) {
    if (!block.sourceIds?.includes(sourceId)) continue;
    const rest = block.sourceIds.filter((target) => target !== sourceId);
    ops.push({
      op: "block.set",
      scene: scene.id,
      id: block.id,
      set: { sourceIds: rest.length > 0 ? rest : null },
    });
  }
  const remaining = (scene.sources ?? []).filter((source) => source.id !== sourceId);
  ops.push({ op: "scene.set", id: scene.id, set: { sources: remaining.length > 0 ? remaining : null } });
  return ops;
}

/** `items` with the one at `index` swapped with its neighbour, or undefined when it has none that way. */
export function swapped<T>(items: readonly T[], index: number, direction: -1 | 1): T[] | undefined {
  const other = index + direction;
  if (index < 0 || other < 0 || other >= items.length) return undefined;
  const next = [...items];
  [next[index], next[other]] = [next[other] as T, next[index] as T];
  return next;
}

/** The id to put a moved item after: the sibling before it when moving up, the one after it when moving down. */
export function afterWhenMoving(
  ids: readonly string[],
  id: string,
  direction: -1 | 1,
): string | null | undefined {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return undefined;
  return direction === -1 ? (ids[index - 2] ?? null) : (ids[index + 1] as string);
}

/** The id to drop an item after when it is released over `over`, on its upper or lower half. */
export function afterWhenDropping(
  ids: readonly string[],
  id: string,
  over: string,
  half: "upper" | "lower",
): string | null | undefined {
  const others = ids.filter((candidate) => candidate !== id);
  // Dropped on itself, or on something unknown: `over` is not among the others.
  const at = others.indexOf(over);
  if (at < 0) return undefined;
  const after = half === "upper" ? (others[at - 1] ?? null) : over;
  const before = ids.indexOf(id);
  const landing = after === null ? 0 : others.indexOf(after) + 1;
  return landing === before ? undefined : after;
}
