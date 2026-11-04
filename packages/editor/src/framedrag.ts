import type { ApplyResult, Frame, Op, Scene, Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { problemOf } from "./fields.ts";
import {
  CORNERS,
  type Corner,
  frameOver,
  type Guide,
  keepShape,
  nudged,
  type Rect,
  resized,
  type Snapped,
  snapMove,
  snapResize,
  targetsOf,
} from "./pin.ts";

/** A press moves nothing until the pointer has gone this far, in pixels, so a click stays a click. */
export const DRAG_THRESHOLD = 3;

/** The side of a corner handle, in pixels. */
const HANDLE = 10;

/** A press on one of these belongs to it: a caret, a slider, a button, a link or a player's own controls. */
const KEEPS_PRESS = "[data-edit], [data-slider], input, textarea, select, button, a, video";

export interface FrameDragHooks {
  /** A block was pressed or its grip taken: choose it. */
  select(id: string): void;
  /** A line about the gesture, or "" to clear it. */
  hint(text: string, problem: boolean): void;
  /** Applies what a gesture decided, as one undo step. */
  act(ops: readonly Op[]): ApplyResult;
  /** A pinned block moved or changed size under the pointer, so whatever sits against it should follow. */
  changed(): void;
}

export interface FrameDrag {
  /** Takes up a scene, in place of the last one. With no scene, nothing is chosen or drawn. */
  draw(scene: Scene | undefined): void;
  /** Puts the corner handles against the chosen block again, after the slide changed size or its text grew. */
  place(): void;
  /** The block whose corners get handles. */
  mark(id: string | undefined): void;
  destroy(): void;
}

interface Gesture {
  kind: "move" | "resize";
  id: string;
  sceneId: string;
  corner: Corner | undefined;
  /** The frame the block had when the press began, and the one it has now. */
  start: Frame;
  frame: Frame;
  x: number;
  y: number;
  slide: Rect;
  others: Frame[];
  /** True once the pointer has gone far enough for this to be a drag and not a click. */
  live: boolean;
}

const sameFrame = (a: Frame, b: Frame) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

const paint = (node: HTMLElement, frame: Frame) => {
  for (const key of ["x", "y", "w", "h"] as const) node.style.setProperty(`--${key}`, String(frame[key]));
};

/**
 * Moving and resizing a pinned block on the slide. A press on the block, or on its grip, moves it, and the four corner
 * handles of the chosen block resize it from the opposite corner. While the pointer is down the block is only drawn at
 * its new place, with guide lines where it has snapped to something; one `block.frame` goes to the session when the
 * pointer is let go, so a whole drag is one undo step, and Escape puts the block back. Alt turns snapping off. A
 * picture keeps its shape as its corner moves, and Shift frees it.
 */
export function createFrameDrag(
  session: Session,
  host: HTMLElement,
  overlay: HTMLElement,
  nodeOf: (id: string) => HTMLElement | undefined,
  hooks: FrameDragHooks,
): FrameDrag {
  const handles = h(
    "div",
    { class: "ed-handles", hidden: "" },
    ...CORNERS.map((corner) =>
      h("span", {
        class: "ed-handle",
        "data-handle": corner,
        title: "Drag to resize",
        "aria-hidden": "true",
      }),
    ),
  );
  const guides = h("div", { class: "ed-guides", "aria-hidden": "true" });
  let sceneId: string | undefined;
  let chosen: string | undefined;
  let gesture: Gesture | undefined;

  const scene = () => (sceneId === undefined ? undefined : session.doc.scenes[sceneId]);
  const pinned = (id: string | undefined) => scene()?.blocks.find((block) => block.id === id)?.frame;

  /**
   * The 16 by 9 slide that pinned blocks sit on, or nothing when they do not: a narrow slide lets them flow, and then
   * a frame means nothing on screen.
   */
  function slideRect(): Rect | undefined {
    const box = host.querySelector<HTMLElement>(".dc-pins")?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return undefined;
    return Math.abs(box.width / box.height - 16 / 9) < 0.02 ? box : undefined;
  }

  function place() {
    const node = chosen === undefined ? undefined : nodeOf(chosen);
    const box = node?.getBoundingClientRect();
    const show =
      pinned(chosen) !== undefined && box !== undefined && box.width > 0 && slideRect() !== undefined;
    handles.hidden = !show;
    if (!show || !box) return;
    const origin = host.getBoundingClientRect();
    for (const handle of handles.querySelectorAll<HTMLElement>("[data-handle]")) {
      const corner = handle.dataset.handle as Corner;
      const left = corner.endsWith("w") ? box.left : box.left + box.width;
      const top = corner.startsWith("n") ? box.top : box.top + box.height;
      handle.style.left = `${left - origin.left - HANDLE / 2}px`;
      handle.style.top = `${top - origin.top - HANDLE / 2}px`;
    }
  }

  function drawGuides(lines: readonly Guide[], slide: Rect) {
    const origin = host.getBoundingClientRect();
    guides.replaceChildren(
      ...lines.map((line) => {
        const node = h("span", { class: "ed-guide", "data-axis": line.axis });
        const across = line.axis === "x";
        node.style.left = `${slide.left - origin.left + (across ? (line.at / 100) * slide.width : 0)}px`;
        node.style.top = `${slide.top - origin.top + (across ? 0 : (line.at / 100) * slide.height)}px`;
        node.style[across ? "height" : "width"] = `${across ? slide.height : slide.width}px`;
        return node;
      }),
    );
  }

  /** The frames the moving block can line up with: every other block of the scene, and its claim. */
  function othersOf(id: string, slide: Rect): Frame[] {
    const current = scene();
    if (!current) return [];
    const ids = [
      ...current.blocks.map((block) => block.id),
      ...(current.summary ? [current.summary.id] : []),
    ];
    const frames: Frame[] = [];
    for (const other of ids) {
      if (other === id) continue;
      const node = nodeOf(other);
      const frame = pinned(other) ?? (node && frameOver(node.getBoundingClientRect(), slide));
      if (frame) frames.push(frame);
    }
    return frames;
  }

  function move(event: PointerEvent) {
    const g = gesture;
    if (!g) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;
    if (!g.live) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.live = true;
      host.dataset.framing = "";
      getSelection()?.removeAllRanges();
    }
    const px = (dx / g.slide.width) * 100;
    const py = (dy / g.slide.height) * 100;
    const targets = targetsOf(g.others);
    let result: Snapped;
    if (g.kind === "move") {
      const moved = nudged(g.start, px, py);
      result = event.altKey ? { frame: moved, guides: [] } : snapMove(moved, targets);
    } else {
      const corner = g.corner as Corner;
      // A picture keeps its shape unless Shift is held, as it would be distorted otherwise.
      const keeps = !event.shiftKey && scene()?.blocks.find((block) => block.id === g.id)?.type === "image";
      result = keeps
        ? { frame: keepShape(g.start, resized(g.start, corner, px, py), corner), guides: [] }
        : event.altKey
          ? { frame: resized(g.start, corner, px, py), guides: [] }
          : snapResize(g.start, corner, px, py, targets);
    }
    g.frame = result.frame;
    const node = nodeOf(g.id);
    if (node) paint(node, result.frame);
    drawGuides(result.guides, g.slide);
    hooks.changed();
  }

  /** The click that ends a drag lands wherever the pointer is, which may be off the block, and would let go of it. */
  function swallowClick() {
    const stop = (event: Event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener("click", stop, { capture: true, once: true });
    // A drag that ends in no click at all leaves the listener behind, which would eat the next real one.
    setTimeout(() => window.removeEventListener("click", stop, true), 0);
  }

  function finish(commit: boolean) {
    const g = gesture;
    if (!g) return;
    gesture = undefined;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    host.removeAttribute("data-framing");
    guides.replaceChildren();
    if (!g.live) return;
    swallowClick();
    const node = nodeOf(g.id);
    if (commit && !sameFrame(g.frame, g.start)) {
      const result = hooks.act([{ op: "block.frame", scene: g.sceneId, id: g.id, frame: g.frame }]);
      if (result.ok) return;
      hooks.hint(problemOf(result), true);
    }
    if (node) paint(node, g.start);
    hooks.changed();
  }

  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    // A drag in progress is what Escape is for: it must not also let go of the block.
    if (gesture?.live) {
      event.preventDefault();
      event.stopPropagation();
    }
    finish(false);
  }

  function begin(event: PointerEvent, id: string | undefined, kind: Gesture["kind"], corner?: Corner) {
    const current = scene();
    const start = pinned(id);
    const slide = slideRect();
    if (!current || id === undefined || !start || !slide) return;
    hooks.select(id);
    gesture = {
      kind,
      id,
      sceneId: current.id,
      corner,
      start,
      frame: start,
      x: event.clientX,
      y: event.clientY,
      slide,
      others: othersOf(id, slide),
      live: false,
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  host.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || gesture || !(event.target instanceof Element)) return;
    const target = event.target;
    const handle = target.closest<HTMLElement>("[data-handle]");
    if (handle) {
      begin(event, chosen, "resize", handle.dataset.handle as Corner);
      return;
    }
    const grip = target.closest<HTMLElement>("[data-grip][data-pinned]");
    if (grip) {
      begin(event, grip.dataset.grip, "move");
      return;
    }
    const node = target.closest<HTMLElement>(".dc-pinned");
    if (node && !target.closest(KEEPS_PRESS)) begin(event, node.dataset.id, "move");
  });

  // A picture or a text selection would otherwise start a drag of the browser's own, which ends the pointer events.
  host.addEventListener("dragstart", (event) => {
    const target =
      event.target instanceof Element ? event.target : (event.target as Node | null)?.parentElement;
    if (target?.closest(".dc-pinned") && !target.closest("[data-edit]")) event.preventDefault();
  });

  // Under the toolbar, which is added to the overlay after this.
  overlay.prepend(guides, handles);

  return {
    draw(next) {
      finish(false);
      sceneId = next?.id;
      guides.replaceChildren();
      place();
    },
    place,
    mark(id) {
      chosen = id;
      place();
    },
    destroy() {
      finish(false);
      guides.remove();
      handles.remove();
    },
  };
}
