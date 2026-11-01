import { h } from "@depthcue/player";

/** What the right-click menu can be opened on: a block, the claim, an empty part of the slide, or a scene in the strip. */
export type Target = "block" | "claim" | "slide" | "scene";

/**
 * One thing the editor can do. The palette lists every command; the right-click menu lists those that say they
 * apply to what was clicked, so the two are one list and cannot disagree about what can be done.
 */
export interface Command {
  id: string;
  /** What the list says. */
  title: string;
  /** The kind of thing it is, written small beside the title. */
  group: string;
  /** More words that find it, which the list does not show. */
  words?: string;
  /** The keys that do the same thing, as the table of shortcuts writes them. */
  keys?: readonly (readonly string[])[] | undefined;
  /** What the right-click menu lists it for. Without it the command is in the palette alone. */
  targets?: readonly Target[];
  /** What the menu says, when that is shorter than the title: the menu already says what it is about. */
  label?: string;
  /** The commands of one section sit together in the menu, with a line between one section and the next. */
  section?: string;
  /** The name of the submenu the menu puts it in, so a long run of choices is one item that opens. */
  submenu?: string;
  run(): void;
}

export interface PaletteHooks {
  /** What can be done right now. It is asked each time the palette opens, so a command that does not apply is not listed. */
  commands(): readonly Command[];
  /** What a key is called on this computer, for the caps drawn beside a command. */
  keyName(token: string): string;
}

export interface Palette {
  /** The palette, shut until it is opened. It belongs inside the editor's root. */
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  destroy(): void;
}

/** Longest list drawn. Past it the query is the way to a command, and a deck of hundreds of scenes does not stall. */
const SHOWN = 50;

const isWordStart = (text: string, at: number) => at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1] ?? "");

/**
 * How well one typed word matches a text: the word appearing in it, better at the start of a word than inside one,
 * and better early. Failing that, its letters appearing in order, better when they are close together. Undefined when
 * it does not match at all.
 */
function scoreWord(text: string, word: string): number | undefined {
  const at = text.indexOf(word);
  if (at >= 0) return 1000 - at + (isWordStart(text, at) ? 500 : 0);
  let from = 0;
  let gaps = 0;
  let last = -1;
  for (const letter of word) {
    const found = text.indexOf(letter, from);
    if (found < 0) return undefined;
    if (last >= 0) gaps += found - last - 1;
    last = found;
    from = found + 1;
  }
  return Math.max(1, 200 - gaps);
}

/**
 * The commands a query finds, best first. The words of the query are each looked for in the title, and failing that in
 * the extra words, which count for half. Every word has to match. An empty query finds all of them in the order given.
 */
export function search(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const ranked: { command: Command; score: number; at: number }[] = [];
  commands.forEach((command, at) => {
    const title = command.title.toLowerCase();
    const extra = (command.words ?? "").toLowerCase();
    let score = 0;
    for (const word of words) {
      const inTitle = scoreWord(title, word);
      const inWords = extra === "" ? undefined : scoreWord(extra, word);
      const best = inTitle ?? (inWords === undefined ? undefined : inWords / 2);
      if (best === undefined) return;
      score += best;
    }
    ranked.push({ command, score, at });
  });
  return ranked.sort((a, b) => b.score - a.score || a.at - b.at).map((entry) => entry.command);
}

let counter = 0;

/**
 * A box to find anything the editor can do by typing a few letters of it. Ctrl K opens it, the arrow keys choose,
 * Enter does it and Esc puts the keyboard back where it was. It is a dialog with one text field that controls a list,
 * and the keyboard never leaves the field, so a screen reader reads each choice as the arrows move over it.
 */
