// @vitest-environment happy-dom
import { LAYOUTS, LEADS, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { createSceneBar } from "../src/scenebar.ts";
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

const lead = (value: string) =>
  host.querySelector<HTMLButtonElement>(`.ed-scene-tools [data-lead='${value}']`);
const layout = (value: string) =>
  host.querySelector<HTMLButtonElement>(`.ed-scene-tools [data-layout='${value}']`);
const pressed = (nodes: Array<HTMLButtonElement | null>) =>
  nodes
    .filter((node) => node?.getAttribute("aria-pressed") === "true")
    .map((node) => node?.dataset.lead ?? node?.dataset.layout);
const scene = (id: string) => store.session.doc.scenes[id];

describe("the lead and layout buttons in the top bar", () => {
  it("sit in the bar, in two named groups, with one button for every lead and layout the core has", () => {
    const groups = [...host.querySelectorAll(".ed-bar .ed-seg")];
    expect(groups.map((group) => group.getAttribute("role"))).toEqual(["group", "group"]);
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Who leads this scene",
      "Layout of this scene",
    ]);
    expect([...(groups[0]?.querySelectorAll("button") ?? [])].map((node) => node.dataset.lead)).toEqual([
      ...LEADS,
    ]);
    expect([...(groups[1]?.querySelectorAll("button") ?? [])].map((node) => node.dataset.layout)).toEqual([
      ...LAYOUTS,
    ]);
  });

  it("give every layout a picture and a name a screen reader can say", () => {
    for (const value of LAYOUTS) {
      const node = layout(value) as HTMLButtonElement;
      expect(node.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(node.querySelectorAll("svg > *").length).toBeGreaterThan(0);
      expect(node.getAttribute("aria-label")).toMatch(/\S/);
      expect(node.title).toBe(node.getAttribute("aria-label"));
    }
  });

  it("show the lead and layout of the scene being edited, and follow the selection", () => {
    expect(pressed(LEADS.map(lead))).toEqual(["human"]);
    expect(pressed(LAYOUTS.map(layout))).toEqual(["title"]);
    editor.select("demand");
    expect(pressed(LEADS.map(lead))).toEqual(["agent"]);
    expect(pressed(LAYOUTS.map(layout))).toEqual(["claim-evidence"]);
    editor.select("method");
    expect(pressed(LAYOUTS.map(layout))).toEqual(["text-media"]);
  });

  it("count a scene with no lead as human, the way the strip does", () => {
    store.session.apply([{ op: "scene.set", id: "opening", set: { lead: null } }]);
    expect(scene("opening")?.lead).toBeUndefined();
    expect(pressed(LEADS.map(lead))).toEqual(["human"]);
    // Pressing the button that is already shown as pressed changes nothing in the deck.
    const before = store.session.doc;
    lead("human")?.click();
    expect(store.session.doc).toBe(before);
  });

  it("change who leads the scene in one click, and undo it in one step", () => {
    lead("agent")?.click();
    expect(scene("opening")?.lead).toBe("agent");
    expect(pressed(LEADS.map(lead))).toEqual(["agent"]);
    expect(host.querySelector("[data-id='opening'] .ed-lead")?.textContent).toBe("Agent");
    store.session.undo();
    expect(scene("opening")?.lead).toBe("human");
    expect(pressed(LEADS.map(lead))).toEqual(["human"]);
  });

  it("change the layout in one click, redraw the slide, and undo it in one step", () => {
    const before = host.querySelector(".ed-frame")?.innerHTML;
    layout("text-media")?.click();
    expect(scene("opening")?.layout).toBe("text-media");
    expect(pressed(LAYOUTS.map(layout))).toEqual(["text-media"]);
    expect(host.querySelector(".ed-frame")?.innerHTML).not.toBe(before);
    store.session.undo();
    expect(scene("opening")?.layout).toBe("title");
    expect(pressed(LAYOUTS.map(layout))).toEqual(["title"]);
  });

  it("act on the scene being edited, not the one clicked last in the strip", () => {
    editor.select("method");
    lead("agent")?.click();
    expect(scene("method")?.lead).toBe("agent");
    expect(scene("opening")?.lead).toBe("human");
  });
});

describe("a change the core refuses", () => {
  it("is reported through the hook with the core's message, and cleared by the next one that works", () => {
    const messages: Array<string | undefined> = [];
    let refuse = true;
    const bar = createSceneBar(store.session, {
      act: (ops) =>
        refuse
          ? ({
              ok: false,
              code: "invalid",
              rev: "",
              diagnostics: [{ message: "Not that.", fix: "Try this." }],
            } as never)
          : store.session.apply(ops),
      problem: (text) => messages.push(text),
    });
    bar.render("opening");
    bar.element.querySelector<HTMLButtonElement>("[data-lead='agent']")?.click();
    expect(messages).toEqual(["Not that. Try this."]);
    refuse = false;
    bar.element.querySelector<HTMLButtonElement>("[data-lead='agent']")?.click();
    expect(messages.at(-1)).toBeUndefined();
    expect(scene("opening")?.lead).toBe("agent");
  });
});
