// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { stepZoom } from "../src/viewbar.ts";
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

const control = (name: string) =>
  host.querySelector<HTMLButtonElement>(`[data-view='${name}']`) as HTMLButtonElement;
const scenes = () => store.session.doc.deck.scenes;

describe("the view bar", () => {
  it("has no pager: the filmstrip and the [ and ] keys move between slides", () => {
    expect(control("previous")).toBeNull();
    expect(control("next")).toBeNull();
    expect(control("where")).toBeNull();
  });

  it("zooms the slide in steps and back to fit, without touching the deck", () => {
    const saved = JSON.stringify(store.session.doc.deck);
    control("zoom-in").click();
    control("zoom-in").click();
    expect(control("fit").textContent).toBe("150%");
    expect(host.querySelector<HTMLElement>(".ed-canvas-host")?.style.getPropertyValue("--ed-zoom")).toBe(
      "1.5",
    );
    control("fit").click();
    expect(control("fit").textContent).toBe("100%");
    expect(JSON.stringify(store.session.doc.deck)).toBe(saved);
    expect(store.history.canUndo).toBe(false);
  });

  it("keeps the zoom when another slide is shown, and stops at the ends of the range", () => {
    for (let at = 0; at < 10; at++) control("zoom-in").click();
    expect(control("fit").textContent).toBe("300%");
    expect(control("zoom-in").disabled).toBe(true);
    editor.select(scenes()[1] as string);
    expect(control("fit").textContent).toBe("300%");
  });

  it("zooms on Ctrl and the wheel", () => {
    const stage = host.querySelector(".ed-main") as HTMLElement;
    const spin = (init: { ctrlKey: boolean }) => {
      const event = new Event("wheel", { bubbles: true, cancelable: true });
      Object.assign(event, { deltaY: -100, ...init });
      stage.dispatchEvent(event);
      return event;
    };
    const wheel = spin({ ctrlKey: true });
    expect(wheel.defaultPrevented).toBe(true);
    expect(control("fit").textContent).toBe("125%");
    expect(spin({ ctrlKey: false }).defaultPrevented).toBe(false);
  });
});

describe("stepZoom", () => {
  it("moves to the neighbouring step and stays at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });
});