export function createPalette(hooks: PaletteHooks): Palette {
  counter += 1;
  const id = `ed-palette-${counter}`;
  const input = h("input", {
    type: "text",
    class: "ed-palette-input",
    role: "combobox",
    "aria-label": "Search for something to do",
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": `${id}-list`,
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Find something to do",
  });
  const list = h("ul", {
    class: "ed-palette-list",
    id: `${id}-list`,
    role: "listbox",
    "aria-label": "Commands",
  });
  const empty = h("p", { class: "ed-palette-empty", "aria-hidden": "true" });
  empty.hidden = true;
  const say = h("span", { class: "ed-sr-only", role: "status", "aria-live": "polite" });
  const card = h(
    "div",
    { class: "ed-palette-card", role: "dialog", "aria-modal": "true", "aria-label": "Everything you can do" },
    input,
    list,
    empty,
    say,
  );
  const element = h("div", { class: "ed-palette" }, card);
  element.hidden = true;

  let all: readonly Command[] = [];
  let found: Command[] = [];
  let at = 0;
  let returnTo: Element | null = null;

  const optionId = (n: number) => `${id}-option-${n}`;

  function mark() {
    const options = [...list.children] as HTMLElement[];
    for (const [n, option] of options.entries()) option.setAttribute("aria-selected", String(n === at));
    if (found.length > 0) input.setAttribute("aria-activedescendant", optionId(at));
    else input.removeAttribute("aria-activedescendant");
    options[at]?.scrollIntoView?.({ block: "nearest" });
  }

  function draw() {
    found = search(all, input.value).slice(0, SHOWN);
    at = 0;
    list.replaceChildren(
      ...found.map((command, n) => {
        const keys = command.keys?.[0];
        const option = h(
          "li",
          { class: "ed-palette-option", id: optionId(n), role: "option", "data-command": command.id },
          h("span", { class: "ed-palette-title" }, command.title),
          h("span", { class: "ed-palette-group" }, command.group),
          keys && h("span", { class: "ed-keys" }, ...keys.map((token) => h("kbd", {}, hooks.keyName(token)))),
        );
        option.addEventListener("click", () => run(command));
        option.addEventListener("pointermove", () => {
          if (at === n) return;
          at = n;
          mark();
        });
        return option;
      }),
    );
    const none = found.length === 0;
    empty.hidden = !none;
    empty.textContent = none ? `Nothing here does "${input.value.trim()}".` : "";
    say.textContent = none
      ? "Nothing matches."
      : `${found.length} ${found.length === 1 ? "command" : "commands"}.`;
    mark();
  }

  function open() {
    if (!element.hidden) return;
    returnTo = document.activeElement;
    all = hooks.commands();
    input.value = "";
    element.hidden = false;
    draw();
    input.focus();
  }

  function close() {
    if (element.hidden) return;
    element.hidden = true;
    list.replaceChildren();
    all = [];
    found = [];
    if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    returnTo = null;
  }

  /** The palette goes first and the command after it, so a command that moves the keyboard has the last word. */
  function run(command: Command) {
    close();
    command.run();
  }

  input.addEventListener("input", draw);
  element.addEventListener("keydown", (event) => {
    // Nothing behind the palette hears a key: a T does not add a text, and Ctrl Z does not undo what it cannot show.
    event.stopPropagation();
    if (event.isComposing) return;
    const key = event.key;
    if (key === "Escape" || ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "k")) {
      event.preventDefault();
      close();
    } else if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (found.length === 0) return;
      at = (at + (key === "ArrowDown" ? 1 : -1) + found.length) % found.length;
      mark();
    } else if (key === "Enter") {
      event.preventDefault();
      const chosen = found[at];
      if (chosen) run(chosen);
    } else if (key === "Tab") {
      // The field is the only control, so Tab has nowhere to go.
      event.preventDefault();
    }
  });
  // A press on the dim part around the card shuts it, and a press on the card does not.
  element.addEventListener("pointerdown", (event) => {
    if (event.target === element) close();
  });

  return {
    element,
    get isOpen() {
      return !element.hidden;
    },
    open,
    close,
    toggle: () => (element.hidden ? open() : close()),
    destroy() {
      element.remove();
    },
  };
}
