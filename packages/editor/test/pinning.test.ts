// @vitest-environment happy-dom
import { type Frame, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let store: EditorStore;
let editor: Editor;

beforeEach(async () => {
  store = await openStore(new FakeServer(), () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select("method");
});
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const SCENE = "method";
const TEXT = "method-body";
const PICTURE = "method-diagram";

const toolbar = () => host.querySelector<HTMLElement>(".ed-toolbar") as HTMLElement;
const part = <T extends HTMLElement = HTMLElement>(name: string) =>
  toolbar().querySelector(`[data-tb='${name}']`) as T;
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const inside = (id: string) =>
  host.querySelector<HTMLElement>(`[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`);
const frameOf = (id: string): Frame | undefined =>
  store.session.doc.scenes[SCENE]?.blocks.find((block) => block.id === id)?.frame;
const press = (node: Element, key: string, init: KeyboardEventInit = {}) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const hint = () => host.querySelector(".ed-hint")?.textContent ?? "";
const popOf = (name: string) =>
  part(name).closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
const control = (key: string) =>
  toolbar().querySelector<HTMLInputElement>(`[data-field="${key}"]`) as HTMLInputElement;
const typeInto = (node: HTMLInputElement, text: string) => {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};

/** Pins a block the way a stored deck has it, without going through the editor. */
const pinned = (id: string, frame: Frame) => {
  const result = store.session.apply([{ op: "block.frame", scene: SCENE, id, frame }]);
  if (!result.ok) throw new Error("the frame should be accepted");
};

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  }) as DOMRect;

/** There is no layout here, so the boxes of the slide and of some blocks are given: the slide is 1600 by 900. */
const laidOut = (boxes: Record<string, [number, number, number, number]>) => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("dc-view")) return rect(0, 0, 1600, 900);
    const found = this instanceof HTMLElement && this.dataset.id ? boxes[this.dataset.id] : undefined;
    return found ? rect(...found) : rect(0, 0, 0, 0);
  });
};

describe("pinning with the toolbar", () => {
  it("pins a block where it is, so it does not move", () => {
    laidOut({ [PICTURE]: [160, 450, 640, 90] });
    blockNode(PICTURE).click();
    expect(part("layout").getAttribute("aria-pressed")).toBe("true");
    expect(part("free").getAttribute("aria-pressed")).toBe("false");
    part("free").click();
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 50, w: 40, h: 10 });
    expect(part("layout").getAttribute("aria-pressed")).toBe("false");
    expect(part("free").getAttribute("aria-pressed")).toBe("true");
  });

  it("does the same for a text, which is pinned from its toolbar and not by typing in it", () => {
    laidOut({ [TEXT]: [320, 90, 800, 180] });
    inside(TEXT)?.focus();
    part("free").click();
    expect(frameOf(TEXT)).toEqual({ x: 20, y: 10, w: 50, h: 20 });
  });

  it("says so, and changes nothing, when the block has no place on the slide to pin", () => {
    blockNode(PICTURE).click();
    part("free").click();
    expect(frameOf(PICTURE)).toBeUndefined();
    expect(hint()).toContain("nowhere to pin");
  });

  it("puts a pinned block back in its slot with Layout, as one undo step that Undo takes back", () => {
    laidOut({ [PICTURE]: [160, 450, 640, 90] });
    blockNode(PICTURE).click();
    part("free").click();
    part("layout").click();
    expect(frameOf(PICTURE)).toBeUndefined();
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 50, w: 40, h: 10 });
    store.session.undo();
    expect(frameOf(PICTURE)).toBeUndefined();
  });

  it("leaves a pinned block where it is when Free is pressed again", () => {
    pinned(PICTURE, { x: 10, y: 10, w: 30, h: 20 });
    laidOut({ [PICTURE]: [800, 450, 320, 90] });
    blockNode(PICTURE).click();
    part("free").click();
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 10, w: 30, h: 20 });
  });

  it("takes no step when Layout is pressed on a block that is already in its slot", () => {
    pinned(TEXT, { x: 50, y: 50, w: 30, h: 20 });
    blockNode(PICTURE).click();
    part("layout").click();
    expect(hint()).toBe("");
    store.session.undo();
    expect(frameOf(TEXT)).toBeUndefined();
  });

  it("shows the Pinned chip only while the block is pinned", () => {
    laidOut({ [PICTURE]: [160, 450, 640, 90] });
    blockNode(PICTURE).click();
    const wrap = part("frame").closest<HTMLElement>(".ed-tb-chip-wrap") as HTMLElement;
    expect(wrap.hidden).toBe(true);
    part("free").click();
    expect(wrap.hidden).toBe(false);
    expect(part("frame").getAttribute("aria-label")).toContain("Pinned at 10% across and 50% down");
  });

  it("closes the Pinned popover when the block is put back in its slot", () => {
    pinned(PICTURE, { x: 10, y: 10, w: 30, h: 20 });
    blockNode(PICTURE).click();
    part("frame").click();
    expect(popOf("frame").hidden).toBe(false);
    part("layout").click();
    expect(popOf("frame").hidden).toBe(true);
  });

  it("does not offer a claim a place to be pinned", () => {
    const claim = store.session.doc.scenes[SCENE]?.summary?.id;
    if (!claim) return;
    host.querySelector<HTMLElement>(`.ed-frame [data-id='${claim}']`)?.click();
    expect(toolbar().querySelector("[data-tb='free']")).toBeNull();
  });
});

