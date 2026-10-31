import { LEADS, type Op, type Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { popoverChip } from "./chip.ts";
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
 * one undo step. A button that is already pressed does nothing, so clicking it again never adds an edit. Auto layout
 * shows only while the scene has a pinned block, and puts all of them back in their slots as one undo step. A Scene
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

  const auto = h(
    "button",
    {
      type: "button",
      class: "ed-auto",
      "data-auto": "",
      hidden: true,
      title: "Put every pinned block of this slide back in its layout's slot",
    },
    "Auto layout",
  );
  auto.addEventListener("click", () => {
    const pinned = (session.doc.scenes[current]?.blocks ?? []).filter((block) => block.frame);
    if (pinned.length === 0) return;
    const ops = pinned.map((block): Op => ({ op: "block.unframe", scene: current, id: block.id }));
    const result = hooks.edits.act(ops);
    hooks.problem(result.ok ? undefined : problemOf(result));
  });

  const host = panelHost(session, {
    edits: hooks.edits,
    upload: hooks.upload,
    problem: hooks.problem,
    close: () => popover.close(),
    openSources: () => open("sources"),
  });
  const panel = scenePanel(host, () => current);
  const popover = popoverChip(panel);

  function open(section?: "steps" | "sources") {
    popover.open();
    if (section) panel.reveal(section);
  }

  const element = h(
    "div",
    { class: "ed-scene-tools" },
    h("div", { class: "ed-seg", role: "group", "aria-label": "Who leads this scene" }, ...leads),
    h("div", { class: "ed-seg", role: "group", "aria-label": "Layout of this scene" }, ...layouts),
    auto,
    popover.chip.wrap,
  );

  return {
    element,
    open,
    destroy: popover.destroy,
    render(sceneId, typing = false) {
      current = sceneId;
      const scene = session.doc.scenes[sceneId];
      if (!scene) return;
      popover.fill(scene, typing);
      // A scene with no lead set is led by a human, which is what the strip and the player say too.
      const lead = scene.lead ?? "human";
      for (const node of leads) node.setAttribute("aria-pressed", String(node.dataset.lead === lead));
      for (const node of layouts)
        node.setAttribute("aria-pressed", String(node.dataset.layout === scene.layout));
      auto.hidden = !scene.blocks.some((block) => block.frame);
    },
  };
}
