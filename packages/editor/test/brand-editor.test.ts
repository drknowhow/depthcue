// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type Block, docToFiles, loadDoc, memoryDraftStore, revisionOf, type Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeckPayload, SaveOptions, SaveResult } from "../src/api.ts";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/decks/v0-4-brand");

/** The fake server, serving the branded fixture with its brand's other files listed, as `depthcue edit` does. */
class BrandServer extends FakeServer {
  readonly brandFiles: string[] = [];

  constructor() {
    super();
    const text: Record<string, string> = {};
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const full = join(at, name);
        const path = relative(fixture, full).split(sep).join("/");
        if (statSync(full).isDirectory()) walk(full);
        else if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
        else this.brandFiles.push(path);
      }
    };
    walk(fixture);
    this.text = text;
    this.assets = [];
  }

  #load(text: Record<string, string>) {
    return loadDoc({ text, assets: this.assets, brandFiles: this.brandFiles }).doc;
  }

  override get rev(): string {
    const doc = this.#load(this.text);
    if (!doc) throw new Error("the branded fixture should be valid");
    return revisionOf(doc);
  }

  override async loadDeck(): Promise<DeckPayload> {
    return { ...(await super.loadDeck()), brandFiles: [...this.brandFiles] };
  }

  override async save(
    files: Record<string, string>,
    baseRev: string,
    _options?: SaveOptions,
  ): Promise<SaveResult> {
    this.saves.push({ files, baseRev, options: _options });
    if (baseRev !== this.rev)
      return { ok: false, kind: "stale", rev: this.rev, message: "The deck changed on disk." };
    const doc = this.#load(files);
    if (!doc) return { ok: false, kind: "rejected", message: "Invalid.", diagnostics: [] };
    this.text = docToFiles(doc);
    return { ok: true, rev: revisionOf(doc) };
  }
}

let host: HTMLElement;
let store: EditorStore;
let editor: Editor;

