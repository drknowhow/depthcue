import {
  type ApplyResult,
  type Block,
  type Op,
  type Scene,
  type Session,
  TEXT_LIMITS,
  TEXT_ROLES,
} from "@depthcue/core";
import { h } from "@depthcue/player";
import { type Canvas, SUMMARY_LIMIT } from "./canvas.ts";
import { removeBlock, removeClaim } from "./cleanup.ts";
import { problemOf } from "./fields.ts";
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
  act(ops: readonly Op[]): ApplyResult;
  /** Says why a change was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Nothing should stay chosen. */
  deselect(): void;
  /** Choose this block and put the keyboard on it. */
  goTo(id: string): void;
  /** Give the keyboard back to the chosen block. */
  focusBlock(id: string): void;
  /** Sources are edited in the details panel until they get a toolbar of their own. */
  openDetails(): void;
}

export interface Toolbar {
  readonly element: HTMLElement;
  /** Shows the toolbar for the chosen block or claim of a scene, brings it up to date, or hides it. */
  render(sceneId: string, id: string | undefined): void;
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
 * The toolbar that floats against the chosen block of the slide. For text it has the role, a count against the
 * limit, a chip for citing sources and a remove button; for the claim and for other blocks it has what applies to
 * them. It is built when the choice changes and brought up to date after that, so a control keeps the keyboard
 * while the deck changes under it.
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
  let cite: HTMLButtonElement | undefined;
  let citeCount: HTMLElement | undefined;
  let pop: HTMLElement | undefined;
  let list: HTMLElement | undefined;
  let listKey = "";

  const scene = (id: string) => session.doc.scenes[id];

  function report(result: ApplyResult) {
    hooks.problem(result.ok ? undefined : problemOf(result));
    return result.ok;
  }

  function closePop(giveBack = false) {
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    cite?.setAttribute("aria-expanded", "false");
    if (giveBack) cite?.focus();
  }

