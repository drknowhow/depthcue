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
  /**
   * Puts the chosen block on the clipboard, and with `cut` takes it off the slide. It fills what a copy or cut event
   * carries. False when no block is chosen, to leave the event to the browser.
   */
  copy(data: DataTransfer | null, cut: boolean): boolean;
  /** Pastes the block a paste event carries, after the chosen block. False when it carries none. */
  paste(data: DataTransfer | null): boolean;
  /** Duplicates the chosen block, unless the key is `again` held down. False when no block is chosen. */
  duplicate(again: boolean): boolean;
  /** Opens the right-click menu on what the keyboard is on: the chosen block or a scene of the strip. False when there is none. */
  menu(): boolean;
  /** Goes to the scene before or after the one on show. */
  scene(direction: 1 | -1): void;
  /** Zooms the slide one step in or out, or back to the size that fits. */
  zoom(change: "in" | "out" | "fit"): void;
  /** Hides the inspector on the right of a wide window, or shows it again. */
  inspector(): void;
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

/** A key with no modifier, which in a field is a character like any other. Held down it repeats. */
const plain = (event: KeyboardEvent, ...keys: string[]) =>
  keys.includes(event.key) && !(event.ctrlKey || event.metaKey || event.altKey) && !typesInto(event.target);

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
      handle: (event) => when(letter("c")(event), () => actions.add("chart")),
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
      id: "previous-scene",
      group: "Moving around",
      does: "Go to the previous slide",
      keys: [["["]],
      handle: (event) => when(plain(event, "["), () => actions.scene(-1)),
    },
    {
      id: "next-scene",
      group: "Moving around",
      does: "Go to the next slide",
      keys: [["]"]],
      handle: (event) => when(plain(event, "]"), () => actions.scene(1)),
    },
    {
      id: "inspector",
      group: "Moving around",
      does: "Hide or show the inspector, on the right of a wide window",
      keys: [["\\"]],
      handle: (event) => when(plain(event, "\\"), () => actions.inspector()),
    },
    {
      id: "zoom-in",
      group: "Moving around",
      does: "Zoom in on the slide",
      keys: [["+"], ["Ctrl", "Scroll up"]],
      handle: (event) => when(plain(event, "+", "="), () => actions.zoom("in")),
    },
    {
      id: "zoom-out",
      group: "Moving around",
      does: "Zoom out",
      keys: [["-"], ["Ctrl", "Scroll down"]],
      handle: (event) => when(plain(event, "-", "_"), () => actions.zoom("out")),
    },
    {
      id: "zoom-fit",
      group: "Moving around",
      does: "Fit the slide to the window",
      keys: [["0"]],
      handle: (event) => when(plain(event, "0"), () => actions.zoom("fit")),
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
      id: "cut",
      group: "The chosen block",
      does: "Cut it, to paste it elsewhere",
      keys: [["Mod", "X"]],
      // The browser sends a cut event, which carries the clipboard and needs no permission: see `onClipboard`.
    },
    {
      id: "copy",
      group: "The chosen block",
      does: "Copy it, also into another deck",
      keys: [["Mod", "C"]],
    },
    {
      id: "paste",
      group: "The chosen block",
      does: "Paste a copied block after it",
      keys: [["Mod", "V"]],
    },
    {
      id: "duplicate",
      group: "The chosen block",
      does: "Duplicate it",
      keys: [["Mod", "D"]],
      // A browser would bookmark the page on this key, so while a block is chosen the key is ours.
      handle: (event) =>
        mod(event) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        !typesInto(event.target) &&
        actions.duplicate(event.repeat),
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
      id: "menu",
      group: "The chosen block",
      does: "Open its right-click menu",
      keys: [["Shift", "F10"], ["Menu"]],
      // Typing in a text keeps the browser's own menu, which has the spelling suggestions.
      handle: (event) =>
        (event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) &&
        !typesInto(event.target) &&
        actions.menu(),
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
      id: "bold",
      group: "Typing in a text",
      does: "Bold the selected words",
      keys: [["Mod", "B"]],
      // Handled where the text is, which also keeps the key from the palette: `defaultPrevented` ends it here.
    },
    {
      id: "italic",
      group: "Typing in a text",
      does: "Italicize the selected words",
      keys: [["Mod", "I"]],
    },
    {
      id: "link",
      group: "Typing in a text",
      does: "Link the selected words: an address that starts https:// or mailto:",
      keys: [["Mod", "K"]],
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

  const owned = (event: Event) => {
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

  /**
   * A copy, a cut or a paste of the chosen block. The page hears these for a key press, with the clipboard attached, so
   * they need no permission. A field keeps its own, and so do words the person selected.
   */
  const onClipboard = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !owned(event) || !sheet.hidden || typesInto(event.target)) return;
    if (document.getSelection()?.isCollapsed === false) return;
    const took =
      event.type === "paste"
        ? actions.paste(event.clipboardData)
        : actions.copy(event.clipboardData, event.type === "cut");
    if (took) event.preventDefault();
  };
  const CLIPBOARD_EVENTS = ["copy", "cut", "paste"] as const;

  document.addEventListener("keydown", onKey);
  for (const type of CLIPBOARD_EVENTS) document.addEventListener(type, onClipboard);
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
      for (const type of CLIPBOARD_EVENTS) document.removeEventListener(type, onClipboard);
      document.removeEventListener("pointermove", track, true);
      document.removeEventListener("pointerdown", track, true);
    },
  };
}
