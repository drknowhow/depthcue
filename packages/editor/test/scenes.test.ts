// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
afterEach(() => editor.destroy());

const button = (action: string) =>
  host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`) as HTMLButtonElement;
const sceneButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".ed-scene")];
const layoutChoice = () =>
  host.querySelector<HTMLSelectElement>("[data-field='rail:layout']") as HTMLSelectElement;
const railProblem = () => host.querySelector<HTMLElement>(".ed-scenes .ed-problem") as HTMLElement;
const sceneOrder = () => store.session.doc.deck.scenes;

describe("adding a scene", () => {
  it("adds one after the scene being edited, with the chosen layout, and opens it", () => {
    sceneButtons()[1]?.click();
    layoutChoice().value = "claim-evidence";
    button("add-scene").click();
    expect(sceneOrder()).toEqual(["opening", "demand", "new-scene", "method"]);
    expect(editor.sceneId).toBe("new-scene");
    expect(store.session.doc.scenes["new-scene"]?.layout).toBe("claim-evidence");
    expect(sceneButtons()[2]?.getAttribute("aria-current")).toBe("true");
    expect(sceneButtons()[2]?.textContent).toContain("New scene");
    host.querySelector<HTMLButtonElement>(".ed-scene-tools [data-tb='scene']")?.click();
    expect(host.querySelector<HTMLInputElement>("[data-field='panel:title']")?.value).toBe("New scene");
    expect(railProblem().hidden).toBe(true);
  });

  it("offers every layout, and makes a valid scene for each", () => {
    const values = [...layoutChoice().options].map((option) => option.value);
    expect(values).toEqual(["title", "claim-evidence", "text-media"]);
    for (const value of values) {
      layoutChoice().value = value;
      button("add-scene").click();
      expect(store.session.doc.scenes[editor.sceneId]?.layout).toBe(value);
    }
  });

  it("never reuses an id, and undoes in one step", () => {
    for (let i = 0; i < 3; i += 1) button("add-scene").click();
    expect(new Set(sceneOrder()).size).toBe(sceneOrder().length);
    expect(sceneOrder()).toHaveLength(6);
    store.session.undo();
    expect(sceneOrder()).toHaveLength(5);
    expect(sceneOrder()).toContain(editor.sceneId);
  });

  it("says why when the deck cannot take another scene, and changes nothing", () => {
    // Filled by batches: clicking the button 197 times redraws the whole editor each time.
    const fillers = Array.from({ length: 200 - sceneOrder().length }, (_, i) => ({
      op: "scene.add" as const,
      scene: {
        id: `filler-${i}`,
        title: "Filler",
        layout: "text-media" as const,
        blocks: [{ id: `filler-${i}-body`, type: "text" as const, role: "body" as const, text: "Filler." }],
      },
    }));
    // A batch holds at most 100 operations.
    for (let at = 0; at < fillers.length; at += 100) {
      expect(store.session.apply(fillers.slice(at, at + 100)).ok).toBe(true);
    }
    expect(sceneOrder()).toHaveLength(200);
    const before = [...sceneOrder()];
    button("add-scene").click();
    expect(sceneOrder()).toEqual(before);
    expect(railProblem().hidden).toBe(false);
    expect(railProblem().textContent).toMatch(/\S/);
    store.session.undo();
    button("add-scene").click();
    expect(railProblem().hidden).toBe(true);
  });
});

describe("dragging scenes", () => {
  const items = () =>
    [...host.querySelectorAll<HTMLElement>(".ed-scene-list > li")] as [HTMLElement, HTMLElement, HTMLElement];
  function drag(type: string, node: Element, at: { x?: number; y?: number } = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clientX", { value: at.x ?? 0 });
    Object.defineProperty(event, "clientY", { value: at.y ?? 0 });
    node.dispatchEvent(event);
    return event;
  }
  const box = (node: HTMLElement) => {
    node.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height: 100 }) as DOMRect;
  };

  it("makes every scene draggable", () => {
    expect(items().every((node) => node.draggable)).toBe(true);
  });

  it("moves a scene after the one it is dropped on, when dropped on its lower half", () => {
    const [first, , last] = items();
    box(last);
    drag("dragstart", first);
    drag("dragover", last, { y: 90 });
    drag("drop", last, { y: 90 });
    expect(sceneOrder()).toEqual(["demand", "method", "opening"]);
  });

  it("moves a scene before the one it is dropped on, when dropped on its upper half", () => {
    const [first, , last] = items();
    box(first);
    drag("dragstart", last);
    drag("dragover", first, { y: 10 });
    drag("drop", first, { y: 10 });
    expect(sceneOrder()).toEqual(["method", "opening", "demand"]);
  });

  it("shows where the scene will land while dragging, and stops showing it afterwards", () => {
    const [first, middle, last] = items();
    box(middle);
    box(last);
    drag("dragstart", first);
    expect(first.hasAttribute("data-dragging")).toBe(true);
    const over = drag("dragover", middle, { y: 10 });
    expect(over.defaultPrevented).toBe(true);
    expect(middle.getAttribute("data-drop")).toBe("upper");
    drag("dragover", middle, { y: 90 });
    expect(middle.getAttribute("data-drop")).toBe("lower");
    drag("dragover", last, { y: 90 });
    expect(middle.hasAttribute("data-drop")).toBe(false);
    expect(last.getAttribute("data-drop")).toBe("lower");
    drag("dragend", first);
    expect(first.hasAttribute("data-dragging")).toBe(false);
    expect(last.hasAttribute("data-drop")).toBe(false);
    expect(sceneOrder()).toEqual(["opening", "demand", "method"]);
  });

  it("uses the horizontal position when the scenes are laid out in a row", () => {
    const [first, middle] = items();
    (host.querySelector(".ed-scene-list") as HTMLElement).dataset.axis = "x";
    box(middle);
    drag("dragstart", first);
    drag("dragover", middle, { x: 10, y: 90 });
    expect(middle.getAttribute("data-drop")).toBe("upper");
    drag("dragover", middle, { x: 90, y: 10 });
    expect(middle.getAttribute("data-drop")).toBe("lower");
  });

  it("reads the layout direction only from a list that is really a row of flex items", () => {
    const list = host.querySelector<HTMLElement>(".ed-scene-list") as HTMLElement;
    const axisAfter = (style: string) => {
      list.setAttribute("style", style);
      sceneButtons()[1]?.click();
      return list.dataset.axis;
    };
    expect(axisAfter("display: flex; flex-direction: row")).toBe("x");
    expect(axisAfter("display: flex; flex-direction: column")).toBe("y");
    // A grid reports flex-direction "row" as well, and the desktop list is a grid.
    expect(axisAfter("display: grid; flex-direction: row")).toBe("y");
  });

  it("does nothing when a scene is dropped on itself, or dropped where it already is", () => {
    const [first, middle] = items();
    drag("dragstart", first);
    const over = drag("dragover", first);
    expect(over.defaultPrevented).toBe(false);
    drag("drop", first);
    box(middle);
    drag("dragstart", first);
    drag("dragover", middle, { y: 10 });
    drag("drop", middle, { y: 10 });
    expect(sceneOrder()).toEqual(["opening", "demand", "method"]);
    expect(store.session.canUndo).toBe(false);
    // Nothing moved, so nothing was redrawn, and the markers must come off by themselves.
    expect(first.hasAttribute("data-dragging")).toBe(false);
    expect(middle.hasAttribute("data-drop")).toBe(false);
  });

  it("ignores a drag that did not start from a scene, such as a file dragged over the page", () => {
    const [first] = items();
    const over = drag("dragover", first);
    expect(over.defaultPrevented).toBe(false);
    const dropped = drag("drop", first);
    expect(dropped.defaultPrevented).toBe(false);
    expect(sceneOrder()).toEqual(["opening", "demand", "method"]);
  });

  it("takes the indicator off a scene the pointer left, but not one it moved within", () => {
    const [first, middle] = items();
    box(middle);
    drag("dragstart", first);
    drag("dragover", middle, { y: 10 });
    const inside = new Event("dragleave", { bubbles: true });
    Object.defineProperty(inside, "relatedTarget", { value: middle.firstElementChild });
    middle.dispatchEvent(inside);
    expect(middle.getAttribute("data-drop")).toBe("upper");
    drag("dragleave", middle);
    expect(middle.hasAttribute("data-drop")).toBe(false);
  });

  it("can be undone as a single step", () => {
    const [first, , last] = items();
    box(last);
    drag("dragstart", first);
    drag("drop", last, { y: 90 });
    expect(sceneOrder()).toEqual(["demand", "method", "opening"]);
    store.session.undo();
    expect(sceneOrder()).toEqual(["opening", "demand", "method"]);
  });
});
