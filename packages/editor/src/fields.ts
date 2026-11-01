import type { ApplyFailure, ApplyOptions, ApplyResult, Op } from "@depthcue/core";
import { h } from "@depthcue/player";

/** How a form changes the deck. The two differ only in what is redrawn afterwards. */
export interface Edits {
  /** For typing: everything is redrawn except the control being typed in, so the caret stays put. */
  type(ops: readonly Op[], options?: ApplyOptions): ApplyResult;
  /** For a click or a choice: everything is redrawn, this form included. */
  act(ops: readonly Op[], options?: ApplyOptions): ApplyResult;
}

/** What the core said was wrong with a refused change, in one line. */
export function problemOf(failure: ApplyFailure): string {
  const first = failure.diagnostics[0];
  if (!first) return "That change was refused.";
  return first.fix ? `${first.message} ${first.fix}` : first.message;
}

let uid = 0;
let visits = 0;

function problemLine(): HTMLElement {
  return h("p", { class: "ed-problem", role: "alert", hidden: true, id: `ed-problem-${++uid}` });
}

function mark(control: HTMLElement, line: HTMLElement, text: string | undefined) {
  line.hidden = text === undefined;
  line.textContent = text ?? "";
  if (text === undefined) {
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-describedby");
  } else {
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", line.id);
  }
}

function labelled(label: string, hint: string | undefined, control: HTMLElement, line: HTMLElement) {
  return h(
    "div",
    { class: "ed-field" },
    h("label", {}, h("span", { class: "ed-label" }, label), control),
    hint && h("p", { class: "ed-hint-text" }, hint),
    line,
  );
}

const dataField = (control: HTMLElement, key: string) => {
  control.setAttribute("data-field", key);
  return control;
};

export interface TextFieldOptions {
  /** Names the control, so it can be found again after a redraw. Unique within the form it is in. */
  key: string;
  label: string;
  /** The document's current value; used to show it again when what was typed cannot be kept. */
  read(): string;
  /** The operation for a typed value, or the reason there cannot be one. */
  commit(value: string): Op | string;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
  /** Left out of the form's label; used where the column already says what it is. */
  bare?: boolean;
}

export function textField(edits: Edits, options: TextFieldOptions): HTMLElement {
  const control = options.multiline
    ? h("textarea", { rows: 3, spellcheck: true })
    : h("input", { type: "text", spellcheck: true });
  control.value = options.read();
  if (options.placeholder) control.setAttribute("placeholder", options.placeholder);
  dataField(control, options.key);
  const line = problemLine();
  let visit = 0;

  control.addEventListener("focus", () => {
    visit = ++visits;
  });
  control.addEventListener("input", () => {
    const next = options.commit(control.value);
    if (typeof next === "string") return mark(control, line, next);
    const result = edits.type([next], { coalesce: `field:${options.key}:${visit}` });
    mark(control, line, result.ok ? undefined : problemOf(result));
  });
  control.addEventListener("blur", () => {
    // A refused value never reached the deck, so show what the deck still says.
    if (!line.hidden) {
      control.value = options.read();
      mark(control, line, undefined);
    }
  });
  if (options.bare) {
    control.setAttribute("aria-label", options.label);
    return h("div", { class: "ed-cell" }, control, line);
  }
  return labelled(options.label, options.hint, control, line);
}

export interface NumberFieldOptions {
  key: string;
  label: string;
  read(): number;
  commit(value: number): Op;
  /** Left out of the form's label; used where the column already says what it is. */
  bare?: boolean;
}

export function numberField(edits: Edits, options: NumberFieldOptions): HTMLElement {
  const control = h("input", { type: "number", step: "any", inputmode: "decimal" });
  control.value = String(options.read());
  dataField(control, options.key);
  if (options.bare) control.setAttribute("aria-label", options.label);
  const line = problemLine();
  let visit = 0;

  control.addEventListener("focus", () => {
    visit = ++visits;
  });
  control.addEventListener("input", () => {
    const value = control.value.trim() === "" ? Number.NaN : Number(control.value);
    if (!Number.isFinite(value)) return mark(control, line, "Enter a number.");
    const result = edits.type([options.commit(value)], { coalesce: `field:${options.key}:${visit}` });
    mark(control, line, result.ok ? undefined : problemOf(result));
  });
  control.addEventListener("blur", () => {
    if (!line.hidden) {
      control.value = String(options.read());
      mark(control, line, undefined);
    }
  });
  return options.bare
    ? h("div", { class: "ed-cell" }, control, line)
    : labelled(options.label, undefined, control, line);
}

