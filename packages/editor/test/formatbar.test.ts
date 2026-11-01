// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createFormatBar, type FormatBar } from "../src/formatbar.ts";
import { LINK_RULE } from "../src/richtext.ts";

let host: HTMLElement;
let field: HTMLElement;
let changed: Mock<() => void>;
let bar: FormatBar;

const enter = () => field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
const button = (key: string) => bar.element.querySelector<HTMLElement>(`[data-fmt="${key}"]`) as HTMLElement;
const form = () => bar.element.querySelector<HTMLFormElement>(".ed-fmt-link") as HTMLFormElement;
const input = () =>
  bar.element.querySelector<HTMLInputElement>("[data-fmt='link-address']") as HTMLInputElement;

/** Selects the characters of the field from `from` to `to`. */
function select(from: number, to: number) {
  const text = field.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, from);
  range.setEnd(text, to);
  const selection = document.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
}

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  field = document.createElement("div");
  field.setAttribute("data-rich", "");
  field.setAttribute("contenteditable", "true");
  field.tabIndex = 0;
  field.textContent = "Orders rose";
  host.append(field);
  document.body.append(host);
  changed = vi.fn<() => void>();
  bar = createFormatBar(host, changed, true);
  host.append(bar.element);
});

afterEach(() => bar.destroy());

describe("the format bar", () => {
  it("is shown while a rich text has the keyboard, and tells the toolbar so it can be placed again", () => {
    expect(bar.element.hidden).toBe(true);
    enter();
    expect(bar.element.hidden).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it("is not shown for a text that is not rich", () => {
    const plain = document.createElement("div");
    plain.setAttribute("contenteditable", "plaintext-only");
    host.append(plain);
    plain.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(bar.element.hidden).toBe(true);
  });

  it("has a button for each way to format, and a color for each of the four tones", () => {
    const keys = [...bar.element.querySelectorAll<HTMLElement>("button[data-fmt]")].map(
      (node) => node.dataset.fmt,
    );
    expect(keys).toEqual([
      "bold",
      "italic",
      "link",
      "tone-text",
      "tone-muted",
      "tone-action",
      "tone-evidence",
      "bullets",
      "numbers",
      "link-apply",
    ]);
  });

  it("offers lists only where the text can hold them, and follows the toolbar when the role changes", () => {
    enter();
    expect(button("bullets").hidden).toBe(false);
    bar.lists(false);
    expect(button("bullets").hidden).toBe(true);
    expect(button("numbers").hidden).toBe(true);
    bar.lists(true);
    expect(button("bullets").hidden).toBe(false);
  });

  it("asks for an address in its own box, in place of the other buttons, and puts it away with Escape", () => {
    enter();
    select(7, 11);
    expect(form().hidden).toBe(true);
    field.dispatchEvent(new Event("dc-link", { bubbles: true }));
    expect(form().hidden).toBe(false);
    expect(bar.element.dataset.linking).toBe("");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(form().hidden).toBe(true);
    expect(bar.element.dataset.linking).toBeUndefined();
    expect(field.textContent).toBe("Orders rose");
  });

  it("refuses an address that is not https or mailto, says what a link starts with, and leaves the words alone", () => {
    enter();
    select(7, 11);
    field.dispatchEvent(new Event("dc-link", { bubbles: true }));
    input().value = "ftp://example.com";
    form().dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const problem = bar.element.querySelector(".ed-problem") as HTMLElement;
    expect(problem.hidden).toBe(false);
    expect(problem.textContent).toBe(LINK_RULE);
    expect(input().getAttribute("aria-invalid")).not.toBeNull();
    expect(form().hidden).toBe(false);
    expect(field.innerHTML).toBe("Orders rose");
    // Typing in the box takes the message away.
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(problem.hidden).toBe(true);
  });
});
