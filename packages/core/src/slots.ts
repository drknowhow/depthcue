import type { Op } from "./apply.ts";
import type { Block, BlockType, Scene } from "./types.ts";

/** The areas a layout draws blocks in. A layout has some of these, never all. */
export type SlotName = "stack" | "claim" | "evidence" | "support" | "text" | "media";

export interface Slot {
  name: SlotName;
  label: string;
  /** The blocks drawn here, in reading order. The claim is not a block and is not listed. */
  blocks: string[];
  /** The kinds of block a person may put here. Empty when the layout fills the area itself. */
  accepts: readonly BlockType[];
}

const ANY: readonly BlockType[] = ["text", "image", "bar-chart", "clip", "table", "chart", "contents"];
const MEDIA: readonly BlockType[] = ["image", "bar-chart", "clip", "table", "chart", "contents"];

/**
 * Where each block of a scene is drawn, which is decided by the layout and not stored in the deck: a title scene
 * stacks its blocks; a claim and evidence scene puts the blocks the claim cites under evidence and the rest under
 * support, with a heading above both while there is no claim; a text and media scene sends text one way and
 * everything else the other. This mirrors the player's renderer, which is the authority.
 */
export function slotsOf(scene: Scene): Slot[] {
  const pick = (keep: (block: Block) => boolean) => scene.blocks.filter(keep).map((block) => block.id);
  if (scene.layout === "claim-evidence") {
    const cited = new Set(scene.summary?.evidenceIds ?? []);
    const heading = (block: Block) => !scene.summary && block.type === "text" && block.role === "heading";
    return [
      { name: "claim", label: "Claim", blocks: pick(heading), accepts: [] },
      { name: "evidence", label: "Evidence", blocks: pick((block) => cited.has(block.id)), accepts: ANY },
      {
        name: "support",
        label: "Support",
        blocks: pick((block) => !cited.has(block.id) && !heading(block)),
        accepts: ANY,
      },
    ];
  }
  if (scene.layout === "text-media") {
    return [
      { name: "text", label: "Text", blocks: pick((block) => block.type === "text"), accepts: ["text"] },
      { name: "media", label: "Media", blocks: pick((block) => block.type !== "text"), accepts: MEDIA },
    ];
  }
  return [{ name: "stack", label: "Slide", blocks: pick(() => true), accepts: ANY }];
}

/** The area a block is drawn in, or undefined when the scene has no such block. */
export const slotOf = (scene: Scene, id: string): SlotName | undefined =>
  slotsOf(scene).find((slot) => slot.blocks.includes(id))?.name;

/**
 * Where to put a block: into an area after a sibling there (null for the start, left out for the end), or in the
 * place of another block, which then takes the first one's place.
 */
export type Placement = { slot: SlotName; after?: string | null } | { swap: string };

export type Placed = { ok: true; ops: Op[] } | { ok: false; message: string };

const refuse = (message: string): Placed => ({ ok: false, message });

/** The operations that turn the block order `from` into `to`, which hold the same ids. */
function reorder(scene: Scene, from: readonly string[], to: readonly string[]): Op[] {
  const ops: Op[] = [];
  const now = [...from];
  to.forEach((id, index) => {
    if (now[index] === id) return;
    now.splice(now.indexOf(id), 1);
    now.splice(index, 0, id);
    ops.push({ op: "block.move", scene: scene.id, id, after: to[index - 1] ?? null });
  });
  return ops;
}

/**
 * Where a block goes in `rest`, the block order without it: after a sibling, or at the start or the end of its
 * area. An empty area has no neighbour to land next to, so the block keeps its own place in the reading order.
 */
function landing(
  rest: readonly string[],
  siblings: readonly string[],
  after: string | null | undefined,
  own: number,
): number {
  if (typeof after === "string") return rest.indexOf(after) + 1;
  if (siblings.length === 0) return Math.min(own, rest.length);
  return after === null
    ? rest.indexOf(siblings[0] as string)
    : rest.indexOf(siblings[siblings.length - 1] as string) + 1;
}

/** Why a block of `type` cannot be put in `slot`, or undefined when it can. */
function turnedAway(scene: Scene, slot: Slot, type: BlockType): string | undefined {
  if (slot.name === "claim")
    return "The claim area holds the claim and its heading. Use Evidence or Support.";
  if (slot.name === "evidence" && !scene.summary) return "Evidence belongs to a claim. Add a claim first.";
  if (slot.accepts.includes(type)) return undefined;
  return slot.name === "text"
    ? "Only text goes in the text area. Images, tables, charts and clips stay in the media area."
    : "Text goes in the text area. Only images, tables, charts and clips go in the media area.";
}

