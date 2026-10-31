import { type ApplyResult, addBlock, type Op, type Session, type SlotName } from "@depthcue/core";
import { problemOf } from "./fields.ts";
import { type NewBlockKind, newBlock, newClaim, VIDEO_FILE } from "./templates.ts";

export interface AdderHooks {
  /** The scene being edited. */
  scene(): string;
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
  /** Gives the slide a claim to fill in. */
  claim(): void;
  /** Whether the deck has a video a clip could play. */
  hasVideo(): boolean;
}

/**
 * Adds to a chosen area of the slide, where the add row under the slide adds after the chosen block. The core
 * decides where the block lands and whether the area takes it, so an empty area drawn on the slide and an agent's
 * `block.add` agree.
 */
export function createAdder(session: Session, hooks: AdderHooks): Adder {
  const firstVideo = () => [...session.doc.assets].sort().find((path) => VIDEO_FILE.test(path));

  return {
    hasVideo: () => firstVideo() !== undefined,
    claim() {
      const target = session.doc.scenes[hooks.scene()];
      if (!target || target.summary) return;
      const result = hooks.act([{ op: "scene.set", id: target.id, set: { summary: newClaim(target) } }]);
      hooks.problem(result.ok ? undefined : problemOf(result));
    },
    async add(slot, kind, file) {
      hooks.problem(undefined);
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
      const block = newBlock(target, kind, asset);
      const placed = addBlock(target, slot, block);
      if (!placed.ok) {
        hooks.problem(placed.message);
        return;
      }
      const result = hooks.act(placed.ops);
      hooks.problem(result.ok ? undefined : problemOf(result));
      if (result.ok) hooks.added(block.id);
    },
  };
}
