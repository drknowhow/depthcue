/**
 * The changes the template editor makes to a brand template, as operations: one slot's properties, a slot added,
 * renamed or removed, and the template's own background and chrome. Each comes back as the operations of one step, to
 * apply together, or as the reason it cannot be made. A rename takes the blocks that name the slot with it, and a removal
 * is refused while a block is in the slot, naming the blocks, unless they are pinned where the slot was or moved to
 * another slot.
 */
import type { Doc, Frame, Op, Scene, Template, TemplateSlot } from "@depthcue/core";
import { describeBlock } from "./templates.ts";

/** A template as `template.set` writes it: without the id and version the operation fills in. */
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

const patched = <T extends object>(value: T, set: { readonly [K in keyof T]?: unknown }): T => {
  const next = { ...value } as Record<string, unknown>;
  for (const [key, to] of Object.entries(set)) {
    if (to === null || to === undefined) delete next[key];
    else next[key] = to;
  }
  return next as T;
};

const own = (doc: Doc, id: string): Template | undefined =>
  doc.templates && Object.hasOwn(doc.templates, id) ? doc.templates[id] : undefined;

const write = (id: string, template: Template): Op => ({
  op: "template.set",
  id,
  template: toWrite(template),
});

/** Changes the template's own properties: its name, description, background or chrome. */
export function templateSet(
  doc: Doc,
  id: string,
  set: Changes<Omit<Template, "id" | "slots">>,
): Op[] | string {
  const template = own(doc, id);
  if (!template) return `The brand has no template "${id}".`;
  return [write(id, patched(template, set))];
}

/** Changes one slot. Its id changes only by `slotRename`. */
export function slotSet(
  doc: Doc,
  id: string,
  slot: string,
  set: Changes<Omit<TemplateSlot, "id">>,
): Op[] | string {
  const template = own(doc, id);
  if (!template) return `The brand has no template "${id}".`;
  if (!template.slots.some((candidate) => candidate.id === slot))
    return `The template has no slot "${slot}".`;
  const slots = template.slots.map((candidate) =>
    candidate.id === slot ? patched(candidate, set) : candidate,
  );
  return [write(id, { ...template, slots })];
}

/** Adds a slot after another, or at the end. */
export function slotAdd(doc: Doc, id: string, slot: TemplateSlot, after?: string): Op[] | string {
  const template = own(doc, id);
  if (!template) return `The brand has no template "${id}".`;
  const at =
    after === undefined ? template.slots.length : template.slots.findIndex((s) => s.id === after) + 1;
  const slots = [...template.slots.slice(0, at), slot, ...template.slots.slice(at)];
  return [write(id, { ...template, slots })];
}

/** The blocks of the deck in a slot of a template, by scene. */
function blocksIn(doc: Doc, id: string, slot: string) {
  return scenesOn(doc, id).flatMap((scene) =>
    scene.blocks.filter((block) => block.slot === slot).map((block) => ({ scene, block })),
  );
}

/** Renames a slot, and moves every block that names it to the new name, in the same step. */
export function slotRename(doc: Doc, id: string, slot: string, to: string): Op[] | string {
  const template = own(doc, id);
  if (!template) return `The brand has no template "${id}".`;
  if (to === slot) return [];
  if (template.slots.some((candidate) => candidate.id === to))
    return `The template already has a slot "${to}".`;
  const slots = template.slots.map((candidate) =>
    candidate.id === slot ? { ...candidate, id: to } : candidate,
  );
  return [
    write(id, { ...template, slots }),
    ...blocksIn(doc, id, slot).map(
      ({ scene, block }): Op => ({ op: "block.set", scene: scene.id, id: block.id, set: { slot: to } }),
    ),
  ];
}

/**
 * Removes a slot. While a block is in it the removal is refused, naming the blocks, unless `to` says where they go: null
 * pins each where the slot was, and a slot id moves them into that slot.
 */
export function slotRemove(doc: Doc, id: string, slot: string, to?: string | null): Op[] | string {
  const template = own(doc, id);
  if (!template) return `The brand has no template "${id}".`;
  const gone = template.slots.find((candidate) => candidate.id === slot);
  if (!gone) return `The template has no slot "${slot}".`;
  if (template.slots.length === 1) return "A template keeps at least one slot.";
  const held = blocksIn(doc, id, slot);
  if (held.length > 0 && to === undefined) {
    const named = held.map(({ scene, block }) => `${describeBlock(block, 32, scene)} (${scene.title})`);
    return `The ${slot} slot holds ${named.join("; ")}. Pin ${held.length === 1 ? "it" : "them"} where the slot was, or move ${held.length === 1 ? "it" : "them"} to another slot first.`;
  }
  const slots = template.slots.filter((candidate) => candidate.id !== slot);
  const moved = held.flatMap(({ scene, block }): Op[] =>
    to === null || to === undefined
      ? [
          { op: "block.set", scene: scene.id, id: block.id, set: { slot: null } },
          { op: "block.frame", scene: scene.id, id: block.id, frame: block.frame ?? (gone.frame as Frame) },
        ]
      : [{ op: "block.set", scene: scene.id, id: block.id, set: { slot: to } }],
  );
  return [write(id, { ...template, slots }), ...moved];
}
