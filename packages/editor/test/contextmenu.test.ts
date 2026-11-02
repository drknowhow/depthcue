// @vitest-environment happy-dom
import { type Block, loadDoc, memoryDraftStore, type Scene, slotOf } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import {
  blockFrom,
  copiedBlock,
  DUPLICATE_OFFSET,
  missingFile,
  pasteInto,
  percentOn,
  wordsOf,
} from "../src/clipboard.ts";
import { LONG_PRESS_MS, LONG_PRESS_SLOP, menuFor } from "../src/contextmenu.ts";
import type { Command, Target } from "../src/palette.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, retitle } from "./helpers.ts";

const command = (id: string, over: Partial<Command> = {}): Command => ({
  id,
  title: id,
  group: "Group",
  run() {},
  ...over,
});

describe("menuFor", () => {
  it("lists the commands that say they apply to the target, and no others", () => {
    const commands = [
      command("a", { targets: ["block"] }),
      command("b", { targets: ["slide", "scene"] }),
      command("c"),
      command("d", { targets: ["claim", "block"] }),
    ];
    const ids = (target: Target) =>
      menuFor(commands, target).flatMap((entry) => (entry.kind === "command" ? [entry.command.id] : []));
    expect(ids("block")).toEqual(["a", "d"]);
    expect(ids("claim")).toEqual(["d"]);
    expect(ids("slide")).toEqual(["b"]);
    expect(ids("scene")).toEqual(["b"]);
  });

  it("puts a line between one section and the next, where a section is the group unless the command names one", () => {
    const commands = [
      command("a", { targets: ["block"], section: "edit" }),
      command("b", { targets: ["block"], section: "place" }),
      command("c", { targets: ["block"], section: "edit" }),
      command("d", { targets: ["block"], group: "Elsewhere" }),
    ];
    const rows = menuFor(commands, "block").map((entry) =>
      entry.kind === "command" ? entry.command.id : entry.kind,
    );
    // The two commands of the first section sit together, in the order the list gives them.
    expect(rows).toEqual(["a", "c", "separator", "b", "separator", "d"]);
  });

  it("gathers the commands that name a submenu into one item, where the first of them stood", () => {
    const commands = [
      command("a", { targets: ["slide"], section: "x" }),
      command("l1", { targets: ["slide"], section: "x", submenu: "Layout" }),
      command("b", { targets: ["slide"], section: "x" }),
      command("l2", { targets: ["slide"], section: "x", submenu: "Layout" }),
      command("m1", { targets: ["slide"], section: "x", submenu: "Lead" }),
    ];
    const rows = menuFor(commands, "slide").map((entry) =>
      entry.kind === "submenu"
        ? `${entry.name}: ${entry.commands.map((each) => each.id).join(",")}`
        : entry.kind === "command"
          ? entry.command.id
          : entry.kind,
    );
    expect(rows).toEqual(["a", "Layout: l1,l2", "b", "Lead: m1"]);
  });

  it("is empty when nothing applies, so the browser's own menu stays", () => {
    expect(menuFor([command("a", { targets: ["block"] })], "scene")).toEqual([]);
  });
});

const TEXT_BLOCK = { id: "text-a", type: "text", role: "body", text: "Words" } as const;
const IMAGE_BLOCK = {
  id: "image-a",
  type: "image",
  asset: "assets/a.svg",
  alt: "A picture",
  caption: "Cap",
} as const;
const CHART_BLOCK: Block = {
  id: "chart-a",
  type: "bar-chart",
  title: "Share",
  unit: "%",
  data: [
    { label: "A", value: 40 },
    { label: "B", value: 60 },
  ],
  sourceIds: ["s1", "other"],
};

function sceneWith(layout: string, blocks: Block[], extra: Record<string, unknown> = {}): Scene {
  const files = {
    "deck.json": JSON.stringify({
      schemaVersion: "0.1",
      id: "deck-d",
      title: "D",
      language: "en",
      theme: "paper",
      scenes: ["scene-s"],
    }),
    "scenes/scene-s.json": JSON.stringify({
      schemaVersion: "0.1",
      id: "scene-s",
      title: "S",
      layout,
      blocks,
      sources: [{ id: "s1", title: "One", asset: "assets/a.svg" }],
      reading: { text: "Read." },
      ...extra,
    }),
  };
  const { doc, diagnostics } = loadDoc({ text: files, assets: ["assets/a.svg"] });
  if (!doc) throw new Error(`the scene should load: ${diagnostics.map((each) => each.message).join(" ")}`);
  return doc.scenes["scene-s"] as Scene;
}

describe("a block on the clipboard", () => {
  it("is the whole block in an envelope, and its words as text", () => {
    const copied = copiedBlock(CHART_BLOCK as Block);
    expect(JSON.parse(copied.json)).toEqual({ depthcue: "block", version: 1, block: CHART_BLOCK });
    expect(copied.words).toBe("Share\nA: 40\nB: 60");
    expect(wordsOf(TEXT_BLOCK as Block)).toBe("Words");
    expect(wordsOf(IMAGE_BLOCK as Block)).toBe("A picture");
  });

  it("is read back from any of the three forms, the JSON first", () => {
    const copied = copiedBlock(IMAGE_BLOCK as Block);
    expect(blockFrom({ json: copied.json })).toEqual({ block: IMAGE_BLOCK });
    expect(blockFrom({ html: copied.html })).toEqual({ block: IMAGE_BLOCK });
    expect(blockFrom({ plain: copied.json })).toEqual({ block: IMAGE_BLOCK });
    const other = copiedBlock(TEXT_BLOCK as Block);
    expect(blockFrom({ json: other.json, html: copied.html, plain: copied.json })).toEqual({
      block: TEXT_BLOCK,
    });
  });

  it("survives a caption with quotes, angle brackets and an ampersand in the HTML form", () => {
    const awkward = { ...TEXT_BLOCK, text: `Tom & "Jerry" <b>say</b> hi` } as Block;
    const copied = copiedBlock(awkward);
    expect(blockFrom({ html: copied.html })).toEqual({ block: awkward });
    expect(copied.html).not.toContain("<b>");
  });

  it("refuses what is not a block of Depthcue, and says why for a block it cannot read", () => {
    expect(blockFrom({ plain: "just words" })).toEqual({
      problem: "The clipboard holds no block from Depthcue. Copy one first.",
    });
    expect(blockFrom({})).toHaveProperty("problem");
    const newer = JSON.stringify({ depthcue: "block", version: 2, block: TEXT_BLOCK });
    expect(blockFrom({ json: newer })).toEqual({
      problem: "That block was copied by a newer Depthcue, which this editor cannot read.",
    });
    const damaged = JSON.stringify({ depthcue: "block", version: 1, block: "nope" });
    expect(blockFrom({ json: damaged })).toEqual({
      problem: "The copied block is damaged, so it was not pasted.",
    });
  });

  it("is refused for an image whose file the deck does not have, with the file named", () => {
    const assets = new Set(["assets/a.svg"]);
    expect(missingFile(assets, IMAGE_BLOCK as Block)).toBeUndefined();
    expect(missingFile(assets, TEXT_BLOCK as Block)).toBeUndefined();
    const elsewhere = { ...IMAGE_BLOCK, asset: "assets/gone.png" } as Block;
    expect(missingFile(assets, elsewhere)).toBe(
      "That image uses assets/gone.png, which is not in this deck. Add the file to the deck's assets folder first.",
    );
    const clip = { id: "v", type: "clip", source: "assets/gone.mp4", alt: "Clip" } as Block;
    expect(missingFile(assets, clip)).toContain("That video uses assets/gone.mp4");
  });
});