/** The claim's evidence with `id` added or taken out, as a change to the scene, or no change at all. */
function evidenceChange(scene: Scene, ids: readonly string[]): Op[] {
  const summary = scene.summary;
  const same =
    summary &&
    ids.length === summary.evidenceIds.length &&
    ids.every((id) => summary.evidenceIds.includes(id));
  return !summary || same
    ? []
    : [{ op: "scene.set", id: scene.id, set: { summary: { ...summary, evidenceIds: [...ids] } } }];
}

/**
 * The operations that put a new block in an area: the block goes after `after` when that block is drawn there, and
 * otherwise after the last one there. In Evidence it is cited by the claim in the same step. The same refusals apply
 * as for a move, so a layout never ends up holding a block it would draw somewhere else.
 */
export function addBlock(scene: Scene, to: SlotName, block: Block, after?: string): Placed {
  const into = slotsOf(scene).find((slot) => slot.name === to);
  if (!into) return refuse("This layout has no such area.");
  const bad = turnedAway(scene, into, block.type);
  if (bad) return refuse(bad);
  const anchor =
    after !== undefined && into.blocks.includes(after) ? after : into.blocks[into.blocks.length - 1];
  const cited = scene.summary?.evidenceIds ?? [];
  return {
    ok: true,
    ops: [
      { op: "block.add", scene: scene.id, block, ...(anchor === undefined ? {} : { after: anchor }) },
      ...evidenceChange(scene, to === "evidence" ? [...cited, block.id] : cited),
    ],
  };
}

/**
 * The operations that move a block between areas, within one, or swap two blocks. They are ordinary core operations
 * and are applied as one step, so one undo takes the move back. Putting a block in Evidence adds it to the claim's
 * evidence, and taking it out of Evidence removes it, because that is what the layout draws. A move that changes
 * nothing is `ok` with no operations. Refusals say why, in words fit for the person who dragged.
 */
export function placeBlock(scene: Scene, id: string, to: Placement): Placed {
  const block = scene.blocks.find((candidate) => candidate.id === id);
  if (!block) return refuse(`There is no block "${id}" in this scene.`);
  const slots = slotsOf(scene);
  const ids = scene.blocks.map((candidate) => candidate.id);
  const from = slots.find((slot) => slot.blocks.includes(id)) as Slot;
  const cited = scene.summary?.evidenceIds ?? [];

  if ("swap" in to) {
    const other = scene.blocks.find((candidate) => candidate.id === to.swap);
    if (!other) return refuse(`There is no block "${to.swap}" in this scene.`);
    const there = slots.find((slot) => slot.blocks.includes(other.id)) as Slot;
    if (there !== from) {
      const bad = turnedAway(scene, there, block.type) ?? turnedAway(scene, from, other.type);
      if (bad) return refuse(bad);
    }
    const next = ids.map((entry) => (entry === id ? other.id : entry === other.id ? id : entry));
    // The two trade places, so each one is cited, or not, as the other was.
    const evidence = cited.map((entry) => (entry === id ? other.id : entry === other.id ? id : entry));
    return { ok: true, ops: [...reorder(scene, ids, next), ...evidenceChange(scene, evidence)] };
  }

  const into = slots.find((slot) => slot.name === to.slot);
  if (!into) return refuse("This layout has no such area.");
  if (from.name === "claim") return refuse("A heading stays with the claim until the scene has a claim.");
  const bad = into === from ? undefined : turnedAway(scene, into, block.type);
  if (bad) return refuse(bad);
  const siblings = into.blocks.filter((entry) => entry !== id);
  if (typeof to.after === "string" && !siblings.includes(to.after)) {
    return refuse(`"${to.after}" is not in the ${into.label.toLowerCase()} area.`);
  }
  const rest = ids.filter((entry) => entry !== id);
  const at = landing(rest, siblings, to.after, ids.indexOf(id));
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  const evidence =
    into.name === "evidence" && from.name !== "evidence"
      ? [...cited, id]
      : from.name === "evidence" && into.name !== "evidence"
        ? cited.filter((entry) => entry !== id)
        : cited;
  return { ok: true, ops: [...reorder(scene, ids, next), ...evidenceChange(scene, evidence)] };
}
