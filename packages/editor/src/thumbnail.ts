import type { Scene } from "@depthcue/core";
import { h, renderScene } from "@depthcue/player";

/** A thumbnail draws the real slide at this width and scales it down, so it shows the true layout. editor.css sets the same size. */
const STAGE_WIDTH = 1280;
/** How many thumbnails are drawn before the browser gets to paint, so a long deck never blocks a frame. */
const DRAWN_PER_FRAME = 2;

/** What a thumbnail was last drawn from. A different scene object, or theme, means it is out of date. */
export interface Drawn {
  scene: Scene;
  theme: string;
}

export const isStale = (drawn: Drawn | undefined, scene: Scene, theme: string) =>
  drawn === undefined || drawn.scene !== scene || drawn.theme !== theme;

/**
 * The slide as a picture: the real scene at full size, inert so nothing in it takes focus or a click, to be scaled by
 * the `--thumb-k` of whatever holds it. The strip and the storyboard both draw it, so they show the same thing.
 */
export function thumbnailFrame(scene: Scene, theme: string): HTMLElement {
  const view = h("div", { class: "dc-view" }, renderScene(scene, { assetBase: "" }));
  for (const node of view.querySelectorAll<HTMLElement>("[data-gated]")) node.dataset.revealed = "true";
  for (const video of view.querySelectorAll("video")) video.controls = false;
  for (const image of view.querySelectorAll("img")) image.loading = "lazy";
  return h(
    "div",
    { class: "dc-player ed-thumb-frame", "data-theme": theme, inert: true },
    h("div", { class: "dc-stage" }, view),
  );
}

/** The slide is drawn at a fixed size, so the scale that fits the thumbnails' width is set on the element that holds them. */
export function fitThumbnails(holder: HTMLElement): void {
  const width = holder.querySelector<HTMLElement>(".ed-thumb")?.clientWidth ?? 0;
  if (width > 0) holder.style.setProperty("--thumb-k", String(width / STAGE_WIDTH));
}

export interface DrawQueue {
  /** Queues a thumbnail to be drawn, in the order they were queued. */
  add(id: string): void;
  /** Takes one back out, such as the thumbnail of a scene that is gone. */
  remove(id: string): void;
  /** Draws what is queued, a couple at a time, one frame after another. Does nothing while a frame is already waiting. */
  kick(): void;
  /** Draws every queued thumbnail now. */
  flush(): void;
  destroy(): void;
}

/** Thumbnails to draw, a few before each paint, so a long deck is drawn over several frames instead of in one. */
export function createDrawQueue(draw: (id: string) => void): DrawQueue {
  const queued = new Set<string>();
  let frame: number | undefined;

  function drain() {
    frame = undefined;
    for (const id of [...queued].slice(0, DRAWN_PER_FRAME)) {
      queued.delete(id);
      draw(id);
    }
    if (queued.size > 0) frame = requestAnimationFrame(drain);
  }

  return {
    add: (id) => void queued.add(id),
    remove: (id) => void queued.delete(id),
    kick() {
      if (frame === undefined && queued.size > 0) frame = requestAnimationFrame(drain);
    },
    flush() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      for (const id of [...queued]) {
        queued.delete(id);
        draw(id);
      }
    },
    destroy() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      queued.clear();
    },
  };
}
