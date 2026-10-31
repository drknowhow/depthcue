import {
  type ApplyResult,
  addBlock,
  type Op,
  type Scene,
  type Session,
  type SlotName,
  slotsOf,
} from "@depthcue/core";
import { problemOf } from "./fields.ts";
import { type NewBlockKind, newBlock, newClaim, VIDEO_FILE } from "./templates.ts";

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

export interface Adder {
  /** Adds a block of `kind` to an area of the slide. An image takes the file to upload. */
  add(slot: SlotName, kind: NewBlockKind, file?: File): Promise<void>;
  /** Adds a block of `kind` where a person pointing at the slide would expect it: see `slotFor`. */
  quick(kind: NewBlockKind, file?: File): Promise<void>;
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
export function slotFor(scene: Scene, kind: NewBlockKind, anchor?: string): SlotName | undefined {
  const open = slotsOf(scene).filter(
    (slot) => slot.accepts.includes(kind) && (slot.name !== "evidence" || scene.summary !== undefined),
  );
  const near = anchor === undefined ? undefined : open.find((slot) => slot.blocks.includes(anchor));
  return (near ?? open.find((slot) => slot.blocks.length === 0) ?? open[0])?.name;
}

/**
 * Adds to a chosen area of the slide, or, for the quick bar, to the area `slotFor` picks. The core decides where the
 * block lands and whether the area takes it, so an empty area drawn on the slide, the quick bar and an agent's
 * `block.add` agree.
 */
export function createAdder(session: Session, hooks: AdderHooks): Adder {
  const firstVideo = () => [...session.doc.assets].sort().find((path) => VIDEO_FILE.test(path));

  async function put(kind: NewBlockKind, file: File | undefined, slot?: SlotName) {
    hooks.problem(undefined);
    // Read now: the person may choose something else while a file is on its way.
    const anchor = slot === undefined ? hooks.block() : undefined;
    let asset: string | undefined;
    if (kind === "image") {
      if (!file) return;
      try {
        asset = await hooks.upload(file);
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
    const into = slot ?? slotFor(target, kind, anchor);
    if (into === undefined) {
      hooks.problem("This slide has no place for that.");
      return;
    }
    const block = newBlock(target, kind, asset);
    const placed = addBlock(target, into, block, anchor);
    if (!placed.ok) {
      hooks.problem(placed.message);
      return;
    }
    const result = hooks.act(placed.ops);
    hooks.problem(result.ok ? undefined : problemOf(result));
    if (result.ok) hooks.added(block.id);
  }

  return {
    hasVideo: () => firstVideo() !== undefined,
    claim() {
      const target = session.doc.scenes[hooks.scene()];
      if (!target || target.summary) return;
      const result = hooks.act([{ op: "scene.set", id: target.id, set: { summary: newClaim(target) } }]);
      hooks.problem(result.ok ? undefined : problemOf(result));
    },
    add: (slot, kind, file) => put(kind, file, slot),
    quick: (kind, file) => put(kind, file),
  };
}
