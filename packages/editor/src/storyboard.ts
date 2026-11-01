import type { Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Count } from "./commentview.ts";
import { type Card, cardsOf, pillsOf, type Step, sayCard, stepOfKey, stepTo } from "./storyboardview.ts";
import { createDrawQueue, type Drawn, fitThumbnails, isStale, thumbnailFrame } from "./thumbnail.ts";

export interface StoryboardHooks {
  /** Shows a scene on the slide. The storyboard closes itself right after. */
  open(sceneId: string): void;
  /** The scene on the slide, which the storyboard marks and puts the keyboard on when it opens. */
  selected(): string;
  /** How many comments each scene has, read each time the cards are brought up to date. */
  comments?(): ReadonlyMap<string, Count>;
  /** How many changes since the last review each scene has. */
  changed?(): ReadonlyMap<string, number>;
  /** How many things to check each scene has. */
  checks?(): ReadonlyMap<string, number>;
}

export interface Storyboard {
  /** The full-screen board. It belongs inside the editor's root, and is hidden until it is opened. */
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  /** Brings the cards up to date with the deck. Does nothing while the board is closed, and draws when it opens. */
  render(): void;
  destroy(): void;
}

interface Tile {
  li: HTMLLIElement;
  thumb: HTMLElement;
  pick: HTMLButtonElement;
  number: HTMLElement;
  name: HTMLElement;
  pills: HTMLElement;
  /** What the pills say, so a card whose marks did not change is not rebuilt under the keyboard. */
  said: string;
  drawn: Drawn | undefined;
}

const HINT = "Arrow keys move over the scenes, Enter opens one, Esc goes back to the slide.";

/**
 * The strip of scenes, full screen: a grid of every scene as the slide draws it, with its number and title and a pill
 * for who leads it and for what is waiting on it: changes, things to check, open comments and pinned blocks. A click or
 * Enter opens the scene on the slide. The grid is built when the board opens and let go of when it closes, so a long
 * deck costs nothing while the person is editing.
 */