beforeEach(async () => {
  store = await openStore(new BrandServer(), () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
});
afterEach(() => editor.destroy());

const scene = (id: string) => store.session.doc.scenes[id] as Scene;
const block = (sceneId: string, id: string) =>
  scene(sceneId).blocks.find((candidate) => candidate.id === id) as Block;
const slide = () => host.querySelector(".ed-canvas-host .dc-scene") as HTMLElement;
/** Chooses a text block the way a person does: by putting the caret in it. */
const choose = (id: string) =>
  (
    host.querySelector<HTMLElement>(
      `[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`,
    ) as HTMLElement
  ).focus();
const dialog = (name: string) => host.querySelector<HTMLDialogElement>(`dialog[data-dialog='${name}']`);
const change = (input: HTMLInputElement) => {
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("the empty slots of a template scene, in the editor", () => {
  it("are drawn on the slide with their hints, and a click puts a block in the slot, as one step of Undo", () => {
    editor.select("growth");
    expect(slide().querySelector(".ed-slot")).toBeNull();
    store.session.apply([{ op: "block.remove", scene: "growth", id: "growth-note" }]);
    const note = slide().querySelector<HTMLElement>(".ed-slot[data-slot='note']") as HTMLElement;
    expect(note.querySelector(".ed-slot-hint")?.textContent).toBe(
      "How to read the chart, in one or two short paragraphs.",
    );
    (note.querySelector(".ed-slot-add") as HTMLButtonElement).click();
    (note.querySelector("[data-slot-kind='body']") as HTMLButtonElement).click();
    const added = scene("growth").blocks.at(-1) as Block;
    expect(added).toMatchObject({ type: "text", role: "body", slot: "note" });
    expect(editor.blockId).toBe(added.id);
    expect(slide().querySelector(".ed-slot")).toBeNull();
    store.session.undo();
    expect(scene("growth").blocks.map((candidate) => candidate.id)).toEqual(["growth-title", "growth-chart"]);
  });

  it("never draws a hint on a scene with a layout", () => {
    editor.select("context");
    expect(slide().querySelector(".ed-slot")).toBeNull();
  });
});

describe("the template picker in the strip", () => {
  it("adds a scene from a template after the one on show, and goes to it", () => {
    editor.select("welcome");
    const open = host.querySelector<HTMLButtonElement>(".ed-add-scene [data-action='pick-template']");
    expect(open?.textContent).toBe("From a template…");
    expect(open?.getAttribute("aria-haspopup")).toBe("dialog");
    open?.click();
    const picker = dialog("picker") as HTMLDialogElement;
    const groups = [...picker.querySelectorAll(".ed-pick-group")].map((node) => node.textContent);
    expect(groups).toEqual(["Harbor Analytics", "Built in", "Layouts"]);
    (picker.querySelector("[data-pick='template:chart-and-note']") as HTMLButtonElement).click();
    expect(dialog("picker")).toBeNull();
    const order = store.session.doc.deck.scenes;
    expect(order).toHaveLength(4);
    const added = scene(order[1] as string);
    expect(added.template).toBe("chart-and-note");
    expect(editor.sceneId).toBe(added.id);
    // Its empty slots show what goes in them.
    expect([...slide().querySelectorAll<HTMLElement>(".ed-slot")].map((node) => node.dataset.slot)).toEqual([
      "chart",
      "note",
    ]);
  });
});

describe("Change template", () => {
  it("is in a template scene's bar in place of the layouts, named for its template, and applies as one step of Undo", () => {
    editor.select("growth");
    const button = host.querySelector<HTMLButtonElement>(".ed-scene-tools [data-action='change-template']");
    const layouts = host.querySelector<HTMLElement>(".ed-scene-tools [aria-label='Layout of this scene']");
    expect(button?.textContent).toBe("Chart and note");
    expect(button?.getAttribute("aria-label")).toBe("Template: Chart and note, change");
    expect([button?.hidden, layouts?.hidden]).toEqual([false, true]);
    // A layout scene has its layouts there, and no template button: the bar is no wider than it was.
    editor.select("context");
    expect([button?.hidden, layouts?.hidden]).toEqual([true, false]);
    editor.select("growth");
    button?.click();
    const box = dialog("retemplate") as HTMLDialogElement;
    change(box.querySelector("input[value='template:cover']") as HTMLInputElement);
    expect(box.querySelector(".ed-retemplate-unplaced li")?.textContent).toMatch(/^Chart/);
    (box.querySelector("[data-dialog-action='apply']") as HTMLButtonElement).click();
    expect(dialog("retemplate")).toBeNull();
    expect(scene("growth").template).toBe("cover");
    // The chart has no slot in the cover, so it stays on the slide, pinned.
    expect(block("growth", "growth-chart").slot).toBeUndefined();
    expect(block("growth", "growth-chart").frame).toBeDefined();
    store.session.undo();
    expect(scene("growth").template).toBe("chart-and-note");
    expect(block("growth", "growth-chart").slot).toBe("chart");
  });

  it("opens at a layout when a template scene is given one from the right-click menu, so nothing moves unseen", () => {
    editor.select("growth");
    slide().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    const item = [...host.querySelectorAll<HTMLElement>(".ed-menu-sub .ed-menu-item")].find(
      (node) => node.querySelector(".ed-menu-label")?.textContent === "Text and media",
    );
    item?.click();
    expect(scene("growth").template).toBe("chart-and-note");
    const box = dialog("retemplate") as HTMLDialogElement;
    expect(box.querySelector<HTMLInputElement>("input:checked")?.value).toBe("layout:text-media");
    (box.querySelector("[data-dialog-action='apply']") as HTMLButtonElement).click();
    expect(scene("growth").layout).toBe("text-media");
    expect(scene("growth").template).toBeUndefined();
    expect(scene("growth").blocks.every((candidate) => candidate.slot === undefined)).toBe(true);
  });

  it("is in the Scene popover of a layout scene", () => {
    editor.select("context");
    (host.querySelector(".ed-scene-tools [data-tb='scene']") as HTMLButtonElement).click();
    (host.querySelector("[data-field='panel:change-template']") as HTMLButtonElement).click();
    const box = dialog("retemplate") as HTMLDialogElement;
    // The scene's own layout is marked as the one it has now.
    expect(box.querySelector("label:has(input[value='layout:text-media'])")?.textContent).toContain("Now");
    expect(host.querySelector(".ed-scene-tools .ed-tb-pop:not([hidden])")).toBeNull();
  });

  it("is on the slide's right-click menu", () => {
    editor.select("growth");
    slide().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    const item = [...host.querySelectorAll<HTMLElement>(".ed-menu-item")].find(
      (node) => node.querySelector(".ed-menu-label")?.textContent === "Change template…",
    );
    item?.click();
    expect(dialog("retemplate")).not.toBeNull();
  });
});

describe("the Style menu of a block", () => {
  it("is a Style chip on the toolbar with the styles for the block's kind, the one it has checked", () => {
    editor.select("context");
    choose("context-quote");
    expect(editor.blockId).toBe("context-quote");
    const chip = host.querySelector<HTMLButtonElement>(".ed-toolbar [data-tb='style']") as HTMLButtonElement;
    chip.click();
    const styles = host.querySelector<HTMLElement>(".ed-toolbar .ed-styles") as HTMLElement;
    const checked = styles.querySelector<HTMLInputElement>("input:checked");
    expect(checked?.dataset.style).toBe("callout");
    // As an arrow key in the list does: the choice is made, and the keyboard stays on it for the next one.
    const panel = styles.querySelector("input[data-style='quiet-panel']") as HTMLInputElement;
    panel.focus();
    change(panel);
    expect(block("context", "context-quote").style).toBe("quiet-panel");
    expect(host.querySelector(".ed-toolbar .ed-styles input[data-style='quiet-panel']")).toBe(panel);
    expect(document.activeElement).toBe(panel);
    expect(panel.checked).toBe(true);
    change(host.querySelector(".ed-toolbar .ed-styles input[data-style='none']") as HTMLInputElement);
    expect(block("context", "context-quote").style).toBeUndefined();
  });

  it("is a Style submenu on the block's right-click menu, with the current one checked", () => {
    editor.select("context");
    const quote = host.querySelector("[data-id='context-quote']") as HTMLElement;
    quote.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    const items = [...host.querySelectorAll<HTMLElement>(".ed-menu-sub .ed-menu-item[role='menuitemradio']")];
    const named = (name: string) =>
      items.find((node) => node.querySelector(".ed-menu-label")?.textContent === name);
    expect(named("Callout")?.getAttribute("aria-checked")).toBe("true");
    expect(named("No style")?.getAttribute("aria-checked")).toBe("false");
    // Only the styles made for a quote: the brand's Kicker is for a caption.
    expect(named("Kicker")).toBeUndefined();
    // Each style shows what it looks like.
    expect(named("Quiet panel")?.querySelector(".ed-mini .dc-scene")).not.toBeNull();
    named("Quiet panel")?.click();
    expect(block("context", "context-quote").style).toBe("quiet-panel");
  });
});

describe("a brand that locks its colors and fonts", () => {
  it("turns the deck's palette and font controls off, and says why", () => {
    const panel = () => host.querySelector(".ed-bar") as HTMLElement;
    expect(panel().querySelector("[data-locked]")).toBeNull();
    store.session.apply([{ op: "brand.set", set: { lock: true } }]);
    const locked = [...panel().querySelectorAll<HTMLFieldSetElement>("fieldset[disabled]")];
    expect(locked.map((set) => set.querySelector("legend")?.textContent)).toEqual(["Colors", "Fonts"]);
    expect([...panel().querySelectorAll("[data-locked]")].map((note) => note.textContent)).toEqual([
      'The brand "harbor" is locked, so the deck cannot set its own colors.',
      'The brand "harbor" is locked, so the deck cannot set its own fonts.',
    ]);
  });
});

describe("the brand's chrome on the slide", () => {
  it("is drawn, but is no block: nothing in it can be chosen, focused or dragged", () => {
    editor.select("growth");
    const chrome = slide().querySelector<HTMLElement>(".dc-chrome") as HTMLElement;
    expect(chrome).not.toBeNull();
    expect(chrome.querySelector("[data-id], [tabindex], button, a, input")).toBeNull();
    choose("growth-title");
    expect(editor.blockId).toBe("growth-title");
    // A click that lands on the chrome is a click on the empty slide.
    (chrome.firstElementChild as HTMLElement).click();
    expect(editor.blockId).toBeUndefined();
  });
});