describe("the P key", () => {
  it("pins the chosen block where it is, and puts it back the next time", () => {
    laidOut({ [PICTURE]: [160, 450, 640, 90] });
    blockNode(PICTURE).click();
    press(document.body, "p");
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 50, w: 40, h: 10 });
    press(document.body, "P");
    expect(frameOf(PICTURE)).toBeUndefined();
  });

  it("is a letter like any other while a field has the keyboard", () => {
    laidOut({ [TEXT]: [320, 90, 800, 180] });
    const typed = inside(TEXT) as HTMLElement;
    typed.focus();
    press(typed, "p");
    expect(frameOf(TEXT)).toBeUndefined();
    const select = part<HTMLSelectElement>("role");
    select.focus();
    press(select, "p");
    expect(frameOf(TEXT)).toBeUndefined();
  });

  it("does nothing with a modifier, or when no block is chosen", () => {
    laidOut({ [PICTURE]: [160, 450, 640, 90] });
    press(document.body, "p");
    blockNode(PICTURE).click();
    press(document.body, "p", { ctrlKey: true });
    press(document.body, "p", { altKey: true });
    press(document.body, "p", { repeat: true });
    expect(frameOf(PICTURE)).toBeUndefined();
  });
});

describe("a pinned text", () => {
  beforeEach(() => pinned(TEXT, { x: 10, y: 10, w: 50, h: 20 }));

  it("is chosen as a block, and is not typed in until it is asked for", () => {
    expect(inside(TEXT)).toBeNull();
    const node = blockNode(TEXT);
    expect(node.hasAttribute("data-pick")).toBe(true);
    expect(node.tabIndex).toBe(0);
    expect(node.getAttribute("aria-label")).toContain("Press Enter to type in it");
    node.click();
    expect(editor.blockId).toBe(TEXT);
    expect(inside(TEXT)).toBeNull();
  });

  it("is typed in after Enter, and the keyboard goes back to the block when Enter finishes", () => {
    press(blockNode(TEXT), "Enter");
    const field = inside(TEXT) as HTMLElement;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    field.textContent = "A new line";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const typed = store.session.doc.scenes[SCENE]?.blocks.find((block) => block.id === TEXT);
    expect(typed?.type === "text" && typed.text).toBe("A new line");
    field.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", cancelable: true }));
    expect(inside(TEXT)).toBeNull();
    expect(document.activeElement).toBe(blockNode(TEXT));
    expect(editor.blockId).toBe(TEXT);
  });

  it("is typed in after a double click", () => {
    blockNode(TEXT).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(document.activeElement).toBe(inside(TEXT));
  });

  it("gives the keyboard back to the block on Escape, still chosen, with the text as the deck has it", () => {
    press(blockNode(TEXT), "Enter");
    const field = inside(TEXT) as HTMLElement;
    field.textContent = "";
    press(field, "Escape");
    expect(inside(TEXT)).toBeNull();
    expect(document.activeElement).toBe(blockNode(TEXT));
    expect(editor.blockId).toBe(TEXT);
    expect(blockNode(TEXT).textContent).not.toBe("");
  });

  it("keeps its Delete, arrow and Enter keys for the caret while it is typed in", () => {
    press(blockNode(TEXT), "Enter");
    const field = inside(TEXT) as HTMLElement;
    for (const name of ["Delete", "Backspace", "ArrowRight", "ArrowDown", "Enter"]) {
      const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(store.session.doc.scenes[SCENE]?.blocks.some((block) => block.id === TEXT)).toBe(true);
    expect(frameOf(TEXT)).toEqual({ x: 10, y: 10, w: 50, h: 20 });
    expect(inside(TEXT)).toBe(field);
  });

  it("is reached by Tab and named as a block again after it has been typed in", () => {
    press(blockNode(TEXT), "Enter");
    (inside(TEXT) as HTMLElement).dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertParagraph", cancelable: true }),
    );
    const node = blockNode(TEXT);
    expect(node.getAttribute("role")).toBe("button");
    expect(node.getAttribute("aria-label")).toContain("Press Enter to type in it");
    expect(node.tabIndex).toBe(0);
    expect(node.hasAttribute("contenteditable")).toBe(false);
    expect(node.hasAttribute("data-edit")).toBe(false);
  });

  it("is left as it is by a double click on the text being typed in, and is put back after it", () => {
    press(blockNode(TEXT), "Enter");
    const field = inside(TEXT) as HTMLElement;
    field.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(inside(TEXT)).toBe(field);
    field.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", cancelable: true }));
    expect(inside(TEXT)).toBeNull();
    expect(blockNode(TEXT).getAttribute("role")).toBe("button");
  });

  it("is typed in as ordinary text again once it is put back in its slot", () => {
    blockNode(TEXT).click();
    part("layout").click();
    expect(inside(TEXT)).not.toBeNull();
  });

  it("is removed by Delete on the block, which Undo takes back", () => {
    blockNode(TEXT).focus();
    press(blockNode(TEXT), "Delete");
    expect(frameOf(TEXT)).toBeUndefined();
    expect(store.session.doc.scenes[SCENE]?.blocks.some((block) => block.id === TEXT)).toBe(false);
    store.session.undo();
    expect(frameOf(TEXT)).toEqual({ x: 10, y: 10, w: 50, h: 20 });
  });
});