describe("pasteInto", () => {
  const scene = () => sceneWith("text-media", [TEXT_BLOCK as Block, IMAGE_BLOCK as Block]);
  const added = (planned: ReturnType<typeof pasteInto>) => {
    if (!planned.ok) throw new Error(planned.message);
    const op = planned.ops.find((candidate) => candidate.op === "block.add");
    if (op?.op !== "block.add") throw new Error("a block.add was expected");
    return { ...op, id: planned.id };
  };

  it("gives the block an id of its own, which is never one the scene has", () => {
    const first = added(pasteInto(scene(), TEXT_BLOCK as Block, { after: "text-a" }));
    expect(first.block.id).toBe("text-a-copy");
    expect(first.id).toBe("text-a-copy");
    const crowded = sceneWith("text-media", [
      TEXT_BLOCK as Block,
      { ...TEXT_BLOCK, id: "text-a-copy" } as Block,
    ]);
    expect(added(pasteInto(crowded, TEXT_BLOCK as Block, { after: "text-a" })).block.id).not.toBe(
      "text-a-copy",
    );
  });

  it("goes after the block named, and into the first area that takes its kind when none is", () => {
    expect(added(pasteInto(scene(), IMAGE_BLOCK as Block, { after: "image-a" })).after).toBe("image-a");
    expect(added(pasteInto(scene(), TEXT_BLOCK as Block, { after: undefined })).block.type).toBe("text");
  });

  it("goes into an area by name, and says no when the area does not take it", () => {
    const planned = pasteInto(scene(), IMAGE_BLOCK as Block, { slot: "text" });
    expect(planned.ok).toBe(false);
    expect(pasteInto(scene(), IMAGE_BLOCK as Block, { slot: "media" }).ok).toBe(true);
  });

  it("leaves the pin off a block that was pinned, unless it is a duplicate, which sits just beside it", () => {
    const frame = { x: 10, y: 10, w: 30, h: 20 };
    const pinned = { ...IMAGE_BLOCK, frame } as Block;
    expect(added(pasteInto(scene(), pinned, { after: "image-a" })).block.frame).toBeUndefined();
    const twin = added(pasteInto(scene(), pinned, { after: "image-a", keepFrame: true })).block.frame;
    expect(twin).toEqual({ ...frame, x: 10 + DUPLICATE_OFFSET, y: 10 + DUPLICATE_OFFSET });
    // At the foot of the slide it goes up instead, so it does not run into the margin a projector cuts off.
    const low = { ...IMAGE_BLOCK, frame: { x: 60, y: 76, w: 30, h: 20 } } as Block;
    const up = added(pasteInto(scene(), low, { after: "image-a", keepFrame: true })).block.frame;
    expect(up).toEqual({ x: 60 + DUPLICATE_OFFSET, y: 76 - DUPLICATE_OFFSET, w: 30, h: 20 });
  });

  it("pins at a point, centered on it, and kept inside the margin", () => {
    const centered = added(pasteInto(scene(), TEXT_BLOCK as Block, { pin: { x: 50, y: 50 } })).block.frame;
    expect(centered).toEqual({ x: 30, y: 43, w: 40, h: 14 });
    const corner = added(pasteInto(scene(), TEXT_BLOCK as Block, { pin: { x: 99, y: 99 } })).block.frame;
    expect(corner).toEqual({ x: 56, y: 82, w: 40, h: 14 });
  });

  it("keeps the sources the scene has and drops the ones it does not", () => {
    const planned = added(pasteInto(scene(), CHART_BLOCK as Block, { after: "image-a" }));
    expect((planned.block as { sourceIds?: string[] }).sourceIds).toEqual(["s1"]);
  });

  it("is one step of Undo when it is applied", async () => {
    const store = await openStore(new FakeServer(), () => memoryDraftStore());
    const scenes = store.session.doc.scenes;
    const before = JSON.stringify(scenes.method);
    const planned = pasteInto(scenes.method as Scene, scenes.method?.blocks[2] as Block, {
      after: "method-diagram",
    });
    if (!planned.ok) throw new Error(planned.message);
    expect(store.session.apply(planned.ops).ok).toBe(true);
    expect(store.session.doc.scenes.method?.blocks).toHaveLength(4);
    store.session.undo();
    expect(JSON.stringify(store.session.doc.scenes.method)).toBe(before);
  });

  it("turns a pointer into a place on the slide, and the middle when the slide has no size", () => {
    expect(percentOn({ left: 100, top: 50, width: 1600, height: 900 }, { x: 900, y: 500 })).toEqual({
      x: 50,
      y: 50,
    });
    expect(percentOn(undefined, { x: 5, y: 5 })).toEqual({ x: 50, y: 50 });
    expect(percentOn({ left: 0, top: 0, width: 0, height: 0 }, { x: 5, y: 5 })).toEqual({ x: 50, y: 50 });
  });
});

// The editor itself

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

const PICTURE = "method-diagram";
const HEADING = "method-heading";

const blocks = (scene = "method") => store.session.doc.scenes[scene]?.blocks ?? [];
const kinds = () => blocks().map((block) => block.type);
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const editable = (id: string) =>
  host.querySelector<HTMLElement>(
    `[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`,
  ) as HTMLElement;
