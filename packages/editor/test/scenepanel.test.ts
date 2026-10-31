// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

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
  // The method scene has two texts and an image, no claim, no steps and no sources.
  editor.select("method");
});
afterEach(() => editor.destroy());

const chip = () =>
  host.querySelector<HTMLButtonElement>(".ed-scene-tools [data-tb='scene']") as HTMLButtonElement;
const pop = () => chip().closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
const control = <T extends HTMLElement = HTMLInputElement>(key: string): T => {
  const found = pop().querySelector<T>(`[data-field="${key}"]`);
  if (!found) throw new Error(`no control with data-field ${key} in the scene popover`);
  return found;
};
const has = (key: string) => pop().querySelector(`[data-field="${key}"]`) !== null;
const section = (name: string) =>
  pop().querySelector<HTMLDetailsElement>(`details[data-section='${name}']`) as HTMLDetailsElement;
const scene = (id = "method") => store.session.doc.scenes[id];
const typeInto = (node: HTMLInputElement, text: string) => {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};
const choose = (node: HTMLSelectElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
};
const tick = (node: HTMLInputElement, on: boolean) => {
  node.checked = on;
  node.dispatchEvent(new Event("change", { bubbles: true }));
};
const press = (node: Element, key: string) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const openPanel = () => chip().click();
const openSection = (name: "steps" | "sources") => {
  openPanel();
  section(name).open = true;
};