describe("nudging with the arrow keys", () => {
  const start = { x: 10, y: 10, w: 30, h: 20 };
  beforeEach(() => {
    pinned(PICTURE, start);
    blockNode(PICTURE).focus();
  });
  /** The block is drawn again after every change, so each key goes to the node that is there now. */
  const key = (name: string, init: KeyboardEventInit = {}) => press(blockNode(PICTURE), name, init);

  it("moves a pinned block 1%, or 5% with Shift", () => {
    key("ArrowRight");
    expect(frameOf(PICTURE)).toEqual({ ...start, x: 11 });
    key("ArrowDown", { shiftKey: true });
    expect(frameOf(PICTURE)).toEqual({ ...start, x: 11, y: 15 });
    key("ArrowLeft", { shiftKey: true });
    key("ArrowUp");
    expect(frameOf(PICTURE)).toEqual({ ...start, x: 6, y: 14 });
  });

  it("keeps the keyboard on the block while it moves", () => {
    key("ArrowRight");
    key("ArrowRight");
    expect(document.activeElement).toBe(blockNode(PICTURE));
  });

  it("joins the presses of one run into a single undo step", () => {
    for (const name of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown"]) key(name);
    expect(frameOf(PICTURE)).toEqual({ ...start, x: 13, y: 11 });
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual(start);
  });

  it("starts a new undo step after a pause", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(10_000);
    key("ArrowRight");
    now.mockReturnValue(10_400);
    key("ArrowRight");
    now.mockReturnValue(12_000);
    key("ArrowRight");
    expect(frameOf(PICTURE)?.x).toBe(13);
    store.session.undo();
    expect(frameOf(PICTURE)?.x).toBe(12);
    store.session.undo();
    expect(frameOf(PICTURE)?.x).toBe(10);
  });

  it("stops at the edge of the slide without making an undo step", () => {
    pinned(PICTURE, { x: 0, y: 10, w: 30, h: 20 });
    key("ArrowLeft");
    key("ArrowLeft", { shiftKey: true });
    expect(frameOf(PICTURE)).toEqual({ x: 0, y: 10, w: 30, h: 20 });
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual(start);
  });

  it("does nothing to a block that is not pinned", () => {
    blockNode(PICTURE).click();
    part("layout").click();
    const before = JSON.stringify(store.session.doc.scenes[SCENE]);
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    blockNode(PICTURE).dispatchEvent(event);
    key("ArrowRight");
    expect(JSON.stringify(store.session.doc.scenes[SCENE])).toBe(before);
    // The arrow keys still scroll the page when they have no block to move.
    expect(event.defaultPrevented).toBe(false);
  });

  it("does not join the presses on two blocks into one undo step", () => {
    pinned(TEXT, { x: 50, y: 50, w: 30, h: 20 });
    key("ArrowRight");
    press(blockNode(TEXT), "ArrowRight");
    expect(frameOf(PICTURE)?.x).toBe(11);
    expect(frameOf(TEXT)?.x).toBe(51);
    store.session.undo();
    expect(frameOf(TEXT)?.x).toBe(50);
    expect(frameOf(PICTURE)?.x).toBe(11);
  });
});

