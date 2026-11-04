import {
  type ApplyResult,
  addBlock,
  type Block,
  type BlockKind,
  type BlockType,
  kindOf,
  type Op,
  type Placed,
  type Scene,
  type Session,
  type SlotName,
  slotMax,
  slotsOf,
  type Template,
  templatesOf,
} from "@depthcue/core";
import { problemOf } from "./fields.ts";
import {
  isNewBlockKind,
  type NewBlockKind,
  newBlock,
  newClaim,
  type TextRole,
  VIDEO_FILE,
} from "./templates.ts";

export interface AdderHooks {
  /** The scene being edited. */
  scene(): string;
  /** The chosen block of that scene, if any. A quick add goes into its area, after it. */
  block(): string | undefined;
  /** Applies what an add decided, as one undo step. */
  act(ops: readonly Op[]): ApplyResult;
  /** Says why an add was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
  /** A block was added: choose it. */
  added(id: string): void;
}

/** The picture an image takes: a file to upload, or the path of one the deck has, as the image library gives it. */
export type Picture = File | string;

/** How many blocks a scene holds, as the scene schema allows. */
export const SCENE_BLOCKS = 12;

export interface Adder {
  /** Adds a block of `kind` to an area of the slide. An image takes the file to upload, or a file the deck has. */
  add(slot: SlotName, kind: NewBlockKind, file?: Picture): Promise<void>;
  /** Adds a block of `kind` where a person pointing at the slide would expect it: see `slotFor`. */
  quick(kind: NewBlockKind, file?: Picture): Promise<void>;
  /**
   * Adds an image block for each file, one after another in the area `quick` would pick, as one undo step. A slide
   * holds 12 blocks, so the ones past that are left out, and the answer says how many. Never rejects.
   */
  many(files: readonly File[]): Promise<void>;
  /** Adds a block of a kind a template's slot takes, a text by its role, into the slot `slot` of a template scene. */
  into(slot: string, kind: BlockKind, file?: File): Promise<void>;
  /** Gives the slide a claim to fill in. */
  claim(): void;
  /** Whether the deck has a video a clip could play. */
  hasVideo(): boolean;
}

/**
 * The area a block of `kind` goes to when nobody named one: the area of the chosen block when it takes that kind,
 * else the first area that holds nothing, else the first area that takes it. Evidence is left out until the slide has
 * a claim to cite it. Undefined when no area takes the kind, which no layout does today.
 */
export function slotFor(scene: Scene, kind: BlockType, anchor?: string): SlotName | undefined {
  const open = slotsOf(scene).filter(
    (slot) => slot.accepts.includes(kind) && (slot.name !== "evidence" || scene.summary !== undefined),
  );
  const near = anchor === undefined ? undefined : open.find((slot) => slot.blocks.includes(anchor));
  return (near ?? open.find((slot) => slot.blocks.length === 0) ?? open[0])?.name;
}

/**
 * The slot of a template a new block of `kind` goes to in a scene: the chosen block's slot when it takes the kind and has
 * room, else the first that does. A pinned block in a slot takes room there, as `depthcue check` counts it.
 */
export function templateSlot(
  template: Template,
  scene: Scene,
  kind: BlockKind,
  anchor?: string,
): string | undefined {
  const fits = (slot: Template["slots"][number]) =>
    slot.accepts?.includes(kind) === true &&
    scene.blocks.filter((block) => block.slot === slot.id).length < slotMax(slot);
  const near = scene.blocks.find((block) => block.id === anchor)?.slot;
  return (template.slots.find((slot) => slot.id === near && fits(slot)) ?? template.slots.find(fits))?.id;
}

/**
 * Adds to a chosen area of the slide, or, for the quick bar, to the area `slotFor` picks. The core decides where the
 * block lands and whether the area takes it, so an empty area drawn on the slide, the quick bar and an agent's
 * `block.add` agree.
 */
