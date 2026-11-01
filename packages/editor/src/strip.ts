import type { ApplyOptions, Op, Scene, Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import { afterWhenMoving } from "./cleanup.ts";
import type { Count } from "./commentview.ts";
import { problemOf } from "./fields.ts";
import { sortableItems } from "./sortable.ts";
import { LAYOUT_CHOICES, type Layout, LEAD_LABEL, newScene, uniqueId } from "./templates.ts";
import { createDrawQueue, type Drawn, fitThumbnails, isStale, thumbnailFrame } from "./thumbnail.ts";

/** How long the edited scene waits for typing to pause before its thumbnail is drawn again. */
const EDIT_QUIET_MS = 250;
const SCENE_TITLE_LIMIT = 120;

export interface StripHooks {
  select(sceneId: string): void;
  act(ops: readonly Op[], options?: ApplyOptions): ReturnType<Session["apply"]>;
  /** How many comments each scene has, read once each time the list is brought up to date. */
  comments?(): ReadonlyMap<string, Count>;
  /** How many changes since the last review each scene has, read once each time the list is brought up to date. */
  changed?(): ReadonlyMap<string, number>;
  /** Opens the storyboard. The strip has a button for it only when it is given a way to. */
  storyboard?(): void;
}

export interface Strip {
  readonly element: HTMLElement;
  /** Brings the list, the numbers and the marks up to date, and queues the thumbnails that went stale. */
  render(selected: string): void;
  /** Draws every stale thumbnail now. The strip does this by itself a frame later. */
  flush(): void;
  /** What the buttons of a scene do, for the right-click menu: each is one step of Undo, and a refusal is shown under the list. */
  duplicate(id: string): void;
  remove(id: string): void;
  move(id: string, direction: -1 | 1): void;
  destroy(): void;
}

interface Item {
  li: HTMLLIElement;
  num: HTMLElement;
  title: HTMLElement;
  lead: HTMLElement;
  /** The count of open comments on the scene, on its thumbnail. Hidden when there are none. */
  notes: HTMLElement;
  /** The count of changes since the last review, on the other lower corner. Hidden when there are none. */
  changes: HTMLElement;
  thumb: HTMLElement;
  pick: HTMLButtonElement;
  earlier: HTMLButtonElement;
  later: HTMLButtonElement;
  duplicate: HTMLButtonElement;
  remove: HTMLButtonElement;
  /** What the thumbnail was last drawn from. A different scene object, or theme, means it is out of date. */
  drawn: Drawn | undefined;
}

/** A copy of a scene under a new id. Ids inside a scene only have to be unique within it, so they stay. */
function copyOf(scene: Scene, taken: ReadonlySet<string>) {
  const { schemaVersion: _version, ...rest } = JSON.parse(JSON.stringify(scene)) as Scene;
  const title = `${scene.title.slice(0, SCENE_TITLE_LIMIT - " (copy)".length)} (copy)`;
  return { ...rest, id: uniqueId(`${scene.id}-copy`, taken), title };
}

/**
 * The strip of scenes on the left: a thumbnail of each, its number, title and who leads it, with move, duplicate
 * and delete on the scene itself and the controls that add a scene below. Rows are kept between renders, so a
 * keystroke on the slide updates one title and queues one thumbnail instead of rebuilding the list.
 */
export function createStrip(session: Session, hooks: StripHooks): Strip {
  const items = new Map<string, Item>();
  const list = h("ol", { class: "ed-scene-list" });
  const sortable = sortableItems(list, {
    ids: () => session.doc.deck.scenes,
    move: (id, after) => void hooks.act([{ op: "scene.move", id, after }]),
  });

  const layoutChoice = h(
    "select",
    { "aria-label": "Layout for the new scene", "data-field": "rail:layout" },
    ...LAYOUT_CHOICES.map((choice) => h("option", { value: choice.value }, choice.label)),
  );
  const problem = h("p", { class: "ed-problem", role: "alert", hidden: true });
  let current = session.doc.deck.scenes[0] as string;

  const run = (ops: readonly Op[]) => {
    const result = hooks.act(ops);
    problem.hidden = result.ok;
    problem.textContent = result.ok ? "" : problemOf(result);
    return result;
  };
  const addScene = h("button", { type: "button", "data-action": "add-scene" }, "Add scene");
  addScene.addEventListener("click", () => {
    const scene = newScene(session.doc, layoutChoice.value as Layout);
    if (run([{ op: "scene.add", scene, after: current }]).ok) hooks.select(scene.id);
  });

  function duplicateScene(id: string) {
    const scene = session.doc.scenes[id];
    if (!scene) return;
    const copy = copyOf(scene, new Set(session.doc.deck.scenes));
    if (run([{ op: "scene.add", scene: copy, after: id }]).ok) hooks.select(copy.id);
  }

  function removeScene(id: string) {
    const order = session.doc.deck.scenes;
    const at = order.indexOf(id);
    if (at < 0) return;
    const neighbour = order[at + 1] ?? order[at - 1];
    // Only the scene being edited has to hand over the slide; deleting another leaves the slide as it is.
    // Asked before the removal, because the editor re-points its own selection as the deck changes.
    const editing = id === current;
    if (run([{ op: "scene.remove", id }]).ok && editing && neighbour) hooks.select(neighbour);
  }

  function moveScene(id: string, direction: -1 | 1) {
    const after = afterWhenMoving(session.doc.deck.scenes, id, direction);
    if (after !== undefined) run([{ op: "scene.move", id, after }]);
  }

  // Every scene on one screen. It sits above the list, so it is found without scrolling to the end of a long deck.
  let storyboard: HTMLButtonElement | null = null;
  const openBoard = hooks.storyboard;
  if (openBoard) {
    storyboard = h("button", {
      type: "button",
      class: "ed-open-board",
      "data-action": "storyboard",
      title: "See every scene on one screen",
    });
    storyboard.append(h("span", { class: "ed-icon ed-icon-board", "aria-hidden": "true" }), "Storyboard");
    storyboard.addEventListener("click", () => openBoard());
  }

  const element = h(
    "nav",
    { class: "ed-scenes", "aria-label": "Scenes" },
    storyboard,
    list,
    h("div", { class: "ed-add-scene" }, layoutChoice, addScene),
    problem,
  );

  function create(id: string): Item {
    const num = h("span", { class: "ed-num" });
    const title = h("span", { class: "ed-title" });
    const lead = h("span", { class: "ed-lead" });
    const pick = h("button", { type: "button", class: "ed-scene", "data-scene": id }, num, title, lead);
    pick.addEventListener("click", () => hooks.select(id));

    // The thumbnail is a picture for the mouse; the button beside it is the way in for the keyboard and for
    // screen readers, so the picture is hidden from both.
    const thumb = h("div", { class: "ed-thumb", "aria-hidden": "true" });
    thumb.addEventListener("click", () => hooks.select(id));

    // Dragging is for the mouse; these two are the way to reorder from the keyboard.
    const mover = (direction: -1 | 1, action: string) => {
      const button = h("button", { type: "button", "data-action": action });
      button.addEventListener("click", () => moveScene(id, direction));
      return button;
    };
    const earlier = mover(-1, "move-scene-earlier");
    const later = mover(1, "move-scene-later");
    const duplicate = h("button", { type: "button", "data-action": "duplicate-scene" });
    duplicate.addEventListener("click", () => duplicateScene(id));
    const remove = h("button", { type: "button", "data-action": "delete-scene", class: "ed-danger" });
    remove.addEventListener("click", () => removeScene(id));

    // A mark on the picture, so it is seen without reading. The button beside it says the same in words. It sits in
    // the picture's lower corner, which the scene's own buttons in the upper one never cover.
    const notes = h("span", { class: "ed-scene-notes", hidden: true, "aria-hidden": "true" });
    const changes = h("span", { class: "ed-scene-changed", hidden: true, "aria-hidden": "true" }, "Changed");
    thumb.append(changes, notes);
    const li = h(
      "li",
      { "data-id": id },
      pick,
      thumb,
      h("div", { class: "ed-scene-actions" }, earlier, later, duplicate, remove),
    );
    sortable.add(id, li);
    return {
      li,
      num,
      title,
      lead,
      notes,
      changes,
      thumb,
      pick,
      earlier,
      later,
      duplicate,
      remove,
      drawn: undefined,
    };
  }

  // Thumbnails

  const queue = createDrawQueue(draw);
  let quiet: ReturnType<typeof setTimeout> | undefined;

  function draw(id: string) {
    const item = items.get(id);
    const scene = session.doc.scenes[id];
    if (!item || !scene) return;
    const theme = session.doc.deck.theme;
    if (!isStale(item.drawn, scene, theme)) return;
    // The picture itself is inert, so nothing in it can take focus or a click; the thumbnail around it takes them.
    item.thumb.replaceChildren(thumbnailFrame(scene, theme), item.changes, item.notes);
    item.drawn = { scene, theme };
    measure();
  }

  const measure = () => fitThumbnails(list);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
  observer?.observe(list);

  // The list

  function render(selected: string) {
    current = selected;
    const { deck, scenes } = session.doc;
    const live = new Set(deck.scenes);
    for (const [id, item] of items) {
      if (live.has(id)) continue;
      item.li.remove();
      items.delete(id);
      queue.remove(id);
      sortable.remove(id);
    }

    let edited = false;
    let fresh = false;
    const total = deck.scenes.length;
    const counts = hooks.comments?.();
    const changed = hooks.changed?.();
    for (const [index, id] of deck.scenes.entries()) {
      const scene = scenes[id] as Scene;
      const item = items.get(id) ?? create(id);
      items.set(id, item);
      const label = `scene ${index + 1}, ${scene.title}`;
      const count = counts?.get(id);
      const open = count?.open ?? 0;
      const tasks = count?.tasks ?? 0;
      const edits = changed?.get(id) ?? 0;
      item.notes.hidden = open === 0;
      item.notes.toggleAttribute("data-tasks", tasks > 0);
      if (item.notes.textContent !== String(open)) item.notes.textContent = String(open);
      item.changes.hidden = edits === 0;
      // The scene's own button is what a screen reader meets, so it carries the counts. With none it keeps its contents.
      const said: string[] = [];
      if (open > 0) {
        const waiting = tasks > 0 ? `, ${tasks} waiting for the agent` : "";
        said.push(`${open} open ${open === 1 ? "comment" : "comments"}${waiting}`);
      }
      if (edits > 0) said.push(`${edits} ${edits === 1 ? "change" : "changes"} to review`);
      if (said.length === 0) item.pick.removeAttribute("aria-label");
      else item.pick.setAttribute("aria-label", `${label}, ${said.join(", ")}`);
      const text = { num: String(index + 1), title: scene.title, lead: LEAD_LABEL[scene.lead ?? "human"] };
      if (item.num.textContent !== text.num) item.num.textContent = text.num;
      if (item.title.textContent !== text.title) item.title.textContent = text.title;
      if (item.lead.textContent !== text.lead) item.lead.textContent = text.lead;
      item.lead.dataset.lead = scene.lead ?? "human";
      item.pick.setAttribute("aria-current", id === selected ? "true" : "false");
      item.li.toggleAttribute("data-current", id === selected);
      const at = index + 1;
      item.earlier.setAttribute("aria-label", `Move ${label} earlier`);
      item.earlier.title = "Move scene earlier";
      item.earlier.toggleAttribute("disabled", index === 0);
      item.later.setAttribute("aria-label", `Move ${label} later`);
      item.later.title = "Move scene later";
      item.later.toggleAttribute("disabled", at === total);
      item.duplicate.setAttribute("aria-label", `Duplicate ${label}`);
      item.duplicate.title = "Duplicate scene";
      item.remove.setAttribute("aria-label", `Delete ${label}`);
      item.remove.title = "Delete scene";
      item.remove.toggleAttribute("disabled", total < 2);

      if (isStale(item.drawn, scene, deck.theme)) {
        queue.add(id);
        if (item.drawn === undefined) fresh = true;
        else edited = true;
      }
    }

    const wanted = deck.scenes.map((id) => (items.get(id) as Item).li);
    const shown = [...list.children];
    if (wanted.length !== shown.length || wanted.some((li, index) => li !== shown[index])) {
      // Putting the rows back drops the keyboard, so it is handed back to the control that had it.
      const held = document.activeElement;
      const keyboard = held instanceof HTMLElement && list.contains(held) ? held : undefined;
      list.replaceChildren(...wanted);
      keyboard?.focus({ preventScroll: true });
    }
    // `flex-direction` is "row" even on a grid, so it only counts when the list really is a flex container.
    const layout = getComputedStyle(list);
    list.dataset.axis = layout.display.includes("flex") && layout.flexDirection.startsWith("row") ? "x" : "y";

    // A scene never drawn yet is drawn at once; one being typed into waits for a pause.
    if (fresh) queue.kick();
    if (edited) {
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = setTimeout(() => {
        quiet = undefined;
        queue.kick();
      }, EDIT_QUIET_MS);
    }
  }

  return {
    element,
    render,
    duplicate: duplicateScene,
    remove: removeScene,
    move: moveScene,
    flush() {
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = undefined;
      queue.flush();
    },
    destroy() {
      if (quiet !== undefined) clearTimeout(quiet);
      observer?.disconnect();
      queue.destroy();
    },
  };
}
