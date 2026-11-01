import { h } from "@depthcue/player";
import type { NewBlockKind } from "./templates.ts";

/** True when a key pressed on this element goes into text: a field, or text being edited on the slide. */
export const typesInto = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;

/** What a key can do to the editor. The mounted editor supplies them, so this file holds no state of its own. */
export interface ShortcutActions {
  /** Adds a block of a kind where the chosen block is, or in the first free area. */
  add(kind: NewBlockKind): void;
  /** Opens the file chooser that adds an image. */
  pickImage(): void;
  /** Starts the Comment tool, or stops it when it is on. */
  comment(): void;
  undo(): void;
  redo(): void;
  save(): void;
  /** Pins the chosen block where it is, or puts it back in its area. False when no block is chosen. */
  pin(): boolean;
  /** Moves the keyboard into the toolbar of the chosen block. False when there is none. */
  toolbar(): boolean;
  /** Opens the palette that finds anything the editor can do. */
  palette(): void;
  /** Opens the storyboard: every scene on one screen. */
  storyboard(): void;
}

export interface Shortcut {
  id: string;
  group: string;
  /** What the sheet says it does. */
  does: string;
  /** The ways to press it. "Mod" is Ctrl, or Command on a Mac. */
  keys: readonly (readonly string[])[];
  /**
   * Present on a key this file handles: it acts and answers true, or answers false to leave the key alone. Absent on
   * a key that is handled where it acts (on a block, in a chart) and is listed here so the sheet is the whole list.
   */
  handle?: (event: KeyboardEvent) => boolean;
}

const mod = (event: KeyboardEvent) => (event.ctrlKey || event.metaKey) && !event.altKey;

/** Runs `act` when the key matched, and says whether it did. */
const when = (matched: boolean, act: () => void) => {
  if (matched) act();
  return matched;
};

/** A plain letter. In a field it is a letter like any other, and held down it does not repeat. */
const letter = (key: string) => (event: KeyboardEvent) =>
  event.key.toLowerCase() === key &&
  !(event.ctrlKey || event.metaKey || event.altKey || event.repeat) &&
  !typesInto(event.target);

/** The table of shortcuts. The handler and the sheet both read it, so a key cannot be listed without being handled. */
export function shortcutTable(actions: ShortcutActions): readonly Shortcut[] {
  return [
    {
      id: "add-text",
      group: "Add to the slide",
      does: "Add a text",
      keys: [["T"]],
      handle: (event) => when(letter("t")(event), () => actions.add("text")),
    },
    {
      id: "add-chart",
      group: "Add to the slide",
      does: "Add a chart",
      keys: [["C"]],
      handle: (event) => when(letter("c")(event), () => actions.add("bar-chart")),
    },
    {
      id: "add-image",
      group: "Add to the slide",
      does: "Add an image: opens the file chooser",
      keys: [["I"]],
      handle: (event) => when(letter("i")(event), () => actions.pickImage()),
    },
    {
      id: "comment",
      group: "Comments",
      does: "Comment on a block: press it, then click the block",
      keys: [["M"]],
      handle: (event) => when(letter("m")(event), () => actions.comment()),
    },
    {
      id: "undo",
      group: "Everywhere",
      does: "Undo",
      keys: [["Mod", "Z"]],
      handle: (event) =>
        when(mod(event) && event.key.toLowerCase() === "z" && !event.shiftKey, () => actions.undo()),
    },
    {
      id: "redo",
      group: "Everywhere",
      does: "Redo",
      keys: [
        ["Mod", "Shift", "Z"],
        ["Mod", "Y"],
      ],
      handle: (event) => {
        const key = event.key.toLowerCase();
        return when(mod(event) && ((key === "z" && event.shiftKey) || key === "y"), () => actions.redo());
      },
    },
    {
      id: "save",
      group: "Everywhere",
      does: "Save now",
      keys: [["Mod", "S"]],
      handle: (event) => when(mod(event) && event.key.toLowerCase() === "s", () => actions.save()),
    },
    {
      id: "palette",
      group: "Everywhere",
      does: "Find anything to do, by typing a few letters of it",
      keys: [["Mod", "K"]],
      // Once it is open the palette hears the keys itself, and this key shuts it there.
      handle: (event) =>
        when(mod(event) && !event.shiftKey && event.key.toLowerCase() === "k", () => actions.palette()),
    },
    {
      id: "storyboard",
      group: "Everywhere",
      does: "See every scene on one screen, and open one",
      keys: [["G"]],
      handle: (event) => when(letter("g")(event), () => actions.storyboard()),
    },
    {
      id: "help",
      group: "Everywhere",
      does: "Show this list",
      keys: [["?"]],
      // Opening the sheet is the dispatcher's job, which needs the sheet.
    },
    {
      id: "pin",
      group: "The chosen block",
      does: "Pin it where it is, or put it back in its area",
      keys: [["P"]],
      handle: (event) => letter("p")(event) && actions.pin(),
    },
    {
      id: "toolbar",
      group: "The chosen block",
      does: "Move the keyboard to its toolbar",
      keys: [["Alt", "F10"]],
      handle: (event) => event.key === "F10" && event.altKey && actions.toolbar(),
    },
    {
      id: "edit",
      group: "With a block focused",
      does: "Type in a pinned text, or choose the block",
      keys: [["Enter"]],
    },
    {
      id: "nudge",
      group: "With a block focused",
      does: "Nudge a pinned block, five steps with Shift",
      keys: [["Arrow keys"]],
    },
    {
      id: "remove",
      group: "With a block focused",
      does: "Remove the block",
      keys: [["Delete"], ["Backspace"]],
    },
    {
      id: "let-go",
      group: "With a block focused",
      does: "Let go of the block",
      keys: [["Esc"]],
    },
    {
      id: "bar-value",
      group: "On a chart bar",
      does: "Change its value, five steps with Shift",
      keys: [["Arrow keys"]],
    },
  ];
}

