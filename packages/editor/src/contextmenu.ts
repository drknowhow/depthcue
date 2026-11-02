import type { SlotName } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Command, Target } from "./palette.ts";
import { typesInto } from "./shortcuts.ts";
import { REGION_SLOT } from "./slotdrag.ts";

/** A long press opens the menu when it lasts this long and moves less than `LONG_PRESS_SLOP` pixels. */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 8;

/** The gap kept between the menu and the edge of the window. */
const EDGE = 8;

/** What the menu is for, which it says to a screen reader. */
const MENU_NAME: Record<Target, string> = {
  block: "Block menu",
  claim: "Claim menu",
  slide: "Slide menu",
  scene: "Scene menu",
  cell: "Cell menu",
};

/** One row of the menu: a command, a submenu that opens to more of them, or the line between two sections. */
export type MenuEntry =
  | { kind: "command"; command: Command }
  | { kind: "submenu"; name: string; commands: Command[] }
  | { kind: "separator" };

/**
 * The menu for what was clicked, from the one list of commands. A command is in it when it says it applies to the
 * target. The commands of a section sit together in the order the list has them, a line between one section and the
 * next, and the commands that name a submenu are gathered into one item where the first of them stood.
 */
export function menuFor(commands: readonly Command[], target: Target): MenuEntry[] {
  type Slot = { kind: "command"; command: Command } | { kind: "submenu"; name: string; commands: Command[] };
  const sections = new Map<string, Slot[]>();
  for (const command of commands) {
    if (!command.targets?.includes(target)) continue;
    const name = command.section ?? command.group;
    const section = sections.get(name) ?? [];
    sections.set(name, section);
    if (command.submenu === undefined) {
      section.push({ kind: "command", command });
      continue;
    }
    const found = section.find((slot) => slot.kind === "submenu" && slot.name === command.submenu);
    if (found?.kind === "submenu") found.commands.push(command);
    else section.push({ kind: "submenu", name: command.submenu, commands: [command] });
  }
  const out: MenuEntry[] = [];
  for (const section of sections.values()) {
    if (out.length > 0) out.push({ kind: "separator" });
    out.push(...section);
  }
  return out;
}

/** What was pointed at, which the editor chooses before the menu lists what can be done to it. */
export interface Pointed {
  target: Target;
  /** The block, the claim or the scene. Absent on the empty slide. */
  id?: string;
  /** The area of the layout under the pointer, on the empty slide. */
  slot?: SlotName;
  /** The cell of a table under the pointer, with `id` the table. Row -1 is the header. */
  cell?: { row: number; column: number };
  /** Where it was pointed at, in pixels of the window. */
  at: { x: number; y: number };
}

export interface ContextMenuHooks {
  /** The slide's stage and the strip of scenes. A right-click anywhere else keeps the browser's own menu. */
  stage: HTMLElement;
  strip: HTMLElement;
  /** What an id found on the slide is: a block, the claim, or neither. A cell is found by its own markers. */
  kindOf(id: string): "block" | "claim" | undefined;
  /** The block or claim that is chosen, so the keyboard can open the menu on it from anywhere in the editor. */
  chosen(): { id: string; node: HTMLElement | undefined } | undefined;
  /** Chooses what was pointed at, and answers with everything the editor can do, for the menu to pick from. */
  commands(pointed: Pointed): readonly Command[];
  /** Puts the keyboard back on what the menu was opened for. `ran` is true when an item ran, and false when it was dismissed. */
  giveBack(pointed: Pointed, ran: boolean): void;
  /** What a key is called on this computer. */
  keyName(token: string): string;
}

export interface ContextMenu {
  /** The menu, shut until it is opened. It belongs inside the editor's root. */
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** Opens the menu on the block the keyboard is on, or the scene of the strip. False when it is on neither. */
  openFromKeyboard(): boolean;
  close(): void;
  destroy(): void;
}

const ITEM = "ed-menu-item";

/** A key of the table of shortcuts as `aria-keyshortcuts` writes it: Ctrl and Command are both given for "Mod". */
function shortcutOf(keys: readonly string[]): string {
  const rest = keys.filter((token) => token !== "Mod");
  return keys.includes("Mod")
    ? ["Control", "Meta"].map((modifier) => [modifier, ...rest].join("+")).join(" ")
    : rest.join("+");
}
const FIELD = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** The items of one menu, in order: its own buttons and the button of each submenu, but not what a submenu holds. */
const itemsOf = (menu: Element): HTMLElement[] =>
  [...menu.children].flatMap((child) =>
    child.classList.contains(ITEM)
      ? [child as HTMLElement]
      : child.classList.contains("ed-menu-branch") && child.firstElementChild
        ? [child.firstElementChild as HTMLElement]
        : [],
  );