export function createAdder(session: Session, hooks: AdderHooks): Adder {
  const firstVideo = () => [...session.doc.assets].sort().find((path) => VIDEO_FILE.test(path));

  async function put(
    kind: NewBlockKind,
    file: Picture | undefined,
    slot?: SlotName,
    into?: string,
    role?: TextRole,
  ) {
    hooks.problem(undefined);
    // Read now: the person may choose something else while a file is on its way.
    const anchor = slot === undefined && into === undefined ? hooks.block() : undefined;
    let asset: string | undefined;
    if (kind === "image") {
      if (!file) return;
      try {
        asset = typeof file === "string" ? file : await hooks.upload(file);
      } catch (error) {
        hooks.problem(error instanceof Error ? error.message : "The upload failed.");
        return;
      }
    } else if (kind === "clip") {
      asset = firstVideo();
      if (!asset) return;
    }
    // The deck may have changed while the file was on its way, so the scene is read again.
    const target = session.doc.scenes[hooks.scene()];
    if (!target) return;
    const made = newBlock(target, kind, asset);
    const block = role && made.type === "text" ? { ...made, role } : made;
    const placed = place(target, [block], kind, slot, into, anchor);
    if (!placed.ok) {
      hooks.problem(placed.message);
      return;
    }
    const result = hooks.act(placed.ops);
    hooks.problem(result.ok ? undefined : problemOf(result));
    if (result.ok) hooks.added(block.id);
  }

  /** The operations that add `blocks`, in order, where one of `kind` goes: see `slotFor` and `templateSlot`. */
  function place(
    target: Scene,
    blocks: readonly Block[],
    kind: NewBlockKind,
    slot?: SlotName,
    into?: string,
    anchor?: string,
  ): Placed {
    const [first] = blocks as [Block, ...Block[]];
    // A template scene puts the block in a slot of its template; a layout scene, in an area of its layout.
    const templates = templatesOf(session.doc);
    const template =
      target.template !== undefined && Object.hasOwn(templates, target.template)
        ? templates[target.template]
        : undefined;
    const at = template
      ? (into ?? templateSlot(template, target, kindOf(first), anchor))
      : (slot ?? slotFor(target, kind, anchor));
    if (at === undefined) return { ok: false, message: "This slide has no place for that." };
    // The first goes where the core puts it; each one after it goes right after the one before.
    const chain = (rest: readonly Block[], within?: string): Op[] =>
      rest.map((block, i) => ({
        op: "block.add",
        scene: target.id,
        block: within === undefined ? block : { ...block, slot: within },
        after: (i === 0 ? first : (rest[i - 1] as Block)).id,
      }));
    if (template) {
      const [head, ...rest] = blocks;
      const ops: Op[] = [
        { op: "block.add", scene: target.id, block: { ...(head as Block), slot: at } },
        ...chain(rest, at),
      ];
      return { ok: true, ops };
    }
    const placed = addBlock(target, at as SlotName, first, anchor);
    return placed.ok ? { ok: true, ops: [...placed.ops, ...chain(blocks.slice(1))] } : placed;
  }

  async function many(files: readonly File[]) {
    hooks.problem(undefined);
    const anchor = hooks.block();
    const room = SCENE_BLOCKS - (session.doc.scenes[hooks.scene()]?.blocks.length ?? SCENE_BLOCKS);
    const take = files.slice(0, Math.max(0, room));
    const leftOut = files.length - take.length;
    const sent = await Promise.allSettled(take.map((file) => hooks.upload(file)));
    const assets = sent.flatMap((one) => (one.status === "fulfilled" ? [one.value] : []));
    const failed = take.length - assets.length;
    const target = session.doc.scenes[hooks.scene()];
    const said: string[] = [];
    if (leftOut > 0) {
      said.push(
        `${leftOut} ${leftOut === 1 ? "picture was" : "pictures were"} left out: a slide holds at most ${SCENE_BLOCKS} blocks.`,
      );
    }
    if (failed > 0) said.push(`${failed} could not be uploaded.`);
    if (target && assets.length > 0) {
      // Each block is named against the ones before it, so no two share an id.
      let grown = target;
      const blocks = assets.map((asset) => {
        const block = newBlock(grown, "image", asset);
        grown = { ...grown, blocks: [...grown.blocks, block] };
        return block;
      });
      const placed = place(target, blocks, "image", undefined, undefined, anchor);
      if (!placed.ok) said.unshift(placed.message);
      else {
        const result = hooks.act(placed.ops);
        if (result.ok) hooks.added((blocks.at(-1) as Block).id);
        else said.unshift(problemOf(result));
      }
    }
    hooks.problem(said.length > 0 ? said.join(" ") : undefined);
  }

  return {
    many,
    hasVideo: () => firstVideo() !== undefined,
    claim() {
      const target = session.doc.scenes[hooks.scene()];
      if (!target || target.summary) return;
      const result = hooks.act([{ op: "scene.set", id: target.id, set: { summary: newClaim(target) } }]);
      hooks.problem(result.ok ? undefined : problemOf(result));
    },
    add: (slot, kind, file) => put(kind, file, slot),
    quick: (kind, file) => put(kind, file),
    into: (slot, kind, file) =>
      isNewBlockKind(kind) ? put(kind, file, undefined, slot) : put("text", file, undefined, slot, kind),
  };
}