  function remove(id: string) {
    const current = scene(sceneId);
    if (!current) return;
    if (current.summary?.id === id) {
      if (report(hooks.act(removeClaim(current)))) hooks.deselect();
      return;
    }
    const order = current.blocks.map((block) => block.id);
    const at = order.indexOf(id);
    const neighbour = order[at + 1] ?? order[at - 1];
    if (report(hooks.act(removeBlock(current, id)))) {
      if (neighbour) hooks.goTo(neighbour);
      else hooks.deselect();
    }
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

  function build(target: Target) {
    closePop();
    role = count = cite = citeCount = pop = list = undefined;
    listKey = "";
    const id = idOf(target);
    const controls: HTMLElement[] = [];

    if (target.kind === "text") {
      const select = h(
        "select",
        { "aria-label": "Text role", "data-tb": "role" },
        ...TEXT_ROLES.map((value) => h("option", { value }, ROLE_LABEL[value])),
      );
      select.addEventListener("change", () => {
        const live = scene(target.scene.id);
        const block = live?.blocks.find((candidate) => candidate.id === id);
        const next = select.value as TextRole;
        if (!live || block?.type !== "text") return;
        const done = report(hooks.act([{ op: "block.set", scene: live.id, id, set: { role: next } }]));
        // A refused role, such as text too long for a heading, leaves the block as it was.
        if (!done) select.value = block.role;
      });
      role = select;
      count = h("span", { class: "ed-tb-count", "data-tb": "count" });

      citeCount = h("span", { class: "ed-tb-n" });
      cite = h(
        "button",
        {
          type: "button",
          class: "ed-tb-cite",
          "data-tb": "cite",
          "aria-haspopup": "true",
          "aria-expanded": "false",
        },
        "Cite",
        citeCount,
      );
      list = h("div", { class: "ed-tb-sources" });
      pop = h(
        "div",
        { class: "ed-tb-pop", role: "group", "aria-label": "Sources this text cites", hidden: true },
        list,
      );
      const chip = cite;
      const popover = pop;
      chip.addEventListener("click", () => {
        const open = popover.hidden;
        popover.hidden = !open;
        chip.setAttribute("aria-expanded", String(open));
        if (open) popover.querySelector<HTMLElement>("input, button")?.focus();
      });
      controls.push(
        select,
        count,
        h("span", { class: "ed-tb-cite-wrap" }, chip, popover),
        removeButton(id, "this text"),
      );
    } else if (target.kind === "claim") {
      count = h("span", { class: "ed-tb-count", "data-tb": "count" });
      controls.push(h("span", { class: "ed-tb-label" }, "Claim"), count, removeButton(id, "the claim"));
    } else {
      controls.push(
        h("span", { class: "ed-tb-label" }, describeBlock(target.block, 28)),
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

  /** The list of sources in the popover, rebuilt only when the scene's sources change so a click keeps its focus. */
  function syncSources(target: Extract<Target, { kind: "text" }>) {
    if (!list || !pop) return;
    const sources = target.scene.sources ?? [];
    const key = JSON.stringify(sources.map((source) => [source.id, source.title]));
    const cited = new Set(target.block.sourceIds ?? []);
    if (key !== listKey) {
      listKey = key;
      if (sources.length === 0) {
        const open = h("button", { type: "button", "data-tb": "open-sources" }, "Add one in Details");
        open.addEventListener("click", () => {
          closePop();
          hooks.openDetails();
        });
        list.replaceChildren(h("p", {}, "This scene has no sources yet."), open);
      } else {
        list.replaceChildren(
          ...sources.map((source) => {
            const box = h("input", { type: "checkbox", value: source.id, "data-tb": "source" });
            box.addEventListener("change", () => {
              const live = scene(target.scene.id);
              const ids = (live?.sources ?? [])
                .map((candidate) => candidate.id)
                .filter((candidate) =>
                  candidate === source.id
                    ? box.checked
                    : (list?.querySelector<HTMLInputElement>(`input[value="${candidate}"]`)?.checked ??
                      false),
                );
              const done = report(
                hooks.act([
                  {
                    op: "block.set",
                    scene: target.scene.id,
                    id: target.block.id,
                    set: { sourceIds: ids.length > 0 ? ids : null },
                  },
                ]),
              );
              if (!done) box.checked = !box.checked;
            });
            return h("label", { class: "ed-tb-source" }, box, h("span", {}, source.title));
          }),
        );
      }
    }
    for (const box of list.querySelectorAll<HTMLInputElement>("input[data-tb='source']")) {
      box.checked = cited.has(box.value);
    }
  }

  function sync(target: Target) {
    if (target.kind === "text") {
      const { block } = target;
      if (role) role.value = block.role;
      showCount(block.text.length, TEXT_LIMITS[block.role]);
      if (citeCount) {
        const n = block.sourceIds?.length ?? 0;
        citeCount.textContent = n > 0 ? String(n) : "";
        cite?.setAttribute("aria-label", n > 0 ? `Cite a source, ${n} cited` : "Cite a source");
      }
      syncSources(target);
    } else if (target.kind === "claim") {
      showCount(target.scene.summary?.text.length ?? 0, SUMMARY_LIMIT);
    }
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
  }

  /** The block moves with every keystroke and every redraw, so placing waits for the next frame and happens once. */
  function soon() {
    if (frame === undefined) frame = requestAnimationFrame(place);
  }

  function hide() {
    closePop();
    element.hidden = true;
    shown = undefined;
  }

  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !shown) return;
    event.stopPropagation();
    if (pop && !pop.hidden) closePop(true);
    else hooks.focusBlock(shown.id);
  });

  const onPointerDown = (event: PointerEvent) => {
    if (pop && !pop.hidden && !(event.target instanceof Node && element.contains(event.target))) closePop();
  };
  document.addEventListener("pointerdown", onPointerDown);

  return {
    element,
    render(inScene, id) {
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
      }
      sync(target);
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
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
  };
}
