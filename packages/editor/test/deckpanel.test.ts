// @vitest-environment happy-dom

import { memoryDraftStore } from "@depthcue/core";
import { firstPartyManifests } from "@depthcue/player";
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
});
afterEach(() => editor.destroy());

const chip = () => host.querySelector<HTMLButtonElement>(".ed-actions [data-tb='deck']") as HTMLButtonElement;
const pop = () => chip().closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
const control = <T extends HTMLElement = HTMLInputElement>(key: string): T => {
  const found = pop().querySelector<T>(`[data-field="${key}"]`);
  if (!found) throw new Error(`no control with data-field ${key} in the deck popover`);
  return found;
};
const deck = () => store.session.doc.deck;
const typeInto = (node: HTMLInputElement, text: string) => {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};
const choose = (node: HTMLSelectElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
};
const first = firstPartyManifests[0] as (typeof firstPartyManifests)[number];

describe("the deck popover", () => {
  it("opens from a Deck chip in the top bar, with the deck's own settings", () => {
    expect(pop().hidden).toBe(true);
    chip().click();
    expect(pop().hidden).toBe(false);
    expect(control("panel:deck:title").value).toBe(deck().title);
    expect(control("panel:deck:language").value).toBe(deck().language);
    expect(control<HTMLSelectElement>("panel:deck:theme").value).toBe(deck().theme);
  });

  it("sets the title as it is typed, and the bar shows it", () => {
    chip().click();
    typeInto(control("panel:deck:title"), "Spring review");
    expect(deck().title).toBe("Spring review");
    expect(host.querySelector(".ed-deck")?.textContent).toBe("Spring review");
  });

  it("refuses an empty title or a language that is not a tag, and keeps the old value", () => {
    chip().click();
    const title = deck().title;
    typeInto(control("panel:deck:title"), "");
    expect(deck().title).toBe(title);
    expect(control("panel:deck:title").getAttribute("aria-invalid")).toBe("true");
    const language = deck().language;
    typeInto(control("panel:deck:language"), "not a tag!");
    expect(deck().language).toBe(language);
  });

  it("changes the language and the theme, each as one undo step", () => {
    chip().click();
    typeInto(control("panel:deck:language"), "pt-BR");
    expect(deck().language).toBe("pt-BR");
    choose(control<HTMLSelectElement>("panel:deck:theme"), "ink");
    expect(deck().theme).toBe("ink");
    store.session.undo();
    expect(deck().theme).not.toBe("ink");
  });

  it("keeps the field being typed in", () => {
    chip().click();
    const input = control("panel:deck:title");
    typeInto(input, "A");
    typeInto(input, "AB");
    expect(control("panel:deck:title")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("asks nothing of a module until it is told to, then turns it off or asks for a version", () => {
    chip().click();
    const select = () => control<HTMLSelectElement>(`panel:deck:module:${first.id}`);
    expect(select().value).toBe("");
    choose(select(), "off");
    expect(deck().modules).toEqual({ [first.id]: "off" });
    choose(select(), first.version);
    expect(deck().modules).toEqual({ [first.id]: first.version });
    choose(select(), "");
    expect(deck()).not.toHaveProperty("modules");
  });

  it("lists a setting for a module that is not installed, and removes it", () => {
    store.session.apply([{ op: "deck.set", set: { modules: { elsewhere: "1.0.0" } } }]);
    chip().click();
    expect(pop().querySelector("[data-module='elsewhere']")?.textContent).toContain("not installed");
    control<HTMLButtonElement>("panel:deck:module:elsewhere:remove").click();
    expect(deck()).not.toHaveProperty("modules");
  });

  it("closes with Escape and on a press elsewhere", () => {
    chip().click();
    control("panel:deck:title").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pop().hidden).toBe(true);
    expect(document.activeElement).toBe(chip());
    chip().click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop().hidden).toBe(true);
  });

  it("is saved to the files", async () => {
    chip().click();
    choose(control<HTMLSelectElement>("panel:deck:theme"), "ink");
    await store.save();
    expect(JSON.parse(server.text["deck.json"] as string).theme).toBe("ink");
  });
});

describe("module settings in the deck popover", () => {
  const modules = () => deck().modules;
  const setModules = (value: Record<string, string> | null) =>
    store.session.apply([{ op: "deck.set", set: { modules: value } }]);
  const select = (id: string) => control<HTMLSelectElement>(`panel:deck:module:${id}`);
  beforeEach(() => chip().click());

  it("lists each installed module by its title, on Automatic until the deck says otherwise", () => {
    expect(select("chart").value).toBe("");
    expect([...select("chart").options].map((option) => option.textContent)).toEqual([
      "Automatic",
      "Off: show it as a plain chart",
      "Needs version 1.0 or newer",
    ]);
    expect(select("chart").closest("label")?.textContent).toContain("Explorable charts");
    expect(modules()).toBeUndefined();
  });

  it("says what each module falls back to, in its own words", () => {
    expect(select("clip").closest("label")?.textContent).toContain("Clip cue points");
    expect([...select("clip").options].map((option) => option.textContent)).toEqual([
      "Automatic",
      "Off: show it as a plain video",
      "Needs version 1.0 or newer",
    ]);
  });

  it("undoes a change as one step", () => {
    choose(select("chart"), "off");
    store.session.undo();
    expect(modules()).toBeUndefined();
    expect(select("chart").value).toBe("");
  });

  it("keeps the other modules settings when one changes", () => {
    setModules({ chart: "off", mystery: "2" });
    choose(select("chart"), "");
    expect(modules()).toEqual({ mystery: "2" });
    choose(select("chart"), "1.0");
    expect(modules()).toEqual({ mystery: "2", chart: "1.0" });
  });

  it("still shows a pinned version the list does not offer", () => {
    setModules({ chart: "1" });
    expect(select("chart").value).toBe("1");
    expect([...select("chart").options].map((option) => option.value)).toContain("1");
  });

  it("removes just the setting of a module that is not installed, and names its button", () => {
    setModules({ chart: "off", mystery: "2" });
    expect(pop().querySelector("[data-module='mystery']")?.textContent).toContain(
      "mystery (2) is not installed here",
    );
    const remove = control<HTMLButtonElement>("panel:deck:module:mystery:remove");
    expect(remove.getAttribute("aria-label")).toBe("Remove the setting for mystery");
    remove.click();
    expect(modules()).toEqual({ chart: "off" });
    expect(pop().querySelector("[data-module='mystery']")).toBeNull();
  });

  it("does not list an installed module as missing", () => {
    setModules({ chart: "off" });
    expect(pop().querySelector("[data-module='chart']")).toBeNull();
  });
});
