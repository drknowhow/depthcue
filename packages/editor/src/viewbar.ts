import { h } from "@depthcue/player";

/** The sizes the slide steps through, as a multiple of the size that fits the window. 1 is Fit. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const FIT = 1;

/** The step after `zoom` in a direction, or `zoom` itself at the end of the range. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 1e-6) ?? zoom;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-6) ?? zoom;
}

export interface ViewBarHooks {
  /** Goes to the scene before or after the one on show. */
  go(direction: 1 | -1): void;
  /** Asks for a zoom, as a multiple of Fit. */
  zoom(zoom: number): void;
}

export interface ViewBar {
  readonly element: HTMLElement;
  /** Shows which scene this is of how many, and the zoom. */
  render(position: number, count: number, zoom: number): void;
}

const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

/**
 * The small bar over the top right of the stage: previous and next scene with where the deck stands, and the zoom of
 * the slide. It changes the view and never the deck, so none of it is an undo step.
 */
export function createViewBar(hooks: ViewBarHooks): ViewBar {
  const button = (action: string, label: string, text: string, onClick: () => void) => {
    const node = h(
      "button",
      { type: "button", "data-view": action, "aria-label": label, title: label },
      text,
    );
    node.addEventListener("click", onClick);
    return node;
  };

  const previous = button("previous", "Previous slide ([)", "‹", () => hooks.go(-1));
  const next = button("next", "Next slide (])", "›", () => hooks.go(1));
  const where = h("span", {
    class: "ed-view-where",
    "data-view": "where",
    role: "status",
    "aria-live": "polite",
  });
  let shown: number = FIT;
  const out = button("zoom-out", "Zoom out (-)", "−", () => hooks.zoom(stepZoom(shown, -1)));
  const into = button("zoom-in", "Zoom in (+)", "+", () => hooks.zoom(stepZoom(shown, 1)));
  const level = button("fit", "Fit the slide to the window (0)", "100%", () => hooks.zoom(FIT));
  level.classList.add("ed-view-level");

  const element = h(
    "div",
    { class: "ed-view", role: "group", "aria-label": "Move between slides and zoom" },
    previous,
    where,
    next,
    h("span", { class: "ed-view-rule", "aria-hidden": "true" }),
    out,
    level,
    into,
  );

  return {
    element,
    render(position, count, zoom) {
      shown = zoom;
      where.textContent = `${position} / ${count}`;
      previous.toggleAttribute("disabled", position <= 1);
      next.toggleAttribute("disabled", position >= count);
      level.textContent = percent(zoom);
      level.title =
        zoom === FIT ? "Fit the slide to the window (0)" : `Back to Fit from ${percent(zoom)} (0)`;
      out.toggleAttribute("disabled", stepZoom(zoom, -1) === zoom);
      into.toggleAttribute("disabled", stepZoom(zoom, 1) === zoom);
    },
  };
}