export interface SelectFieldOptions {
  key: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  read(): string;
  commit(value: string): Op;
  /** Shown instead of a value when the document has none. */
  empty?: string;
  bare?: boolean;
}

export function selectField(edits: Edits, options: SelectFieldOptions): HTMLElement {
  const control = h("select", {});
  const current = options.read();
  const items = [
    ...(options.empty === undefined ? [] : [{ value: "", label: options.empty }]),
    ...options.options,
  ];
  // A value the list does not know, such as a file that was removed, is still shown rather than hidden.
  if (!items.some((item) => item.value === current)) items.push({ value: current, label: current });
  for (const item of items) control.append(h("option", { value: item.value }, item.label));
  control.value = current;
  dataField(control, options.key);
  if (options.bare) control.setAttribute("aria-label", options.label);
  const line = problemLine();
  control.addEventListener("change", () => {
    const result = edits.act([options.commit(control.value)]);
    if (!result.ok) {
      mark(control, line, problemOf(result));
      control.value = options.read();
    }
  });
  return options.bare
    ? h("div", { class: "ed-cell" }, control, line)
    : labelled(options.label, undefined, control, line);
}

export interface ColorFieldOptions {
  key: string;
  label: string;
  /** The color the deck is drawn with now, as `#rrggbb`. */
  read(): string;
  commit(value: string): Op;
  /** Whether the deck names this color itself. Only then is there a reset to show. */
  changed(): boolean;
  /** The operation that puts the color back to what the preset has. */
  reset(): Op;
  /** Says a refusal where the person is looking beyond this field, or clears it. */
  problem?(text: string | undefined): void;
}

/**
 * A color swatch: the native color input, the name of the color, its hex, and a reset while the deck names the color
 * itself. Dragging in the picker is one undo step, however many colors it passes through. A color the deck refuses, as
 * one that leaves text unreadable, is said in a line under the swatch and never reaches the deck, and the swatch goes
 * back to what the deck has when the picker closes.
 */
export function colorField(edits: Edits, options: ColorFieldOptions): HTMLElement {
  const control = h("input", { type: "color", class: "ed-swatch" });
  const hex = h("code", { class: "ed-color-hex" });
  const show = (value: string) => {
    control.value = value;
    hex.textContent = value;
  };
  show(options.read().toLowerCase());
  dataField(control, options.key);
  control.setAttribute("aria-label", options.label);
  const line = problemLine();
  const reset = h("button", { type: "button", class: "ed-tb-mini ed-color-reset" }, "Reset");
  reset.setAttribute("aria-label", `Reset ${options.label} to the preset`);
  reset.setAttribute("data-field", `${options.key}:reset`);
  reset.hidden = !options.changed();
  // Each pass of the picker, from opening it to closing it, is a step of its own to undo.
  let pass = ++visits;

  const say = (text: string | undefined) => {
    mark(control, line, text);
    options.problem?.(text);
  };
  control.addEventListener("input", () => {
    hex.textContent = control.value;
    const result = edits.type([options.commit(control.value)], { coalesce: `field:${options.key}:${pass}` });
    say(result.ok ? undefined : problemOf(result));
    if (result.ok) reset.hidden = false;
  });
  // A refused color never reached the deck, so show what the deck still says.
  const settle = () => {
    if (line.hidden) return;
    show(options.read().toLowerCase());
    say(undefined);
  };
  control.addEventListener("change", () => {
    pass = ++visits;
    settle();
  });
  control.addEventListener("blur", settle);
  reset.addEventListener("click", () => {
    const result = edits.act([options.reset()]);
    say(result.ok ? undefined : problemOf(result));
  });
  return h(
    "div",
    { class: "ed-field ed-color", "data-color": options.key.slice(options.key.lastIndexOf(":") + 1) },
    h(
      "div",
      { class: "ed-color-row" },
      h("label", { class: "ed-color-pick" }, control, h("span", { class: "ed-color-name" }, options.label)),
      hex,
      reset,
    ),
    line,
  );
}

