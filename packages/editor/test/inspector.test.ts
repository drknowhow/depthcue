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

async function mount(setup?: (server: FakeServer) => void) {
  server = new FakeServer();
  setup?.(server);
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
}

beforeEach(() => mount());
afterEach(() => editor.destroy());

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
const field = <T extends Control = HTMLInputElement>(key: string): T => {
  const found = host.querySelector<T>(`[data-field="${key}"]`);
  if (!found) throw new Error(`no control with data-field ${key}`);
  return found;
};
const hasField = (key: string) => host.querySelector(`[data-field="${key}"]`) !== null;

function typeInto(node: HTMLInputElement | HTMLTextAreaElement, text: string) {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}
function choose(node: HTMLSelectElement, value: string) {
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
}
function tick(node: HTMLInputElement, on: boolean) {
  node.checked = on;
  node.dispatchEvent(new Event("change", { bubbles: true }));
}
function chooseFile(key: string, file: File) {
  const input = field(key);
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const doc = () => store.session.doc;
const scene = (id: string) => doc().scenes[id];
/** Whether the object has the key. Throws on a missing object, so a vanished block fails loudly. */
const has = (value: object | undefined, key: string): boolean => {
  if (!value) throw new Error(`Expected an object to look for "${key}" in.`);
  return key in value;
};
const sceneEl = (id: string) => host.querySelector<HTMLElement>(`[data-scene="${id}"]`) as HTMLElement;
const goTo = (id: string) => sceneEl(id).click();
const problems = () =>
  [...host.querySelectorAll<HTMLElement>(".ed-problem:not([hidden])")].map((node) => node.textContent);
const blockIds = (id: string) => scene(id)?.blocks.map((block) => block.id);
const opening = () => scene("opening");
const section = (name: string) =>
  host.querySelector<HTMLDetailsElement>(`.ed-inspector [data-section="${name}"]`) as HTMLDetailsElement;

describe("the scene form", () => {
  it("shows the scene's own properties", () => {
    expect(field("scene:title").value).toBe("Why channel B now leads");
    expect(field<HTMLSelectElement>("scene:layout").value).toBe("title");
    expect(field<HTMLSelectElement>("scene:lead").value).toBe("human");
    expect(field<HTMLTextAreaElement>("scene:notes").value).toBe(
      "Open with the answer, then show the evidence.",
    );
    expect(field<HTMLTextAreaElement>("scene:reading").value).toMatch(/^This deck explains why channel B/);
    goTo("demand");
    expect(field("scene:title").value).toBe("Demand is shifting");
    expect(field<HTMLSelectElement>("scene:lead").value).toBe("agent");
  });

  it("applies typing as it happens, in one undo step, without rebuilding the field under the caret", () => {
    const input = field("scene:title");
    typeInto(input, "A");
    typeInto(input, "AB");
    typeInto(input, "ABC");
    expect(opening()?.title).toBe("ABC");
    expect(field("scene:title")).toBe(input);
    expect(sceneEl("opening").textContent).toContain("ABC");
    store.session.undo();
    expect(opening()?.title).toBe("Why channel B now leads");
    expect(store.session.canUndo).toBe(false);
  });

  it("separates two visits to a field into two undo steps", () => {
    const input = field("scene:title");
    typeInto(input, "First");
    input.blur();
    typeInto(field("scene:title"), "Second");
    store.session.undo();
    expect(opening()?.title).toBe("First");
  });

  it("refuses an empty title with the core's message, keeps the deck, and shows the real title again on blur", () => {
    const input = field("scene:title");
    typeInto(input, "");
    expect(opening()?.title).toBe("Why channel B now leads");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const message = input.closest(".ed-field")?.querySelector<HTMLElement>(".ed-problem");
    expect(message?.hidden).toBe(false);
    expect(message?.textContent).toMatch(/\S/);
    expect(input.getAttribute("aria-describedby")).toBe(message?.id);
    input.dispatchEvent(new Event("blur"));
    expect(input.value).toBe("Why channel B now leads");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(message?.hidden).toBe(true);
  });

  it("clears the problem as soon as the text is acceptable again", () => {
    const input = field("scene:title");
    typeInto(input, "");
    typeInto(input, "Back");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(opening()?.title).toBe("Back");
  });

  it("changes the layout and who leads, and removes the lead when it is set back to none", () => {
    choose(field<HTMLSelectElement>("scene:layout"), "text-media");
    expect(opening()?.layout).toBe("text-media");
    choose(field<HTMLSelectElement>("scene:lead"), "shared");
    expect(opening()?.lead).toBe("shared");
    expect(sceneEl("opening").querySelector<HTMLElement>(".ed-lead")?.dataset.lead).toBe("shared");
    choose(field<HTMLSelectElement>("scene:lead"), "");
    expect(opening() && "lead" in (opening() as object)).toBe(false);
  });

  it("sets and clears the speaker notes and the reading version, which are optional", () => {
    typeInto(field<HTMLTextAreaElement>("scene:notes"), "New notes");
    expect(opening()?.notes).toBe("New notes");
    typeInto(field<HTMLTextAreaElement>("scene:notes"), "");
    expect(opening() && "notes" in (opening() as object)).toBe(false);
    typeInto(field<HTMLTextAreaElement>("scene:reading"), "Plain words.");
    expect(opening()?.reading).toEqual({ text: "Plain words." });
    typeInto(field<HTMLTextAreaElement>("scene:reading"), "");
    expect(opening() && "reading" in (opening() as object)).toBe(false);
  });

  it("refuses text over the limit and says so", () => {
    typeInto(field<HTMLTextAreaElement>("scene:notes"), "x".repeat(4001));
    expect(opening()?.notes).toBe("Open with the answer, then show the evidence.");
    expect(field("scene:notes").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the focused control focused after a choice redraws the form", () => {
    const layout = field<HTMLSelectElement>("scene:layout");
    layout.focus();
    choose(layout, "text-media");
    expect(field("scene:layout")).not.toBe(layout);
    expect(document.activeElement).toBe(field("scene:layout"));
  });

  it("moves the scene up and down, and disables the ends", () => {
    expect(field<HTMLButtonElement>("scene:up").disabled).toBe(true);
    field<HTMLButtonElement>("scene:down").click();
    expect(doc().deck.scenes).toEqual(["demand", "opening", "method"]);
    expect(editor.sceneId).toBe("opening");
    field<HTMLButtonElement>("scene:down").click();
    expect(doc().deck.scenes).toEqual(["demand", "method", "opening"]);
    expect(field<HTMLButtonElement>("scene:down").disabled).toBe(true);
    field<HTMLButtonElement>("scene:up").click();
    expect(doc().deck.scenes).toEqual(["demand", "opening", "method"]);
    store.session.undo();
    expect(doc().deck.scenes).toEqual(["demand", "method", "opening"]);
  });

  it("removes the scene and moves to its neighbour; the last scene cannot be removed", () => {
    goTo("demand");
    field<HTMLButtonElement>("scene:remove").click();
    expect(doc().deck.scenes).toEqual(["opening", "method"]);
    expect(editor.sceneId).toBe("method");
    field<HTMLButtonElement>("scene:remove").click();
    expect(editor.sceneId).toBe("opening");
    expect(doc().deck.scenes).toEqual(["opening"]);
    expect(field<HTMLButtonElement>("scene:remove").disabled).toBe(true);
  });

  it("moves to the previous scene when the last one is removed", () => {
    goTo("method");
    field<HTMLButtonElement>("scene:remove").click();
    expect(editor.sceneId).toBe("demand");
  });
});

describe("the deck form", () => {
  it("edits the title, which the bar follows", () => {
    section("deck").open = true;
    typeInto(field("deck:title"), "A new title");
    expect(doc().deck.title).toBe("A new title");
    expect(host.querySelector(".ed-deck")?.textContent).toBe("A new title");
    expect(field("deck:title").getAttribute("aria-invalid")).toBeNull();
  });

  it("refuses a language that is not a language tag", () => {
    typeInto(field("deck:language"), "Not A Tag");
    expect(doc().deck.language).toBe("en");
    expect(field("deck:language").getAttribute("aria-invalid")).toBe("true");
    typeInto(field("deck:language"), "pt-BR");
    expect(doc().deck.language).toBe("pt-BR");
  });

  it("switches the theme, which the preview follows", () => {
    choose(field<HTMLSelectElement>("deck:theme"), "ink");
    expect(doc().deck.theme).toBe("ink");
    expect(host.querySelector(".ed-frame")?.getAttribute("data-theme")).toBe("ink");
  });

  describe("module settings", () => {
    const modules = () => doc().deck.modules;
    const setModules = (value: Record<string, string> | null) =>
      store.session.apply([{ op: "deck.set", set: { modules: value } }]);

    it("lists each installed module by its title, on Automatic until the deck says otherwise", () => {
      const select = field<HTMLSelectElement>("deck:module:chart");
      expect(select.value).toBe("");
      expect([...select.options].map((option) => option.textContent)).toEqual([
        "Automatic",
        "Off: show it as a plain chart",
        "Needs version 1.0 or newer",
      ]);
      expect(select.closest("label")?.textContent).toContain("Explorable charts");
      expect(modules()).toBeUndefined();
    });

    it("says what each module's block falls back to, in the module's own words", () => {
      const clip = field<HTMLSelectElement>("deck:module:clip");
      expect(clip.closest("label")?.textContent).toContain("Clip cue points");
      expect([...clip.options].map((option) => option.textContent)).toEqual([
        "Automatic",
        "Off: show it as a plain video",
        "Needs version 1.0 or newer",
      ]);
    });

    it("turns a module off, pins its version, and goes back to Automatic", () => {
      const select = () => field<HTMLSelectElement>("deck:module:chart");
      choose(select(), "off");
      expect(modules()).toEqual({ chart: "off" });
      expect(select().value).toBe("off");
      choose(select(), "1.0");
      expect(modules()).toEqual({ chart: "1.0" });
      choose(select(), "");
      expect(modules()).toBeUndefined();
      expect(has(doc().deck, "modules")).toBe(false);
    });

    it("undoes a change as one step", () => {
      choose(field<HTMLSelectElement>("deck:module:chart"), "off");
      store.session.undo();
      expect(modules()).toBeUndefined();
      expect(field<HTMLSelectElement>("deck:module:chart").value).toBe("");
    });

    it("keeps the other modules' settings when one changes", () => {
      setModules({ chart: "off", mystery: "2" });
      choose(field<HTMLSelectElement>("deck:module:chart"), "");
      expect(modules()).toEqual({ mystery: "2" });
      choose(field<HTMLSelectElement>("deck:module:chart"), "1.0");
      expect(modules()).toEqual({ mystery: "2", chart: "1.0" });
    });

    it("still shows a pinned version the list does not offer", () => {
      setModules({ chart: "1" });
      const select = field<HTMLSelectElement>("deck:module:chart");
      expect(select.value).toBe("1");
      expect([...select.options].map((option) => option.value)).toContain("1");
    });

    it("says when a deck names a module that is not installed, and removes just that setting", () => {
      setModules({ chart: "off", mystery: "2" });
      const note = host.querySelector<HTMLElement>("[data-module='mystery']");
      expect(note?.textContent).toContain("mystery (2) is not installed here");
      field<HTMLButtonElement>("deck:module:mystery:remove").click();
      expect(modules()).toEqual({ chart: "off" });
      expect(host.querySelector("[data-module='mystery']")).toBeNull();
    });

    it("clears the property when the last setting goes", () => {
      setModules({ mystery: "2" });
      field<HTMLButtonElement>("deck:module:mystery:remove").click();
      expect(has(doc().deck, "modules")).toBe(false);
    });

    it("names the remove button for a screen reader", () => {
      setModules({ mystery: "2" });
      expect(field<HTMLButtonElement>("deck:module:mystery:remove").getAttribute("aria-label")).toBe(
        "Remove the setting for mystery",
      );
    });

    it("does not list an installed module as missing", () => {
      setModules({ chart: "off" });
      expect(host.querySelector("[data-module='chart']")).toBeNull();
    });
  });

  it("saves what the forms changed to the files", async () => {
    choose(field<HTMLSelectElement>("deck:theme"), "ink");
    typeInto(field("scene:title"), "Saved from the form");
    await store.save();
    expect(JSON.parse(server.text["deck.json"] as string).theme).toBe("ink");
    expect(JSON.parse(server.text["scenes/opening.json"] as string).title).toBe("Saved from the form");
  });
});

describe("the claim form", () => {
  beforeEach(() => goTo("demand"));

  it("edits the claim's text on the slide as well", () => {
    typeInto(field<HTMLTextAreaElement>("claim:text"), "A different claim.");
    expect(scene("demand")?.summary?.text).toBe("A different claim.");
    expect(scene("demand")?.summary?.evidenceIds).toEqual(["chart-demand"]);
    expect(host.querySelector(".dc-claim")?.textContent).toBe("A different claim.");
  });

  it("lists the blocks as evidence, with the cited one ticked", () => {
    expect(field("claim:evidence:chart-demand").checked).toBe(true);
  });

  it("changes the evidence, and says so when there is none to choose", () => {
    tick(field("claim:evidence:chart-demand"), false);
    expect(scene("demand")?.summary?.evidenceIds).toEqual([]);
    tick(field("claim:evidence:chart-demand"), true);
    expect(scene("demand")?.summary?.evidenceIds).toEqual(["chart-demand"]);
  });

  it("removes the claim together with the step that revealed it, in one undo step", () => {
    field<HTMLButtonElement>("claim:remove").click();
    expect(scene("demand")?.summary).toBeUndefined();
    expect(scene("demand")?.steps).toEqual([{ id: "show-evidence", reveal: ["chart-demand"] }]);
    expect(hasField("claim:add")).toBe(true);
    store.session.undo();
    expect(scene("demand")?.summary?.id).toBe("claim-shift");
    expect(scene("demand")?.steps).toHaveLength(2);
    expect(store.session.canUndo).toBe(false);
  });

  it("adds a claim to a scene that has none, citing nothing yet", () => {
    goTo("opening");
    expect(hasField("claim:text")).toBe(false);
    field<HTMLButtonElement>("claim:add").click();
    expect(opening()?.summary).toEqual({
      id: "opening-claim",
      text: "State the claim here.",
      evidenceIds: [],
    });
    expect(field<HTMLTextAreaElement>("claim:text").value).toBe("State the claim here.");
    expect(field("claim:evidence:opening-title").checked).toBe(false);
  });
});

describe("the block list", () => {
  beforeEach(() => goTo("method"));
  const pressed = () =>
    [...host.querySelectorAll<HTMLElement>(".ed-pick")]
      .filter((node) => node.getAttribute("aria-pressed") === "true")
      .map((node) => node.dataset.field);

  it("lists the blocks in order, each described", () => {
    const labels = [...host.querySelectorAll(".ed-pick")].map((node) => node.textContent);
    expect(labels[0]).toMatch(/^Heading: Same period/);
    expect(labels[2]).toMatch(/^Image: Diagram/);
  });

  it("starts with nothing selected and no block form", () => {
    expect(editor.blockId).toBeUndefined();
    expect(section("block")).toBeNull();
    expect(host.querySelector("[data-selected]")).toBeNull();
  });

  it("selects a block from the list, shows its form, and marks it on the slide", () => {
    const pick = field<HTMLButtonElement>("pick:method-body");
    pick.focus();
    pick.click();
    expect(editor.blockId).toBe("method-body");
    expect(pressed()).toEqual(["pick:method-body"]);
    expect(section("block").open).toBe(true);
    expect(host.querySelector<HTMLElement>("[data-selected]")?.dataset.id).toBe("method-body");
    expect(document.activeElement).toBe(field("pick:method-body"));
  });

  it("opens the block's form again for the next block, even if it was closed for the last one", () => {
    field<HTMLButtonElement>("pick:method-body").click();
    section("block").open = false;
    field<HTMLButtonElement>("pick:method-heading").click();
    expect(section("block").open).toBe(true);
  });

  it("selects the claim when it is focused, and shows no block form since the claim is not a block", () => {
    goTo("demand");
    host.querySelector<HTMLElement>(".ed-frame [data-id='chart-demand']")?.click();
    expect(editor.blockId).toBe("chart-demand");
    host.querySelector<HTMLElement>("[data-id='claim-shift'][data-edit]")?.focus();
    expect(editor.blockId).toBe("claim-shift");
    expect(section("block")).toBeNull();
  });

  it("selects the block whose text is focused on the slide", () => {
    host.querySelector<HTMLElement>("[data-id='method-heading'][data-edit]")?.focus();
    expect(editor.blockId).toBe("method-heading");
    expect(pressed()).toEqual(["pick:method-heading"]);
  });

  it("selects an image from the slide by clicking it, and by pressing Enter on it", () => {
    host.querySelector<HTMLElement>("[data-id='method-diagram']")?.click();
    expect(editor.blockId).toBe("method-diagram");
    field<HTMLButtonElement>("pick:method-body").click();
    host
      .querySelector<HTMLElement>("[data-id='method-diagram']")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(editor.blockId).toBe("method-diagram");
  });

  it("forgets the selection when another scene is chosen, and when the block goes away", () => {
    field<HTMLButtonElement>("pick:method-body").click();
    goTo("demand");
    expect(editor.blockId).toBeUndefined();
    goTo("method");
    field<HTMLButtonElement>("pick:method-body").click();
    field<HTMLButtonElement>("remove:method-body").click();
    expect(editor.blockId).toBeUndefined();
    expect(section("block")).toBeNull();
  });

  it("moves blocks up and down, with the ends disabled, as single undo steps", () => {
    expect(field<HTMLButtonElement>("up:method-heading").disabled).toBe(true);
    expect(field<HTMLButtonElement>("down:method-diagram").disabled).toBe(true);
    field<HTMLButtonElement>("down:method-heading").click();
    expect(blockIds("method")).toEqual(["method-body", "method-heading", "method-diagram"]);
    field<HTMLButtonElement>("up:method-diagram").click();
    expect(blockIds("method")).toEqual(["method-body", "method-diagram", "method-heading"]);
    field<HTMLButtonElement>("up:method-diagram").click();
    expect(blockIds("method")).toEqual(["method-diagram", "method-body", "method-heading"]);
    store.session.undo();
    expect(blockIds("method")).toEqual(["method-body", "method-diagram", "method-heading"]);
  });

  it("keeps the focus on the button that was pressed after the list is redrawn", () => {
    const down = field<HTMLButtonElement>("down:method-heading");
    down.focus();
    down.click();
    expect(document.activeElement).toBe(field("down:method-heading"));
  });

  it("removes a block", () => {
    field<HTMLButtonElement>("remove:method-body").click();
    expect(blockIds("method")).toEqual(["method-heading", "method-diagram"]);
  });

  it("will not remove the only block, and says why", () => {
    field<HTMLButtonElement>("remove:method-body").click();
    field<HTMLButtonElement>("remove:method-heading").click();
    field<HTMLButtonElement>("remove:method-diagram").click();
    expect(blockIds("method")).toEqual(["method-diagram"]);
    expect(problems()).toHaveLength(1);
    expect(problems()[0]).toMatch(/\S/);
  });

  it("cleans the claim and steps that pointed at a removed block, in the same undo step", () => {
    goTo("demand");
    field<HTMLButtonElement>("add:text").click();
    field<HTMLButtonElement>("remove:chart-demand").click();
    const demand = scene("demand");
    expect(demand?.blocks).toHaveLength(1);
    expect(demand?.summary?.evidenceIds).toEqual([]);
    expect(demand?.steps).toEqual([{ id: "show-claim", reveal: ["claim-shift"] }]);
    store.session.undo();
    expect(scene("demand")?.blocks.map((block) => block.id)).toContain("chart-demand");
    expect(scene("demand")?.steps).toHaveLength(2);
    expect(scene("demand")?.summary?.evidenceIds).toEqual(["chart-demand"]);
  });
});

describe("adding blocks", () => {
  beforeEach(() => goTo("method"));

  it("adds a text block after the selected one and selects it", () => {
    field<HTMLButtonElement>("pick:method-heading").click();
    field<HTMLButtonElement>("add:text").click();
    expect(blockIds("method")).toEqual(["method-heading", "method-text", "method-body", "method-diagram"]);
    expect(editor.blockId).toBe("method-text");
    expect(host.querySelector<HTMLElement>("[data-selected]")?.dataset.id).toBe("method-text");
  });

  it("adds at the end when nothing is selected, with a fresh id each time", () => {
    field<HTMLButtonElement>("add:text").click();
    field<HTMLButtonElement>("pick:method-heading").click();
    field<HTMLButtonElement>("add:text").click();
    const ids = blockIds("method") as string[];
    expect(ids.at(-1)).toBe("method-text");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("adds a chart with two rows to edit", () => {
    field<HTMLButtonElement>("add:bar-chart").click();
    expect(scene("method")?.blocks.at(-1)?.type).toBe("bar-chart");
    expect(hasField("block:method-chart:row0:value")).toBe(true);
    expect(hasField("block:method-chart:row1:value")).toBe(true);
  });

  it("uploads a file and adds it as an image block, with alt text from its name", async () => {
    chooseFile("add:image", new File(["x"], "Sales Chart.png", { type: "image/png" }));
    await flush();
    expect(server.uploads).toEqual(["assets/sales-chart.png"]);
    const added = scene("method")?.blocks.at(-1);
    expect(added?.type).toBe("image");
    expect(added?.type === "image" && added.asset).toBe("assets/sales-chart.png");
    expect(added?.type === "image" && added.alt).toBe("sales chart");
    expect(editor.blockId).toBe(added?.id);
    expect(store.session.doc.assets.has("assets/sales-chart.png")).toBe(true);
  });

  it("lets the same file be chosen again, by clearing the file input after each choice", async () => {
    const input = field("add:image");
    const sets: unknown[] = [];
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: (value) => void sets.push(value),
    });
    chooseFile("add:image", new File(["x"], "again.png", { type: "image/png" }));
    await flush();
    expect(sets).toContain("");
    chooseFile("add:image", new File(["x"], "again.png", { type: "image/png" }));
    await flush();
    expect(blockIds("method")?.filter((id) => id.startsWith("method-image"))).toHaveLength(2);
  });

  it("clears an upload problem as soon as the deck changes in another way", async () => {
    server.uploadAsset = async () => {
      throw new Error("Nope.");
    };
    chooseFile("add:image", new File(["x"], "a.png", { type: "image/png" }));
    await flush();
    expect(problems()).toEqual(["Nope."]);
    store.session.apply([{ op: "scene.set", id: "method", set: { lead: "agent" } }]);
    expect(problems()).toEqual([]);
  });

  it("shows why an upload failed, and adds nothing", async () => {
    server.uploadAsset = async () => {
      throw new Error("That file is not an image the editor accepts.");
    };
    const before = blockIds("method");
    chooseFile("add:image", new File(["x"], "notes.txt", { type: "text/plain" }));
    await flush();
    expect(blockIds("method")).toEqual(before);
    expect(problems()).toEqual(["That file is not an image the editor accepts."]);
  });

  it("cannot add a clip until the deck has a video file", () => {
    expect(field<HTMLButtonElement>("add:clip").disabled).toBe(true);
    expect(field<HTMLButtonElement>("add:clip").title).toMatch(/assets/);
  });

  it("stops at twelve blocks and says so, leaving the scene as it was", () => {
    for (let i = 0; i < 9; i += 1) field<HTMLButtonElement>("add:text").click();
    expect(blockIds("method")).toHaveLength(12);
    expect(problems()).toEqual([]);
    field<HTMLButtonElement>("add:text").click();
    expect(blockIds("method")).toHaveLength(12);
    expect(problems()).toHaveLength(1);
  });

  it("clears an earlier problem once something succeeds", () => {
    for (let i = 0; i < 10; i += 1) field<HTMLButtonElement>("add:text").click();
    expect(problems()).toHaveLength(1);
    field<HTMLButtonElement>("remove:method-text").click();
    expect(problems()).toEqual([]);
  });
});

describe("adding a clip", () => {
  it("adds one that plays the first video in the deck", async () => {
    editor.destroy();
    await mount((s) => s.assets.push("assets/talk.mp4", "assets/other.webm"));
    goTo("method");
    expect(field<HTMLButtonElement>("add:clip").disabled).toBe(false);
    field<HTMLButtonElement>("add:clip").click();
    const clip = scene("method")?.blocks.at(-1);
    expect(clip?.type).toBe("clip");
    expect(clip?.type === "clip" && clip.source).toBe("assets/other.webm");
    expect(clip?.type === "clip" && clip.alt).toBe("other");
    const source = field<HTMLSelectElement>(`block:${clip?.id}:source`);
    expect([...source.options].map((option) => option.value)).toEqual([
      "assets/other.webm",
      "assets/talk.mp4",
    ]);
  });
});

describe("a text block's form", () => {
  beforeEach(() => {
    goTo("method");
    field<HTMLButtonElement>("pick:method-body").click();
  });

  it("edits the text, and the slide shows it", () => {
    typeInto(field<HTMLTextAreaElement>("block:method-body:text"), "Shorter.");
    expect(scene("method")?.blocks[1]).toMatchObject({ text: "Shorter." });
    expect(host.querySelector("[data-id='method-body']")?.textContent).toBe("Shorter.");
  });

  it("refuses empty text with a message under the field", () => {
    const area = field<HTMLTextAreaElement>("block:method-body:text");
    typeInto(area, "");
    expect(scene("method")?.blocks[1]).toMatchObject({ text: expect.stringMatching(/^Each order/) });
    expect(area.getAttribute("aria-invalid")).toBe("true");
  });

  it("changes the role, and refuses a role whose limit the text exceeds, putting the choice back", () => {
    const role = field<HTMLSelectElement>("block:method-body:role");
    choose(role, "quote");
    expect(scene("method")?.blocks[1]).toMatchObject({ role: "quote" });
    choose(field<HTMLSelectElement>("block:method-body:role"), "heading");
    expect(scene("method")?.blocks[1]).toMatchObject({ role: "quote" });
    expect(field<HTMLSelectElement>("block:method-body:role").value).toBe("quote");
    expect(problems()).toHaveLength(1);
  });
});

describe("an image block's form", () => {
  beforeEach(() => {
    goTo("method");
    field<HTMLButtonElement>("pick:method-diagram").click();
  });

  it("offers only the image files in the deck", () => {
    const select = field<HTMLSelectElement>("block:method-diagram:asset");
    expect([...select.options].map((option) => option.value)).toEqual(["assets/method.svg"]);
  });

  it("keeps showing a file that is no longer in the deck rather than hiding it", () => {
    store.session.reset({ ...doc(), assets: new Set(["assets/report.csv"]) });
    const select = field<HTMLSelectElement>("block:method-diagram:asset");
    expect(select.value).toBe("assets/method.svg");
  });

  it("changes the file to another image", () => {
    server.assets.push("assets/second.png");
    store.session.addAssets(["assets/second.png"]);
    choose(field<HTMLSelectElement>("block:method-diagram:asset"), "assets/second.png");
    expect(scene("method")?.blocks[2]).toMatchObject({ asset: "assets/second.png" });
  });

  it("uploads a replacement image and uses it", async () => {
    chooseFile("block:method-diagram:upload", new File(["x"], "new.png", { type: "image/png" }));
    await flush();
    expect(scene("method")?.blocks[2]).toMatchObject({ asset: "assets/new.png" });
  });

  it("requires alt text and allows the caption to be cleared", () => {
    typeInto(field("block:method-diagram:alt"), "");
    expect(scene("method")?.blocks[2]).toMatchObject({ alt: expect.stringMatching(/^Diagram/) });
    expect(field("block:method-diagram:alt").getAttribute("aria-invalid")).toBe("true");
    typeInto(field("block:method-diagram:alt"), "New alt");
    expect(scene("method")?.blocks[2]).toMatchObject({ alt: "New alt" });
    typeInto(field("block:method-diagram:caption"), "");
    expect(has(scene("method")?.blocks[2], "caption")).toBe(false);
    typeInto(field("block:method-diagram:caption"), "A caption");
    expect(scene("method")?.blocks[2]).toMatchObject({ caption: "A caption" });
  });
});

describe("a chart block's form", () => {
  beforeEach(() => {
    goTo("demand");
    field<HTMLButtonElement>("pick:chart-demand").click();
  });
  const rows = () => {
    const chart = scene("demand")?.blocks[0];
    return chart?.type === "bar-chart" ? chart.data : [];
  };

  it("names each row's boxes for a screen reader, since they have no visible label", () => {
    expect(field("block:chart-demand:row0:label").getAttribute("aria-label")).toBe("Row 1 label");
    expect(field("block:chart-demand:row1:value").getAttribute("aria-label")).toBe("Row 2 value");
  });

  it("shows each row's label and value", () => {
    expect(field("block:chart-demand:row0:label").value).toBe("Channel A");
    expect(field("block:chart-demand:row1:value").value).toBe("60");
  });

  it("changes a value, and the bar on the slide follows", () => {
    typeInto(field("block:chart-demand:row1:value"), "75");
    expect(rows()[1]).toEqual({ label: "Channel B", value: 75 });
    expect(host.querySelector(".dc-chart")?.textContent).toContain("75%");
  });

  it("accepts a decimal and a negative value", () => {
    typeInto(field("block:chart-demand:row0:value"), "-2.5");
    expect(rows()[0]?.value).toBe(-2.5);
  });

  it("refuses something that is not a number, and puts the old value back", () => {
    const input = field("block:chart-demand:row0:value");
    typeInto(input, "abc");
    expect(rows()[0]?.value).toBe(40);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.closest(".ed-cell")?.querySelector(".ed-problem")?.textContent).toBe("Enter a number.");
    input.dispatchEvent(new Event("blur"));
    expect(input.value).toBe("40");
    typeInto(input, "");
    expect(rows()[0]?.value).toBe(40);
  });

  it("changes a label, refusing an empty one", () => {
    typeInto(field("block:chart-demand:row0:label"), "Direct");
    expect(rows()[0]?.label).toBe("Direct");
    typeInto(field("block:chart-demand:row0:label"), "");
    expect(rows()[0]?.label).toBe("Direct");
    expect(field("block:chart-demand:row0:label").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps typing in a value as one undo step", () => {
    const input = field("block:chart-demand:row0:value");
    typeInto(input, "4");
    typeInto(input, "45");
    typeInto(input, "450");
    expect(rows()[0]?.value).toBe(450);
    store.session.undo();
    expect(rows()[0]?.value).toBe(40);
  });

  it("adds a row and removes one, but never the last", () => {
    field<HTMLButtonElement>("block:chart-demand:addrow").click();
    expect(rows()).toHaveLength(3);
    expect(rows()[2]).toEqual({ label: "Item 3", value: 0 });
    field<HTMLButtonElement>("block:chart-demand:row0:remove").click();
    expect(rows().map((row) => row.label)).toEqual(["Channel B", "Item 3"]);
    field<HTMLButtonElement>("block:chart-demand:row0:remove").click();
    expect(rows()).toHaveLength(1);
    expect(field<HTMLButtonElement>("block:chart-demand:row0:remove").disabled).toBe(true);
  });

  it("stops at twenty-four rows and says so", () => {
    for (let i = 0; i < 22; i += 1) field<HTMLButtonElement>("block:chart-demand:addrow").click();
    expect(rows()).toHaveLength(24);
    expect(problems()).toEqual([]);
    field<HTMLButtonElement>("block:chart-demand:addrow").click();
    expect(rows()).toHaveLength(24);
    expect(problems()).toHaveLength(1);
  });

  it("sets and clears the title and unit", () => {
    typeInto(field("block:chart-demand:title"), "New title");
    expect(scene("demand")?.blocks[0]).toMatchObject({ title: "New title" });
    typeInto(field("block:chart-demand:title"), "");
    expect(has(scene("demand")?.blocks[0], "title")).toBe(false);
    typeInto(field("block:chart-demand:unit"), "x".repeat(17));
    expect(scene("demand")?.blocks[0]).toMatchObject({ unit: "%" });
    typeInto(field("block:chart-demand:unit"), "pts");
    expect(scene("demand")?.blocks[0]).toMatchObject({ unit: "pts" });
  });

  it("chooses which sources the block cites", () => {
    expect(field("block:chart-demand:sources:source-report").checked).toBe(true);
    tick(field("block:chart-demand:sources:source-report"), false);
    expect(has(scene("demand")?.blocks[0], "sourceIds")).toBe(false);
    tick(field("block:chart-demand:sources:source-report"), true);
    expect(scene("demand")?.blocks[0]).toMatchObject({ sourceIds: ["source-report"] });
  });
});

describe("a clip block's form", () => {
  beforeEach(async () => {
    editor.destroy();
    await mount((s) => s.assets.push("assets/talk.mp4"));
    goTo("method");
    field<HTMLButtonElement>("add:clip").click();
  });

  it("chooses the poster from the images, and removes it again", () => {
    const id = editor.blockId as string;
    const poster = field<HTMLSelectElement>(`block:${id}:poster`);
    expect([...poster.options].map((option) => option.value)).toEqual(["", "assets/method.svg"]);
    choose(poster, "assets/method.svg");
    expect(scene("method")?.blocks.at(-1)).toMatchObject({ poster: "assets/method.svg" });
    choose(field<HTMLSelectElement>(`block:${id}:poster`), "");
    expect(has(scene("method")?.blocks.at(-1), "poster")).toBe(false);
  });

  it("requires alt text", () => {
    const id = editor.blockId as string;
    typeInto(field(`block:${id}:alt`), "");
    expect(scene("method")?.blocks.at(-1)).toMatchObject({ alt: "talk" });
    expect(field(`block:${id}:alt`).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("the steps form", () => {
  beforeEach(() => goTo("demand"));
  const steps = () => scene("demand")?.steps;

  it("shows each step with what it reveals ticked", () => {
    expect(field("step:show-claim:claim-shift").checked).toBe(true);
    expect(field("step:show-claim:chart-demand").checked).toBe(false);
    expect(field("step:show-evidence:chart-demand").checked).toBe(true);
  });

  it("changes what a step reveals", () => {
    tick(field("step:show-claim:chart-demand"), true);
    expect(steps()?.[0]?.reveal).toEqual(["claim-shift", "chart-demand"]);
  });

  it("refuses a step that would reveal nothing, and puts the tick back", () => {
    tick(field("step:show-claim:claim-shift"), false);
    expect(steps()?.[0]?.reveal).toEqual(["claim-shift"]);
    expect(field("step:show-claim:claim-shift").checked).toBe(true);
    const message = host.querySelector<HTMLElement>(
      ".ed-inspector [data-section='steps'] .ed-problem:not([hidden])",
    );
    expect(message?.textContent).toMatch(/\S/);
  });

  it("adds a step revealing the first thing no step reveals yet, or the first thing when all are", () => {
    field<HTMLButtonElement>("add:text").click();
    field<HTMLButtonElement>("step:add").click();
    expect(steps()).toHaveLength(3);
    expect(steps()?.[2]).toEqual({ id: "demand-step", reveal: ["demand-text"] });
    field<HTMLButtonElement>("step:add").click();
    expect(steps()?.[3]).toEqual({ id: "demand-step-2", reveal: ["claim-shift"] });
  });

  it("removes a step, and drops the property with the last one", () => {
    field<HTMLButtonElement>("step-remove:show-claim").click();
    expect(steps()).toEqual([{ id: "show-evidence", reveal: ["chart-demand"] }]);
    field<HTMLButtonElement>("step-remove:show-evidence").click();
    expect(steps()).toBeUndefined();
  });

  it("moves a step up and down, with the ends disabled", () => {
    expect(field<HTMLButtonElement>("step-up:show-claim").disabled).toBe(true);
    expect(field<HTMLButtonElement>("step-down:show-evidence").disabled).toBe(true);
    field<HTMLButtonElement>("step-down:show-claim").click();
    expect(steps()?.map((step) => step.id)).toEqual(["show-evidence", "show-claim"]);
    field<HTMLButtonElement>("step-up:show-claim").click();
    expect(steps()?.map((step) => step.id)).toEqual(["show-claim", "show-evidence"]);
  });

  it("explains what steps do, and lets a scene without any add its first", () => {
    goTo("opening");
    expect(section("steps").textContent).toContain("Each press");
    field<HTMLButtonElement>("step:add").click();
    expect(opening()?.steps).toEqual([{ id: "opening-step", reveal: ["opening-title"] }]);
  });
});

describe("the sources form", () => {
  beforeEach(() => goTo("demand"));
  const sources = () => scene("demand")?.sources;

  it("shows each source's title, link and file", () => {
    expect(field("source:source-report:title").value).toBe("Quarterly order snapshot");
    expect(field("source:source-report:url").value).toBe("");
    expect(field<HTMLSelectElement>("source:source-report:asset").value).toBe("assets/report.csv");
  });

  it("edits the title, refusing an empty one", () => {
    typeInto(field("source:source-report:title"), "Renamed");
    expect(sources()?.[0]?.title).toBe("Renamed");
    typeInto(field("source:source-report:title"), "");
    expect(sources()?.[0]?.title).toBe("Renamed");
    expect(field("source:source-report:title").getAttribute("aria-invalid")).toBe("true");
  });

  it("sets a link that starts with http, refuses one that does not, and removes it when cleared", () => {
    typeInto(field("source:source-report:url"), "https://example.com/report");
    expect(sources()?.[0]?.url).toBe("https://example.com/report");
    typeInto(field("source:source-report:url"), "ftp://example.com");
    expect(sources()?.[0]?.url).toBe("https://example.com/report");
    expect(field("source:source-report:url").getAttribute("aria-invalid")).toBe("true");
    typeInto(field("source:source-report:url"), "");
    expect(has(sources()?.[0], "url")).toBe(false);
  });

  it("points at another file, or at none", () => {
    choose(field<HTMLSelectElement>("source:source-report:asset"), "assets/method.svg");
    expect(sources()?.[0]?.asset).toBe("assets/method.svg");
    choose(field<HTMLSelectElement>("source:source-report:asset"), "");
    expect(has(sources()?.[0], "asset")).toBe(false);
  });

  it("adds a source with a fresh id", () => {
    field<HTMLButtonElement>("source:add").click();
    field<HTMLButtonElement>("source:add").click();
    expect(sources()?.map((source) => source.id)).toEqual([
      "source-report",
      "demand-source",
      "demand-source-2",
    ]);
    expect(sources()?.[1]?.title).toBe("New source");
  });

  it("removes a source and the citations of it", () => {
    field<HTMLButtonElement>("source-remove:source-report").click();
    expect(sources()).toBeUndefined();
    expect(has(scene("demand")?.blocks[0], "sourceIds")).toBe(false);
    store.session.undo();
    expect(sources()).toHaveLength(1);
    expect(scene("demand")?.blocks[0]).toMatchObject({ sourceIds: ["source-report"] });
  });
});

describe("the column as a whole", () => {
  it("remembers which sections are open across redraws", () => {
    expect(section("deck").open).toBe(false);
    section("deck").open = true;
    section("scene").open = false;
    typeInto(field("scene:notes"), "x");
    store.session.apply([{ op: "scene.set", id: "opening", set: { lead: "agent" } }]);
    expect(section("deck").open).toBe(true);
    expect(section("scene").open).toBe(false);
  });

  it("opens a section by itself when its scene has something in it, until the person decides", () => {
    expect(section("claim").open).toBe(false);
    goTo("demand");
    expect(section("claim").open).toBe(true);
    section("claim").open = false;
    goTo("opening");
    goTo("demand");
    expect(section("claim").open).toBe(false);
  });

  it("follows an edit made on the slide", () => {
    const heading = host.querySelector<HTMLElement>("[data-id='opening-title'][data-edit]") as HTMLElement;
    heading.focus();
    heading.textContent = "Typed on the slide";
    heading.dispatchEvent(new Event("input", { bubbles: true }));
    expect(field<HTMLTextAreaElement>("block:opening-title:text").value).toBe("Typed on the slide");
  });

  it("follows undo and redo", () => {
    typeInto(field("scene:title"), "Changed");
    store.session.undo();
    expect(field("scene:title").value).toBe("Why channel B now leads");
    store.session.redo();
    expect(field("scene:title").value).toBe("Changed");
  });

  it("follows the files when they change on disk", async () => {
    server.external([{ op: "scene.set", id: "opening", set: { title: "Changed elsewhere" } }]);
    await store.syncFromDisk();
    expect(field("scene:title").value).toBe("Changed elsewhere");
  });

  it("takes Ctrl+Z from inside a field and undoes the document, not the field", () => {
    const input = field("scene:title");
    typeInto(input, "Changed");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(opening()?.title).toBe("Why channel B now leads");
  });
});