const view = () => host.querySelector<HTMLElement>(".ed-canvas-host .dc-view") as HTMLElement;
const row = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-scene-list > li[data-id='${id}']`) as HTMLElement;
const hint = () => host.querySelector<HTMLElement>(".ed-hint")?.textContent ?? "";
const menu = () => host.querySelector<HTMLElement>(".ed-menu:not(.ed-menu-sub)") as HTMLElement;
const open = () => !menu().hidden;
const item = (name: string) =>
  [...menu().querySelectorAll<HTMLElement>(".ed-menu-item")].find(
    (node) => node.querySelector(".ed-menu-label")?.textContent === name,
  ) as HTMLElement;
const sub = (name: string) => item(name).nextElementSibling as HTMLElement;

/** What the menu says, top to bottom: each item by its words, a submenu with an arrow, a line as a dash. */
const labels = () =>
  [...menu().children].map((child) =>
    child.classList.contains("ed-menu-sep")
      ? "-"
      : child.classList.contains("ed-menu-branch")
        ? `${child.querySelector(".ed-menu-label")?.textContent}>`
        : (child.querySelector(".ed-menu-label")?.textContent ?? ""),
  );

const context = (node: Element, init: MouseEventInit = {}) => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 300,
    clientY: 200,
    ...init,
  });
  node.dispatchEvent(event);
  return event;
};
const press = (node: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
};
/** A pointer event, built from a plain event, because what the menu reads from it is only these few fields. */
const pointer = (
  type: string,
  node: Element | Document,
  init: { pointerType?: string; x?: number; y?: number; id?: number } = {},
) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: init.pointerType ?? "mouse" },
    pointerId: { value: init.id ?? 1 },
    isPrimary: { value: true },
    clientX: { value: init.x ?? 300 },
    clientY: { value: init.y ?? 200 },
    button: { value: 0 },
  });
  node.dispatchEvent(event);
  return event;
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

/** A clipboard that holds what was written to it, the way a browser's does after a click. */
function fakeClipboard() {
  /** What a clipboard item lets a page do: ask what forms it has, and read one. */
  interface Held {
    types: readonly string[];
    getType(type: string): Promise<Blob>;
  }
  class Item implements Held {
    constructor(private readonly data: Record<string, Blob>) {}
    get types() {
      return Object.keys(this.data);
    }
    async getType(type: string) {
      return this.data[type] as Blob;
    }
  }
  vi.stubGlobal("ClipboardItem", Item);
  let held: Held[] = [];
  const clipboard = {
    write: vi.fn(async (items: Held[]) => {
      held = items;
    }),
    read: vi.fn(async (): Promise<Held[]> => held),
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  return clipboard;
}

describe("right-clicking a block", () => {
  it("opens the menu of that block, chooses it, and keeps the browser's menu away", () => {
    fakeClipboard();
    const event = context(blockNode(PICTURE));
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(true);
    expect(editor.blockId).toBe(PICTURE);
    expect(menu().getAttribute("aria-label")).toBe("Block menu");
    expect(menu().getAttribute("role")).toBe("menu");
  });

  it("lists what can be done to the block, in sections, with the keys beside them", () => {
    fakeClipboard();
    context(blockNode(PICTURE));
    // The picture is the last block, so it has nowhere later to go.
    expect(labels()).toEqual([
      "Cut",
      "Copy",
      "Paste",
      "Duplicate",
      "Delete",
      "-",
      "Pin where it is",
      "Move earlier",
      "-",
      "Style>",
      "-",
      "Comment",
    ]);
    const keys = (name: string) =>
      [...item(name).querySelectorAll("kbd")].map((cap) => cap.textContent).join(" ");
    expect(keys("Cut")).toBe("Ctrl X");
    expect(keys("Copy")).toBe("Ctrl C");
    expect(keys("Paste")).toBe("Ctrl V");
    expect(keys("Duplicate")).toBe("Ctrl D");
    expect(keys("Pin where it is")).toBe("P");
    expect(keys("Delete")).toBe("");
    // A screen reader gets the keys after the name, and not as part of it.
    expect(item("Cut").getAttribute("aria-keyshortcuts")).toBe("Control+X Meta+X");
    expect(item("Pin where it is").getAttribute("aria-keyshortcuts")).toBe("P");
    expect(item("Delete").hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(item("Cut").querySelector(".ed-keys")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is made of menu items, each a button a screen reader meets as one", () => {
    fakeClipboard();
    context(blockNode(PICTURE));
    const found = [...menu().querySelectorAll(".ed-menu-item")];
    expect(found.length).toBeGreaterThan(5);
    for (const node of found) {
      // The choices of the Style submenu are the one kind of item that is checked or not.
      expect(node.getAttribute("role")).toBe(node.closest(".ed-menu-sub") ? "menuitemradio" : "menuitem");
      expect(node.tagName).toBe("BUTTON");
      expect(node.getAttribute("tabindex")).toBe("-1");
    }
    for (const line of menu().querySelectorAll(".ed-menu-sep")) {
      expect(line.getAttribute("role")).toBe("separator");
    }
  });

  it("offers Put back in layout for a pinned block, and the moves the block has room for", () => {
    fakeClipboard();
    store.session.apply([
      { op: "block.frame", scene: "method", id: HEADING, frame: { x: 10, y: 10, w: 30, h: 10 } },
    ]);
    context(blockNode(HEADING));
    // The heading is first, so it cannot move earlier.
    expect(labels()).toContain("Put back in layout");
    expect(labels()).toContain("Move later");
    expect(labels()).not.toContain("Move earlier");
  });

  it("leaves Paste out when this editor has nothing to paste and the browser will not say what is there", () => {
    Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
    context(blockNode(PICTURE));
    expect(labels()).not.toContain("Paste");
    expect(labels()).toContain("Copy");
  });

  it("does what an item says, as one step of Undo", () => {
    fakeClipboard();
    context(blockNode(PICTURE));
    item("Duplicate").click();
    expect(open()).toBe(false);
    expect(kinds()).toEqual(["text", "text", "image", "image"]);
    store.session.undo();
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("moves a block with the move items", () => {
    fakeClipboard();
    context(blockNode(PICTURE));
    item("Move earlier").click();
    expect(blocks().map((block) => block.id)).toEqual([HEADING, PICTURE, "method-body"]);
  });

  it("lists what the palette lists for the same choice, because they are one list", () => {
    fakeClipboard();
    context(blockNode(PICTURE));
    const inMenu = [...menu().querySelectorAll<HTMLElement>("[data-command]")].map(
      (node) => node.dataset.command,
    );
    press(document, "Escape");
    press(document, "k", { ctrlKey: true });
    const inPalette = [...host.querySelectorAll<HTMLElement>(".ed-palette-option")].map(
      (node) => node.dataset.command,
    );
    expect(inMenu.length).toBeGreaterThan(5);
    for (const id of inMenu) expect(inPalette).toContain(id);
  });
});

describe("right-clicking the claim", () => {
  it("lists what applies to a claim: Paste, Delete and Comment", () => {
    fakeClipboard();
    editor.select("demand");
    const claim = host.querySelector<HTMLElement>("[data-id='claim-shift']") as HTMLElement;
    expect(context(claim).defaultPrevented).toBe(true);
    expect(menu().getAttribute("aria-label")).toBe("Claim menu");
    expect(labels()).toEqual(["Paste", "Delete", "-", "Comment"]);
    expect(editor.blockId).toBe("claim-shift");
  });
});

describe("right-clicking the empty slide", () => {
  it("lets go of the chosen block and lists what can be added where the pointer is", () => {
    fakeClipboard();
    blockNode(PICTURE).click();
    expect(editor.blockId).toBe(PICTURE);
    expect(context(view()).defaultPrevented).toBe(true);
    expect(editor.blockId).toBeUndefined();
    expect(menu().getAttribute("aria-label")).toBe("Slide menu");
    expect(labels().slice(0, -2)).toEqual([
      "Paste here",
      "Add a text here",
      "Add a chart here",
      "Add a table here",
      "Add an image here",
      "Add a claim",
      "-",
      "Layout>",
      "Change template…",
      "Lead>",
      "-",
    ]);
    expect(labels().at(-2)).toMatch(/^(Show|Hide) the comments$/);
    expect(labels().at(-1)).toBe("Deck style");
  });

  it("holds the layouts and the leads in submenus that leave out the one the slide has", () => {
    fakeClipboard();
    context(view());
    const layouts = [...sub("Layout").querySelectorAll(".ed-menu-label")].map((node) => node.textContent);
    expect(layouts.length).toBeGreaterThan(1);
    expect(layouts).not.toContain("Text and media");
    expect(sub("Layout").getAttribute("role")).toBe("menu");
    expect(sub("Layout").hidden).toBe(true);
    expect(item("Layout").getAttribute("aria-haspopup")).toBe("menu");
    expect(item("Layout").getAttribute("aria-expanded")).toBe("false");
    const leads = [...sub("Lead").querySelectorAll(".ed-menu-label")].map((node) => node.textContent);
    expect(leads).toHaveLength(2);
  });

  it("offers to put every pinned block back only when there is one", () => {
    fakeClipboard();
    context(view());
    expect(labels()).not.toContain("Put every pinned block back");
    press(menu(), "Escape");
    store.session.apply([
      { op: "block.frame", scene: "method", id: HEADING, frame: { x: 10, y: 10, w: 30, h: 10 } },
    ]);
    context(view());
    expect(labels()).toContain("Put every pinned block back");
    item("Put every pinned block back").click();
    expect(blocks().some((block) => block.frame)).toBe(false);
  });

  it("adds a block that the slide takes", () => {
    fakeClipboard();
    context(view());
    item("Add a chart here").click();
    expect(kinds()).toContain("chart");
  });

  it("changes the layout from the submenu", () => {
    fakeClipboard();
    context(view());
    const choice = sub("Layout").querySelector<HTMLElement>(".ed-menu-item") as HTMLElement;
    choice.click();
    expect(store.session.doc.scenes.method?.layout).not.toBe("text-media");
  });

  it("says Hide the comments when they are shown", () => {
    context(view());
    const word = labels().find((text) => /comments$/.test(text));
    expect(word).toMatch(/^(Show|Hide) the comments$/);
    item(word as string).click();
    context(view());
    const after = labels().find((text) => /comments$/.test(text));
    expect(after).not.toBe(word);
  });
});

describe("right-clicking a scene in the strip", () => {
  it("chooses the scene and lists what the buttons of the row do, and Present from here", () => {
    const event = context(row("opening"));
    expect(event.defaultPrevented).toBe(true);
    expect(editor.sceneId).toBe("opening");
    expect(menu().getAttribute("aria-label")).toBe("Scene menu");
    // The first scene has nowhere earlier to go. The demo deck is below 0.3, so it can start using text styles.
    expect(labels()).toEqual([
      "Change template…",
      "-",
      "Add scene from a template…",
      "Duplicate",
      "Delete",
      "-",
      "Use text styles",
      "-",
      "Move later",
      "-",
      "Present from here",
    ]);
  });

  it("brings a scene below 0.3 up to it with Use text styles, and then no longer offers it", () => {
    context(row("opening"));
    item("Use text styles").click();
    expect(store.session.doc.scenes.opening?.schemaVersion).toBe("0.3");
    expect(store.session.doc.scenes.demand?.schemaVersion).not.toBe("0.3");
    context(row("opening"));
    expect(labels()).not.toContain("Use text styles");
    // One undo takes the whole upgrade back.
    store.session.undo();
    expect(store.session.doc.scenes.opening?.schemaVersion).not.toBe("0.3");
  });

  it("duplicates, moves and deletes the scene that was clicked, and not the one on show", () => {
    context(row("opening"));
    item("Move later").click();
    expect(store.session.doc.deck.scenes).toEqual(["demand", "opening", "method"]);
    context(row("method"));
    item("Duplicate").click();
    expect(store.session.doc.deck.scenes).toHaveLength(4);
    context(row("demand"));
    item("Delete").click();
    expect(store.session.doc.deck.scenes).not.toContain("demand");
  });

  it("leaves Delete out when it is the only scene", () => {
    for (const id of ["opening", "demand"]) {
      context(row(id));
      item("Delete").click();
    }
    context(row("method"));
    expect(labels()).not.toContain("Delete");
  });
});

describe("a right-click that is not for the menu", () => {
  it("keeps the browser's menu over text that was already being typed in", () => {
    const text = editable(HEADING);
    text.focus();
    // The press comes first, while the caret is where it was.
    pointer("pointerdown", text);
    const event = context(text);
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("opens the menu over a text that was not, even though the browser moves the caret to it on the press", () => {
    const text = editable(HEADING);
    pointer("pointerdown", text);
    text.focus();
    fakeClipboard();
    expect(context(text).defaultPrevented).toBe(true);
    expect(open()).toBe(true);
    expect(editor.blockId).toBe(HEADING);
  });

  it("opens the menu over another text while typing in this one", () => {
    editable("method-body").focus();
    const other = editable(HEADING);
    pointer("pointerdown", other);
    other.focus();
    fakeClipboard();
    expect(context(other).defaultPrevented).toBe(true);
    expect(open()).toBe(true);
  });

  it("keeps the browser's menu in a field of the editor", () => {
    const field = document.createElement("textarea");
    host.querySelector(".ed-main")?.append(field);
    field.focus();
    pointer("pointerdown", field);
    expect(context(field).defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("keeps the browser's menu outside the slide, the strip and the stage", () => {
    expect(context(host.querySelector(".ed-bar") as Element).defaultPrevented).toBe(false);
    expect(context(host.querySelector(".ed-quick") as Element).defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("leaves Shift+F10 to the browser in a text being typed in", () => {
    const text = editable(HEADING);
    text.focus();
    const event = press(text, "F10", { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("closes a menu that was open when the next right-click is not for it", () => {
    fakeClipboard();
    context(blockNode(PICTURE));
    expect(open()).toBe(true);
    context(host.querySelector(".ed-bar") as Element);
    expect(open()).toBe(false);
  });
});

describe("opening it from the keyboard", () => {
  it("opens on Shift+F10 over the block the keyboard is on, anchored to it, with the first item focused", () => {
    fakeClipboard();
    const node = blockNode(PICTURE);
    node.focus();
    vi.spyOn(node, "getBoundingClientRect").mockReturnValue(rect(100, 120, 200, 80));
    const event = press(node, "F10", { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(true);
    expect(editor.blockId).toBe(PICTURE);
    expect(document.activeElement).toBe(menu().querySelector(".ed-menu-item"));
    // Under the block's lower left corner.
    expect(menu().style.left).toBe("100px");
    expect(menu().style.top).toBe("200px");
  });

  it("opens on the Menu key too", () => {
    fakeClipboard();
    const node = blockNode(PICTURE);
    node.focus();
    expect(press(node, "ContextMenu").defaultPrevented).toBe(true);
    expect(open()).toBe(true);
  });

  it("opens over the chosen block from the toolbar, which is where Alt+F10 takes the keyboard", () => {
    fakeClipboard();
    blockNode(PICTURE).click();
    press(document, "F10", { altKey: true });
    const inToolbar = document.activeElement as HTMLElement;
    expect(inToolbar.closest(".ed-toolbar")).not.toBeNull();
    press(inToolbar, "F10", { shiftKey: true });
    expect(open()).toBe(true);
    expect(menu().getAttribute("aria-label")).toBe("Block menu");
  });

  it("opens over a scene of the strip from its button, and says so", () => {
    const pick = row("demand").querySelector<HTMLElement>("button[data-scene]") as HTMLElement;
    pick.focus();
    expect(press(pick, "F10", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(menu().getAttribute("aria-label")).toBe("Scene menu");
    expect(editor.sceneId).toBe("demand");
  });

  it("leaves the key alone when the keyboard is on nothing it could open a menu for", () => {
    const event = press(document.body, "F10", { shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(open()).toBe(false);
  });

  it("does not open a second time for the context menu event the browser sends after the key", () => {
    fakeClipboard();
    const node = blockNode(PICTURE);
    node.focus();
    press(node, "F10", { shiftKey: true });
    const first = item("Cut");
    const native = context(node);
    expect(native.defaultPrevented).toBe(true);
    // The same menu, not a new one: the item the keyboard was moved to is still the one that has it.
    expect(menu().contains(first)).toBe(true);
  });
});

describe("using the menu from the keyboard", () => {
  const start = () => {
    fakeClipboard();
    const node = blockNode(PICTURE);
    node.focus();
    press(node, "F10", { shiftKey: true });
  };
  const focused = () => document.activeElement?.querySelector(".ed-menu-label")?.textContent;

  it("moves with the arrows, which wrap, and with Home and End", () => {
    start();
    expect(focused()).toBe("Cut");
    press(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("Copy");
    press(document.activeElement as Element, "ArrowUp");
    press(document.activeElement as Element, "ArrowUp");
    expect(focused()).toBe("Comment");
    press(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("Cut");
    press(document.activeElement as Element, "End");
    expect(focused()).toBe("Comment");
    press(document.activeElement as Element, "Home");
    expect(focused()).toBe("Cut");
  });

  it("jumps to the next item that starts with the letter typed", () => {
    start();
    press(document.activeElement as Element, "d");
    expect(focused()).toBe("Duplicate");
    press(document.activeElement as Element, "d");
    expect(focused()).toBe("Delete");
  });

  it("runs the item on Enter, and on Space", () => {
    start();
    press(document.activeElement as Element, "ArrowDown");
    press(document.activeElement as Element, "ArrowDown");
    press(document.activeElement as Element, "ArrowDown");
    expect(focused()).toBe("Duplicate");
    const event = press(document.activeElement as Element, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(false);
    expect(kinds()).toEqual(["text", "text", "image", "image"]);
    // Again, with Space.
    const node = blockNode(PICTURE);
    node.focus();
    press(node, "F10", { shiftKey: true });
    // The picture is no longer the last block, so it can move either way. Style and Comment are below the moves.
    press(document.activeElement as Element, "End");
    press(document.activeElement as Element, "ArrowUp");
    press(document.activeElement as Element, "ArrowUp");
    press(document.activeElement as Element, "ArrowUp");
    expect(focused()).toBe("Move earlier");
    press(document.activeElement as Element, " ");
    expect(open()).toBe(false);
    expect(
      blocks()
        .map((block) => block.id)
        .indexOf(PICTURE),
    ).toBe(1);
  });

  it("shuts on Esc and gives the keyboard back to the block it was opened on", () => {
    start();
    const event = press(document.activeElement as Element, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(blockNode(PICTURE));
  });

  it("shuts on Tab, and gives the keyboard back too", () => {
    start();
    press(document.activeElement as Element, "Tab");
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(blockNode(PICTURE));
  });

  it("gives the keyboard back to the block when an item has run", () => {
    start();
    press(document.activeElement as Element, "ArrowDown");
    press(document.activeElement as Element, "Enter");
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(blockNode(PICTURE));
  });

  it("keeps every key to itself while it is open", () => {
    // Something to undo, so a Ctrl+Z that got through would show.
    store.session.apply([{ op: "block.remove", scene: "method", id: HEADING }]);
    start();
    const event = press(document.activeElement as Element, "t");
    expect(kinds()).toEqual(["text", "image"]);
    expect(event.defaultPrevented).toBe(false);
    press(document.activeElement as Element, "z", { ctrlKey: true });
    expect(kinds()).toEqual(["text", "image"]);
    expect(open()).toBe(true);
  });

  it("opens a submenu on Right and shuts it on Left, with Esc shutting only the submenu", () => {
    fakeClipboard();
    context(view());
    const parent = item("Layout");
    parent.focus();
    press(parent, "ArrowRight");
    const panel = sub("Layout");
    expect(panel.hidden).toBe(false);
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(panel.querySelector(".ed-menu-item"));
    press(document.activeElement as Element, "ArrowDown");
    expect(document.activeElement).toBe(panel.querySelectorAll(".ed-menu-item")[1]);
    press(document.activeElement as Element, "ArrowLeft");
    expect(panel.hidden).toBe(true);
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(parent);
    press(parent, "ArrowRight");
    press(document.activeElement as Element, "Escape");
    expect(panel.hidden).toBe(true);
    expect(open()).toBe(true);
    expect(document.activeElement).toBe(parent);
    press(parent, "Escape");
    expect(open()).toBe(false);
  });

  it("opens a submenu on Enter, and runs what is chosen in it", () => {
    fakeClipboard();
    context(view());
    const parent = item("Lead");
    parent.focus();
    press(parent, "Enter");
    expect(sub("Lead").hidden).toBe(false);
    press(document.activeElement as Element, "Enter");
    expect(open()).toBe(false);
    expect(store.session.doc.scenes.method?.lead).not.toBe("human");
  });

  it("follows the pointer: the item under it has the keyboard, and a submenu opens with it", () => {
    fakeClipboard();
    context(view());
    const parent = item("Layout");
    pointer("pointermove", parent);
    expect(document.activeElement).toBe(parent);
    expect(sub("Layout").hidden).toBe(false);
    pointer("pointermove", item("Add a text here"));
    expect(document.activeElement).toBe(item("Add a text here"));
    expect(sub("Layout").hidden).toBe(true);
  });
});

describe("closing without choosing", () => {
  beforeEach(() => {
    fakeClipboard();
    context(blockNode(PICTURE));
  });

  it("shuts on a press outside it, and not on a press inside it", () => {
    pointer("pointerdown", item("Copy"));
    expect(open()).toBe(true);
    pointer("pointerdown", document.body);
    expect(open()).toBe(false);
  });

  it("shuts when the window changes size or loses the keyboard", () => {
    window.dispatchEvent(new Event("resize"));
    expect(open()).toBe(false);
    context(blockNode(PICTURE));
    expect(open()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(open()).toBe(false);
  });

  it("shuts when the page scrolls, though not while it is still settling on what was chosen", () => {
    vi.useFakeTimers();
    context(blockNode(PICTURE));
    document.dispatchEvent(new Event("scroll"));
    expect(open()).toBe(true);
    vi.advanceTimersByTime(200);
    document.dispatchEvent(new Event("scroll"));
    expect(open()).toBe(false);
  });

  it("shuts when the deck changes under it, because what it lists was true before the change", () => {
    expect(open()).toBe(true);
    store.session.apply([retitle("Edited")]);
    expect(open()).toBe(false);
  });

  it("is rebuilt for the next thing pointed at, and holds nothing of the last", () => {
    expect(labels()).toContain("Duplicate");
    context(row("opening"));
    expect(labels()).not.toContain("Cut");
    expect(menu().querySelectorAll(".ed-menu-item")).toHaveLength(7);
  });
});

describe("putting the keyboard back", () => {
  /** The menu opened over a text with the pointer, the way a right-click does: the press comes before the caret moves. */
  const overText = () => {
    fakeClipboard();
    const text = editable(HEADING);
    pointer("pointerdown", text);
    text.focus();
    context(text);
    expect(open()).toBe(true);
    return text;
  };

  it("returns it to the text the menu was opened over, when the menu is dismissed", () => {
    const text = overText();
    expect(document.activeElement).not.toBe(text);
    press(menu(), "Escape");
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(text);
  });

  it("leaves it out of the text when an item ran, so the next Ctrl+V is for the block and not for the words", () => {
    const text = overText();
    item("Copy").click();
    expect(open()).toBe(false);
    expect(document.activeElement).not.toBe(text);
  });

  it("returns it to a block that can take it, whether the menu was dismissed or an item ran", () => {
    fakeClipboard();
    const node = blockNode(PICTURE);
    node.tabIndex = 0;
    context(node);
    press(menu(), "Escape");
    expect(document.activeElement).toBe(node);
    (document.activeElement as HTMLElement).blur();
    context(node);
    item("Copy").click();
    expect(document.activeElement).toBe(node);
  });

  it("returns it to the button of the scene in the strip", () => {
    context(row("demand"));
    press(menu(), "Escape");
    expect(document.activeElement).toBe(row("demand").querySelector("button[data-scene]"));
  });

  it("does not move it when the menu shuts because of something else", () => {
    const text = overText();
    text.blur();
    window.dispatchEvent(new Event("resize"));
    expect(open()).toBe(false);
    expect(document.activeElement).not.toBe(text);
  });
});

describe("the place it opens at", () => {
  /** The menu is given a size, and the window one: there is no layout here to measure. */
  const sized = (width: number, height: number, window: { width: number; height: number }) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ed-menu") ? rect(0, 0, width, height) : rect(0, 0, 0, 0);
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: window.width,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: window.height,
      configurable: true,
    });
  };
  afterEach(() => {
    Reflect.deleteProperty(document.documentElement, "clientWidth");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });
  const at = () => [Number.parseFloat(menu().style.left), Number.parseFloat(menu().style.top)];

  it("is at the pointer when there is room", () => {
    fakeClipboard();
    sized(200, 300, { width: 1024, height: 768 });
    context(blockNode(PICTURE), { clientX: 300, clientY: 200 });
    expect(at()).toEqual([300, 200]);
  });

  it("opens leftward at the right edge and upward at the bottom", () => {
    fakeClipboard();
    sized(200, 300, { width: 1024, height: 768 });
    context(blockNode(PICTURE), { clientX: 1000, clientY: 700 });
    expect(at()).toEqual([800, 400]);
  });

  it("stays inside the window, a little way in from its edge", () => {
    fakeClipboard();
    sized(200, 300, { width: 1024, height: 768 });
    context(blockNode(PICTURE), { clientX: 2, clientY: 2 });
    expect(at()).toEqual([8, 8]);
    // Larger than the window, it still starts inside it.
    sized(2000, 2000, { width: 1024, height: 768 });
    context(blockNode(PICTURE), { clientX: 500, clientY: 500 });
    expect(at()).toEqual([8, 8]);
  });

  it("puts a submenu on the other side of its item when the right side has no room", () => {
    fakeClipboard();
    context(view());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ed-menu-sub") ? rect(990, 100, 200, 100) : rect(0, 0, 0, 0);
    });
    Object.defineProperty(document.documentElement, "clientWidth", { value: 1024, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", { value: 768, configurable: true });
    item("Layout").focus();
    press(item("Layout"), "ArrowRight");
    expect(sub("Layout").hasAttribute("data-flip")).toBe(true);
    press(document.activeElement as Element, "ArrowLeft");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ed-menu-sub") ? rect(300, 100, 200, 100) : rect(0, 0, 0, 0);
    });
    press(item("Layout"), "ArrowRight");
    expect(sub("Layout").hasAttribute("data-flip")).toBe(false);
  });
});

describe("a long press", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeClipboard();
  });

  it("opens the menu after half a second of a finger that stays put", () => {
    const node = blockNode(PICTURE);
    pointer("pointerdown", node, { pointerType: "touch", x: 100, y: 100 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(open()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(open()).toBe(true);
    expect(editor.blockId).toBe(PICTURE);
  });

  it("works for a pen, and not for a mouse, which has its right button", () => {
    pointer("pointerdown", blockNode(PICTURE), { pointerType: "pen" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open()).toBe(true);
    press(menu(), "Escape");
    pointer("pointerdown", blockNode(PICTURE), { pointerType: "mouse" });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(open()).toBe(false);
  });

  it("does not open when the finger lifts early", () => {
    const node = blockNode(PICTURE);
    pointer("pointerdown", node, { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    pointer("pointerup", node, { pointerType: "touch" });
    vi.advanceTimersByTime(1000);
    expect(open()).toBe(false);
  });

  it("does not open when the finger is taken away by the system", () => {
    const node = blockNode(PICTURE);
    pointer("pointerdown", node, { pointerType: "touch" });
    pointer("pointercancel", node, { pointerType: "touch" });
    vi.advanceTimersByTime(1000);
    expect(open()).toBe(false);
  });

  it("is a drag, and not a long press, once the finger has moved as far as the slop", () => {
    const node = blockNode(PICTURE);
    pointer("pointerdown", node, { pointerType: "touch", x: 100, y: 100 });
    pointer("pointermove", node, { pointerType: "touch", x: 100 + LONG_PRESS_SLOP - 1, y: 100 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open()).toBe(true);
    press(menu(), "Escape");
    pointer("pointerdown", node, { pointerType: "touch", x: 100, y: 100 });
    pointer("pointermove", node, { pointerType: "touch", x: 100 + LONG_PRESS_SLOP, y: 100 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(open()).toBe(false);
  });

  it("opens on a scene of the strip and on the empty slide", () => {
    pointer("pointerdown", row("demand"), { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menu().getAttribute("aria-label")).toBe("Scene menu");
    press(menu(), "Escape");
    pointer("pointerdown", view(), { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(menu().getAttribute("aria-label")).toBe("Slide menu");
  });

  it("does not open over text that is being typed in, which has its own menu for touch", () => {
    const text = editable(HEADING);
    text.focus();
    pointer("pointerdown", text, { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(open()).toBe(false);
  });

  it("swallows the click that follows, which is the finger coming up, and not a press on anything", () => {
    const node = blockNode(PICTURE);
    pointer("pointerdown", node, { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    pointer("pointerup", node, { pointerType: "touch" });
    const first = new MouseEvent("click", { bubbles: true, cancelable: true });
    node.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    // Only that one: a click after it is a click.
    const second = new MouseEvent("click", { bubbles: true, cancelable: true });
    node.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it("keeps the browser's own context menu event that follows the long press from opening it twice", () => {
    const node = blockNode(PICTURE);
    pointer("pointerdown", node, { pointerType: "touch" });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const first = item("Cut");
    expect(context(node).defaultPrevented).toBe(true);
    expect(menu().contains(first)).toBe(true);
  });
});

describe("cut, copy and paste from the menu", () => {
  it("copies the block to the clipboard as the block and as its words, and pastes it back", async () => {
    const clipboard = fakeClipboard();
    context(blockNode(PICTURE));
    item("Copy").click();
    await vi.waitFor(() => expect(clipboard.write).toHaveBeenCalledTimes(1));
    const written = clipboard.write.mock.calls[0]?.[0][0];
    expect(written?.types).toEqual(["text/plain", "text/html"]);
    const html = await (await written?.getType("text/html"))?.text();
    expect(blockFrom({ html })).toMatchObject({ block: { id: PICTURE, type: "image" } });
    expect(await (await written?.getType("text/plain"))?.text()).toContain("Diagram");
    context(blockNode(PICTURE));
    item("Paste").click();
    await vi.waitFor(() => expect(kinds()).toEqual(["text", "text", "image", "image"]));
    store.session.undo();
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("takes the block off the slide on Cut, and Undo brings it back", async () => {
    const clipboard = fakeClipboard();
    context(blockNode(PICTURE));
    item("Cut").click();
    await vi.waitFor(() => expect(kinds()).toEqual(["text", "text"]));
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    store.session.undo();
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("says so when the browser will not copy from a menu", async () => {
    const clipboard = fakeClipboard();
    clipboard.write.mockRejectedValue(new Error("no"));
    context(blockNode(PICTURE));
    item("Copy").click();
    await vi.waitFor(() =>
      expect(hint()).toBe("The browser would not copy from a menu. Press Ctrl C instead."),
    );
  });

  it("pastes what another program put on the clipboard only if it is a block, and says so if it is not", async () => {
    const clipboard = fakeClipboard();
    clipboard.read.mockResolvedValue([
      {
        types: ["text/plain"],
        getType: async () => new Blob(["just words"], { type: "text/plain" }),
      },
    ]);
    context(blockNode(PICTURE));
    item("Paste").click();
    await vi.waitFor(() =>
      expect(hint()).toBe("The clipboard holds no block from Depthcue. Copy one first."),
    );
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("falls back to its own copy when the browser will not let a menu read the clipboard", async () => {
    const clipboard = fakeClipboard();
    context(blockNode(PICTURE));
    item("Copy").click();
    await vi.waitFor(() => expect(clipboard.write).toHaveBeenCalled());
    clipboard.read.mockRejectedValue(new Error("denied"));
    context(blockNode(PICTURE));
    item("Paste").click();
    await vi.waitFor(() => expect(kinds()).toEqual(["text", "text", "image", "image"]));
  });

  it("refuses an image whose file is not in this deck, and says why, and changes nothing", async () => {
    const clipboard = fakeClipboard();
    const stranger = copiedBlock({ ...IMAGE_BLOCK, id: "far", asset: "assets/far-away.png" } as Block);
    clipboard.read.mockResolvedValue([
      {
        types: ["text/html"],
        getType: async () => new Blob([stranger.html], { type: "text/html" }),
      },
    ]);
    context(blockNode(PICTURE));
    item("Paste").click();
    await vi.waitFor(() => expect(hint()).toContain("assets/far-away.png, which is not in this deck"));
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("pins a paste at the pointer when the empty slide it was opened on has no area for it", async () => {
    const clipboard = fakeClipboard();
    const words = copiedBlock({ ...TEXT_BLOCK, id: "far-text", text: "From elsewhere" } as Block);
    clipboard.read.mockResolvedValue([
      {
        types: ["text/html"],
        getType: async () => new Blob([words.html], { type: "text/html" }),
      },
    ]);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("dc-view") ? rect(0, 0, 1600, 900) : rect(0, 0, 0, 0);
    });
    context(view(), { clientX: 800, clientY: 450 });
    item("Paste here").click();
    await vi.waitFor(() => expect(kinds()).toHaveLength(4));
    const pasted = blocks().find((block) => block.id === "far-text-copy");
    expect(pasted?.frame).toEqual({ x: 30, y: 43, w: 40, h: 14 });
    expect(editor.blockId).toBe("far-text-copy");
  });

  it("puts a paste into the area under the pointer when that area takes it", async () => {
    const clipboard = fakeClipboard();
    const words = copiedBlock({ ...TEXT_BLOCK, id: "far-text", text: "From elsewhere" } as Block);
    clipboard.read.mockResolvedValue([
      {
        types: ["text/html"],
        getType: async () => new Blob([words.html], { type: "text/html" }),
      },
    ]);
    const area = host.querySelector<HTMLElement>(".dc-text-region") as HTMLElement;
    context(area);
    item("Paste here").click();
    await vi.waitFor(() => expect(kinds()).toHaveLength(4));
    const pasted = blocks().find((block) => block.id === "far-text-copy");
    expect(pasted?.frame).toBeUndefined();
    expect(pasted?.type).toBe("text");
  });
});

describe("the keys that go with it", () => {
  it("leaves Ctrl C, Ctrl V and Ctrl D to a field, and to text being typed in", () => {
    blockNode(PICTURE).click();
    const text = editable(HEADING);
    text.focus();
    const clipboard = { files: [], getData: () => "", setData: vi.fn() };
    const sent = ["copy", "cut", "paste"].map((type) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboard });
      text.dispatchEvent(event);
      return event;
    });
    // The text keeps its own copy and cut. Its paste is its own too, which only ever inserts words.
    expect(sent.slice(0, 2).map((event) => event.defaultPrevented)).toEqual([false, false]);
    expect(clipboard.setData).not.toHaveBeenCalled();
    expect(press(text, "d", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  it("leaves Ctrl D to the browser when no block is chosen", () => {
    expect(press(document.body, "d", { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("does not paste a clipboard that holds no block of Depthcue, and says so", () => {
    blockNode(PICTURE).click();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { files: [], getData: (type: string) => (type === "text/plain" ? "hello" : ""), setData() {} },
    });
    blockNode(PICTURE).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(hint()).toBe("The clipboard holds no block from Depthcue. Copy one first.");
    expect(kinds()).toEqual(["text", "text", "image"]);
  });

  describe("pasting a chart on the slide that has a claim", () => {
    const paste = () => {
      const chart = copiedBlock(store.session.doc.scenes.demand?.blocks[0] as Block);
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => (type === "application/json" ? chart.json : ""),
          setData() {},
        },
      });
      document.body.dispatchEvent(event);
      return event;
    };
    const slotOfCopy = () => {
      const scene = store.session.doc.scenes.demand as Scene;
      const copy = scene.blocks.find((block) => block.id !== "chart-demand");
      return copy && slotOf(scene, copy.id);
    };
    beforeEach(() => editor.select("demand"));

    it("goes after the chosen block, in the area that block is in", () => {
      (host.querySelector("[data-id='chart-demand']") as HTMLElement).click();
      expect(paste().defaultPrevented).toBe(true);
      expect(blocks("demand")).toHaveLength(2);
      expect(slotOfCopy()).toBe("evidence");
      // A copy placed as evidence is cited as evidence, so the claim stands on both.
      expect(store.session.doc.scenes.demand?.summary?.evidenceIds).toHaveLength(2);
      expect(editor.blockId).not.toBe("chart-demand");
    });

    it("goes into the first empty area that takes it when the claim is what is chosen", () => {
      // The claim is chosen by its menu, which is shut again with the choice kept.
      context(host.querySelector("[data-id='claim-shift']") as HTMLElement);
      press(menu(), "Escape");
      expect(editor.blockId).toBe("claim-shift");
      expect(paste().defaultPrevented).toBe(true);
      expect(blocks("demand")).toHaveLength(2);
      expect(slotOfCopy()).toBe("support");
    });
  });
});

describe("the right-click menu, taken down", () => {
  it("leaves nothing of it on the page, and no right-click opens it", () => {
    editor.destroy();
    expect(document.querySelector(".ed-menu")).toBeNull();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    // The next test's teardown takes down the editor mounted here.
    return mount();
  });
});