/**
 * The menu that opens on a right-click: over a block, the claim, an empty part of the slide, or a scene of the strip.
 * It lists the commands of the palette that apply to what was clicked, so the two cannot disagree. It opens with the
 * pointer, with Shift+F10 or the Menu key on the block or scene the keyboard is on, and with a long press on a touch
 * screen. A person typing in a text keeps the browser's own menu, which has the spelling suggestions.
 *
 * It is a menu to a screen reader: arrows move over the items, Right opens a submenu and Left shuts it, Enter or Space
 * does the item, Home and End go to the ends, and Esc shuts it and puts the keyboard back on what it was opened for.
 */
export function createContextMenu(root: HTMLElement, hooks: ContextMenuHooks): ContextMenu {
  const element = h("div", {
    class: "ed-menu",
    role: "menu",
    tabindex: "-1",
    "aria-orientation": "vertical",
  });
  element.hidden = true;
  const commandOf = new WeakMap<HTMLElement, Command>();
  let pointed: Pointed | undefined;
  let openedAt = 0;
  /** A native context menu event that follows our own opening, for the same press or key, is not a second request. */
  let quietUntil = 0;
  /** What had the keyboard when the last press began: a right-click on text already being typed in is the browser's. */
  let pressed: { focus: Element | null; at: number } | undefined;
  let hold: { id: number; x: number; y: number; target: EventTarget | null; timer: number } | undefined;
  let swallowClick = false;
  let swallowTimer: number | undefined;

  function item(command: Command): HTMLButtonElement {
    const keys = command.keys?.[0];
    const node = h(
      "button",
      {
        type: "button",
        role: command.checked === undefined ? "menuitem" : "menuitemradio",
        class: ITEM,
        tabindex: "-1",
        "data-command": command.id,
        "aria-keyshortcuts": keys && shortcutOf(keys),
        "aria-checked": command.checked === undefined ? undefined : String(command.checked),
        // Focusable and read out, with its reason, but it does nothing: a choice that is greyed says why.
        "aria-disabled": command.disabled === undefined ? undefined : "true",
      },
      command.icon?.(),
      h("span", { class: "ed-menu-label" }, command.label ?? command.title),
      command.disabled !== undefined && h("span", { class: "ed-menu-why" }, command.disabled),
      // Written for the eye. A screen reader gets the keys from `aria-keyshortcuts`, after the name.
      keys &&
        h(
          "span",
          { class: "ed-keys", "aria-hidden": "true" },
          ...keys.map((token) => h("kbd", {}, hooks.keyName(token))),
        ),
    );
    commandOf.set(node, command);
    return node;
  }

  function branch(name: string, commands: readonly Command[]): HTMLElement {
    const parent = h(
      "button",
      {
        type: "button",
        role: "menuitem",
        class: `${ITEM} ed-menu-parent`,
        tabindex: "-1",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-submenu": name,
      },
      h("span", { class: "ed-menu-label" }, name),
      h("span", { class: "ed-menu-arrow", "aria-hidden": "true" }),
    );
    const panel = h(
      "div",
      { class: "ed-menu ed-menu-sub", role: "menu", "aria-label": name, tabindex: "-1" },
      ...commands.map(item),
    );
    panel.hidden = true;
    return h("div", { class: "ed-menu-branch", role: "none" }, parent, panel);
  }

  function rows(entries: readonly MenuEntry[]): HTMLElement[] {
    return entries.map((entry) =>
      entry.kind === "command"
        ? item(entry.command)
        : entry.kind === "submenu"
          ? branch(entry.name, entry.commands)
          : h("div", { class: "ed-menu-sep", role: "separator" }),
    );
  }

  const viewport = () => ({
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  });

  /** Puts the menu at a point, or against an element, and keeps all of it inside the window: it opens leftward or upward at an edge. */
  function place(x: number, y: number, around?: DOMRect) {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    const box = element.getBoundingClientRect();
    const room = viewport();
    let left = x;
    let top = y;
    if (left + box.width + EDGE > room.width) left = (around ? around.right : x) - box.width;
    if (top + box.height + EDGE > room.height) top = (around ? around.top : y) - box.height;
    left = Math.max(EDGE, Math.min(left, room.width - box.width - EDGE));
    top = Math.max(EDGE, Math.min(top, room.height - box.height - EDGE));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  /** A submenu opens beside its item, on the other side when there is no room, and slides up when it would run off the bottom. */
  function placeSub(panel: HTMLElement) {
    panel.removeAttribute("data-flip");
    panel.style.top = "";
    const box = panel.getBoundingClientRect();
    const room = viewport();
    if (box.right + EDGE > room.width) panel.dataset.flip = "";
    // Slid up by what ran off the bottom, from the place the style sheet gives it.
    if (box.bottom + EDGE > room.height)
      panel.style.top = `calc(${room.height - EDGE - box.bottom}px - 1px - var(--dc-space-1))`;
  }

  const panelOf = (parent: Element) => parent.nextElementSibling as HTMLElement | null;

  function openSub(parent: HTMLElement, focusFirst: boolean) {
    const menu = parent.closest(".ed-menu");
    for (const other of menu ? itemsOf(menu) : []) if (other !== parent) shutSub(other);
    const panel = panelOf(parent);
    if (!panel?.classList.contains("ed-menu-sub")) return;
    panel.hidden = false;
    parent.setAttribute("aria-expanded", "true");
    placeSub(panel);
    if (focusFirst) itemsOf(panel)[0]?.focus({ preventScroll: true });
  }

  function shutSub(parent: HTMLElement) {
    const panel = panelOf(parent);
    if (!panel?.classList.contains("ed-menu-sub") || panel.hidden) return;
    panel.hidden = true;
    parent.setAttribute("aria-expanded", "false");
  }

  function activate(node: HTMLElement) {
    if (node.classList.contains("ed-menu-parent")) {
      openSub(node, true);
      return;
    }
    const command = commandOf.get(node);
    if (!command || command.disabled !== undefined) return;
    // The menu goes first and the command after it, so a command that moves the keyboard has the last word.
    close("ran");
    command.run();
  }

  /** Shuts the menu. With a reason, the keyboard goes back to what it was opened for: the menu was dismissed, or ran an item. */
  function close(back?: "dismissed" | "ran") {
    if (element.hidden) return;
    const was = pointed;
    element.hidden = true;
    element.replaceChildren();
    pointed = undefined;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onAway);
    window.removeEventListener("blur", onAway);
    if (back && was) hooks.giveBack(was, back === "ran");
  }

  const onOutside = (event: PointerEvent) => {
    if (!(event.target instanceof Node && element.contains(event.target))) close();
  };
  // Scrolling moves what the menu was opened on. The first moments are the editor settling on the choice it just made.
  const onScroll = (event: Event) => {
    if (event.target instanceof Node && element.contains(event.target)) return;
    if (Date.now() - openedAt > 150) close();
  };
  const onAway = () => close();

  /** Opens the menu for what was pointed at. False when there is nothing to list, and the browser's menu is left alone. */
  function open(next: Pointed, how: "pointer" | "keyboard", around?: Element): boolean {
    close();
    const entries = menuFor(hooks.commands(next), next.target);
    if (entries.length === 0) return false;
    pointed = next;
    element.dataset.target = next.target;
    element.setAttribute("aria-label", MENU_NAME[next.target]);
    element.replaceChildren(...rows(entries));
    element.hidden = false;
    openedAt = Date.now();
    const box = around?.getBoundingClientRect();
    if (box) place(box.left, box.bottom, box);
    else place(next.at.x, next.at.y);
    if (how === "keyboard") itemsOf(element)[0]?.focus({ preventScroll: true });
    else element.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", onAway);
    return true;
  }

  /** The block or claim an element is in, or is, on the slide. */
  function itemAround(node: Element): { id: string; kind: "block" | "claim"; node: HTMLElement } | undefined {
    for (
      let at = node.closest<HTMLElement>("[data-id]");
      at;
      at = at.parentElement?.closest("[data-id]") ?? null
    ) {
      const kind = hooks.kindOf(at.dataset.id ?? "");
      if (kind) return { id: at.dataset.id as string, kind, node: at };
    }
    return undefined;
  }

  const rowOf = (node: Element) => {
    const row = node.closest<HTMLElement>(".ed-scene-list > li[data-id]");
    return row && hooks.strip.contains(row) ? row : undefined;
  };

  /** The cell of a table that an element is in, with the table it is in, or undefined for anything else. */
  function cellAround(
    node: Element,
  ): { cell: { row: number; column: number }; node: HTMLElement } | undefined {
    const cell = node.closest<HTMLElement>("[data-cell]");
    if (!cell || cell.dataset.row === undefined || cell.dataset.col === undefined) return undefined;
    return { cell: { row: Number(cell.dataset.row), column: Number(cell.dataset.col) }, node: cell };
  }

  /** What a pointer at `node` is pointing at, or undefined for anything the menu is not for: the bars, popovers and fields. */
  function pointedAt(node: EventTarget | null, at: { x: number; y: number }): Pointed | undefined {
    if (!(node instanceof Element)) return undefined;
    const row = rowOf(node);
    if (row) return { target: "scene", id: row.dataset.id as string, at };
    if (!hooks.stage.contains(node)) return undefined;
    // A grip stands for the block beside it.
    const grip = node.closest<HTMLElement>("[data-grip]");
    const gripped = grip?.dataset.grip;
    if (gripped !== undefined) {
      const kind = hooks.kindOf(gripped);
      return kind ? { target: kind, id: gripped, at } : undefined;
    }
    // The toolbar, the handles, the pins and the badges are drawn over the slide, and are not the slide.
    if (node.closest(".ed-overlay, .ed-hint")) return undefined;
    const found = itemAround(node);
    // A cell of a table has a menu of its own. The border, the caption and the toolbar of the table keep the block's.
    const cell = found?.kind === "block" ? cellAround(node) : undefined;
    if (found && cell) return { target: "cell", id: found.id, cell: cell.cell, at };
    if (found) return { target: found.kind, id: found.id, at };
    const region = node.closest(".dc-region");
    const slot = region && Object.entries(REGION_SLOT).find(([name]) => region.classList.contains(name))?.[1];
    return { target: "slide", ...(slot ? { slot } : {}), at };
  }

  /** True while the person is typing in what the press landed on: a text that already had the caret before the press. */
  function typing(node: EventTarget | null): boolean {
    if (!(node instanceof Element) || !typesInto(node)) return false;
    const field = node.closest(FIELD);
    const before = pressed && Date.now() - pressed.at < 2000 ? pressed.focus : document.activeElement;
    return field !== null && before !== null && field.contains(before);
  }

  function openFromKeyboard(): boolean {
    const active = document.activeElement;
    if (!(active instanceof Element) || !root.contains(active)) return false;
    const row = rowOf(active);
    if (row)
      return open({ target: "scene", id: row.dataset.id as string, at: { x: 0, y: 0 } }, "keyboard", row);
    const found = hooks.stage.contains(active) ? itemAround(active) : undefined;
    const cell = found?.kind === "block" ? cellAround(active) : undefined;
    if (found && cell)
      return open(
        { target: "cell", id: found.id, cell: cell.cell, at: { x: 0, y: 0 } },
        "keyboard",
        cell.node,
      );
    if (found) return open({ target: found.kind, id: found.id, at: { x: 0, y: 0 } }, "keyboard", found.node);
    // Anywhere else in the editor the menu is for the chosen block, which the toolbar's keys are for as well.
    const chosen = hooks.chosen();
    const kind = chosen && hooks.kindOf(chosen.id);
    if (!chosen || !kind || !chosen.node) return false;
    return open({ target: kind, id: chosen.id, at: { x: 0, y: 0 } }, "keyboard", chosen.node);
  }

  element.addEventListener("keydown", (event) => {
    // Nothing behind the menu hears a key: a T does not add a text, and Ctrl Z does not undo what it cannot show.
    event.stopPropagation();
    if (event.isComposing) return;
    const target = event.target as HTMLElement;
    const focused = target.closest<HTMLElement>(`.${ITEM}`);
    const menu = (focused ?? target).closest<HTMLElement>(".ed-menu") ?? element;
    const items = itemsOf(menu);
    const at = focused ? items.indexOf(focused) : -1;
    const go = (to: number) => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        go(at + 1);
        break;
      case "ArrowUp":
        go(at < 0 ? items.length - 1 : at - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(items.length - 1);
        break;
      case "ArrowRight":
        if (focused?.classList.contains("ed-menu-parent")) {
          event.preventDefault();
          openSub(focused, true);
        }
        break;
      case "ArrowLeft": {
        const parent = menu.classList.contains("ed-menu-sub")
          ? (menu.previousElementSibling as HTMLElement)
          : undefined;
        if (parent) {
          event.preventDefault();
          shutSub(parent);
          parent.focus({ preventScroll: true });
        }
        break;
      }
      case "Enter":
      case " ":
        if (focused) {
          event.preventDefault();
          activate(focused);
        }
        break;
      case "Escape": {
        event.preventDefault();
        const parent = menu.classList.contains("ed-menu-sub")
          ? (menu.previousElementSibling as HTMLElement)
          : undefined;
        if (parent) {
          shutSub(parent);
          parent.focus({ preventScroll: true });
        } else {
          close("dismissed");
        }
        break;
      }
      case "Tab":
        event.preventDefault();
        close("dismissed");
        break;
      default:
        // A letter goes to the next item that starts with it.
        if (event.key.length === 1 && !(event.ctrlKey || event.metaKey || event.altKey)) {
          const letter = event.key.toLowerCase();
          const labels = items.map(
            (node) => node.querySelector(".ed-menu-label")?.textContent?.toLowerCase() ?? "",
          );
          for (let step = 1; step <= items.length; step++) {
            const next = (at + step + items.length) % items.length;
            if (labels[next]?.startsWith(letter)) {
              go(next);
              break;
            }
          }
        }
    }
  });
  // A Space that did the item on its key down is not pressed again on the key up.
  element.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") event.preventDefault();
  });
  element.addEventListener("click", (event) => {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${ITEM}`) : null;
    if (node) activate(node);
  });
  // The pointer over an item is the keyboard on it, so the two never point at different items.
  element.addEventListener("pointermove", (event) => {
    const node = event.target instanceof Element ? event.target.closest<HTMLElement>(`.${ITEM}`) : null;
    if (!node) return;
    if (document.activeElement !== node) node.focus({ preventScroll: true });
    if (node.classList.contains("ed-menu-parent")) openSub(node, false);
    else {
      const menu = node.closest(".ed-menu");
      for (const other of menu ? itemsOf(menu) : []) shutSub(other);
    }
  });
  element.addEventListener("contextmenu", (event) => event.preventDefault());

  // The press is noted before the browser moves the caret to it, so the click that follows can tell a text being typed in.
  const onPress = (event: PointerEvent) => {
    pressed = { focus: document.activeElement, at: Date.now() };
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (!event.isPrimary) return;
    cancelHold();
    const { clientX: x, clientY: y, pointerId: id, target } = event;
    hold = {
      id,
      x,
      y,
      target,
      timer: window.setTimeout(() => {
        hold = undefined;
        const found = pointedAt(target, { x, y });
        if (!found || typing(target)) return;
        if (open(found, "pointer")) {
          quietUntil = Date.now() + 700;
          // The finger comes up on what it pressed, and that is not a click on it.
          swallowClick = true;
          window.clearTimeout(swallowTimer);
          swallowTimer = window.setTimeout(() => {
            swallowClick = false;
          }, 800);
        }
      }, LONG_PRESS_MS),
    };
  };
  function cancelHold() {
    if (hold) window.clearTimeout(hold.timer);
    hold = undefined;
  }
  const onMove = (event: PointerEvent) => {
    if (
      hold &&
      event.pointerId === hold.id &&
      Math.hypot(event.clientX - hold.x, event.clientY - hold.y) >= LONG_PRESS_SLOP
    )
      cancelHold();
  };
  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onContext = (event: MouseEvent) => {
    if (event.target instanceof Node && element.contains(event.target)) {
      event.preventDefault();
      return;
    }
    // The key or the long press that opened the menu may be followed by the browser's own request for one.
    if (Date.now() < quietUntil) {
      event.preventDefault();
      return;
    }
    const found = pointedAt(event.target, { x: event.clientX, y: event.clientY });
    if (!found || typing(event.target)) {
      close();
      return;
    }
    if (open(found, "pointer")) event.preventDefault();
  };

  root.addEventListener("pointerdown", onPress, true);
  root.addEventListener("pointermove", onMove, true);
  root.addEventListener("pointerup", cancelHold, true);
  root.addEventListener("pointercancel", cancelHold, true);
  root.addEventListener("click", onClick, true);
  root.addEventListener("contextmenu", onContext);

  return {
    element,
    get isOpen() {
      return !element.hidden;
    },
    openFromKeyboard() {
      const opened = openFromKeyboard();
      // The browser may follow a key with a context menu event of its own, for the same key.
      if (opened) quietUntil = Date.now() + 500;
      return opened;
    },
    close: () => close(),
    destroy() {
      close();
      cancelHold();
      window.clearTimeout(swallowTimer);
      root.removeEventListener("pointerdown", onPress, true);
      root.removeEventListener("pointermove", onMove, true);
      root.removeEventListener("pointerup", cancelHold, true);
      root.removeEventListener("pointercancel", cancelHold, true);
      root.removeEventListener("click", onClick, true);
      root.removeEventListener("contextmenu", onContext);
      element.remove();
    },
  };
}
