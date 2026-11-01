import type { Scene } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Panel } from "./panels.ts";

/** A chip and the popover it opens. The toolbar and the scene bar each hold some and decide which one is open. */
export interface Chip {
  panel: Panel;
  button: HTMLButtonElement;
  badge: HTMLElement;
  pop: HTMLElement;
  wrap: HTMLElement;
}

export function buildChip(panel: Panel): Chip {
  const badge = h("span", { class: "ed-tb-n" });
  const button = h(
    "button",
    {
      type: "button",
      class: "ed-tb-chip",
      "data-tb": panel.name,
      "aria-label": panel.title,
      "aria-haspopup": "true",
      "aria-expanded": "false",
    },
    panel.label,
    badge,
  );
  const pop = h(
    "div",
    { class: "ed-tb-pop", role: "group", "aria-label": panel.title, hidden: true },
    panel.body,
  );
  const wrap = h("span", { class: "ed-tb-chip-wrap" }, button, pop);
  return { panel, button, badge, pop, wrap };
}

/** Brings the popover and the chip's count up to date with the scene. */
export function fillChip(chip: Chip, scene: Scene, typing: boolean) {
  chip.panel.fill(scene, typing);
  chip.wrap.hidden = chip.panel.visible?.(scene) === false;
  const state = chip.panel.state?.(scene);
  chip.badge.textContent = state?.badge ?? "";
  chip.button.setAttribute("aria-label", state?.title ?? chip.panel.title);
}

/**
 * Opens a popover and puts the keyboard on its first control, or on `focus` when that is given. `fit` runs once the
 * popover is shown and before the keyboard moves into it: a popover that overhangs the window would otherwise make
 * the browser scroll the page sideways to reach the control, and fitting would then measure a scrolled page.
 */
export function showPopover(chip: Chip, focus?: HTMLElement | null, fit?: () => void) {
  chip.pop.hidden = false;
  chip.button.setAttribute("aria-expanded", "true");
  fit?.();
  (focus ?? chip.pop.querySelector<HTMLElement>("input, select, textarea, button"))?.focus({
    preventScroll: true,
  });
}

export function hidePopover(chip: Chip) {
  chip.pop.hidden = true;
  chip.button.setAttribute("aria-expanded", "false");
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Keeps an open popover inside `bounds`: slid sideways when it would overhang, and shortened to the room it has.
 * `up` opens it above its chip instead of below.
 */
export function fitPopover(pop: HTMLElement, bounds: Bounds, up: boolean) {
  // Measuring with no height limit would scroll a long popover back to its top, so the place is kept.
  const scrolled = pop.scrollTop;
  pop.style.left = "0px";
  pop.style.maxHeight = "";
  pop.toggleAttribute("data-up", up);
  const box = pop.getBoundingClientRect();
  const shift = Math.max(bounds.left - box.left, Math.min(0, bounds.right - box.right));
  pop.style.left = `${Math.round(shift)}px`;
  const room = up ? box.bottom - bounds.top : bounds.bottom - box.top;
  if (box.height > room - 8) pop.style.maxHeight = `${Math.max(160, Math.floor(room - 8))}px`;
  pop.scrollTop = scrolled;
}

/**
 * Slides an open popover clear of the block it edits, to whichever side has room for it, so a person who changes a
 * chart's data watches the chart change. With no room on either side it stays where it is, over the block.
 */
export function standBeside(pop: HTMLElement, block: Bounds, bounds: Bounds, gap = 8) {
  const box = pop.getBoundingClientRect();
  if (box.right <= block.left || box.left >= block.right) return;
  const nearest = [block.left - gap - box.width, block.right + gap]
    .filter((left) => left >= bounds.left && left + box.width <= bounds.right)
    .sort((a, b) => Math.abs(a - box.left) - Math.abs(b - box.left))[0];
  if (nearest === undefined) return;
  pop.style.left = `${Math.round((Number.parseFloat(pop.style.left) || 0) + nearest - box.left)}px`;
}

/** A chip with its popover and what keeps it behaving: Escape and a press elsewhere close it, and it stays fitted. */
export interface PopoverChip {
  readonly chip: Chip;
  readonly isOpen: boolean;
  open(): void;
  /** Closes the popover. `giveBack` puts the keyboard on the chip, as Escape does. */
  close(giveBack?: boolean): void;
  /** Brings the popover and the chip's count up to date, and fits the popover again when it is open. */
  fill(scene: Scene, typing: boolean): void;
  destroy(): void;
}

/**
 * `up` opens the popover above its chip, for a chip near the bottom of the window. `margin` keeps it that many pixels
 * from the sides of the window, for a popover that is not meant to touch them.
 */
export function popoverChip(panel: Panel, up = false, margin = 0): PopoverChip {
  const chip = buildChip(panel);
  let isOpen = false;

  // The popover grows and shrinks as sections open and rows are added, so it is fitted again each time.
  const fit = () =>
    fitPopover(
      chip.pop,
      {
        left: margin,
        right: document.documentElement.clientWidth - margin,
        top: 0,
        bottom: window.innerHeight,
      },
      up,
    );
  const close = (giveBack = false) => {
    if (!isOpen) return;
    isOpen = false;
    hidePopover(chip);
    if (giveBack) chip.button.focus();
  };
  const open = () => {
    isOpen = true;
    showPopover(chip, null, fit);
  };

  chip.button.addEventListener("click", () => (isOpen ? close() : open()));
  chip.wrap.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.stopPropagation();
    close(true);
  });
  // A details element reports its own opening and closing, and that event does not bubble.
  chip.pop.addEventListener("toggle", () => isOpen && fit(), true);
  const onPointerDown = (event: PointerEvent) => {
    if (isOpen && !(event.target instanceof Node && chip.wrap.contains(event.target))) close();
  };
  document.addEventListener("pointerdown", onPointerDown);

  return {
    chip,
    get isOpen() {
      return isOpen;
    },
    open,
    close,
    fill(scene, typing) {
      fillChip(chip, scene, typing);
      if (isOpen) fit();
    },
    destroy() {
      document.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
