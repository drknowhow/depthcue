// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type Command, createPalette, type Palette, search } from "../src/palette.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

const command = (id: string, title: string, extra: Partial<Command> = {}): Command => ({
  id,
  title,
  group: "Test",
  run() {},
  ...extra,
});
const titles = (found: readonly Command[]) => found.map((entry) => entry.title);

describe("searching the commands", () => {
  const all = [command("a", "Add a text"), command("b", "Layout: Text and media"), command("c", "Undo")];

  it("gives every command in the order it was given when nothing is typed", () => {
    const found = search(all, "");
    expect(found).toEqual(all);
    expect(found).not.toBe(all);
    expect(titles(search(all, "   "))).toEqual(titles(all));
  });

  it("finds a command by the words of its title, in any order, whatever the case", () => {
    // The letters of "add" are also in "Layout: Text and media", in order, so it is found too, but after the real match.
    expect(titles(search(all, "TEXT add"))).toEqual(["Add a text", "Layout: Text and media"]);
    expect(titles(search(all, "media layout"))).toEqual(["Layout: Text and media"]);
  });

  it("needs every word to match", () => {
    expect(search(all, "text zebra")).toEqual([]);
  });

  it("puts the start of a word ahead of the middle of one, and an earlier match ahead of a later one", () => {
    const found = search([command("m", "Context menu"), command("t", "Add a text")], "tex");
    expect(titles(found)).toEqual(["Add a text", "Context menu"]);
    const early = search([command("o", "One text"), command("t", "Text one")], "text");
    expect(titles(early)).toEqual(["Text one", "One text"]);
  });

  it("finds letters that are in the title in order, though they are not a word of it", () => {
    const found = search([command("p", "Put the block back"), command("z", "Zebra")], "ptb");
    expect(titles(found)).toEqual(["Put the block back"]);
    expect(search([command("p", "Put the block back")], "bpt")).toEqual([]);
    expect(search([command("p", "Put the block back")], "ptbz")).toEqual([]);
  });

  it("ranks letters that are close together ahead of letters that are far apart", () => {
    const found = search([command("far", "A bit of cake"), command("near", "A b c")], "abc");
    expect(titles(found)).toEqual(["A b c", "A bit of cake"]);
  });

  it("ranks a word that is in the title ahead of the same letters spread over it", () => {
    const found = search([command("spread", "Take extra"), command("held", "Context menu")], "tex");
    expect(titles(found)).toEqual(["Context menu", "Take extra"]);
  });

  it("looks in the extra words only for a command the title does not match, and counts them for less", () => {
    const found = search(
      [command("c", "Add a chart", { words: "graph" }), command("g", "Graph paper")],
      "graph",
    );
    expect(titles(found)).toEqual(["Graph paper", "Add a chart"]);
  });

  it("keeps the given order between commands that match equally", () => {
    const same = [command("1", "Go to one"), command("2", "Go to two"), command("3", "Go to three")];
    expect(titles(search(same, "go to"))).toEqual(["Go to one", "Go to two", "Go to three"]);
  });
});

