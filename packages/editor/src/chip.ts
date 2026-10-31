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
  const state = chip.panel.state?.(scene);
  chip.badge.textContent = state?.badge ?? "";
  chip.button.setAttribute("aria-label", state?.title ?? chip.panel.title);
}

/** Opens a popover and puts the keyboard on its first control, or on `focus` when that is given. */
export function showPopover(chip: Chip, focus?: HTMLElement | null) {
  chip.pop.hidden = false;
  chip.button.setAttribute("aria-expanded", "true");
  (focus ?? chip.pop.querySelector<HTMLElement>("input, select, textarea, button"))?.focus();
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
