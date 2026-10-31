import {
  type ApplyResult,
  type Op,
  type Placement,
  placeBlock,
  type Scene,
  type Session,
  type SlotName,
  slotOf,
  slotsOf,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { problemOf } from "./fields.ts";

/**
 * The class the player gives each area of a layout, and the slot it is. A hand list of the renderer's names: a name
 * missing here means a drop on that area does nothing, and `slotdrag.test.ts` fails by naming this list when the
 * player draws an area it does not have.
 */
export const REGION_SLOT: Readonly<Record<string, SlotName>> = {
  "dc-stack": "stack",
  "dc-claim-region": "claim",
  "dc-evidence-region": "evidence",
  "dc-support-region": "support",
  "dc-text-region": "text",
  "dc-media-region": "media",
};

/** The drag carries this and nothing else, so a browser has no text to drop into a field that can be typed in. */
const BLOCK_TYPE = "application/x-depthcue-block";

/** Where a drop would land, drawn on the node it would land on. */
export type Landing = "before" | "after" | "swap" | "into" | "refused";

export interface SlotDragHooks {
  /** A grip was taken hold of: choose the block it belongs to. */
  select(id: string): void;
  /** A line about the drop, or "" to clear it. `problem` marks a refused one. */
  hint(text: string, problem: boolean): void;
  /** Applies what a drop decided, as one undo step. */
  act(ops: readonly Op[]): ApplyResult;
}

export interface SlotDrag {
  /** Draws a grip for each block of the scene, in place of the last ones. With no scene, draws none. */
  draw(scene: Scene | undefined): void;
  /** Puts each grip against its block again, after the slide changed size or its text grew. */
  place(): void;
  /** Marks the grip of the chosen block. */
  mark(id: string | undefined): void;
  destroy(): void;
}

const GRIP = "⠿";
const GAP = 6;

/**
 * A grip beside each block of the slide. Dragging it onto another block of the same area puts the block before or
 * after it; onto a block of another area, the two swap; onto the empty part of an area, it moves there. All of it is
 * `placeBlock` from the core, which says what a drop would do and why one is refused, so the slide only shows that
 * answer while the pointer is over a place. The grips live in the overlay, not in the blocks: a block's own text is
 * what a person edits, and a grip inside it would be part of that text.
 */
export function createSlotDrag(
  session: Session,
  host: HTMLElement,
  overlay: HTMLElement,
  nodeOf: (id: string) => HTMLElement | undefined,
  hooks: SlotDragHooks,
): SlotDrag {
  const layer = h("div", { class: "ed-grips" });
  let sceneId: string | undefined;
  let dragging: string | undefined;
  let marked: Element | undefined;
  let frame: number | undefined;

  const scene = () => (sceneId === undefined ? undefined : session.doc.scenes[sceneId]);

  const clear = () => {
    for (const node of host.querySelectorAll("[data-place], [data-dragging]")) {
      node.removeAttribute("data-place");
      node.removeAttribute("data-dragging");
    }
    layer.removeAttribute("data-dragging");
  };

  /** The block a pointer is over: the block itself, or the grip that stands for it. */
  const blockUnder = (target: EventTarget | null): string | undefined => {
    if (!(target instanceof Element)) return undefined;
    const grip = target.closest<HTMLElement>("[data-grip]");
    if (grip) return grip.dataset.grip;
    return target.closest<HTMLElement>(".dc-block")?.dataset.id;
  };

  const regionUnder = (target: EventTarget | null): { node: HTMLElement; slot: SlotName } | undefined => {
    if (!(target instanceof Element)) return undefined;
    const node = target.closest<HTMLElement>(".dc-region");
    const slot = node && Object.entries(REGION_SLOT).find(([name]) => node.classList.contains(name))?.[1];
    return node && slot ? { node, slot } : undefined;
  };

  interface Drop {
    node: HTMLElement;
    placement: Placement;
    landing: Landing;
  }

  /** What dropping here would ask for, or undefined over a place that is neither a block nor an area. */
  function dropAt(event: DragEvent): Drop | undefined {
    const current = scene();
    if (!current || dragging === undefined) return undefined;
    const overId = blockUnder(event.target);
    if (overId !== undefined) {
      const node = nodeOf(overId);
      if (!node || overId === dragging) return undefined;
      const from = slotOf(current, dragging);
      const there = slotOf(current, overId);
      if (from === undefined || there === undefined) return undefined;
      if (from !== there) return { node, placement: { swap: overId }, landing: "swap" };
      const box = node.getBoundingClientRect();
      const half = event.clientY < box.top + box.height / 2 ? "upper" : "lower";
      // The core works out whether that is a move at all: dropping next to where the block already is changes nothing.
      const siblings = (slotsOf(current).find((slot) => slot.name === from)?.blocks ?? []).filter(
        (id) => id !== dragging,
      );
      const after = half === "upper" ? (siblings[siblings.indexOf(overId) - 1] ?? null) : overId;
      return { node, placement: { slot: from, after }, landing: half === "upper" ? "before" : "after" };
    }
    const region = regionUnder(event.target);
    if (!region || region.slot === slotOf(current, dragging)) return undefined;
    return { node: region.node, placement: { slot: region.slot }, landing: "into" };
  }

  /** The drop, asked of the core: what it would do, or why not. Nothing when there is nothing to do. */
  function judged(drop: Drop) {
    const current = scene();
    return current && dragging !== undefined ? placeBlock(current, dragging, drop.placement) : undefined;
  }

  function over(event: DragEvent) {
    if (dragging === undefined || !event.dataTransfer?.types.includes(BLOCK_TYPE)) return;
    for (const node of host.querySelectorAll("[data-place]")) node.removeAttribute("data-place");
    const drop = dropAt(event);
    const placed = drop && judged(drop);
    if (!drop || !placed) {
      hooks.hint("", false);
      return;
    }
    if (!placed.ok) {
      drop.node.dataset.place = "refused";
      hooks.hint(placed.message, true);
      event.dataTransfer.dropEffect = "none";
      return;
    }
    hooks.hint("", false);
    if (placed.ops.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    drop.node.dataset.place = drop.landing;
  }

  function dropped(event: DragEvent) {
    if (dragging === undefined || !event.dataTransfer?.types.includes(BLOCK_TYPE)) return;
    // Never the browser's own drop: it would put the dragged thing's text into a field.
    event.preventDefault();
    const drop = dropAt(event);
    const placed = drop && judged(drop);
    dragging = undefined;
    clear();
    hooks.hint("", false);
    if (!placed?.ok || placed.ops.length === 0) return;
    const result = hooks.act(placed.ops);
    if (!result.ok) hooks.hint(problemOf(result), true);
  }

  // A browser sends dragenter when the pointer reaches a new element, and dragover only with its next movement.
  host.addEventListener("dragenter", over);
  host.addEventListener("dragover", over);
  host.addEventListener("drop", dropped);
  host.addEventListener("dragleave", (event) => {
    if (dragging === undefined || host.contains(event.relatedTarget as Node | null)) return;
    for (const node of host.querySelectorAll("[data-place]")) node.removeAttribute("data-place");
    hooks.hint("", false);
  });

  function grip(id: string): HTMLElement {
    const node = h(
      "span",
      { class: "ed-grip", draggable: "true", "data-grip": id, title: "Drag to move", "aria-hidden": "true" },
      GRIP,
    );
    node.addEventListener("dragstart", (event) => {
      const block = nodeOf(id);
      if (!event.dataTransfer || !block) return;
      dragging = id;
      hooks.select(id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(BLOCK_TYPE, id);
      const box = block.getBoundingClientRect();
      event.dataTransfer.setDragImage(block, event.clientX - box.left, event.clientY - box.top);
      block.dataset.dragging = "";
      layer.dataset.dragging = "";
    });
    node.addEventListener("dragend", () => {
      dragging = undefined;
      clear();
      hooks.hint("", false);
    });
    return node;
  }

  function place() {
    const origin = host.getBoundingClientRect();
    for (const node of layer.querySelectorAll<HTMLElement>("[data-grip]")) {
      const block = nodeOf(node.dataset.grip ?? "");
      if (!block) {
        node.hidden = true;
        continue;
      }
      node.hidden = false;
      const box = block.getBoundingClientRect();
      const room = box.left - origin.left - node.offsetWidth;
      // Beside the block or not at all: on a narrow slide a grip would cover the corner of the block it is for.
      if (room < 0) {
        node.hidden = true;
        continue;
      }
      node.style.left = `${room - Math.min(GAP, room)}px`;
      node.style.top = `${box.top - origin.top}px`;
    }
  }

  const soon = () => {
    if (frame === undefined) {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        place();
      });
    }
  };
  // The slide scales with the room it has, so a resized window or an opened panel moves every block.
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
  resized?.observe(host);

  // Under the toolbar, which is added to the overlay after this.
  overlay.prepend(layer);

  return {
    draw(next) {
      sceneId = next?.id;
      dragging = undefined;
      clear();
      marked = undefined;
      layer.replaceChildren(...(next?.blocks ?? []).map((block) => grip(block.id)));
      place();
    },
    place,
    mark(id) {
      marked?.removeAttribute("data-chosen");
      marked = id === undefined ? undefined : (layer.querySelector(`[data-grip="${id}"]`) ?? undefined);
      marked?.setAttribute("data-chosen", "");
    },
    destroy() {
      resized?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      layer.remove();
    },
  };
}
