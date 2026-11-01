// @vitest-environment happy-dom
import { type Frame, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { shortcutTable } from "../src/shortcuts.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

async function mount() {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  // The method scene has a heading, a body text and a picture, and no claim.
  editor.select("method");
}

beforeEach(mount);
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const TEXT = "method-body";
const PICTURE = "method-diagram";

const press = (node: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
};
const bar = () => host.querySelector<HTMLElement>(".ed-quick") as HTMLElement;
const quick = (name: string) =>
  bar().querySelector<HTMLButtonElement>(`[data-quick='${name}']`) as HTMLElement;
const sheet = () => host.querySelector<HTMLElement>(".ed-sheet") as HTMLElement;
const card = () => sheet().querySelector<HTMLElement>("[role='dialog']") as HTMLElement;
const closeButton = () =>
  sheet().querySelector<HTMLElement>("[data-action='close-shortcuts']") as HTMLElement;
const fileInput = () => bar().querySelector<HTMLInputElement>("input[type='file']") as HTMLInputElement;
const blocks = () => store.session.doc.scenes.method?.blocks ?? [];
const kinds = () => blocks().map((block) => block.type);
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const inside = (id: string) =>
  host.querySelector<HTMLElement>(`[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`);
const frameOf = (id: string): Frame | undefined => blocks().find((block) => block.id === id)?.frame;
const chartValues = () => {
  const chart = store.session.doc.scenes.demand?.blocks.find((block) => block.id === "chart-demand");
  return chart?.type === "bar-chart" ? chart.data.map((row) => row.value) : [];
};

/** Pins a block the way a stored deck has it. */
const pinned = (id: string, frame: Frame) => {
  const result = store.session.apply([{ op: "block.frame", scene: "method", id, frame }]);
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

/** There is no layout here, so a block is given its box on a slide that is 1600 by 900. */
const laidOut = (boxes: Record<string, [number, number, number, number]>) => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("dc-view")) return rect(0, 0, 1600, 900);
    const found = this instanceof HTMLElement && this.dataset.id ? boxes[this.dataset.id] : undefined;
    return found ? rect(...found) : rect(0, 0, 0, 0);
  });
};

/**
 * One case for every key in the table, by its id. A key added to the table, or taken out, fails the test below
 * until this list says what pressing it does.
 */