export function createStoryboard(session: Session, hooks: StoryboardHooks): Storyboard {
  const tiles = new Map<string, Tile>();
  let open = false;
  /** The scene whose card holds the keyboard's place: the only one in the tab order. */
  let target: string | undefined;
  let returnTo: Element | null = null;
  /** What the board made inert on opening, so closing gives back exactly that and nothing that was inert already. */
  const held: Element[] = [];

  const back = h("button", { type: "button", "data-action": "close-storyboard" });
  back.append(h("span", { class: "ed-icon ed-icon-back", "aria-hidden": "true" }), "Back to the slide");
  const count = h("span", { class: "ed-board-count" });
  const grid = h("ol", { class: "ed-board-grid" });
  const element = h(
    "section",
    { class: "ed-board", role: "dialog", "aria-modal": "true", "aria-label": "Storyboard", tabindex: "-1" },
    h("header", { class: "ed-board-head" }, back, h("h2", {}, "Storyboard"), count, h("p", {}, HINT)),
    grid,
  );
  element.hidden = true;

  const queue = createDrawQueue(draw);
  const measure = () => fitThumbnails(grid);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;

  function draw(id: string) {
    const tile = tiles.get(id);
    const scene = session.doc.scenes[id];
    if (!tile || !scene) return;
    const theme = session.doc.deck.theme;
    tile.thumb.replaceChildren(thumbnailFrame(scene, theme));
    tile.drawn = { scene, theme };
    measure();
  }

  function pick(id: string) {
    close();
    hooks.open(id);
  }

  function make(id: string): Tile {
    const number = h("span", { class: "ed-card-number" });
    const name = h("span", { class: "ed-card-name" });
    const pills = h("span", { class: "ed-pills" });
    const button = h(
      "button",
      { type: "button", class: "ed-card-pick", "data-scene": id },
      number,
      name,
      pills,
    );
    button.addEventListener("click", () => pick(id));
    // The picture is for the mouse; the button under it is the way in for the keyboard and for screen readers.
    const thumb = h("div", { class: "ed-thumb", "aria-hidden": "true" });
    thumb.addEventListener("click", () => pick(id));
    const li = h("li", { class: "ed-card", "data-id": id }, thumb, button);
    return { li, thumb, pick: button, number, name, pills, said: "", drawn: undefined };
  }

  function update(tile: Tile, card: Card, current: string) {
    const text = String(card.number);
    if (tile.number.textContent !== text) tile.number.textContent = text;
    if (tile.name.textContent !== card.title) tile.name.textContent = card.title;
    const pills = pillsOf(card);
    const said = JSON.stringify(pills);
    if (said !== tile.said) {
      tile.said = said;
      tile.pills.replaceChildren(
        ...pills.map((pill) => {
          const node = h("span", { class: "ed-pill", "data-kind": pill.kind }, pill.text);
          if (pill.lead !== undefined) node.dataset.lead = pill.lead;
          node.toggleAttribute("data-tasks", pill.tasks === true);
          return node;
        }),
      );
    }
    tile.pick.setAttribute("aria-label", sayCard(card));
    tile.pick.setAttribute("aria-current", card.id === current ? "true" : "false");
    tile.pick.tabIndex = card.id === target ? 0 : -1;
    tile.li.toggleAttribute("data-current", card.id === current);
  }

  function render() {
    if (!open) return;
    const { doc } = session;
    const current = hooks.selected();
    const cards = cardsOf(doc, {
      comments: hooks.comments?.(),
      changed: hooks.changed?.(),
      checks: hooks.checks?.(),
    });
    const live = new Set(cards.map((card) => card.id));
    let lost = false;
    for (const [id, tile] of tiles) {
      if (live.has(id)) continue;
      lost ||= document.activeElement === tile.pick;
      tiles.delete(id);
      queue.remove(id);
    }
    if (target === undefined || !live.has(target)) target = live.has(current) ? current : cards[0]?.id;

    const stale: string[] = [];
    for (const card of cards) {
      const tile = tiles.get(card.id) ?? make(card.id);
      tiles.set(card.id, tile);
      update(tile, card, current);
      const scene = doc.scenes[card.id];
      if (scene && isStale(tile.drawn, scene, doc.deck.theme)) stale.push(card.id);
    }
    // The scene on show is drawn first, so it is the first thing the person sees come in.
    for (const id of stale.sort((a, b) => Number(b === current) - Number(a === current))) queue.add(id);

    const wanted = cards.map((card) => (tiles.get(card.id) as Tile).li);
    const shown = [...grid.children];
    if (wanted.length !== shown.length || wanted.some((li, index) => li !== shown[index])) {
      // Putting the cards back drops the keyboard, so it is handed back to the control that had it.
      const had = document.activeElement;
      const keyboard = had instanceof HTMLElement && grid.contains(had) ? had : undefined;
      grid.replaceChildren(...wanted);
      keyboard?.focus({ preventScroll: true });
    }
    // The card the keyboard was on is gone, such as a scene the agent just deleted: the keyboard goes to the next best.
    if (lost && target !== undefined) focusCard(target);
    const scenes = `${cards.length} ${cards.length === 1 ? "scene" : "scenes"}`;
    if (count.textContent !== scenes) count.textContent = scenes;
    measure();
    queue.kick();
  }

  /** How many cards are in a row, read from where they are, because the grid fills as many as fit. */
  function columns(): number {
    const tops = [...grid.children].map((li) => Math.round(li.getBoundingClientRect().top));
    const first = tops[0];
    const row = tops.findIndex((top) => top !== first);
    return row < 0 ? tops.length : row;
  }

  /** Puts the keyboard on a scene's card, which is then the one a Tab arrives at. */
  function focusCard(id: string) {
    const tile = tiles.get(id);
    if (!tile) return;
    if (target !== undefined && target !== id) {
      const before = tiles.get(target);
      if (before) before.pick.tabIndex = -1;
    }
    target = id;
    tile.pick.tabIndex = 0;
    tile.pick.focus({ preventScroll: true });
    tile.li.scrollIntoView({ block: "nearest" });
  }

  function go(step: Step) {
    const ids = [...grid.children].map((li) => (li as HTMLElement).dataset.id as string);
    const active = document.activeElement;
    const from = ids.findIndex((id) => tiles.get(id)?.pick === active);
    // With the keyboard on no card, such as after a click on the empty part of the board, the first press only brings it back.
    if (from < 0) {
      const home = target ?? ids[0];
      if (home !== undefined) focusCard(home);
      return;
    }
    focusCard(ids[stepTo(step, from, ids.length, columns())] as string);
  }

  function onKey(event: KeyboardEvent) {
    // Nothing behind the board hears a key: a T does not add a text the person cannot see, and Ctrl Z does not undo it.
    event.stopPropagation();
    if (event.isComposing || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const step = stepOfKey(event.key);
    if (step === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    go(step);
  }

  /** The rest of the editor cannot be reached while the board is up: not by Tab, not by a click, not by a screen reader. */
  function holdTheRest() {
    for (const sibling of [...(element.parentElement?.children ?? [])]) {
      if (sibling === element || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      held.push(sibling);
    }
  }

  function releaseTheRest() {
    for (const sibling of held) sibling.removeAttribute("inert");
    held.length = 0;
  }

  function close() {
    if (!open) return;
    open = false;
    element.hidden = true;
    document.removeEventListener("keydown", onKey, true);
    observer?.disconnect();
    queue.destroy();
    releaseTheRest();
    // The grid is let go of, so the pictures of a long deck are not kept in memory while they are not looked at.
    grid.replaceChildren();
    tiles.clear();
    target = undefined;
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
    returnTo = null;
  }

  back.addEventListener("click", close);

  const board: Storyboard = {
    element,
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      returnTo = document.activeElement;
      open = true;
      element.hidden = false;
      holdTheRest();
      // Registered while the event is still on its way down, so it runs before anything else that listens for keys.
      document.addEventListener("keydown", onKey, true);
      observer?.observe(grid);
      render();
      const first = target !== undefined ? tiles.get(target) : undefined;
      if (first) focusCard(target as string);
      else element.focus({ preventScroll: true });
    },
    close,
    render,
    destroy() {
      close();
      element.remove();
    },
  };
  return board;
}