describe("the scene popover", () => {
  it("opens from a Scene chip in the top bar, with the scene's title", () => {
    expect(pop().hidden).toBe(true);
    openPanel();
    expect(pop().hidden).toBe(false);
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(control("panel:title").value).toBe(scene()?.title);
  });

  it("sets the title as it is typed, and the strip shows it", () => {
    openPanel();
    typeInto(control("panel:title"), "How we compared");
    expect(scene()?.title).toBe("How we compared");
    expect(host.querySelector(".ed-scene[data-scene='method']")?.textContent).toContain("How we compared");
  });

  it("refuses an empty title and keeps the old one", () => {
    const before = scene()?.title;
    openPanel();
    typeInto(control("panel:title"), "");
    expect(scene()?.title).toBe(before);
    expect(control("panel:title").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the field being typed in, and shows the change in the details panel too", () => {
    openPanel();
    const input = control("panel:title");
    typeInto(input, "A");
    typeInto(input, "AB");
    expect(control("panel:title")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(host.querySelector<HTMLInputElement>("[data-field='scene:title']")?.value).toBe("AB");
  });

  it("follows the scene chosen in the strip", () => {
    openPanel();
    editor.select("demand");
    expect(control("panel:title").value).toBe(scene("demand")?.title);
  });

  it("closes with Escape and gives the keyboard to its chip", () => {
    openPanel();
    press(control("panel:title"), "Escape");
    expect(pop().hidden).toBe(true);
    expect(document.activeElement).toBe(chip());
  });

  it("closes when the pointer goes down anywhere else", () => {
    openPanel();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop().hidden).toBe(true);
  });
});

describe("steps in the scene popover", () => {
  it("starts closed, with a count once there are steps", () => {
    openPanel();
    expect(section("steps").open).toBe(false);
    expect(section("steps").querySelector(".ed-tb-n")?.textContent).toBe("");
    section("steps").open = true;
    control<HTMLButtonElement>("panel:step:add").click();
    expect(section("steps").querySelector(".ed-tb-n")?.textContent).toBe("1");
  });

  it("adds a step that reveals the first block no step reveals yet, and puts the keyboard on it", () => {
    openSection("steps");
    control<HTMLButtonElement>("panel:step:add").click();
    const [step] = scene()?.steps ?? [];
    expect(step?.reveal).toEqual(["method-heading"]);
    expect(document.activeElement).toBe(control(`panel:step:${step?.id}:method-heading`));
    control<HTMLButtonElement>("panel:step:add").click();
    expect(scene()?.steps?.[1]?.reveal).toEqual(["method-body"]);
  });

  it("changes what a step reveals", () => {
    openSection("steps");
    control<HTMLButtonElement>("panel:step:add").click();
    const id = scene()?.steps?.[0]?.id;
    tick(control(`panel:step:${id}:method-body`), true);
    expect(scene()?.steps?.[0]?.reveal).toEqual(["method-heading", "method-body"]);
  });

  it("moves a step up or down and removes it, and drops the list when the last one goes", () => {
    openSection("steps");
    control<HTMLButtonElement>("panel:step:add").click();
    control<HTMLButtonElement>("panel:step:add").click();
    const [first, second] = (scene()?.steps ?? []).map((step) => step.id);
    expect(control<HTMLButtonElement>(`panel:step-up:${first}`).disabled).toBe(true);
    expect(control<HTMLButtonElement>(`panel:step-down:${second}`).disabled).toBe(true);
    control<HTMLButtonElement>(`panel:step-down:${first}`).click();
    expect(scene()?.steps?.map((step) => step.id)).toEqual([second, first]);
    control<HTMLButtonElement>(`panel:step-remove:${second}`).click();
    control<HTMLButtonElement>(`panel:step-remove:${first}`).click();
    expect("steps" in (scene() ?? {})).toBe(false);
  });

  it("stays open when a change redraws it", () => {
    openSection("steps");
    control<HTMLButtonElement>("panel:step:add").click();
    expect(section("steps").open).toBe(true);
  });
});

describe("sources in the scene popover", () => {
  it("adds a source and puts the keyboard on its title", () => {
    openSection("sources");
    control<HTMLButtonElement>("panel:source:add").click();
    const [source] = scene()?.sources ?? [];
    expect(source).toMatchObject({ title: "New source" });
    expect(document.activeElement).toBe(control(`panel:source:${source?.id}:title`));
    expect(section("sources").querySelector(".ed-tb-n")?.textContent).toBe("1");
  });

  it("edits the title and the link, and refuses a link that is not one", () => {
    openSection("sources");
    control<HTMLButtonElement>("panel:source:add").click();
    const id = scene()?.sources?.[0]?.id;
    typeInto(control(`panel:source:${id}:title`), "Annual report");
    expect(scene()?.sources?.[0]?.title).toBe("Annual report");
    typeInto(control(`panel:source:${id}:url`), "https://example.org/report");
    expect(scene()?.sources?.[0]?.url).toBe("https://example.org/report");
    typeInto(control(`panel:source:${id}:url`), "not a link");
    expect(scene()?.sources?.[0]?.url).toBe("https://example.org/report");
    expect(control(`panel:source:${id}:url`).getAttribute("aria-invalid")).toBe("true");
    typeInto(control(`panel:source:${id}:url`), "");
    expect("url" in (scene()?.sources?.[0] ?? {})).toBe(false);
  });

  it("points a source at a file in the deck and clears it again", () => {
    openSection("sources");
    control<HTMLButtonElement>("panel:source:add").click();
    const id = scene()?.sources?.[0]?.id;
    choose(control<HTMLSelectElement>(`panel:source:${id}:asset`), "assets/report.csv");
    expect(scene()?.sources?.[0]?.asset).toBe("assets/report.csv");
    choose(control<HTMLSelectElement>(`panel:source:${id}:asset`), "");
    expect("asset" in (scene()?.sources?.[0] ?? {})).toBe(false);
  });

  it("removes a source and the citations of it, as one undo step", () => {
    openSection("sources");
    control<HTMLButtonElement>("panel:source:add").click();
    const id = scene()?.sources?.[0]?.id as string;
    store.session.apply([{ op: "block.set", scene: "method", id: "method-body", set: { sourceIds: [id] } }]);
    control<HTMLButtonElement>(`panel:source-remove:${id}`).click();
    expect("sources" in (scene() ?? {})).toBe(false);
    expect(scene()?.blocks.find((block) => block.id === "method-body")).not.toHaveProperty("sourceIds");
    store.session.undo();
    expect(scene()?.sources).toHaveLength(1);
    expect(scene()?.blocks.find((block) => block.id === "method-body")).toHaveProperty("sourceIds", [id]);
  });

  it("is where a text's Cite chip sends you when the scene has no sources", () => {
    const body = host.querySelector<HTMLElement>(
      "[data-id='method-body'] [data-edit], [data-id='method-body'][data-edit]",
    );
    body?.focus();
    host.querySelector<HTMLButtonElement>(".ed-toolbar [data-tb='cite']")?.click();
    host.querySelector<HTMLButtonElement>(".ed-toolbar [data-tb='open-sources']")?.click();
    expect(pop().hidden).toBe(false);
    expect(section("sources").open).toBe(true);
    expect(has("panel:source:add")).toBe(true);
    expect(host.querySelector<HTMLElement>(".ed-toolbar .ed-tb-pop:not([hidden])")).toBeNull();
  });
});
