import { LEADS, type Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { buildChip, fillChip, fitPopover, hidePopover, showPopover } from "./chip.ts";
import { type Edits, problemOf } from "./fields.ts";
import { panelHost, scenePanel } from "./panels.ts";
import { LAYOUT_CHOICES, type Layout, LEAD_LABEL } from "./templates.ts";

type Shape = readonly [tag: "rect" | "path", attributes: Readonly<Record<string, string>>];

/**
 * What each layout looks like, drawn in a 24 by 16 box. A `Record` over `Layout`, so a layout added to the core
 * does not compile until it has a picture here.
 */
const PICTOGRAM: Record<Layout, readonly Shape[]> = {
  title: [
    ["path", { d: "M3 5h18M3 9h12" }],
    ["rect", { x: "3", y: "11.5", width: "18", height: "3", rx: "1" }],
  ],
  "claim-evidence": [
    ["rect", { x: "1.5", y: "1.5", width: "9", height: "13", rx: "1" }],
    ["rect", { x: "13.5", y: "1.5", width: "9", height: "13", rx: "1" }],
  ],
  "text-media": [
    ["rect", { x: "1.5", y: "1.5", width: "11", height: "13", rx: "1" }],
    ["path", { d: "M15 4h8M15 8h8M15 12h5" }],
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function pictogram(layout: Layout): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of PICTOGRAM[layout]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}

export interface SceneBarHooks {
  /** How the bar changes the deck: `act` for a click or a choice, `type` for a keystroke in one of its fields. */
  edits: Edits;
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
}

export interface SceneBar {
  readonly element: HTMLElement;
  /**
   * Marks the lead and the layout of the scene being edited, and brings its popover up to date. `typing` is true
   * while a keystroke in a field of that popover is being applied, so the field is not drawn again.
   */
  render(sceneId: string, typing?: boolean): void;
  /** Opens the scene popover, at one of its sections when that is given. */
  open(section?: "steps" | "sources"): void;
  destroy(): void;
}

/**
 * Who leads the scene and which layout it has, as two short rows of buttons in the top bar. Each is one click and
 * one undo step. A button that is already pressed does nothing, so clicking it again never adds an edit. A Scene
 * chip opens a popover with the scene's title, steps and sources.
 */
export function createSceneBar(session: Session, hooks: SceneBarHooks): SceneBar {
  let current = session.doc.deck.scenes[0] as string;

  function choose(set: { lead: (typeof LEADS)[number] } | { layout: Layout }) {
    const result = hooks.edits.act([{ op: "scene.set", id: current, set }]);
    hooks.problem(result.ok ? undefined : problemOf(result));
  }

  const leads = LEADS.map((value) => {
    const node = h(
      "button",
      { type: "button", "data-lead": value, "aria-pressed": "false" },
      LEAD_LABEL[value],
    );
    node.addEventListener("click", () => {
      if (node.getAttribute("aria-pressed") !== "true") choose({ lead: value });
    });
    return node;
  });

  const layouts = LAYOUT_CHOICES.map(({ value, label }) => {
    const node = h(
      "button",
      { type: "button", "data-layout": value, "aria-pressed": "false", "aria-label": label, title: label },
      pictogram(value as Layout),
    );
    node.addEventListener("click", () => {
      if (node.getAttribute("aria-pressed") !== "true") choose({ layout: value as Layout });
    });
    return node;
  });

  const host = panelHost(session, {
    edits: hooks.edits,
    upload: hooks.upload,
    problem: hooks.problem,
    close: () => close(),
    openSources: () => open("sources"),
  });
  const panel = scenePanel(host, () => current);
  const chip = buildChip(panel);
  let isOpen = false;

  function close(giveBack = false) {
    if (!isOpen) return;
    isOpen = false;
    hidePopover(chip);
    if (giveBack) chip.button.focus();
  }

  // The popover grows and shrinks as sections open and rows are added, so it is fitted again each time.
  const fit = () =>
    fitPopover(
      chip.pop,
      { left: 0, right: document.documentElement.clientWidth, top: 0, bottom: window.innerHeight },
      false,
    );

  function open(section?: "steps" | "sources") {
    isOpen = true;
    showPopover(chip, null, fit);
    if (section) panel.reveal(section);
  }
  // A details element reports its own opening and closing, and that event does not bubble.
  chip.pop.addEventListener("toggle", () => isOpen && fit(), true);

  chip.button.addEventListener("click", () => (isOpen ? close() : open()));
  chip.wrap.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.stopPropagation();
    close(true);
  });
  const onPointerDown = (event: PointerEvent) => {
    if (isOpen && !(event.target instanceof Node && chip.wrap.contains(event.target))) close();
  };
  document.addEventListener("pointerdown", onPointerDown);

  const element = h(
    "div",
    { class: "ed-scene-tools" },
    h("div", { class: "ed-seg", role: "group", "aria-label": "Who leads this scene" }, ...leads),
    h("div", { class: "ed-seg", role: "group", "aria-label": "Layout of this scene" }, ...layouts),
    chip.wrap,
  );

  return {
    element,
    open,
    destroy() {
      document.removeEventListener("pointerdown", onPointerDown);
    },
    render(sceneId, typing = false) {
      current = sceneId;
      const scene = session.doc.scenes[sceneId];
      if (!scene) return;
      fillChip(chip, scene, typing);
      if (isOpen) fit();
      // A scene with no lead set is led by a human, which is what the strip and the player say too.
      const lead = scene.lead ?? "human";
      for (const node of leads) node.setAttribute("aria-pressed", String(node.dataset.lead === lead));
      for (const node of layouts)
        node.setAttribute("aria-pressed", String(node.dataset.layout === scene.layout));
    },
  };
}
