import {
  type ApplyResult,
  type BuildEntry,
  type BuildTarget,
  buildOf,
  type Op,
  placeInBuild,
  type Scene,
  type Session,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { problemOf } from "./fields.ts";
import { describeBlock } from "./templates.ts";

export interface BuildHooks {
  /** Applies what a choice decided, as one undo step. */
  act(ops: readonly Op[]): ApplyResult;
  /** A line about a refused choice, or undefined to clear it. */
  problem(text: string | undefined): void;
}

export interface BuildBadges {
  /** Draws a badge for each part of the scene, in place of the last ones, while the mode is on. */
  draw(scene: Scene | undefined): void;
  /** Puts each badge against its part again, after the slide changed size or its text grew. */
  place(): void;
  /** Turns the mode on or off. */
  setOn(on: boolean): void;
  destroy(): void;
}

const GAP = 8;

/** What a part is called to someone asking when it appears. */
const nameOf = (scene: Scene, id: string): string => {
  if (scene.summary?.id === id) return "The claim";
  const block = scene.blocks.find((candidate) => candidate.id === id);
  return block ? describeBlock(block, 40, scene) : id;
};

/**
 * Build order: a numbered badge beside each part of the slide that says when it appears. The number is the step whose
 * press shows it; a dot means it is there from the start. A badge opens a short list of the places it could go, and
 * a choice is `placeInBuild` from the core, which keeps each part in one step and drops a step that is left empty.
 * The badges live in the overlay, not in the blocks, so they are never part of the text a person edits.
 */
export function createBuildBadges(
  session: Session,
  host: HTMLElement,
  overlay: HTMLElement,
  nodeOf: (id: string) => HTMLElement | undefined,
  hooks: BuildHooks,
): BuildBadges {
  const layer = h("div", { class: "ed-build" });
  let sceneId: string | undefined;
  let on = false;
  let frame: number | undefined;
  let open: { id: string; badge: HTMLElement; menu: HTMLElement } | undefined;

  const scene = () => (sceneId === undefined ? undefined : session.doc.scenes[sceneId]);

  function close(refocus = false) {
    if (!open) return;
    const { badge, menu } = open;
    open = undefined;
    menu.remove();
    badge.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (refocus) badge.focus();
  }

  /** A press anywhere but on the list puts it away. */
  function outside(event: Event) {
    if (open && event.target instanceof Node && !open.menu.contains(event.target)) close();
  }

  function choose(id: string, to: BuildTarget) {
    const current = scene();
    close(true);
    if (!current) return;
    const placed = placeInBuild(current, id, to);
    if (!placed.ok) {
      hooks.problem(placed.message);
      return;
    }
    hooks.problem(undefined);
    if (placed.ops.length === 0) return;
    const result = hooks.act(placed.ops);
    if (!result.ok) hooks.problem(problemOf(result));
  }

  function openMenu(entry: BuildEntry, badge: HTMLElement) {
    const current = scene();
    if (!current) return;
    close();
    const count = current.steps?.length ?? 0;
    const option = (label: string, to: BuildTarget, picked: boolean) => {
      const item = h(
        "button",
        {
          type: "button",
          class: "ed-build-choice",
          role: "menuitemradio",
          "aria-checked": String(picked),
          "data-build": String(to),
        },
        label,
      );
      item.addEventListener("click", () => choose(entry.id, to));
      return item;
    };
    const menu = h(
      "div",
      { class: "ed-build-menu", role: "menu", "aria-label": `When ${nameOf(current, entry.id)} appears` },
      h("p", { class: "ed-build-title" }, "Appears"),
      option("From the start", "start", entry.step === undefined),
      ...Array.from({ length: count }, (_, index) =>
        option(`Step ${index + 1}`, index + 1, entry.step === index + 1),
      ),
      option("A new step", "new", false),
    );
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    });
    layer.append(menu);
    const origin = host.getBoundingClientRect();
    const below = badge.getBoundingClientRect();
    const left = below.left - origin.left;
    menu.style.left = `${Math.max(0, Math.min(left, origin.width - menu.offsetWidth))}px`;
    menu.style.top = `${below.bottom - origin.top + 4}px`;
    badge.setAttribute("aria-expanded", "true");
    open = { id: entry.id, badge, menu };
    document.addEventListener("pointerdown", outside, true);
    menu.querySelector<HTMLElement>("[aria-checked='true']")?.focus();
  }

  function badgeFor(current: Scene, entry: BuildEntry): HTMLElement {
    const name = nameOf(current, entry.id);
    const badge = h(
      "button",
      {
        type: "button",
        class: "ed-badge",
        "data-badge": entry.id,
        "data-step": entry.step === undefined ? undefined : String(entry.step),
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-label": `${name}: ${entry.step === undefined ? "there from the start" : `appears at step ${entry.step}`}. Change when it appears.`,
      },
      entry.step === undefined ? "•" : String(entry.step),
    );
    badge.addEventListener("click", () => (open?.id === entry.id ? close() : openMenu(entry, badge)));
    return badge;
  }

  function place() {
    const origin = host.getBoundingClientRect();
    for (const node of layer.querySelectorAll<HTMLElement>("[data-badge]")) {
      const part = nodeOf(node.dataset.badge ?? "");
      if (!part) {
        node.hidden = true;
        continue;
      }
      node.hidden = false;
      const box = part.getBoundingClientRect();
      const left = box.right - origin.left + GAP;
      node.style.left = `${Math.max(0, Math.min(left, origin.width - node.offsetWidth - 2))}px`;
      node.style.top = `${box.top - origin.top}px`;
    }
    if (open) {
      const below = open.badge.getBoundingClientRect();
      open.menu.style.left = `${Math.max(0, Math.min(below.left - origin.left, origin.width - open.menu.offsetWidth))}px`;
      open.menu.style.top = `${below.bottom - origin.top + 4}px`;
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
  // The slide scales with the room it has, so a resized window or an opened panel moves every part.
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
  resized?.observe(host);

  // Over the grips, so a list that opens across one gets the press, and under the toolbar, which is added to the
  // overlay after this.
  overlay.append(layer);

  function draw(next: Scene | undefined) {
    // A choice redraws the slide under the badge that was used, which keeps the keyboard.
    const active = document.activeElement;
    const kept = active instanceof HTMLElement && layer.contains(active) ? active.dataset.badge : undefined;
    close();
    sceneId = next?.id;
    layer.replaceChildren(...(on && next ? buildOf(next).map((entry) => badgeFor(next, entry)) : []));
    place();
    if (kept !== undefined) {
      [...layer.querySelectorAll<HTMLElement>("[data-badge]")]
        .find((node) => node.dataset.badge === kept)
        ?.focus();
    }
  }

  return {
    draw: (next) => draw(next),
    place,
    setOn(value) {
      on = value;
      draw(scene());
    },
    destroy() {
      close();
      resized?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      layer.remove();
    },
  };
}
