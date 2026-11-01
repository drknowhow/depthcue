import { isLinkTarget, TONES, type Tone } from "@depthcue/core";
import { h } from "@depthcue/player";
import { type Format, isOn, LINK_RULE, linkOf, rangeIn, runFormat, toneOf } from "./richtext.ts";
import { TONE_LABEL } from "./templates.ts";

export interface FormatBar {
  readonly element: HTMLElement;
  /** Says whether the bar offers lists, which only body text has. */
  lists(on: boolean): void;
  destroy(): void;
}

const MARKS = [
  ["bold", "Bold", "Bold (Ctrl+B)", "b", "B"],
  ["italic", "Italic", "Italic (Ctrl+I)", "i", "I"],
] as const;

/**
 * The row of controls under the toolbar of a text while the keyboard is in the text: bold, italic, a link, a color for
 * the selected words, and bullets and numbers. A press on a button leaves the selection where it is. A link asks for its
 * address in a box of the row; the selection is kept for it, and given back when it is applied or put away.
 *
 * `host` is the slide's room: the bar finds out which text has the keyboard from the focus that moves through it, and
 * is shown while one does. `changed` is called when the bar appears, disappears or grows, so the toolbar can be placed
 * again.
 */
export function createFormatBar(host: HTMLElement, changed: () => void, withLists: boolean): FormatBar {
  let field: HTMLElement | undefined;
  let saved: Range | undefined;

  const press = (key: string, label: string, title: string, face: Node | string) =>
    h(
      "button",
      {
        type: "button",
        class: "ed-fmt-button",
        "data-fmt": key,
        "aria-label": label,
        title,
        "aria-pressed": "false",
      },
      face,
    );
  const marks = MARKS.map(([key, label, title, tag, letter]) => press(key, label, title, h(tag, {}, letter)));
  const linkButton = press("link", "Link", "Link the selected words (Ctrl+K)", "Link");
  const dots = TONES.map((tone) =>
    press(
      `tone-${tone}`,
      `${TONE_LABEL[tone]} color`,
      `Color the selected words ${TONE_LABEL[tone].toLowerCase()}; again to take it off`,
      h("span", { class: "ed-fmt-dot", "aria-hidden": "true" }),
    ),
  );
  const listButtons = [
    press("bullets", "Bulleted list", "Bulleted list", "•"),
    press("numbers", "Numbered list", "Numbered list", "1."),
  ];

  const input = h("input", {
    type: "text",
    class: "ed-fmt-input",
    "data-fmt": "link-address",
    "aria-label": "Link address",
    placeholder: "https://",
    spellcheck: "false",
    autocomplete: "off",
  });
  const line = h("p", { class: "ed-problem", role: "alert", hidden: true });
  const form = h(
    "form",
    { class: "ed-fmt-link", hidden: true },
    input,
    h("button", { type: "submit", "data-fmt": "link-apply" }, "Apply"),
    line,
  );
  const element = h(
    "div",
    {
      class: "ed-fmt",
      role: "toolbar",
      "aria-label": "Format the selected words",
      "data-formatbar": "",
      hidden: true,
    },
    ...marks,
    linkButton,
    h("span", { class: "ed-fmt-tones", role: "group", "aria-label": "Color" }, ...dots),
    ...listButtons,
    form,
  );

  const say = (text: string | undefined) => {
    line.hidden = text === undefined;
    line.textContent = text ?? "";
    input.toggleAttribute("aria-invalid", text !== undefined);
    changed();
  };
  const buttonOf = (key: string) => element.querySelector<HTMLElement>(`[data-fmt="${key}"]`);

  /** Brings each button up to date with the words the caret is in. */
  const refresh = () => {
    if (!field?.isConnected || element.hidden) return;
    const tone = toneOf(field);
    const pressed: Array<[string, boolean]> = [
      ...(["bold", "italic", "bullets", "numbers"] as const).map((key): [string, boolean] => [
        key,
        isOn(key),
      ]),
      ["link", linkOf(field) !== undefined],
      ...TONES.map((name): [string, boolean] => [`tone-${name}`, tone === name]),
    ];
    for (const [key, on] of pressed) buttonOf(key)?.setAttribute("aria-pressed", String(on));
  };

  /** The colors are the deck's own, so each dot is drawn in the color the words will have on the slide. */
  const paint = () => {
    const room = host.querySelector<HTMLElement>(".dc-player");
    if (!room) return;
    const style = getComputedStyle(room);
    TONES.forEach((tone, at) => {
      const color = style.getPropertyValue(`--dc-${tone}`).trim();
      if (color) dots[at]?.style.setProperty("--swatch", color);
    });
  };

  const show = () => {
    for (const button of listButtons) button.hidden = !withLists;
    if (element.hidden) {
      element.hidden = false;
      paint();
      changed();
    }
    refresh();
  };
  const closeLink = (back: boolean) => {
    if (form.hidden) return;
    // The keyboard goes back first: hiding the box while it has the keyboard would let go of it to nowhere.
    if (back && field?.isConnected) {
      field.focus({ preventScroll: true });
      const selection = getSelection();
      if (saved && selection) {
        selection.removeAllRanges();
        selection.addRange(saved);
      }
    }
    form.hidden = true;
    delete element.dataset.linking;
    say(undefined);
  };
  const hide = () => {
    closeLink(false);
    if (element.hidden) return;
    element.hidden = true;
    changed();
  };

  const run = (how: Format) => {
    if (!field?.isConnected) return;
    const problem = runFormat(field, how);
    if (problem !== undefined) say(problem);
    else if (!line.hidden && form.hidden) say(undefined);
    refresh();
  };

  const openLink = () => {
    const range = field && rangeIn(field);
    if (!field || !range) return;
    saved = range.cloneRange();
    input.value = linkOf(field) ?? "";
    form.hidden = false;
    // The box takes the place of the other buttons, so the bar stays as short as it was and clear of the words.
    element.dataset.linking = "";
    say(undefined);
    input.focus({ preventScroll: true });
    input.select();
  };

  // A press on a button must not take the keyboard from the text, or the selection would be lost with it.
  element.addEventListener("mousedown", (event) => {
    if (event.target instanceof Element && event.target.closest(".ed-fmt-link")) return;
    event.preventDefault();
  });
  element.addEventListener("click", (event) => {
    const key =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-fmt]")?.dataset.fmt : "";
    if (key === "bold" || key === "italic" || key === "bullets" || key === "numbers") run(key);
    else if (key === "link") {
      if (form.hidden) openLink();
      else closeLink(true);
    } else if (key?.startsWith("tone-")) run({ tone: key.slice(5) as Tone });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = input.value.trim();
    if (address !== "" && !isLinkTarget(address)) return say(LINK_RULE);
    if (!field?.isConnected) return;
    const problem = runFormat(field, { link: address }, saved);
    if (problem !== undefined) return say(problem);
    closeLink(false);
    refresh();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // The toolbar's own Escape would take the keyboard to the block; this one gives it back to the words.
    event.preventDefault();
    event.stopPropagation();
    closeLink(true);
  });
  input.addEventListener("input", () => {
    if (!line.hidden) say(undefined);
  });
  input.addEventListener("blur", (event) => {
    const to = event.relatedTarget;
    if (to instanceof Node && (element.contains(to) || field?.contains(to))) return;
    // The keyboard went somewhere else, so the text it left is settled as if it had been left directly.
    closeLink(false);
    field?.dispatchEvent(new Event("dc-settle"));
  });

  const onFocusIn = (event: FocusEvent) => {
    const rich = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-rich]") : null;
    if (!rich) return;
    field = rich;
    show();
  };
  const onFocusOut = (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (to instanceof Node && (element.contains(to) || (host.contains(to) && field?.contains(to)))) return;
    // Focus is on its way to a field that is not a rich text, or nowhere: the bar goes when it has settled.
    setTimeout(() => {
      const now = document.activeElement;
      if (now && (element.contains(now) || (field?.contains(now) ?? false))) return;
      hide();
    }, 0);
  };
  const onLink = (event: Event) => {
    if (event.target instanceof HTMLElement) field = event.target;
    show();
    openLink();
  };
  host.addEventListener("focusin", onFocusIn);
  host.addEventListener("focusout", onFocusOut);
  host.addEventListener("dc-link", onLink);
  document.addEventListener("selectionchange", refresh);

  // A bar built while a text has the keyboard shows at once.
  const active = document.activeElement;
  if (active instanceof Element && host.contains(active)) {
    const rich = active.closest<HTMLElement>("[data-rich]");
    if (rich) {
      field = rich;
      show();
    }
  }

  return {
    element,
    lists(on) {
      withLists = on;
      for (const button of listButtons) button.hidden = !on;
      changed();
    },
    destroy() {
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      host.removeEventListener("dc-link", onLink);
      document.removeEventListener("selectionchange", refresh);
    },
  };
}
