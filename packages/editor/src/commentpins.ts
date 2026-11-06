import { COMMENT_LIMITS, type Comment, type CommentOp, type Scene, type Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { CommentBook } from "./commentbook.ts";
import {
  type Anchor,
  anchorAt,
  DEFAULT_ANCHOR,
  DRAG_MIN,
  type PinState,
  type PinView,
  type Point,
  pinsOf,
  pointOf,
  regionAt,
  regionBox,
  stateOf,
  WHO,
} from "./commentview.ts";
import { slideIn } from "./pin.ts";
import { restingBox } from "./snap.ts";
import { describeBlock } from "./templates.ts";

export interface CommentSurface {
  /** The comments to draw and to write through. */
  book: CommentBook;
  /** The tool, the visibility or the resolved filter changed, so the buttons that show them can follow. */
  changed(): void;
}

export interface CommentPins {
  /** Draws a pin for each comment of the scene, in place of the last ones. */
  draw(scene: Scene | undefined): void;
  /** Puts each pin, and the open thread, against its block again, after the slide changed size or a block moved. */
  place(): void;
  /** While the tool is on a press on a block starts a comment there. It turns itself off after one comment. */
  readonly tool: boolean;
  setTool(on: boolean): void;
  /** The pins are on the slide. Off, there are none and the tool cannot be used. */
  readonly shown: boolean;
  setShown(on: boolean): void;
  /** Resolved comments are drawn too, dimmed. */
  readonly showResolved: boolean;
  setShowResolved(on: boolean): void;
  /** Opens the box that writes a comment on a block of the scene, at a point or an area of it or at the usual corner. */
  compose(blockId: string, at?: Anchor): boolean;
  /** Opens the thread of a comment of the scene. False when the scene has no such comment. */
  open(id: string): boolean;
  /** Puts the open thread or box away. */
  close(refocus?: boolean): void;
  /** Whether a thread or the box is open. */
  readonly isOpen: boolean;
  destroy(): void;
}

/** Said under the tool's banner. The second is for a press that landed on no block. */
const TOOL_HINT = "Click a block to comment on it, or drag to mark an area. Esc to stop.";
const MISS_HINT = "That is not a block. Click a text, a chart, an image, a clip or the claim.";

const GAP = 8;
const ORPHAN_STEP = 6;
const SAY: Record<PinState, string> = {
  open: "open",
  task: "waiting for the agent",
  answered: "the agent has replied",
  resolved: "resolved",
};

type Open = { kind: "thread"; id: string } | { kind: "new"; block: string; at: Anchor };

const hasArea = (anchor: Anchor): anchor is Required<Anchor> =>
  anchor.w !== undefined && anchor.h !== undefined;

/** What a comment points at, in words: the claim, or the kind of block and the start of its text. */
function nameOf(scene: Scene, id: string): string {
  if (scene.summary?.id === id) return "the claim";
  const block = scene.blocks.find((candidate) => candidate.id === id);
  return block ? describeBlock(block, 40, scene) : "a block that is gone";
}

function whenOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const shorten = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * The comments on the slide: a numbered pin at the point of each block that a comment was made on, the thread that
 * opens from it, and the tool that starts a new one. Everything lives in the overlay, never in a block, so nothing
 * here is part of the text a person edits and nothing is part of the deck. A pin is kept as a fraction of its block,
 * so it follows the block when the block moves, is pinned or changes size.
 */
export function createCommentPins(
  session: Session,
  host: HTMLElement,
  overlay: HTMLElement,
  nodeOf: (id: string) => HTMLElement | undefined,
  surface: CommentSurface,
  at?: Element,
): CommentPins {
  const { book } = surface;
  const catcher = h("div", { class: "ed-comment-catch", hidden: true });
  const pinLayer = h("div", { class: "ed-pins" });
  const banner = h("p", { class: "ed-comment-banner", role: "status", hidden: true }, TOOL_HINT);
  const layer = h("div", { class: "ed-comments" }, catcher, pinLayer, banner);
  let sceneId: string | undefined;
  let tool = false;
  let shown = true;
  let showResolved = false;
  let open: Open | undefined;
  let frame: number | undefined;

  const scene = () => (sceneId === undefined ? undefined : session.doc.scenes[sceneId]);
  const targets = (current: Scene) => [
    ...current.blocks.map((block) => block.id),
    ...(current.summary ? [current.summary.id] : []),
  ];
  const find = (id: string): Comment | undefined => book.state.comments.find((comment) => comment.id === id);

  // The thread

  interface Panel {
    root: HTMLElement;
    title: HTMLElement;
    state: HTMLElement;
    list: HTMLElement;
    field: HTMLTextAreaElement;
    problem: HTMLElement;
    submit: HTMLButtonElement;
    ask: HTMLButtonElement | undefined;
    toggle: HTMLButtonElement | undefined;
    remove: HTMLButtonElement | undefined;
  }
  let panel: Panel | undefined;
  /** Where a comment being written will point, drawn as an empty pin until it is sent. */
  let draft: HTMLElement | undefined;
  /** The area a comment being written marks, outlined until it is sent. */
  let draftArea: HTMLElement | undefined;
  let busy = false;
  const keyOf = (item: Open) => (item.kind === "thread" ? `thread:${item.id}` : `new:${item.block}`);

  /** The pin a thread was opened from, so the keyboard goes back to it when the thread is put away. */
  const pinOf = (id: string) =>
    [...pinLayer.querySelectorAll<HTMLElement>("[data-pin]")].find((node) => node.dataset.pin === id);

  function close(refocus = false) {
    if (!panel || !open) return;
    const was = open;
    panel.root.remove();
    draft?.remove();
    draftArea?.remove();
    panel = undefined;
    draft = undefined;
    draftArea = undefined;
    open = undefined;
    busy = false;
    document.removeEventListener("pointerdown", outside, true);
    for (const node of pinLayer.querySelectorAll("[aria-expanded='true']"))
      node.setAttribute("aria-expanded", "false");
    if (!refocus) return;
    const back = was.kind === "thread" ? pinOf(was.id) : nodeOf(was.block);
    if (back?.isConnected && back.matches("button, [tabindex], [data-pick], [data-edit]"))
      back.focus({ preventScroll: true });
  }

  /** A press anywhere else puts the box away, unless something was written in it that the press would lose. */
  function outside(event: Event) {
    if (!panel || !(event.target instanceof Node)) return;
    if (
      panel.root.contains(event.target) ||
      (event.target instanceof Element && event.target.closest("[data-pin]"))
    )
      return;
    if (panel.field.value.trim() === "") close();
  }

  function problem(text: string | undefined) {
    if (!panel) return;
    panel.problem.textContent = text ?? "";
    panel.problem.hidden = text === undefined;
  }

  /** Whether a send can be made: some text, and nothing already on its way. */
  function ready() {
    if (!panel) return;
    const empty = panel.field.value.trim() === "";
    panel.submit.disabled = empty || busy;
    if (panel.ask) panel.ask.disabled = empty || busy;
    if (panel.toggle) panel.toggle.disabled = busy;
    if (panel.remove) panel.remove.disabled = busy;
  }

  async function send(ops: readonly CommentOp[], then: (added: string[]) => void) {
    if (!panel || busy) return;
    const mine = panel;
    busy = true;
    ready();
    problem(undefined);
    const result = await book.apply(ops);
    busy = false;
    if (panel !== mine) return; // put away while the file was being written
    ready();
    if (!result.ok) return problem(result.message);
    then(result.added);
  }

  function reply() {
    if (open?.kind !== "thread" || !panel) return;
    const { id } = open;
    const text = panel.field.value.trim();
    if (text === "") return;
    void send([{ op: "comment.reply", id, author: "you", text }], () => {
      if (!panel) return;
      panel.field.value = "";
      ready();
      // The thread was filled again while the answer came in, and the keyboard stays where the person is writing.
      panel.field.focus({ preventScroll: true });
    });
  }

  function start(ask: boolean) {
    const current = scene();
    if (open?.kind !== "new" || !panel || !current) return;
    const { block, at } = open;
    const text = panel.field.value.trim();
    if (text === "") return;
    void send(
      [
        {
          op: "comment.add",
          scene: current.id,
          block,
          anchor: at,
          author: "you",
          text,
          ...(ask ? { ask: true } : {}),
        },
      ],
      (added) => {
        const id = added[0];
        close();
        if (id !== undefined) openThread(id);
      },
    );
  }

  function buildPanel(item: Open): Panel {
    const fresh = item.kind === "new";
    const title = h("h3", { class: "ed-thread-title" });
    const closer = h(
      "button",
      { type: "button", class: "ed-thread-close", "aria-label": "Close", "data-comment": "close" },
      "×",
    );
    closer.addEventListener("click", () => close(true));
    const state = h("p", { class: "ed-thread-state", role: "status" });
    const list = h("ol", { class: "ed-thread-list" });
    const field = h("textarea", {
      class: "ed-thread-field",
      rows: 3,
      maxlength: COMMENT_LIMITS.text,
      "data-comment": "field",
      "aria-label": fresh ? "Your comment" : "Your reply",
      placeholder: fresh ? "Write a comment" : "Write a reply",
    });
    const submit = h(
      "button",
      { type: "submit", class: "ed-thread-send", "data-comment": fresh ? "add" : "reply" },
      fresh ? "Comment" : "Reply",
    );
    const ask = fresh
      ? h(
          "button",
          {
            type: "button",
            class: "ed-thread-ask",
            "data-comment": "ask",
            title: "Comment, and ask the agent to act on it",
          },
          "Ask the agent",
        )
      : undefined;
    const toggle = fresh ? undefined : h("button", { type: "button", "data-comment": "resolve" });
    const remove = fresh
      ? undefined
      : h("button", { type: "button", class: "ed-danger", "data-comment": "delete" }, "Delete");
    const problemLine = h("p", { class: "ed-thread-problem", role: "alert", hidden: true });
    const form = h(
      "form",
      { class: "ed-thread-form" },
      field,
      h("div", { class: "ed-thread-actions" }, submit, ask, toggle, remove),
    );
    const root = h(
      "div",
      { class: "ed-thread", role: "dialog", "aria-label": "Comment", "data-thread": keyOf(item) },
      h("div", { class: "ed-thread-head" }, title, closer),
      state,
      list,
      problemLine,
      form,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (fresh) start(false);
      else reply();
    });
    ask?.addEventListener("click", () => start(true));
    field.addEventListener("input", ready);
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        if (fresh) start(false);
        else reply();
      }
    });
    toggle?.addEventListener("click", () => {
      if (open?.kind !== "thread") return;
      const comment = find(open.id);
      if (!comment) return;
      const op: CommentOp = comment.resolved
        ? { op: "comment.reopen", id: comment.id }
        : { op: "comment.resolve", id: comment.id };
      void send([op], () => {});
    });
    // Deleting a thread loses it for good, so the button asks once more, and a press anywhere else takes it back.
    remove?.addEventListener("click", () => {
      if (open?.kind !== "thread") return;
      if (remove.dataset.confirm === undefined) {
        remove.dataset.confirm = "";
        remove.textContent = "Delete the thread?";
        return;
      }
      const { id } = open;
      void send([{ op: "comment.delete", id }], () => close(true));
    });
    remove?.addEventListener("blur", () => {
      delete remove.dataset.confirm;
      remove.textContent = "Delete";
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    });
    return { root, title, state, list, field, problem: problemLine, submit, ask, toggle, remove };
  }

  /** Brings the open thread up to date with the file, without rebuilding the box the person may be writing in. */
  function fill() {
    if (!panel || !open) return;
    const current = scene();
    if (!current) return close();
    if (open.kind === "new") {
      if (!targets(current).includes(open.block)) return close();
      panel.title.textContent = `Comment on ${nameOf(current, open.block)}`;
      panel.root.setAttribute("aria-label", panel.title.textContent);
      ready();
      return;
    }
    const comment = find(open.id);
    if (!comment || comment.scene !== current.id) return close();
    const pin = pinsOf(book.state.comments, session.doc, current.id, true).find(
      (view) => view.comment.id === comment.id,
    );
    const state = stateOf(comment);
    const gone = pin?.orphan === true;
    panel.title.textContent = `Comment ${pin?.number ?? ""} on ${nameOf(current, comment.block)}`.replace(
      "  ",
      " ",
    );
    panel.root.setAttribute("aria-label", panel.title.textContent);
    panel.root.dataset.state = state;
    panel.state.textContent = [
      gone ? "The block this was about is gone." : "",
      state === "task"
        ? "Waiting for the agent."
        : state === "answered"
          ? "The agent has replied."
          : state === "resolved"
            ? "Resolved."
            : "",
    ]
      .filter(Boolean)
      .join(" ");
    panel.state.hidden = panel.state.textContent === "";
    panel.list.replaceChildren(
      ...comment.thread.map((message) =>
        h(
          "li",
          { class: "ed-thread-message", "data-author": message.author },
          h(
            "p",
            { class: "ed-thread-who" },
            WHO[message.author],
            " ",
            h("time", { datetime: message.at }, whenOf(message.at)),
          ),
          h("p", { class: "ed-thread-text" }, message.text),
        ),
      ),
    );
    if (panel.toggle) panel.toggle.textContent = comment.resolved ? "Reopen" : "Resolve";
    ready();
  }

  function openPanel(item: Open) {
    if (open && keyOf(open) === keyOf(item) && panel) return;
    close();
    open = item;
    panel = buildPanel(item);
    if (item.kind === "new") {
      draft = h("span", { class: "ed-pin ed-pin-draft", "aria-hidden": "true" }, "+");
      layer.append(draft);
      if (hasArea(item.at)) {
        draftArea = h("span", { class: "ed-region ed-region-draft", "aria-hidden": "true" });
        layer.append(draftArea);
      }
    }
    layer.append(panel.root);
    document.addEventListener("pointerdown", outside, true);
    fill();
    if (!panel) return; // fill put it away: what it was opened for is not there
    place();
    panel.field.focus({ preventScroll: true });
  }

  function openThread(id: string): boolean {
    const comment = find(id);
    if (!comment || comment.scene !== sceneId) return false;
    if (!shown) setShown(true);
    openPanel({ kind: "thread", id });
    for (const node of pinLayer.querySelectorAll<HTMLElement>("[data-pin]")) {
      node.setAttribute("aria-expanded", String(node.dataset.pin === id));
    }
    return true;
  }

  // The pins

  /** Where on the screen a comment points: against its block, or in the corner of the slide when the block is gone. */
  function pointFor(view: PinView, orphans: number, size: number): Point {
    const node = view.orphan ? undefined : nodeOf(view.comment.block);
    if (node) return pointOf(view.comment.anchor, restingBox(node));
    const room = host.querySelector<HTMLElement>(".dc-view");
    const slide = room ? slideIn(room.getBoundingClientRect()) : host.getBoundingClientRect();
    return { x: slide.left + GAP + size / 2 + orphans * (size + ORPHAN_STEP), y: slide.top + GAP + size / 2 };
  }

  function pinFor(view: PinView, current: Scene): HTMLElement {
    const { comment } = view;
    const first = comment.thread[0]?.text ?? "";
    const target = view.orphan ? "a block that is gone" : nameOf(current, comment.block);
    const pin = h(
      "button",
      {
        type: "button",
        class: "ed-pin",
        "data-pin": comment.id,
        "data-state": view.state,
        "data-orphan": view.orphan ? "" : undefined,
        "aria-haspopup": "dialog",
        "aria-expanded": String(open?.kind === "thread" && open.id === comment.id),
        "aria-label": `Comment ${view.number} on ${target}, ${SAY[view.state]}: ${shorten(first, 60)}`,
      },
      String(view.number),
    );
    pin.addEventListener("click", () => {
      if (open?.kind === "thread" && open.id === comment.id) close(true);
      else openThread(comment.id);
    });
    return pin;
  }

  /** Puts an area's outline over the pixels it covers, in the layer's own coordinates. */
  function areaAt(
    node: HTMLElement,
    box: { left: number; top: number; width: number; height: number },
    origin: DOMRect,
  ) {
    node.style.left = `${box.left - origin.left}px`;
    node.style.top = `${box.top - origin.top}px`;
    node.style.width = `${box.width}px`;
    node.style.height = `${box.height}px`;
  }

  function place() {
    const origin = host.getBoundingClientRect();
    let orphans = 0;
    let anchor: { node: HTMLElement; point: Point } | undefined;
    const views = new Map(
      (scene() ? pinsOf(book.state.comments, session.doc, sceneId as string, true) : []).map((view) => [
        view.comment.id,
        view,
      ]),
    );
    for (const node of pinLayer.querySelectorAll<HTMLElement>("[data-pin]")) {
      const view = views.get(node.dataset.pin ?? "");
      if (!view) continue;
      const size = node.offsetWidth || 28;
      const point = pointFor(view, view.orphan ? orphans++ : 0, size);
      const left = Math.max(0, Math.min(point.x - origin.left - size / 2, origin.width - size));
      const top = Math.max(0, Math.min(point.y - origin.top - size / 2, origin.height - size));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      if (open?.kind === "thread" && open.id === view.comment.id)
        anchor = { node, point: { x: left + size / 2, y: top + size / 2 } };
    }
    for (const node of pinLayer.querySelectorAll<HTMLElement>("[data-region]")) {
      const view = views.get(node.dataset.region ?? "");
      const target = view && !view.orphan ? nodeOf(view.comment.block) : undefined;
      if (view && target && hasArea(view.comment.anchor)) {
        areaAt(node, regionBox(view.comment.anchor, restingBox(target)), origin);
      }
    }
    if (draft && open?.kind === "new") {
      const node = nodeOf(open.block);
      if (node && draftArea && hasArea(open.at))
        areaAt(draftArea, regionBox(open.at, restingBox(node)), origin);
      if (node) {
        const spot = pointOf(open.at, restingBox(node));
        const size = draft.offsetWidth || 28;
        const left = Math.max(0, Math.min(spot.x - origin.left - size / 2, origin.width - size));
        const top = Math.max(0, Math.min(spot.y - origin.top - size / 2, origin.height - size));
        draft.style.left = `${left}px`;
        draft.style.top = `${top}px`;
        anchor = { node: draft, point: { x: left + size / 2, y: top + size / 2 } };
      }
    }
    if (!panel || !open) return;
    // An open thread whose pin is not drawn, such as a resolved one, still sits where the comment points.
    let at = anchor?.point;
    let size = anchor?.node.offsetWidth || 28;
    if (!at && open.kind === "new") {
      const node = nodeOf(open.block);
      if (node) {
        const point = pointOf(open.at, restingBox(node));
        at = { x: point.x - origin.left, y: point.y - origin.top };
      }
    } else if (!at && open.kind === "thread") {
      const comment = find(open.id);
      const node = comment ? nodeOf(comment.block) : undefined;
      if (comment && node) {
        const point = pointOf(comment.anchor, restingBox(node));
        at = { x: point.x - origin.left, y: point.y - origin.top };
      }
    }
    size = at ? size : 28;
    const width = panel.root.offsetWidth;
    const height = panel.root.offsetHeight;
    const near = at ?? { x: origin.width / 2, y: origin.height / 2 };
    const right = near.x + size / 2 + GAP;
    const left = right + width > origin.width ? near.x - size / 2 - GAP - width : right;
    panel.root.style.left = `${Math.max(0, Math.min(left, origin.width - width))}px`;
    panel.root.style.top = `${Math.max(0, Math.min(near.y - size / 2, origin.height - height))}px`;
  }

  const soon = () => {
    if (frame === undefined) {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        place();
      });
    }
  };
  // The slide scales with the room it has, so a resized window or an opened panel moves every pin.
  const resized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
  resized?.observe(host);

  function draw(next: Scene | undefined) {
    const active = document.activeElement;
    const kept = active instanceof HTMLElement && pinLayer.contains(active) ? active.dataset.pin : undefined;
    if (next?.id !== sceneId) close();
    sceneId = next?.id;
    layer.hidden = !shown;
    const views = next && shown ? pinsOf(book.state.comments, session.doc, next.id, showResolved) : [];
    const areas = views
      .filter((view) => !view.orphan && hasArea(view.comment.anchor))
      .map((view) =>
        h("span", {
          class: "ed-region",
          "data-region": view.comment.id,
          "data-state": view.state,
          "aria-hidden": "true",
        }),
      );
    pinLayer.replaceChildren(...areas, ...views.map((view) => pinFor(view, next as Scene)));
    fill();
    place();
    if (kept !== undefined) pinOf(kept)?.focus({ preventScroll: true });
  }

  // The tool

  /** A block under a point of the screen, found through the slide and not through the layer that is over it. */
  function blockAt(x: number, y: number): string | undefined {
    const current = scene();
    if (!current || typeof document.elementsFromPoint !== "function") return undefined;
    const ids = targets(current);
    for (const node of document.elementsFromPoint(x, y)) {
      if (!host.contains(node) || overlay.contains(node)) continue;
      const id = node.closest<HTMLElement>("[data-id]")?.dataset.id;
      if (id !== undefined && ids.includes(id)) return id;
    }
    return undefined;
  }

  // A press that moves marks an area of the block it started on; one that stays is a click and leaves a pin.
  let press: { id: string; from: Point; moved: boolean } | undefined;
  /** The click that ends a drag follows it, and must not also leave a pin. */
  let dragged = false;
  const rubber = h("span", { class: "ed-region ed-region-draft", hidden: true, "aria-hidden": "true" });
  layer.append(rubber);

  const endPress = () => {
    press = undefined;
    rubber.hidden = true;
  };

  catcher.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const id = blockAt(event.clientX, event.clientY);
    press = id === undefined ? undefined : { id, from: { x: event.clientX, y: event.clientY }, moved: false };
  });

  catcher.addEventListener("pointermove", (event) => {
    const node = press ? nodeOf(press.id) : undefined;
    if (!press || !node) return;
    const to = { x: event.clientX, y: event.clientY };
    if (!press.moved && Math.hypot(to.x - press.from.x, to.y - press.from.y) < DRAG_MIN) return;
    press.moved = true;
    const area = regionAt(press.from, to, restingBox(node)) as Required<Anchor>;
    areaAt(rubber, regionBox(area, restingBox(node)), host.getBoundingClientRect());
    rubber.hidden = false;
  });

  catcher.addEventListener("pointerup", (event) => {
    const was = press;
    endPress();
    const node = was ? nodeOf(was.id) : undefined;
    if (!was?.moved || !node) return;
    dragged = true;
    compose(was.id, regionAt(was.from, { x: event.clientX, y: event.clientY }, restingBox(node)));
  });
  catcher.addEventListener("pointercancel", endPress);

  catcher.addEventListener("click", (event) => {
    if (dragged) {
      dragged = false;
      return;
    }
    const id = blockAt(event.clientX, event.clientY);
    if (id === undefined) {
      banner.textContent = MISS_HINT;
      banner.dataset.problem = "";
      return;
    }
    const node = nodeOf(id);
    const at = node ? anchorAt({ x: event.clientX, y: event.clientY }, restingBox(node)) : DEFAULT_ANCHOR;
    compose(id, at);
  });

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && tool && !panel && !event.defaultPrevented) {
      event.preventDefault();
      setTool(false);
    }
  };

  function setTool(on: boolean) {
    if (on && !shown) setShown(true);
    if (on === tool) return;
    tool = on;
    catcher.hidden = !on;
    banner.hidden = !on;
    banner.textContent = TOOL_HINT;
    delete banner.dataset.problem;
    host.toggleAttribute("data-commenting", on);
    if (on) {
      close();
      document.addEventListener("keydown", onKey);
    } else {
      document.removeEventListener("keydown", onKey);
    }
    surface.changed();
  }

  function setShown(on: boolean) {
    if (on === shown) return;
    shown = on;
    if (!on) {
      setTool(false);
      close();
    }
    draw(scene());
    surface.changed();
  }

  function compose(blockId: string, at: Anchor = DEFAULT_ANCHOR): boolean {
    const current = scene();
    if (!current || !targets(current).includes(blockId)) return false;
    if (!shown) setShown(true);
    setTool(false);
    openPanel({ kind: "new", block: blockId, at });
    return true;
  }

  // The layer goes in over the grips and the build badges, and under the toolbar, which is added to the overlay after.
  // Made later than the toolbar, it takes the place `at` that was kept for it.
  if (at) at.replaceWith(layer);
  else overlay.append(layer);
  const unsubscribe = book.subscribe(() => draw(scene()));

  return {
    draw,
    place,
    get tool() {
      return tool;
    },
    setTool,
    get shown() {
      return shown;
    },
    setShown,
    get showResolved() {
      return showResolved;
    },
    setShowResolved(on) {
      if (on === showResolved) return;
      showResolved = on;
      draw(scene());
      surface.changed();
    },
    compose,
    open: openThread,
    close,
    get isOpen() {
      return open !== undefined;
    },
    destroy() {
      unsubscribe();
      close();
      document.removeEventListener("keydown", onKey);
      resized?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      layer.remove();
    },
  };
}
