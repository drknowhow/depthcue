import { type Scene, type SlotName, slotsOf } from "@depthcue/core";
import { h } from "@depthcue/player";
import { actionButton, fileButton } from "./fields.ts";
import { REGION_SLOT } from "./slotdrag.ts";
import { BLOCK_KINDS, IMAGE_ACCEPT, isNewBlockKind, type NewBlockKind } from "./templates.ts";

export interface GhostHooks {
  /** Adds a block of `kind` to an area of the slide. An image comes with the file to upload. */
  add(slot: SlotName, kind: NewBlockKind, file?: File): void;
  /** Gives the slide a claim. */
  claim(): void;
  /** Whether the deck has a video a clip could play. */
  hasVideo(): boolean;
}

/** What the ghost of each area says. A `Record` over the core's names, so a new area does not compile without one. */
const GHOST_LABEL: Record<SlotName, string> = {
  stack: "Add to the slide",
  claim: "Add the claim",
  evidence: "Add evidence",
  support: "Add support",
  text: "Add text",
  media: "Add media",
};

const KIND_LABEL: Record<NewBlockKind, string> = Object.fromEntries(
  BLOCK_KINDS.map(({ kind, label }) => [kind, kind === "bar-chart" ? "Chart" : label]),
) as Record<NewBlockKind, string>;

const regionClass = (slot: SlotName) =>
  Object.entries(REGION_SLOT).find(([, name]) => name === slot)?.[0] as string;

/**
 * The area of the slide for `slot`. The player leaves out an area that holds nothing and, for media, does not draw it
 * at all, so an empty one is made here. The layout's own style then lays it out as it will look with a block in it.
 */
function regionFor(slot: SlotName, view: HTMLElement): HTMLElement | undefined {
  const found = view.querySelector<HTMLElement>(`.${regionClass(slot)}`);
  if (found) return found;
  const scene = view.querySelector<HTMLElement>(".dc-scene");
  if (!scene) return undefined;
  const region = h("div", { class: `dc-region ${regionClass(slot)}` });
  const sources = scene.querySelector(".dc-sources");
  if (sources) sources.before(region);
  else scene.append(region);
  return region;
}

function ghost(slot: SlotName, kinds: readonly NewBlockKind[], hooks: GhostHooks): HTMLElement {
  const label = GHOST_LABEL[slot];
  const root = h("div", { class: "ed-ghost", role: "group", "aria-label": label, "data-ghost": slot });
  const open = h("button", { type: "button", class: "ed-ghost-open" }, `+ ${label}`);
  root.append(open);

  if (slot === "claim") {
    open.addEventListener("click", () => hooks.claim());
    return root;
  }
  const only = kinds.length === 1 ? kinds[0] : undefined;
  if (only !== undefined && only !== "image") {
    open.addEventListener("click", () => hooks.add(slot, only));
    return root;
  }

  const choice = (kind: NewBlockKind): HTMLElement => {
    if (kind === "image") {
      return fileButton(KIND_LABEL.image, IMAGE_ACCEPT, `ghost:${slot}:image`, (file) =>
        hooks.add(slot, "image", file),
      );
    }
    const video = kind !== "clip" || hooks.hasVideo();
    return actionButton(KIND_LABEL[kind], () => hooks.add(slot, kind), {
      class: "ed-ghost-choice",
      "data-ghost-kind": kind,
      disabled: !video,
      title: video ? undefined : "Put an .mp4 or .webm file in the deck's assets folder first.",
    });
  };
  const menu = h("div", { class: "ed-ghost-menu", role: "group", "aria-label": `${label}: what kind` });
  menu.append(...kinds.map(choice));
  menu.hidden = true;
  root.append(menu);

  const toggle = (show: boolean) => {
    menu.hidden = !show;
    open.setAttribute("aria-expanded", String(show));
  };
  open.setAttribute("aria-expanded", "false");
  open.addEventListener("click", () => toggle(menu.hidden !== false));
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hidden) return;
    event.stopPropagation();
    toggle(false);
    open.focus();
  });
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) toggle(false);
  });
  return root;
}

/**
 * Draws a place for each area of the slide that holds nothing yet, so there is somewhere to add to and, with a block
 * dragged over it, somewhere to drop. The claim's place stands where the claim will go while the slide has none.
 * These are for the editor only: the player and the export never draw them.
 */
export function drawGhosts(scene: Scene, view: HTMLElement, hooks: GhostHooks): void {
  for (const slot of slotsOf(scene)) {
    const claim = slot.name === "claim";
    const empty = slot.blocks.length === 0 && slot.accepts.length > 0;
    // Evidence is what a claim cites, so there is nowhere to put it before there is a claim.
    const wanted = claim
      ? !scene.summary
      : empty && (slot.name !== "evidence" || scene.summary !== undefined);
    if (!wanted) continue;
    const region = regionFor(slot.name, view);
    region?.append(ghost(slot.name, slot.accepts.filter(isNewBlockKind), hooks));
  }
}