/** What a key is called on this computer. */
export const keyName = (token: string) =>
  token === "Mod" ? (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl") : token;

export interface Shortcuts {
  /** The shortcut sheet, shut until `?` or the bar's button opens it. It belongs inside the editor's root. */
  readonly sheet: HTMLElement;
  readonly isOpen: boolean;
  /** The ways to press the key with this id in the table, for a place that says which key does the same thing. */
  keysOf(id: string): readonly (readonly string[])[] | undefined;
  open(): void;
  close(): void;
  destroy(): void;
}

/**
 * Listens for the editor's keys. They are for the editor when the keyboard is in it, or when the pointer was last over
 * it and the keyboard is nowhere in particular: a page that holds the editor beside other things keeps its own keys.
 */
export function createShortcuts(host: HTMLElement, actions: ShortcutActions): Shortcuts {
  const table = shortcutTable(actions);

  let pointerOver = true;
  const track = (event: Event) => {
    pointerOver = event.target instanceof Node && host.contains(event.target);
  };

  const owned = (event: KeyboardEvent) => {
    const { target } = event;
    const nowhere =
      target === null ||
      target === document ||
      target === document.body ||
      target === document.documentElement;
    return nowhere ? pointerOver : target instanceof Node && host.contains(target);
  };

  const close = h("button", { type: "button", "data-action": "close-shortcuts" }, "Close");
  const groups = [...new Set(table.map((entry) => entry.group))].map((group) =>
    h(
      "section",
      { class: "ed-sheet-group" },
      h("h3", {}, group),
      h(
        "ul",
        {},
        ...table
          .filter((entry) => entry.group === group)
          .map((entry) =>
            h(
              "li",
              { "data-shortcut": entry.id },
              h("span", {}, entry.does),
              h(
                "span",
                { class: "ed-keys" },
                ...entry.keys.flatMap((combo, at) => [
                  ...(at > 0 ? [h("span", { class: "ed-keys-or" }, "or")] : []),
                  ...combo.map((token) => h("kbd", {}, keyName(token))),
                ]),
              ),
            ),
          ),
      ),
    ),
  );
  const card = h(
    "div",
    {
      class: "ed-sheet-card",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "ed-sheet-title",
      tabindex: "-1",
    },
    h("div", { class: "ed-sheet-head" }, h("h2", { id: "ed-sheet-title" }, "Keyboard shortcuts"), close),
    ...groups,
  );
  const sheet = h("div", { class: "ed-sheet" }, card);
  sheet.hidden = true;

  let returnTo: Element | null = null;
  const open = () => {
    if (!sheet.hidden) return;
    returnTo = document.activeElement;
    sheet.hidden = false;
    card.focus();
  };
  const shut = () => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    returnTo = null;
  };

  close.addEventListener("click", shut);
  // A press on the dim part around the card shuts it, and a press on the card does not.
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) shut();
  });
  // The sheet holds one control, so Tab has nowhere to go but back to it.
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    close.focus();
  });

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !owned(event)) return;
    const asksForHelp = event.key === "?" && !(event.ctrlKey || event.metaKey || event.altKey);
    if (!sheet.hidden) {
      // Behind an open sheet nothing else acts, so a T does not add a text the person cannot see.
      if (event.key === "Escape" || (asksForHelp && !event.repeat)) {
        event.preventDefault();
        shut();
      }
      return;
    }
    if (asksForHelp && !event.repeat && !typesInto(event.target)) {
      event.preventDefault();
      open();
      return;
    }
    for (const entry of table) {
      if (entry.handle?.(event)) {
        event.preventDefault();
        return;
      }
    }
  };

  document.addEventListener("keydown", onKey);
  document.addEventListener("pointermove", track, true);
  document.addEventListener("pointerdown", track, true);

  return {
    sheet,
    get isOpen() {
      return !sheet.hidden;
    },
    keysOf: (id) => table.find((entry) => entry.id === id)?.keys,
    open,
    close: shut,
    destroy() {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointermove", track, true);
      document.removeEventListener("pointerdown", track, true);
    },
  };
}
