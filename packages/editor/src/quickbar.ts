import type { Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { popoverChip } from "./chip.ts";
import { actionButton, type Edits, fileButton } from "./fields.ts";
import { notesPanel, panelHost } from "./panels.ts";
import { BLOCK_KINDS, IMAGE_ACCEPT, type NewBlockKind } from "./templates.ts";

export interface QuickBarHooks {
  /** How the notes change the deck: `type` for a keystroke. */
  edits: Edits;
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
  /** Adds a block of a kind where the chosen block is, or in the first free area. An image comes with its file. */
  add(kind: NewBlockKind, file?: File): void;
  /** Gives the slide a claim. */
  claim(): void;
  /** Whether the deck has a video a clip could play. */
  hasVideo(): boolean;
  /** The Build order button was pressed: show the badges on the slide, or put them away. */
  build?(on: boolean): void;
}

export interface QuickBar {
  readonly element: HTMLElement;
  /** Brings the bar up to date with the scene being edited. `typing` is true while a keystroke in the notes is applied. */
  render(sceneId: string, typing?: boolean): void;
  destroy(): void;
}

/** The order the bar lists the kinds in. A kind that is not here comes last, so a new one still gets a button. */
const ORDER: readonly NewBlockKind[] = ["text", "bar-chart", "image", "clip"];
const rank = (kind: NewBlockKind) => {
  const at = ORDER.indexOf(kind);
  return at < 0 ? ORDER.length : at;
};

/**
 * The bar that floats at the foot of the stage: a block of each kind, or the claim, and the scene's notes. Where a new
 * block goes is the adder's business, so the bar and the empty places on the slide agree.
 */
export function createQuickBar(session: Session, hooks: QuickBarHooks): QuickBar {
  let current = session.doc.deck.scenes[0] as string;
  const scene = () => session.doc.scenes[current];

  const clip = actionButton("Clip", () => hooks.add("clip"), { "data-quick": "clip" });
  const claim = actionButton("Claim", () => hooks.claim(), { "data-quick": "claim" });

  const adders = [...BLOCK_KINDS]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(({ kind, label }) => {
      if (kind === "clip") return clip;
      if (kind === "image") {
        return fileButton(label, IMAGE_ACCEPT, "quick:image", (file) => hooks.add("image", file));
      }
      return actionButton(kind === "bar-chart" ? "Chart" : label, () => hooks.add(kind), {
        "data-quick": kind,
      });
    });

  const host = panelHost(session, {
    edits: hooks.edits,
    upload: hooks.upload,
    problem: hooks.problem,
    close: () => notes.close(),
    openSources: () => {},
  });
  const panel = notesPanel(host, () => current);
  // The bar sits at the foot of the stage, so the notes open upward over it, a little way in from the window's edge.
  const notes = popoverChip(panel, true, 8);

  // Build order is a view of the slide and not an addition to it, so it sits apart from the row of things to add.
  const order = actionButton(
    "Build order",
    () => {
      const on = order.getAttribute("aria-pressed") !== "true";
      order.setAttribute("aria-pressed", String(on));
      hooks.build?.(on);
    },
    { "data-quick": "build", "aria-pressed": "false", class: "ed-quick-build" },
  );

  const element = h(
    "div",
    { class: "ed-quick", role: "group", "aria-label": "Add to this slide" },
    ...adders,
    claim,
    h("span", { class: "ed-quick-rule", "aria-hidden": "true" }),
    notes.chip.wrap,
    order,
  );

  return {
    element,
    destroy: notes.destroy,
    render(sceneId, typing = false) {
      current = sceneId;
      const live = scene();
      if (!live) return;
      notes.fill(live, typing);
      const hasVideo = hooks.hasVideo();
      clip.disabled = !hasVideo;
      clip.title = hasVideo ? "" : "Put an .mp4 or .webm file in the deck's assets folder first.";
      claim.disabled = live.summary !== undefined;
      claim.title = live.summary ? "This scene already has a claim." : "";
    },
  };
}
