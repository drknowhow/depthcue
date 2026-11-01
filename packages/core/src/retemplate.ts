/**
 * Moving a scene to another template or to a layout, as operations a person or an agent can look at before applying.
 * Blocks go into the new template's slots by kind, in the order they appear; a block no slot can take is listed and left
 * where it is, never removed, so nothing is lost without someone choosing to lose it.
 */
import type { Op } from "./apply.ts";
import { type BrandPart, kindOf, slotMax, templatesOf } from "./brand.ts";
import { escapeText } from "./inline.ts";
import { own } from "./own.ts";
import type { LAYOUTS } from "./schema.ts";
import { sceneSchema, TEXT_LIMITS } from "./schema.ts";
import type { Block, Scene } from "./types.ts";

export type Layout = (typeof LAYOUTS)[number];

export interface Retemplated {
  /** The operations that make the move, to apply as one transaction. */
  ops: Op[];
  /**
   * Ids of what does not fit, in scene order: the blocks no slot of the template takes, and a claim that cannot become a
   * block because the scene has as many blocks as a scene may. While any are left the operations do not apply: remove
   * them, move them to another scene, or pick a template that takes them. A claim that does not fit stays a claim.
   */
  unplaced: string[];
}

/** What a scene of a template has in place of a claim: the claim's words as a heading, or as body text when long. */
function claimBlock(scene: Scene): Block | undefined {
  const summary = scene.summary;
  if (!summary) return undefined;
  const heading = summary.text.length <= TEXT_LIMITS.heading;
  const role = heading ? "heading" : "body";
  return { id: summary.id, type: "text", role, text: escapeText(summary.text, { lists: !heading }) };
}

/**
 * The operations that move a scene to the template `to.template`, or to the layout `to.layout`. To a layout, every
 * block leaves its slot. To a template, a claim becomes a text block when the scene has room for one more, since a
 * template has no place for a claim, and each
 * block goes to the first slot that takes its kind and has room, keeping the slot it has when that one is in the new
 * template too. Throws for a scene or template the deck does not have.
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

  const found = claimBlock(scene);
  // The claim is one block more, which a scene already at the most blocks it may have has no room for.
  const claim = found && scene.blocks.length < sceneSchema.properties.blocks.maxItems ? found : undefined;
  const blocks = claim ? [claim, ...scene.blocks] : scene.blocks;
  const room = new Map(template.slots.map((slot) => [slot.id, slotMax(slot)]));
  // A pinned block floats at its frame: it needs a slot that takes its kind, but no room in it.
  const takes = (slotId: string | undefined, block: Block): boolean => {
    const slot = template.slots.find((candidate) => candidate.id === slotId);
    return (
      slot !== undefined &&
      (block.frame !== undefined || (room.get(slot.id) ?? 0) > 0) &&
      (slot.accepts as readonly string[]).includes(kindOf(block))
    );
  };
  const placed = new Map<Block, string>();
  const put = (block: Block, slotId: string) => {
    placed.set(block, slotId);
    if (block.frame === undefined) room.set(slotId, (room.get(slotId) ?? 0) - 1);
  };
  // Blocks that already sit in a slot the new template has, and that it takes, stay in it.
  for (const block of blocks)
    if (block.slot !== undefined && takes(block.slot, block)) put(block, block.slot);
  const unplaced: string[] = found && !claim ? [found.id] : [];
  for (const block of blocks) {
    if (placed.has(block)) continue;
    const slot = template.slots.find((candidate) => takes(candidate.id, block));
    if (slot) put(block, slot.id);
    else unplaced.push(block.id);
  }

  const ops: Op[] = [
    {
      op: "scene.set",
      id: sceneId,
      set: { template: to.template, layout: null, ...(claim ? { summary: null } : {}) },
    },
  ];
  if (claim) {
    const slot = placed.get(claim);
    ops.push({ op: "block.add", scene: sceneId, block: slot ? { ...claim, slot } : claim, after: null });
  }
  for (const block of scene.blocks) {
    const slot = placed.get(block);
    if (slot !== undefined && slot !== block.slot) {
      ops.push({ op: "block.set", scene: sceneId, id: block.id, set: { slot } });
    }
  }
  return { ops, unplaced };
}
