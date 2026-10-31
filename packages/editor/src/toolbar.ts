import {
  type ApplyResult,
  type Block,
  type Scene,
  type Session,
  TEXT_LIMITS,
  TEXT_ROLES,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { type Canvas, SUMMARY_LIMIT } from "./canvas.ts";
import { addedRow, CHART_ROWS_MAX, sortedRows } from "./chart.ts";
import { buildChip, type Chip, fillChip, fitPopover, hidePopover, showPopover } from "./chip.ts";
import { afterWhenMoving, removeBlock, removeClaim } from "./cleanup.ts";
import { actionButton, type Edits, problemOf } from "./fields.ts";
import {
  chartPanel,
  citePanel,
  clipPanel,
  evidencePanel,
  imagePanel,
  type Panel,
  type PanelHost,
  panelHost,
} from "./panels.ts";
import { describeBlock, ROLE_LABEL, type TextRole } from "./templates.ts";

/** How far the toolbar floats from the block it belongs to, in pixels. */
const GAP = 8;

type Text = Extract<Block, { type: "text" }>;

/** What the toolbar is for: a piece of text, the claim, or a block that has no text of its own to set. */
type Target =
  | { kind: "text"; scene: Scene; block: Text }
  | { kind: "claim"; scene: Scene; id: string }
  | { kind: "block"; scene: Scene; block: Block };

const idOf = (target: Target) => (target.kind === "claim" ? target.id : target.block.id);

export interface Spot {
  left: number;
  top: number;
  side: "above" | "below" | "inside";
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a toolbar of `size` goes against a block, all in pixels from the slide's top left corner: above the block,
 * lined up with its left edge, or below it when there is no room above. A block that fills the slide leaves no room
 * on either side, so the toolbar sits inside its top edge.
 */
export function placeToolbar(
  anchor: Box,
  host: { width: number; height: number },
  size: { width: number; height: number },
  gap = GAP,
): Spot {
  const left = Math.min(Math.max(anchor.left, 0), Math.max(0, host.width - size.width));
  const above = anchor.top - size.height - gap;
  if (above >= 0) return { left, top: above, side: "above" };
  const below = anchor.top + anchor.height + gap;
  if (below + size.height <= host.height) return { left, top: below, side: "below" };
  return { left, top: 0, side: "inside" };
}

export interface ToolbarHooks {
  /** How the toolbar changes the deck: `act` for a click or a choice, `type` for a keystroke in one of its fields. */
  edits: Edits;
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Stores a file in the deck and answers with its path. Rejects with a message the person can read. */
  upload(file: File): Promise<string>;
  /** Nothing should stay chosen. */
  deselect(): void;
  /** Choose this block and put the keyboard on it. */
  goTo(id: string): void;
  /** Give the keyboard back to the chosen block. */
  focusBlock(id: string): void;
  /** Opens where the scene's sources are added and edited. */
  openSources(): void;
}

export interface Toolbar {
  readonly element: HTMLElement;
  /**
   * Shows the toolbar for the chosen block or claim of a scene, brings it up to date, or hides it. `typing` is true
   * while a keystroke in one of the toolbar's own fields is being applied, so that field is not drawn again.
   */
  render(sceneId: string, id: string | undefined, typing?: boolean): void;
  /** Puts the toolbar against its block again. */
  place(): void;
  /** Takes the length of what is typed on the slide, which the document does not have when it is refused. */
  typed(id: string, length: number, limit: number): void;
  /** Takes a block out of its scene as one undo step, and moves on to its neighbour. */
  remove(id: string): void;
  /** Moves the keyboard into the toolbar. False when there is no toolbar to go to. */
  focus(): boolean;
  destroy(): void;
}

function resolve(scene: Scene, id: string): Target | undefined {
  if (scene.summary?.id === id) return { kind: "claim", scene, id };
  const block = scene.blocks.find((candidate) => candidate.id === id);
  if (!block) return undefined;
  return block.type === "text" ? { kind: "text", scene, block } : { kind: "block", scene, block };
}

/**
 * The toolbar that floats against the chosen block of the slide. Text has its role, a count against the limit and
 * a remove button; every kind of block also has chips that open a popover for what the slide cannot show, such as
 * a chart's rows or the sources a block cites. It is built when the choice changes and brought up to date after
 * that, so a control keeps the keyboard while the deck changes under it.
 */
export function createToolbar(
  session: Session,
  canvas: Pick<Canvas, "element" | "nodeOf">,
  hooks: ToolbarHooks,
): Toolbar {
  const element = h("div", { class: "ed-toolbar", role: "toolbar", hidden: true });
  let shown: { id: string; kind: Target["kind"] } | undefined;
  /** The scene the keyboard is in, which `remove` acts on: ids repeat from one scene to the next. */
  let sceneId = "";
  let frame: number | undefined;

  // The parts of whichever toolbar is built. Each is only set for the kinds that have it.
  let role: HTMLSelectElement | undefined;
  let count: HTMLElement | undefined;
  let label: HTMLElement | undefined;
  let chips: Chip[] = [];
  let moves: HTMLButtonElement[] = [];
  /** A chart's Add bar and Sort buttons, which are built only for a chart. */
  let barTools: { add: HTMLButtonElement; sort: HTMLButtonElement } | undefined;
  let open: Chip | undefined;

  const scene = (id: string) => session.doc.scenes[id];

  function report(result: ApplyResult) {
    hooks.problem(result.ok ? undefined : problemOf(result));
    return result.ok;
  }

  const host: PanelHost = panelHost(session, {
    edits: hooks.edits,
    upload: hooks.upload,
    problem: hooks.problem,
    close: () => closePop(),
    openSources: hooks.openSources,
  });

  function closePop(giveBack = false) {
    if (!open) return;
    const chip = open;
    open = undefined;
    hidePopover(chip);
    if (giveBack) chip.button.focus();
  }

  /** Keeps the open popover inside the slide, opening it upward when the toolbar is below its block. */
  function fitPop() {
    if (open) fitPopover(open.pop, canvas.element.getBoundingClientRect(), element.dataset.side === "below");
  }

  function openPop(chip: Chip) {
    closePop();
    open = chip;
    showPopover(chip);
    fitPop();
  }

  function chipFor(panel: Panel): Chip {
    const chip = buildChip(panel);
    chip.button.addEventListener("click", () => (open === chip ? closePop() : openPop(chip)));
    return chip;
  }

  function remove(id: string) {
    const current = scene(sceneId);
    if (!current) return;
    if (current.summary?.id === id) {
      if (report(hooks.edits.act(removeClaim(current)))) hooks.deselect();
      return;
    }
    const order = current.blocks.map((block) => block.id);
    const at = order.indexOf(id);
    const neighbour = order[at + 1] ?? order[at - 1];
    if (report(hooks.edits.act(removeBlock(current, id)))) {
      if (neighbour) hooks.goTo(neighbour);
      else hooks.deselect();
    }
  }

  /** Moves the block one place along the slide's order, which is also the order the layout fills its slots. */
  function moveButton(id: string, direction: -1 | 1) {
    const name = direction === -1 ? "earlier" : "later";
    const node = h(
      "button",
      {
        type: "button",
        class: "ed-tb-mini",
        "data-tb": `move-${name}`,
        "aria-label": `Move ${name}`,
        title: `Move ${name}`,
      },
      direction === -1 ? "←" : "→",
    );
    node.addEventListener("click", () => {
      const current = scene(sceneId);
      if (!current) return;
      const after = afterWhenMoving(
        current.blocks.map((block) => block.id),
        id,
        direction,
      );
      if (after === undefined) return;
      report(hooks.edits.act([{ op: "block.move", scene: current.id, id, after }]));
    });
    return node;
  }

  /** Adds a bar to a chart, or sorts its bars: the two chart changes that do not need a popover. */
  function barButtons(id: string) {
    const rowsOf = () => {
      const block = scene(sceneId)?.blocks.find((candidate) => candidate.id === id);
      return block?.type === "bar-chart" ? block.data : [];
    };
    const change = (data: ReturnType<typeof rowsOf>) =>
      report(hooks.edits.act([{ op: "block.set", scene: sceneId, id, set: { data } }]));
    return {
      add: actionButton("Add bar", () => change(addedRow(rowsOf())), { "data-tb": "add-bar" }),
      sort: actionButton("Sort", () => change(sortedRows(rowsOf())), {
        "data-tb": "sort-bars",
        title: "Sort the bars by value, largest first; again for smallest first",
      }),
    };
  }

  function removeButton(id: string, what: string) {
    const node = h("button", {
      type: "button",
      class: "ed-tb-remove",
      "data-tb": "remove",
      "aria-label": `Remove ${what}`,
      title: "Remove",
    });
    node.addEventListener("click", () => remove(id));
    return node;
  }

  /** What each kind of block can be asked for beyond what it shows, then the sources it cites. */
  function panelsFor(block: Block): Panel[] {
    const own = (): Panel[] => {
      switch (block.type) {
        case "bar-chart":
          return [chartPanel(host, sceneId, block.id)];
        case "image":
          return [imagePanel(host, sceneId, block.id)];
        case "clip":
          return [clipPanel(host, sceneId, block.id)];
        default:
          return [];
      }
    };
    return [...own(), citePanel(host, sceneId, block.id)];
  }

  function build(target: Target) {
    closePop();
    role = count = label = undefined;
    moves = [];
    barTools = undefined;
    const id = idOf(target);
    const controls: HTMLElement[] = [];
    const inScene = target.scene.id;
    sceneId = inScene;
    chips = (target.kind === "claim" ? [evidencePanel(host, inScene)] : panelsFor(target.block)).map(chipFor);

    if (target.kind === "text") {
      const select = h(
        "select",
        { "aria-label": "Text role", "data-tb": "role" },
        ...TEXT_ROLES.map((value) => h("option", { value }, ROLE_LABEL[value])),
      );
      select.addEventListener("change", () => {
        const live = scene(inScene);
        const block = live?.blocks.find((candidate) => candidate.id === id);
        const next = select.value as TextRole;
        if (!live || block?.type !== "text") return;
        const done = report(hooks.edits.act([{ op: "block.set", scene: live.id, id, set: { role: next } }]));
        // A refused role, such as text too long for a heading, leaves the block as it was.
        if (!done) select.value = block.role;
      });
      role = select;
      count = h("span", { class: "ed-tb-count", "data-tb": "count" });
      moves = [moveButton(id, -1), moveButton(id, 1)];
      controls.push(
        select,
        count,
        ...moves,
        ...chips.map((chip) => chip.wrap),
        removeButton(id, "this text"),
      );
    } else if (target.kind === "claim") {
      count = h("span", { class: "ed-tb-count", "data-tb": "count" });
      controls.push(
        h("span", { class: "ed-tb-label" }, "Claim"),
        count,
        ...chips.map((chip) => chip.wrap),
        removeButton(id, "the claim"),
      );
    } else {
      label = h("span", { class: "ed-tb-label" }, describeBlock(target.block, 28));
      moves = [moveButton(id, -1), moveButton(id, 1)];
      barTools = target.block.type === "bar-chart" ? barButtons(id) : undefined;
      controls.push(
        label,
        ...(barTools ? [barTools.add, barTools.sort] : []),
        ...moves,
        ...chips.map((chip) => chip.wrap),
        removeButton(id, "this block"),
      );
    }
    element.setAttribute(
      "aria-label",
      target.kind === "text" ? "Text options" : target.kind === "claim" ? "Claim options" : "Block options",
    );
    element.replaceChildren(...controls);
  }

  function showCount(length: number, limit: number) {
    if (!count) return;
    count.textContent = `${length} / ${limit}`;
    count.toggleAttribute("data-over", length > limit);
    count.setAttribute("aria-label", `${length} of ${limit} characters`);
  }

  function sync(target: Target, typing: boolean) {
    if (target.kind === "text") {
      const { block } = target;
      if (role) role.value = block.role;
      showCount(block.text.length, TEXT_LIMITS[block.role]);
    } else if (target.kind === "claim") {
      showCount(target.scene.summary?.text.length ?? 0, SUMMARY_LIMIT);
    } else if (label) {
      label.textContent = describeBlock(target.block, 28);
    }
    if (barTools && target.kind === "block" && target.block.type === "bar-chart") {
      const full = target.block.data.length >= CHART_ROWS_MAX;
      barTools.add.disabled = full;
      barTools.add.title = full ? `A chart holds at most ${CHART_ROWS_MAX} bars.` : "";
      barTools.sort.disabled = target.block.data.length < 2;
    }
    // The first block cannot move earlier and the last cannot move later.
    if (target.kind !== "claim") {
      const order = target.scene.blocks.map((block) => block.id);
      const id = idOf(target);
      for (const [index, direction] of ([-1, 1] as const).entries()) {
        const node = moves[index];
        if (node) node.disabled = afterWhenMoving(order, id, direction) === undefined;
      }
    }
    for (const chip of chips) fillChip(chip, target.scene, typing);
  }

  function place() {
    frame = undefined;
    if (element.hidden || !shown) return;
    const anchor = canvas.nodeOf(shown.id);
    if (!anchor) return;
    const host = canvas.element.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    const spot = placeToolbar(
      { left: box.left - host.left, top: box.top - host.top, width: box.width, height: box.height },
      { width: host.width, height: host.height },
      { width: element.offsetWidth, height: element.offsetHeight },
    );
    element.style.left = `${Math.round(spot.left)}px`;
    element.style.top = `${Math.round(spot.top)}px`;
    element.dataset.side = spot.side;
    fitPop();
  }

  /** The block moves with every keystroke and every redraw, so placing waits for the next frame and happens once. */
  function soon() {
    if (frame === undefined) frame = requestAnimationFrame(place);
  }

  function hide() {
    closePop();
    element.hidden = true;
    shown = undefined;
    delete element.dataset.side;
  }

  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !shown) return;
    event.stopPropagation();
    if (open) closePop(true);
    else hooks.focusBlock(shown.id);
  });

  const onPointerDown = (event: PointerEvent) => {
    if (open && !(event.target instanceof Node && element.contains(event.target))) closePop();
  };
  document.addEventListener("pointerdown", onPointerDown);
  // The slide scales with the room it has, so a resized window or an opened panel moves every block.
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => soon());
  resized?.observe(canvas.element);

  return {
    element,
    render(inScene, id, typing = false) {
      sceneId = inScene;
      const current = scene(inScene);
      const target = current && id !== undefined ? resolve(current, id) : undefined;
      if (!target) {
        hide();
        return;
      }
      if (!shown || shown.id !== idOf(target) || shown.kind !== target.kind) {
        build(target);
        shown = { id: idOf(target), kind: target.kind };
        // The side is only known once the new target is placed, a frame from now. Until then it is not the old one.
        delete element.dataset.side;
      }
      sync(target, typing);
      element.hidden = false;
      soon();
    },
    place,
    typed(id, length, limit) {
      if (shown?.id === id) showCount(length, limit);
    },
    remove,
    focus() {
      if (element.hidden) return false;
      element.querySelector<HTMLElement>("select, button")?.focus();
      return true;
    },
    destroy() {
      document.removeEventListener("pointerdown", onPointerDown);
      resized?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
  };
}
