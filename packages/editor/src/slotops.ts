/**
 * The changes the template editor makes to a brand template, as the operations `depthcue apply` takes for them:
 * `slot.set`, `slot.add`, `slot.rename` and `slot.remove` for a slot, and `template.set` with `set` for the template's
 * own background and chrome. Each comes back as the operations of one step, or as the reason it cannot be made, said
 * before core is asked: a removal is refused while a block is in the slot, naming the blocks, unless they are pinned
 * where the slot was or moved to another slot.
 */
import type { Doc, Op, Scene, Template, TemplateSlot } from "@depthcue/core";
import { describeBlock } from "./templates.ts";

/** A template as `template.set` writes it whole: without the id and version the operation fills in. */
export function toWrite(template: Template): Omit<Template, "id" | "schemaVersion"> {
  const {
    id: _id,
    schemaVersion: _version,
    $schema: _schema,
    ...rest
  } = template as Template & {
    $schema?: string;
  };
  return rest;
}

/** The scenes of the deck on a template, in deck order. */
export const scenesOn = (doc: Doc, id: string): Scene[] =>
  doc.deck.scenes.flatMap((sceneId) => {
    const scene = doc.scenes[sceneId];
    return scene?.template === id ? [scene] : [];
  });

/** The properties to write, each null to take one out. */
export type Changes<T> = { [K in keyof T]?: T[K] | null };

const own = (doc: Doc, id: string): Template | undefined =>
  doc.templates && Object.hasOwn(doc.templates, id) ? doc.templates[id] : undefined;

/** The template, or why the editor cannot change it. */
const find = (doc: Doc, id: string): Template | string =>
  own(doc, id) ?? `The brand has no template "${id}".`;

/** The template and the slot in it, or why the editor cannot change it. */
function findSlot(doc: Doc, id: string, slot: string): { template: Template; found: TemplateSlot } | string {
  const template = find(doc, id);
  if (typeof template === "string") return template;
  const found = template.slots.find((candidate) => candidate.id === slot);
  return found ? { template, found } : `The template has no slot "${slot}".`;
}

/** Changes the template's own properties: its name, description, background or chrome. */
export function templateSet(
  doc: Doc,
  id: string,
  set: Changes<Omit<Template, "id" | "slots">>,
): Op[] | string {
  const template = find(doc, id);
  return typeof template === "string" ? template : [{ op: "template.set", id, set }];
}

/** Changes one slot. Its id changes only by `slotRename`. */
export function slotSet(
  doc: Doc,
  id: string,
  slot: string,
  set: Changes<Omit<TemplateSlot, "id">>,
): Op[] | string {
  const found = findSlot(doc, id, slot);
  return typeof found === "string" ? found : [{ op: "slot.set", template: id, id: slot, set }];
}

/** Adds a slot after another, or at the end. */
export function slotAdd(doc: Doc, id: string, slot: TemplateSlot, after?: string): Op[] | string {
  const template = find(doc, id);
  if (typeof template === "string") return template;
  return [{ op: "slot.add", template: id, slot, ...(after === undefined ? {} : { after }) }];
}

/** The blocks of the deck in a slot of a template, by scene. */
function blocksIn(doc: Doc, id: string, slot: string) {
  return scenesOn(doc, id).flatMap((scene) =>
    scene.blocks.filter((block) => block.slot === slot).map((block) => ({ scene, block })),
  );
}

/** Renames a slot; core moves every block that names it to the new name, in the same step. */
export function slotRename(doc: Doc, id: string, slot: string, to: string): Op[] | string {
  const found = findSlot(doc, id, slot);
  if (typeof found === "string") return found;
  if (to === slot) return [];
  if (found.template.slots.some((candidate) => candidate.id === to))
    return `The template already has a slot "${to}".`;
  return [{ op: "slot.rename", template: id, id: slot, to }];
}

/**
 * Removes a slot. While a block is in it the removal is refused, naming the blocks, unless `to` says where they go: null
 * pins each where the slot was, and a slot id moves them into that slot.
 */
export function slotRemove(doc: Doc, id: string, slot: string, to?: string | null): Op[] | string {
  const found = findSlot(doc, id, slot);
  if (typeof found === "string") return found;
  if (found.template.slots.length === 1) return "A template keeps at least one slot.";
  const held = blocksIn(doc, id, slot);
  if (held.length === 0) return [{ op: "slot.remove", template: id, id: slot }];
  if (to === undefined) {
    const named = held.map(({ scene, block }) => `${describeBlock(block, 32, scene)} (${scene.title})`);
    const them = held.length === 1 ? "it" : "them";
    return `The ${slot} slot holds ${named.join("; ")}. Pin ${them} where the slot was, or move ${them} to another slot first.`;
  }
  return [{ op: "slot.remove", template: id, id: slot, to }];
}