const CASES: Record<string, () => void | Promise<void>> = {
  "add-text"() {
    press(document, "t");
    // The new text joins the texts of the slide, ahead of its picture, and is the chosen block.
    expect(kinds()).toEqual(["text", "text", "text", "image"]);
    expect(editor.blockId).toBe(blocks()[2]?.id);
  },
  "add-chart"() {
    press(document, "c");
    expect(kinds()).toEqual(["text", "text", "image", "bar-chart"]);
  },
  "add-image"() {
    const opened = vi.fn();
    fileInput().addEventListener("click", opened);
    press(document, "i");
    expect(opened).toHaveBeenCalledTimes(1);
  },
  undo() {
    store.session.apply([retitle("Edited")]);
    press(document, "z", { ctrlKey: true });
    expect(openingTitle(store.session.doc)).not.toBe("Edited");
  },
  redo() {
    store.session.apply([retitle("Edited")]);
    store.session.undo();
    press(document, "z", { ctrlKey: true, shiftKey: true });
    expect(openingTitle(store.session.doc)).toBe("Edited");
    store.session.undo();
    press(document, "y", { ctrlKey: true });
    expect(openingTitle(store.session.doc)).toBe("Edited");
  },
  async save() {
    store.session.apply([retitle("Edited")]);
    press(document, "s", { ctrlKey: true });
    await vi.waitFor(() => expect(server.saves).toHaveLength(1));
  },
  palette() {
    const palette = () => host.querySelector<HTMLElement>(".ed-palette") as HTMLElement;
    const event = press(document, "k", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(palette().hidden).toBe(false);
    // Inside it the same key puts it away again.
    press(palette().querySelector("input") as HTMLElement, "k", { ctrlKey: true });
    expect(palette().hidden).toBe(true);
  },
  help() {
    press(document, "?");
    expect(sheet().hidden).toBe(false);
  },
  pin() {
    laidOut({ [PICTURE]: [160, 450, 640, 90] });
    blockNode(PICTURE).click();
    press(document, "p");
    expect(frameOf(PICTURE)).toEqual({ x: 10, y: 50, w: 40, h: 10 });
    press(document, "p");
    expect(frameOf(PICTURE)).toBeUndefined();
  },
  toolbar() {
    blockNode(PICTURE).click();
    const event = press(document, "F10", { altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.closest(".ed-toolbar")).not.toBeNull();
  },
  edit() {
    pinned(TEXT, { x: 10, y: 10, w: 50, h: 20 });
    press(blockNode(TEXT), "Enter");
    expect(inside(TEXT)).not.toBeNull();
  },
  nudge() {
    pinned(PICTURE, { x: 10, y: 10, w: 30, h: 20 });
    press(blockNode(PICTURE), "ArrowRight");
    expect(frameOf(PICTURE)?.x).toBe(11);
    press(blockNode(PICTURE), "ArrowDown", { shiftKey: true });
    expect(frameOf(PICTURE)?.y).toBe(15);
  },
  remove() {
    blockNode(PICTURE).click();
    press(blockNode(PICTURE), "Delete");
    expect(blocks().some((block) => block.id === PICTURE)).toBe(false);
  },
  "let-go"() {
    blockNode(PICTURE).click();
    expect(editor.blockId).toBe(PICTURE);
    press(blockNode(PICTURE), "Escape");
    expect(editor.blockId).toBeUndefined();
  },
  "bar-value"() {
    editor.select("demand");
    const first = host.querySelector<HTMLElement>(".dc-bar") as HTMLElement;
    first.focus();
    const before = chartValues()[0] as number;
    press(first, "ArrowRight");
    expect(chartValues()[0]).toBe(before + 1);
    press(host.querySelector<HTMLElement>(".dc-bar") as HTMLElement, "ArrowRight", { shiftKey: true });
    expect(chartValues()[0]).toBe(before + 6);
  },
};

describe("the table of shortcuts", () => {
  it("is the list the sheet draws, and every key in it has a case here", () => {
    const drawn = [...sheet().querySelectorAll("[data-shortcut]")].map((row) =>
      row.getAttribute("data-shortcut"),
    );
    const table = shortcutTable({
      add() {},
      pickImage() {},
      undo() {},
      redo() {},
      save() {},
      pin: () => false,
      toolbar: () => false,
      palette() {},
    }).map((entry) => entry.id);
    expect([...drawn].sort()).toEqual([...table].sort());
    expect([...table].sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(Object.keys(CASES))("%s does what the sheet says", async (id) => {
    await CASES[id]?.();
  });

  it("opens the palette on Ctrl K or Command K, and not on a K alone or with Shift", () => {
    const palette = host.querySelector<HTMLElement>(".ed-palette") as HTMLElement;
    // Each press is checked by itself: a second one that opened it would shut it again.
    for (const keys of [{}, { shiftKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }]) {
      press(document, keys.shiftKey ? "K" : "k", keys);
      expect(palette.hidden).toBe(true);
    }
    press(document, "k", { metaKey: true });
    expect(palette.hidden).toBe(false);
  });
});

describe("the shortcut sheet", () => {
  it("is shut until it is asked for", () => {
    expect(sheet().hidden).toBe(true);
  });

  it("opens on ? and puts the keyboard in the dialog", () => {
    const event = press(document, "?");
    expect(event.defaultPrevented).toBe(true);
    expect(sheet().hidden).toBe(false);
    expect(card().getAttribute("aria-modal")).toBe("true");
    const title = host.querySelector(`#${card().getAttribute("aria-labelledby")}`);
    expect(title?.textContent).toBe("Keyboard shortcuts");
    expect(document.activeElement).toBe(card());
  });

  it("groups the keys and writes each of them on a key cap", () => {
    const groups = [...sheet().querySelectorAll(".ed-sheet-group h3")].map((heading) => heading.textContent);
    expect(groups).toEqual([
      "Add to the slide",
      "Everywhere",
      "The chosen block",
      "With a block focused",
      "On a chart bar",
    ]);
    const caps = (id: string) =>
      [...(sheet().querySelectorAll(`[data-shortcut='${id}'] kbd`) ?? [])].map((key) => key.textContent);
    expect(caps("add-text")).toEqual(["T"]);
    expect(caps("undo")).toEqual(["Ctrl", "Z"]);
    expect(caps("redo")).toEqual(["Ctrl", "Shift", "Z", "Ctrl", "Y"]);
    expect(sheet().querySelector("[data-shortcut='redo'] .ed-keys-or")?.textContent).toBe("or");
  });

  it("calls the shortcut key Command on a Mac", async () => {
    editor.destroy();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await mount();
    expect([...sheet().querySelectorAll("[data-shortcut='undo'] kbd")].map((key) => key.textContent)).toEqual(
      ["⌘", "Z"],
    );
  });

  it("opens from the ? button in the bar, and gives the keyboard back to it", () => {
    const button = quick("keys");
    button.focus();
    button.click();
    expect(sheet().hidden).toBe(false);
    closeButton().click();
    expect(sheet().hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it.each([
    ["?", () => press(card(), "?")],
    ["Escape", () => press(card(), "Escape")],
    ["the Close button", () => closeButton().click()],
    ["a press on the dimmed editor around it", () => sheet().click()],
  ])("shuts on %s and gives the keyboard back", (_name, close) => {
    const from = quick("claim");
    from.focus();
    press(document, "?");
    close();
    expect(sheet().hidden).toBe(true);
    expect(document.activeElement).toBe(from);
  });

  it("stays open when the card itself is pressed", () => {
    press(document, "?");
    card().click();
    expect(sheet().hidden).toBe(false);
  });

  it("keeps Tab on its one control", () => {
    press(document, "?");
    const event = press(card(), "Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton());
  });

  it("lets no other key act behind it", () => {
    store.session.apply([retitle("Edited")]);
    press(document, "?");
    press(card(), "t");
    press(card(), "z", { ctrlKey: true });
    expect(kinds()).toEqual(["text", "text", "image"]);
    expect(openingTitle(store.session.doc)).toBe("Edited");
  });

  it("is not opened by a ? typed into a field", () => {
    const field = document.createElement("textarea");
    host.append(field);
    field.focus();
    const event = press(field, "?");
    expect(event.defaultPrevented).toBe(false);
    expect(sheet().hidden).toBe(true);
  });

  it("stops listening when the editor is taken down", async () => {
    const removed = vi.spyOn(document, "removeEventListener");
    editor.destroy();
    expect(removed.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(["keydown", "pointermove", "pointerdown"]),
    );
    // A key pressed after that reaches nothing: the deck is as it was and the page has no sheet.
    press(document, "t");
    press(document, "?");
    expect(kinds()).toEqual(["text", "text", "image"]);
    expect(document.querySelector(".ed-sheet")).toBeNull();
    // The next test's teardown takes down the editor mounted here.
    await mount();
  });
});

describe("the keys that add to the slide", () => {
  it("answer to a capital letter too, for a keyboard with Caps Lock on", () => {
    press(document, "T", { shiftKey: true });
    expect(kinds()).toHaveLength(4);
  });

  it("leave a key with Ctrl, Alt or Command to the browser", () => {
    const events = [
      press(document, "t", { ctrlKey: true }),
      press(document, "c", { altKey: true }),
      press(document, "i", { metaKey: true }),
    ];
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false]);
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("act once for a key held down", () => {
    press(document, "t");
    press(document, "t", { repeat: true });
    expect(kinds()).toHaveLength(4);
  });

  it("are letters like any other in a field, and in text being edited on the slide", () => {
    const field = document.createElement("textarea");
    host.append(field);
    field.focus();
    const events = [press(field, "t"), press(field, "c"), press(field, "i"), press(field, "p")];
    const text = inside("method-heading") as HTMLElement;
    events.push(press(text, "t"));
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false, false, false]);
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("leave a key to whatever already took it", () => {
    quick("claim").addEventListener("keydown", (event) => event.preventDefault());
    press(quick("claim"), "t");
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("do nothing while the keyboard is composing a character", () => {
    press(document, "t", { isComposing: true });
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("do the same as the buttons, down to the one Undo that takes the block back", () => {
    press(document, "t");
    store.session.undo();
    expect(kinds()).toEqual(["text", "text", "image"]);
  });
});

describe("keys that need a block, or an editor to answer them", () => {
  it("leave P and Alt+F10 alone while nothing is chosen, so the browser keeps them", () => {
    const events = [press(document, "p"), press(document, "F10", { altKey: true })];
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false]);
  });

  it("still take Ctrl+Z and Ctrl+S in a field of the editor, where the page's own history would be the wrong one", () => {
    store.session.apply([retitle("Edited")]);
    const field = document.createElement("textarea");
    host.append(field);
    field.focus();
    expect(press(field, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(openingTitle(store.session.doc)).not.toBe("Edited");
    expect(press(field, "s", { ctrlKey: true }).defaultPrevented).toBe(true);
  });
});

describe("whose keys they are", () => {
  let outside: HTMLInputElement;
  beforeEach(() => {
    outside = document.createElement("input");
    document.body.append(outside);
  });

  it("belong to the page when the keyboard is in a field outside the editor", () => {
    store.session.apply([retitle("Edited")]);
    outside.focus();
    const events = [
      press(outside, "t"),
      press(outside, "z", { ctrlKey: true }),
      press(outside, "s", { ctrlKey: true }),
      press(outside, "?"),
    ];
    expect(events.map((event) => event.defaultPrevented)).toEqual([false, false, false, false]);
    expect(kinds()).toEqual(["text", "text", "image"]);
    expect(openingTitle(store.session.doc)).toBe("Edited");
    expect(server.saves).toHaveLength(0);
    expect(sheet().hidden).toBe(true);
  });

  it("belong to the page when the pointer last pressed outside the editor and the keyboard is nowhere", () => {
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    press(document.body, "t");
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("belong to the editor again once the pointer moves over it", () => {
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    quick("claim").dispatchEvent(new Event("pointermove", { bubbles: true }));
    press(document.body, "t");
    expect(kinds()).toHaveLength(4);
  });

  it("belong to the editor when no pointer has been seen at all, as on a keyboard alone", () => {
    press(document.body, "t");
    expect(kinds()).toHaveLength(4);
  });

  it("belong to the editor when the keyboard is in it, wherever the pointer last was", () => {
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    press(quick("claim"), "t");
    expect(kinds()).toHaveLength(4);
  });
});