export interface ChoiceFieldOptions {
  key: string;
  label: string;
  hint?: string;
  choices: ReadonlyArray<{
    value: string;
    label: string;
    /** A second line that says more about the choice. */
    detail?: string;
    /** Set on the choice's own element, so the page's styles can show the choice as it will look. */
    attributes?: Record<string, string>;
  }>;
  read(): string;
  commit(value: string): Op;
}

let groups = 0;

/** A few choices of which one holds, as radio buttons. Each choice is a control of its own, found by `key:value`. */
export function choiceField(edits: Edits, options: ChoiceFieldOptions): HTMLElement {
  const name = `ed-choice-${++groups}`;
  const line = problemLine();
  const current = options.read();
  const radios = options.choices.map((choice) => {
    const radio = h("input", { type: "radio", name, value: choice.value });
    radio.checked = choice.value === current;
    dataField(radio, `${options.key}:${choice.value}`);
    const row = h(
      "label",
      { class: "ed-choice", ...choice.attributes },
      radio,
      h("span", { class: "ed-choice-sample", "aria-hidden": "true" }, "Aa"),
      h(
        "span",
        { class: "ed-choice-text" },
        h("span", { class: "ed-choice-name" }, choice.label),
        choice.detail && h("span", { class: "ed-hint-text" }, choice.detail),
      ),
    );
    return { radio, row };
  });
  const group = h(
    "fieldset",
    { class: "ed-choices" },
    h("legend", { class: "ed-label" }, options.label),
    options.hint && h("p", { class: "ed-hint-text" }, options.hint),
    ...radios.map(({ row }) => row),
    line,
  );
  group.addEventListener("change", (event) => {
    const picked = radios.find(({ radio }) => radio === event.target);
    if (!picked) return;
    const result = edits.act([options.commit(picked.radio.value)]);
    if (result.ok) {
      line.hidden = true;
      return;
    }
    for (const { radio } of radios) radio.checked = radio.value === options.read();
    line.hidden = false;
    line.textContent = problemOf(result);
  });
  return group;
}

export interface CheckFieldOptions {
  key: string;
  label: string;
  items: ReadonlyArray<{ id: string; label: string }>;
  read(): readonly string[];
  commit(ids: string[]): Op;
  none?: string;
}

/** A set of choices, each a checkbox; the chosen ids come back in the list's own order. */
export function checkField(edits: Edits, options: CheckFieldOptions): HTMLElement {
  const chosen = new Set(options.read());
  const line = problemLine();
  const boxes = options.items.map((item) => {
    const box = h("input", { type: "checkbox", value: item.id });
    box.checked = chosen.has(item.id);
    dataField(box, `${options.key}:${item.id}`);
    return { item, box };
  });
  const group = h(
    "fieldset",
    { class: "ed-checks" },
    h("legend", { class: "ed-label" }, options.label),
    ...(boxes.length === 0
      ? [h("p", { class: "ed-hint-text" }, options.none ?? "Nothing to choose yet.")]
      : boxes.map(({ item, box }) => h("label", { class: "ed-check" }, box, h("span", {}, item.label)))),
    line,
  );
  group.addEventListener("change", () => {
    const ids = boxes.filter(({ box }) => box.checked).map(({ item }) => item.id);
    const result = edits.act([options.commit(ids)]);
    if (!result.ok) {
      for (const { item, box } of boxes) box.checked = options.read().includes(item.id);
      line.hidden = false;
      line.textContent = problemOf(result);
    }
  });
  return group;
}

export function actionButton(
  label: string,
  onClick: () => void,
  attributes: Record<string, string | boolean | undefined> = {},
): HTMLButtonElement {
  const node = h("button", { type: "button", ...attributes }, label);
  node.addEventListener("click", onClick);
  return node;
}

/** A button that opens the file chooser. The real input stays reachable by keyboard, behind its label. */
export function fileButton(
  label: string,
  accept: string,
  key: string,
  onFile: (file: File) => void,
): HTMLElement {
  const input = h("input", { type: "file", accept, class: "ed-sr-only" });
  dataField(input, key);
  input.addEventListener("change", () => {
    const [file] = input.files ?? [];
    if (file) onFile(file);
    input.value = "";
  });
  return h("label", { class: "ed-button" }, input, h("span", {}, label));
}
