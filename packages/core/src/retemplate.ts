/**
 * Moving a scene to another template or to a layout, as operations a person or an agent can look at before applying.
 * Blocks go into the new template's slots by kind, in the order they appear; a block no slot can take is listed and left
 * where it is, never removed, so nothing is lost without someone choosing to lose it.
 */
import type { Op } from "./apply.ts";
import { type BrandPart, claimSlot, kindOf, slotMax, templatesOf } from "./brand.ts";
import { own } from "./own.ts";
import type { LAYOUTS } from "./schema.ts";
import type { Block, Scene } from "./types.ts";

export type Layout = (typeof LAYOUTS)[number];

export interface Retemplated {
  /** The operations that make the move, to apply as one transaction. */
  ops: Op[];
  /**
   * Ids of what does not fit, in scene order: the claim, when the template has no claim slot, and the blocks no slot of
   * the template takes. While any are left the operations do not apply: remove them, move them to another scene, or
   * pick a template that takes them.
   */
  unplaced: string[];
}

/**
 * The operations that move a scene to the template `to.template`, or to the layout `to.layout`. To a layout, every
 * block leaves its slot. To a template, the claim stays the scene's claim, its evidence with it, and goes in the
 * template's claim slot; it never turns into a block. Each block goes to the first slot that takes its kind and has room,
 * keeping the slot it has when that one is in the new template too. A pinned block takes room like any other; one that
 * no slot takes stays pinned over the slots, with no slot, and so does a block that already sits over them. Throws for a
 * scene or template the deck does not have.
 */
export function retemplate(
  doc: BrandPart & { readonly scenes: Readonly<Record<string, Scene>> },
  sceneId: string,
  to: { template: string } | { layout: Layout },
): Retemplated {
  const scene = own(doc.scenes, sceneId);
  if (!scene) throw new Error(`There is no scene "${sceneId}".`);
  if ("layout" in to) {
    const ops: Op[] = [{ op: "scene.set", id: sceneId, set: { layout: to.layout, template: null } }];
    for (const block of scene.blocks) {
      if (block.slot !== undefined)
        ops.push({ op: "block.set", scene: sceneId, id: block.id, set: { slot: null } });
    }
    return { ops, unplaced: [] };
  }
  const template = own(templatesOf(doc), to.template);
  if (!template) throw new Error(`There is no template "${to.template}".`);

  const room = new Map(template.slots.map((slot) => [slot.id, slotMax(slot)]));
  const takes = (slotId: string | undefined, block: Block): boolean => {
    const slot = template.slots.find((candidate) => candidate.id === slotId);
    return (
      slot !== undefined &&
      (room.get(slot.id) ?? 0) > 0 &&
      (slot.accepts as readonly string[] | undefined)?.includes(kindOf(block)) === true
    );
  };
  /** Each block's slot in the new template, or null for one pinned over the slots. */
  const placed = new Map<Block, string | null>();
  const put = (block: Block, slotId: string) => {
    placed.set(block, slotId);
    room.set(slotId, (room.get(slotId) ?? 0) - 1);
  };
  // Blocks that already sit in a slot the new template has, and that it takes, stay in it.
  for (const block of scene.blocks)
    if (block.slot !== undefined && takes(block.slot, block)) put(block, block.slot);
  const unplaced: string[] = scene.summary && !claimSlot(template) ? [scene.summary.id] : [];
  for (const block of scene.blocks) {
    if (placed.has(block)) continue;
    // A block pinned over another template's slots stays over this one's.
    if (block.frame !== undefined && block.slot === undefined && scene.template !== undefined) continue;
    const slot = template.slots.find((candidate) => takes(candidate.id, block));
    if (slot) put(block, slot.id);
    else if (block.frame !== undefined) placed.set(block, null);
    else unplaced.push(block.id);
  }

  const ops: Op[] = [{ op: "scene.set", id: sceneId, set: { template: to.template, layout: null } }];
  for (const block of scene.blocks) {
    const slot = placed.get(block);
    if (slot !== undefined && slot !== (block.slot ?? null)) {
      ops.push({ op: "block.set", scene: sceneId, id: block.id, set: { slot } });
    }
  }
  return { ops, unplaced };
}
