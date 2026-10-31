import type { Op, Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { popoverChip } from "./chip.ts";
import { actionButton, type Edits, fileButton, problemOf } from "./fields.ts";
import { notesPanel, panelHost } from "./panels.ts";
import {
  BLOCK_KINDS,
  IMAGE_ACCEPT,
  idsInScene,
  type NewBlockKind,
  newBlock,
  uniqueId,
  VIDEO_FILE,
} from "./templates.ts";

export interface QuickBarHooks {
  /** How the bar changes the deck: `act` for a click, `type` for a keystroke in the notes. */
  edits: Edits;
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
  /** The chosen block of the scene, if any. A new block goes after it. */
  block(): string | undefined;
  /** A block was added: choose it. */
  added(id: string): void;
}

export interface QuickBar {
  readonly element: HTMLElement;
  /** Brings the bar up to date with the scene being edited. `typing` is true while a keystroke in the notes is applied. */
  render(sceneId: string, typing?: boolean): void;
  destroy(): void;
}

/**
 * The row under the slide that adds to it: a block of each kind, or the claim, and the scene's notes. A new block
 * goes after the chosen one, or at the end, and is chosen so its toolbar is right there.
 */
export function createQuickBar(session: Session, hooks: QuickBarHooks): QuickBar {
  let current = session.doc.deck.scenes[0] as string;
  const scene = () => session.doc.scenes[current];

  const run = (ops: readonly Op[]) => {
    const result = hooks.edits.act(ops);
    hooks.problem(result.ok ? undefined : problemOf(result));
    return result.ok;
  };

  function add(kind: NewBlockKind, asset?: string) {
    const target = scene();
    if (!target) return;
    const block = newBlock(target, kind, asset);
    const anchor = hooks.block();
    const after =
      anchor !== undefined && target.blocks.some((candidate) => candidate.id === anchor) ? anchor : undefined;
    if (run([{ op: "block.add", scene: current, block, ...(after === undefined ? {} : { after }) }])) {
      hooks.added(block.id);
    }
  }

  async function addImage(file: File) {
    hooks.problem(undefined);
    try {
      add("image", await hooks.upload(file));
    } catch (error) {
      hooks.problem(error instanceof Error ? error.message : "The upload failed.");
    }
  }

  const clip = actionButton(
    "Clip",
    () => {
      const first = [...session.doc.assets].sort().find((path) => VIDEO_FILE.test(path));
      if (first) add("clip", first);
    },
    { "data-quick": "clip" },
  );
  const claim = actionButton(
    "Claim",
    () => {
      const target = scene();
      if (!target || target.summary) return;
      run([
        {
          op: "scene.set",
          id: current,
          set: {
            summary: {
              id: uniqueId(`${target.id}-claim`, idsInScene(target)),
              text: "State the claim here.",
              evidenceIds: [],
            },
          },
        },
      ]);
    },
    { "data-quick": "claim" },
  );

  const adders = BLOCK_KINDS.map(({ kind, label }) => {
    if (kind === "clip") return clip;
    if (kind === "image") {
      return fileButton(label, IMAGE_ACCEPT, "quick:image", (file) => void addImage(file));
    }
    return actionButton(kind === "bar-chart" ? "Chart" : label, () => add(kind), { "data-quick": kind });
  });

  const host = panelHost(session, {
    edits: hooks.edits,
    upload: hooks.upload,
    problem: hooks.problem,
    close: () => notes.close(),
    openSources: () => {},
  });
  const panel = notesPanel(host, () => current);
  // The bar sits under the slide, so the notes open upward over it.
  const notes = popoverChip(panel, true);

  const element = h(
    "div",
    { class: "ed-quick", role: "group", "aria-label": "Add to this slide" },
    h("span", { class: "ed-quick-label" }, "Add"),
    ...adders,
    claim,
    notes.chip.wrap,
  );

  return {
    element,
    destroy: notes.destroy,
    render(sceneId, typing = false) {
      current = sceneId;
      const live = scene();
      if (!live) return;
      notes.fill(live, typing);
      const hasVideo = [...session.doc.assets].some((path) => VIDEO_FILE.test(path));
      clip.disabled = !hasVideo;
      clip.title = hasVideo ? "" : "Put an .mp4 or .webm file in the deck's assets folder first.";
      claim.disabled = live.summary !== undefined;
      claim.title = live.summary ? "This scene already has a claim." : "";
    },
  };
}
