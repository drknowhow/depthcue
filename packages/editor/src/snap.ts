/** How long a block takes to slide into its slot, or out of it. */
const SNAP_MS = 220;
/** A move shorter than this is the rounding of a frame, and is not worth showing. */
const SNAP_MIN = 2;

/** The slide each block is on, so its resting box can be told from the box it has on the way. */
const sliding = new WeakMap<Element, Animation>();

/** Where a block stood on the screen, and whether it was pinned. */
export interface Stand {
  pinned: boolean;
  left: number;
  top: number;
}

/** Where each block of the slide stands now. Read before the slide is drawn again, while the old blocks are there. */
export function standings(root: ParentNode): Map<string, Stand> {
  const found = new Map<string, Stand>();
  for (const node of root.querySelectorAll<HTMLElement>(".dc-block[data-id]")) {
    const box = node.getBoundingClientRect();
    found.set(node.dataset.id as string, {
      pinned: node.classList.contains("dc-pinned"),
      left: box.left,
      top: box.top,
    });
  }
  return found;
}

/**
 * Slides each block that went into its slot, or came out of it, from where it stood to where it is now. A block that
 * is as pinned as it was, or that moved by a hair, stays still. Nothing moves for a person who asks for less motion,
 * or in a browser that cannot animate.
 */
export function snap(root: ParentNode, before: ReadonlyMap<string, Stand>): void {
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const node of root.querySelectorAll<HTMLElement>(".dc-block[data-id]")) {
    const was = before.get(node.dataset.id as string);
    if (!was || was.pinned === node.classList.contains("dc-pinned") || typeof node.animate !== "function")
      continue;
    const box = node.getBoundingClientRect();
    const dx = was.left - box.left;
    const dy = was.top - box.top;
    if (Math.abs(dx) < SNAP_MIN && Math.abs(dy) < SNAP_MIN) continue;
    const slide = node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: SNAP_MS,
      easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
    });
    if (slide) sliding.set(node, slide);
  }
}

/**
 * The box of a block where it rests, which is where it is once it has slid there. The toolbar and the pin measure
 * this, because the box a block has on the screen while it slides is only wherever the slide has got to.
 */
export function restingBox(node: HTMLElement): DOMRect {
  const slide = sliding.get(node);
  if (slide?.playState !== "running") return node.getBoundingClientRect();
  const at = slide.currentTime;
  slide.currentTime = SNAP_MS;
  const box = node.getBoundingClientRect();
  slide.currentTime = at;
  return box;
}