describe("the Pinned popover", () => {
  const start = { x: 10, y: 10, w: 30, h: 20 };
  beforeEach(() => {
    pinned(PICTURE, start);
    blockNode(PICTURE).click();
    part("frame").click();
  });

  it("shows where the block is, in percent of the slide", () => {
    expect(popOf("frame").hidden).toBe(false);
    expect(["x", "y", "w", "h"].map((name) => control(`frame:${name}`).value)).toEqual([
      "10",
      "10",
      "30",
      "20",
    ]);
  });

  it("moves and resizes the block as numbers are typed, and joins a visit into one undo step", () => {
    typeInto(control("frame:x"), "2");
    typeInto(control("frame:x"), "25");
    typeInto(control("frame:w"), "40");
    expect(frameOf(PICTURE)).toEqual({ x: 25, y: 10, w: 40, h: 20 });
    store.session.undo();
    store.session.undo();
    expect(frameOf(PICTURE)).toEqual(start);
  });

  it("refuses a number that runs off the slide, says why, and leaves the block where it is", () => {
    const width = control("frame:w");
    typeInto(width, "95");
    expect(frameOf(PICTURE)).toEqual(start);
    expect(width.getAttribute("aria-invalid")).toBe("true");
    expect(width.closest(".ed-field")?.querySelector(".ed-problem")?.textContent).toContain("105%");
  });

  it("lines the block up on the left margin, the middle, and the right margin", () => {
    const align = (how: string) => part(`align-${how}`).click();
    align("right");
    expect(frameOf(PICTURE)).toEqual({ x: 66, y: 10, w: 30, h: 20 });
    align("center");
    expect(frameOf(PICTURE)).toEqual({ x: 35, y: 10, w: 30, h: 20 });
    align("left");
    expect(frameOf(PICTURE)).toEqual({ x: 4, y: 10, w: 30, h: 20 });
  });

  it("follows the block as it is moved by the keyboard", () => {
    blockNode(PICTURE).focus();
    press(blockNode(PICTURE), "ArrowRight", { shiftKey: true });
    expect(control("frame:x").value).toBe("15");
  });
});