describe("the palette", () => {
  let palette: Palette;
  let asked = 0;
  let list: Command[];
  let previous: HTMLButtonElement;

  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    input().dispatchEvent(event);
    return event;
  };
  const input = () => palette.element.querySelector("input") as HTMLInputElement;
  const options = () => [...palette.element.querySelectorAll<HTMLElement>("[role='option']")];
  const selected = () => options().findIndex((option) => option.getAttribute("aria-selected") === "true");
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const status = () => palette.element.querySelector("[role='status']")?.textContent;

  beforeEach(() => {
    asked = 0;
    list = [
      command("one", "Add a text", { group: "Add", keys: [["T"], ["Mod", "T"]] }),
      command("two", "Add a chart", { group: "Add" }),
      command("three", "Layout: Title", { group: "This scene" }),
    ];
    palette = createPalette({
      commands: () => {
        asked += 1;
        return list;
      },
      keyName: (token) => (token === "Mod" ? "Ctrl" : token),
    });
    previous = document.createElement("button");
    document.body.replaceChildren(previous, palette.element);
    previous.focus();
  });
  afterEach(() => {
    palette.destroy();
    document.body.replaceChildren();
  });

  it("is shut until it is opened, and asks for nothing before that", () => {
    expect(palette.element.hidden).toBe(true);
    expect(palette.isOpen).toBe(false);
    expect(asked).toBe(0);
  });

  it("opens as a dialog whose one field controls a list, with the keyboard in the field", () => {
    palette.open();
    expect(palette.isOpen).toBe(true);
    const card = palette.element.querySelector("[role='dialog']") as HTMLElement;
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(card.getAttribute("aria-label")).toBeTruthy();
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("role")).toBe("combobox");
    const listbox = palette.element.querySelector("[role='listbox']") as HTMLElement;
    expect(input().getAttribute("aria-controls")).toBe(listbox.id);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-label")).toBeTruthy();
    expect(options().map((option) => option.dataset.command)).toEqual(["one", "two", "three"]);
  });

  it("marks the first command, and says which one the keyboard is on to assistive technology", () => {
    palette.open();
    expect(selected()).toBe(0);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(status()).toBe("3 commands.");
  });

  it("writes the group of each command, and the first way to press the key that does the same", () => {
    palette.open();
    const first = options()[0] as HTMLElement;
    expect(first.querySelector(".ed-palette-title")?.textContent).toBe("Add a text");
    expect(first.querySelector(".ed-palette-group")?.textContent).toBe("Add");
    expect([...first.querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["T"]);
    expect(options()[1]?.querySelector("kbd")).toBeNull();
  });

  it("asks what can be done each time it opens, and not again while it is open", () => {
    palette.open();
    palette.open();
    expect(asked).toBe(1);
    palette.close();
    list = [command("only", "Undo")];
    palette.open();
    expect(asked).toBe(2);
    expect(options().map((option) => option.dataset.command)).toEqual(["only"]);
    expect(status()).toBe("1 command.");
  });

  it("narrows the list as letters are typed, and starts at the best match again", () => {
    palette.open();
    press("ArrowDown");
    type("add");
    expect(options().map((option) => option.dataset.command)).toEqual(["one", "two"]);
    expect(selected()).toBe(0);
    type("chart");
    expect(options().map((option) => option.dataset.command)).toEqual(["two"]);
    expect(status()).toBe("1 command.");
  });

  it("says so, and has nothing to choose, when nothing matches", () => {
    palette.open();
    type("zebra");
    expect(options()).toEqual([]);
    const empty = palette.element.querySelector<HTMLElement>(".ed-palette-empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain("zebra");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    expect(status()).toBe("Nothing matches.");
    press("Enter");
    expect(palette.isOpen).toBe(true);
    type("");
    expect(empty.hidden).toBe(true);
  });

  it("moves down and up with the arrow keys, and goes round at either end", () => {
    palette.open();
    expect(press("ArrowDown").defaultPrevented).toBe(true);
    expect(selected()).toBe(1);
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toBe(0);
    press("ArrowUp");
    expect(selected()).toBe(2);
    press("ArrowUp");
    expect(selected()).toBe(1);
  });

  it("puts itself away before it runs a command, so a command that moves the keyboard has the last word", () => {
    const ran = vi.fn(() => {
      expect(palette.isOpen).toBe(false);
      expect(document.activeElement).toBe(previous);
    });
    list = [command("go", "Go", { run: ran })];
    palette.open();
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(palette.isOpen).toBe(false);
  });

  it("runs the chosen command, not the first", () => {
    const second = vi.fn();
    list = [command("a", "Alpha"), command("b", "Beta", { run: second })];
    palette.open();
    press("ArrowDown");
    press("Enter");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("runs a command that is clicked, and only moves the mark when the pointer goes over another", () => {
    const run = vi.fn();
    list = [command("a", "Alpha"), command("b", "Beta", { run })];
    palette.open();
    options()[1]?.dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(selected()).toBe(1);
    expect(run).not.toHaveBeenCalled();
    options()[1]?.click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(palette.isOpen).toBe(false);
  });

  it("puts the keyboard back where it was on Esc, and on the key that opened it", () => {
    palette.open();
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(palette.isOpen).toBe(false);
    expect(document.activeElement).toBe(previous);
    palette.open();
    expect(press("k", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(palette.isOpen).toBe(false);
    palette.open();
    press("K", { metaKey: true });
    expect(palette.isOpen).toBe(false);
    expect(document.activeElement).toBe(previous);
  });

  it("gives nothing to the page behind it: no key typed in it is heard outside it", () => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    palette.open();
    press("t");
    press("z", { ctrlKey: true });
    press("ArrowDown");
    press("Enter");
    document.removeEventListener("keydown", heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it("keeps the keyboard in its one field when Tab is pressed", () => {
    palette.open();
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(press("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("does not act on Enter while a letter is still being composed", () => {
    const run = vi.fn();
    list = [command("a", "Alpha", { run })];
    palette.open();
    press("Enter", { isComposing: true });
    expect(run).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
  });

  it("shuts on a press on the dim part around it, and not on a press on the card", () => {
    palette.open();
    (palette.element.querySelector(".ed-palette-card") as HTMLElement).dispatchEvent(
      new Event("pointerdown", { bubbles: true }),
    );
    expect(palette.isOpen).toBe(true);
    palette.element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(palette.isOpen).toBe(false);
  });

  it("toggles, and shutting it when it is shut moves nothing", () => {
    palette.toggle();
    expect(palette.isOpen).toBe(true);
    palette.toggle();
    expect(palette.isOpen).toBe(false);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    palette.close();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("draws the first fifty matches of a long list", () => {
    list = Array.from({ length: 80 }, (_, n) => command(`s${n}`, `Go to scene ${n}`));
    palette.open();
    expect(options()).toHaveLength(50);
    type("scene 7");
    expect(options().length).toBeGreaterThan(0);
  });
});

describe("the palette in the editor", () => {
  let host: HTMLElement;
  let server: FakeServer;
  let store: EditorStore;
  let editor: Editor;

  beforeEach(async () => {
    server = new FakeServer();
    store = await openStore(server, () => memoryDraftStore());
    host = document.createElement("div");
    document.body.replaceChildren(host);
    editor = mountEditor(host, store);
    editor.select("method");
  });
  afterEach(() => {
    editor.destroy();
    vi.restoreAllMocks();
  });

  const palette = () => host.querySelector<HTMLElement>(".ed-palette") as HTMLElement;
  const field = () => palette().querySelector("input") as HTMLInputElement;
  const options = () => [...palette().querySelectorAll<HTMLElement>("[role='option']")];
  const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const open = () => press(document, "k", { ctrlKey: true });
  const type = (text: string) => {
    field().value = text;
    field().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const method = () => store.session.doc.scenes.method;
  const layoutShown = () =>
    host.querySelector("[data-layout][aria-pressed='true']")?.getAttribute("data-layout");

  it("opens on Ctrl K and on the Everything button of the bar, and is shut when the editor starts", () => {
    expect(palette().hidden).toBe(true);
    open();
    expect(palette().hidden).toBe(false);
    press(field(), "Escape");
    host.querySelector<HTMLElement>("[data-quick='palette']")?.click();
    expect(palette().hidden).toBe(false);
  });

  it("changes the layout of the scene with a few letters and Enter, in one step that Undo takes back", () => {
    const before = method()?.layout;
    open();
    type("layout claim");
    expect(options()[0]?.textContent).toContain("Layout: Claim and evidence");
    press(field(), "Enter");
    expect(method()?.layout).toBe("claim-evidence");
    expect(layoutShown()).toBe("claim-evidence");
    press(document, "z", { ctrlKey: true });
    expect(method()?.layout).toBe(before);
  });

  it("hears nothing behind it: a T adds no text and Ctrl Z undoes nothing while it is open", () => {
    store.session.apply([{ op: "scene.set", id: "method", set: { lead: "agent" } }]);
    const count = method()?.blocks.length;
    open();
    press(field(), "t");
    press(field(), "z", { ctrlKey: true });
    expect(method()?.blocks.length).toBe(count);
    expect(method()?.lead).toBe("agent");
  });

  it("goes to another scene by its name", () => {
    open();
    type("go to demand");
    press(field(), "Enter");
    expect(editor.sceneId).toBe("demand");
    expect(palette().hidden).toBe(true);
  });

  it("pins the chosen block where it is, and offers to put it back once it is pinned", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = (left: number, top: number, width: number, height: number) =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
      if (this.classList.contains("dc-view")) return box(0, 0, 1600, 900);
      return this instanceof HTMLElement && this.dataset.id === "method-diagram"
        ? box(160, 450, 640, 90)
        : box(0, 0, 0, 0);
    });
    host.querySelector<HTMLElement>(".ed-frame [data-id='method-diagram']")?.click();
    open();
    type("pin");
    expect(options()[0]?.textContent).toContain("Pin the block where it is");
    press(field(), "Enter");
    const frame = () => method()?.blocks.find((block) => block.id === "method-diagram")?.frame;
    expect(frame()).toEqual({ x: 10, y: 50, w: 40, h: 10 });
    open();
    type("pin");
    const ofPin = () => options().find((option) => option.dataset.command === "pin");
    expect(ofPin()?.textContent).toContain("Put the block back in its layout");
    // Something is pinned now, so the scene as a whole can be put back too.
    expect(options().map((option) => option.dataset.command)).toContain("auto-layout");
    ofPin()?.click();
    expect(frame()).toBeUndefined();
  });

  it("lists nothing about a block when none is chosen, and Add commands that do what the keys do", () => {
    open();
    const ids = options().map((option) => option.dataset.command);
    expect(ids).not.toContain("pin");
    expect(ids).not.toContain("remove");
    expect(ids).toEqual(expect.arrayContaining(["add-text", "add-chart", "add-image"]));
    type("add a text");
    press(field(), "Enter");
    expect(method()?.blocks.map((block) => block.type)).toEqual(["text", "text", "text", "image"]);
    expect(editor.blockId).toBe(method()?.blocks[2]?.id);
  });

  it("opens the presentation at this scene in a new window", () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    open();
    type("present");
    press(field(), "Enter");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(String(opened.mock.calls[0]?.[0])).toContain("/present#/method");
    expect(opened.mock.calls[0]?.[2]).toBe("noopener");
  });

  it("shows the keyboard shortcuts from the palette", () => {
    open();
    type("shortcuts");
    press(field(), "Enter");
    expect(host.querySelector<HTMLElement>(".ed-sheet")?.hidden).toBe(false);
  });

  it("names the key that does the same, from the table of shortcuts", () => {
    open();
    const caps = (id: string) =>
      [
        ...(options()
          .find((option) => option.dataset.command === id)
          ?.querySelectorAll("kbd") ?? []),
      ].map((key) => key.textContent);
    expect(caps("add-text")).toEqual(["T"]);
    expect(caps("add-chart")).toEqual(["C"]);
    expect(caps("add-image")).toEqual(["I"]);
    expect(caps("save")).toEqual(["Ctrl", "S"]);
    expect(caps("keys")).toEqual(["?"]);
    expect(caps("layout-claim-evidence")).toEqual([]);
  });

  /** Opens the palette and does the command with this id, as a click on it does. */
  const choose = (id: string) => {
    open();
    const found = options().find((option) => option.dataset.command === id);
    if (!found) throw new Error(`the palette should list ${id}`);
    found.click();
  };
  const undo = () => press(document, "z", { ctrlKey: true });

  it("sets who leads the scene, in one step that Undo takes back", () => {
    expect(method()?.lead).toBe("human");
    choose("lead-agent");
    expect(method()?.lead).toBe("agent");
    undo();
    expect(method()?.lead).toBe("human");
  });

  it("puts every pinned block back in its layout in one step, and Undo pins them again", () => {
    const frame = { x: 10, y: 10, w: 30, h: 30 };
    store.session.apply([{ op: "block.frame", scene: "method", id: "method-diagram", frame }]);
    choose("auto-layout");
    expect(method()?.blocks.some((block) => block.frame)).toBe(false);
    undo();
    expect(method()?.blocks.find((block) => block.id === "method-diagram")?.frame).toEqual(frame);
  });

  it("adds a claim to a scene that has none, and Undo takes it back", () => {
    expect(method()?.summary).toBeUndefined();
    choose("add-claim");
    expect(method()?.summary).toBeDefined();
    undo();
    expect(method()?.summary).toBeUndefined();
  });

  it("removes the chosen block, and Undo brings it back", () => {
    host.querySelector<HTMLElement>(".ed-frame [data-id='method-diagram']")?.click();
    const has = () => method()?.blocks.some((block) => block.id === "method-diagram");
    choose("remove");
    expect(has()).toBe(false);
    undo();
    expect(has()).toBe(true);
  });

  it("undoes and redoes from the palette", () => {
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "Kept" } }]);
    choose("undo");
    expect(method()?.notes).toBeUndefined();
    choose("redo");
    expect(method()?.notes).toBe("Kept");
  });

  it("saves at once, without waiting for the pause that saves by itself", () => {
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "Kept" } }]);
    expect(server.saves).toHaveLength(0);
    choose("save");
    expect(server.saves).toHaveLength(1);
  });
});
