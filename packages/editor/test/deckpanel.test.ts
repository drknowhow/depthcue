// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FONT_PAIRS, memoryDraftStore, PALETTE_COLORS, PRESETS, styleOf } from "@depthcue/core";
import { firstPartyManifests } from "@depthcue/player";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { FONT_LABEL } from "../src/panels.ts";
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

describe("the Style section of the deck popover", () => {
  const pick = (name: string, value: string) => {
    const swatch = control(`panel:deck:palette:${name}`);
    swatch.focus();
    swatch.value = value;
    swatch.dispatchEvent(new Event("input", { bubbles: true }));
    return swatch;
  };
  const frame = () => host.querySelector<HTMLElement>(".ed-frame") as HTMLElement;
  const reset = (name: string) => control<HTMLButtonElement>(`panel:deck:palette:${name}:reset`);
  const choice = (pair: string) => control(`panel:deck:fonts:${pair}`);
  beforeEach(() => chip().click());

  it("holds the preset, a swatch for each of the seven palette colors and the four font pairs", () => {
    const section = pop().querySelector("details[data-section='style']");
    expect(section?.querySelector("summary")?.textContent).toBe("Style");
    expect(section?.contains(control("panel:deck:theme"))).toBe(true);
    for (const name of PALETTE_COLORS)
      expect(section?.contains(control(`panel:deck:palette:${name}`))).toBe(true);
    expect(PALETTE_COLORS).toHaveLength(7);
    expect(
      [...(section?.querySelectorAll("input[type='radio']") ?? [])].map(
        (radio) => (radio as HTMLInputElement).value,
      ),
    ).toEqual([...FONT_PAIRS]);
  });

  it("shows the color the deck is drawn with, the preset's until the palette names it, and no reset for it", () => {
    for (const name of PALETTE_COLORS) {
      expect(control(`panel:deck:palette:${name}`).value).toBe(styleOf(deck()).colors[name].toLowerCase());
      expect(reset(name).hidden).toBe(true);
    }
    choose(control<HTMLSelectElement>("panel:deck:theme"), "ink");
    expect(control("panel:deck:palette:bg").value).toBe(PRESETS.ink.bg.toLowerCase());
  });

  it("sets one palette color as it is picked, and the slide takes it", () => {
    pick("evidence", "#0044cc");
    expect(deck().palette).toEqual({ evidence: "#0044cc" });
    expect(frame().style.getPropertyValue("--dc-evidence")).toBe("#0044cc");
    expect(reset("evidence").hidden).toBe(false);
    expect(
      control("panel:deck:palette:evidence").closest(".ed-color")?.querySelector(".ed-color-hex")
        ?.textContent,
    ).toBe("#0044cc");
  });

  it("makes one undo step of a drag through the picker, and another of the next time it is opened", () => {
    const swatch = pick("evidence", "#0044cc");
    pick("evidence", "#0033bb");
    pick("evidence", "#0022aa");
    expect(deck().palette).toEqual({ evidence: "#0022aa" });
    swatch.dispatchEvent(new Event("change", { bubbles: true }));
    pick("evidence", "#001199");
    expect(deck().palette).toEqual({ evidence: "#001199" });
    store.session.undo();
    expect(deck().palette).toEqual({ evidence: "#0022aa" });
    store.session.undo();
    expect(deck()).not.toHaveProperty("palette");
  });

  it("keeps the other colors the palette names when one changes, and puts one back with its Reset", () => {
    pick("evidence", "#0044cc");
    pick("action", "#aa2200");
    expect(deck().palette).toEqual({ evidence: "#0044cc", action: "#aa2200" });
    reset("evidence").click();
    expect(deck().palette).toEqual({ action: "#aa2200" });
    expect(control("panel:deck:palette:evidence").value).toBe(PRESETS.paper.evidence.toLowerCase());
    reset("action").click();
    expect(deck()).not.toHaveProperty("palette");
    expect(frame().style.getPropertyValue("--dc-action")).toBe("");
  });

  it("puts every color back at once, and does nothing when none has been changed", () => {
    const before = store.session.canUndo;
    control<HTMLButtonElement>("panel:deck:palette:reset").click();
    expect(store.session.canUndo).toBe(before);
    pick("evidence", "#0044cc");
    pick("action", "#aa2200");
    control<HTMLButtonElement>("panel:deck:palette:reset").click();
    expect(deck()).not.toHaveProperty("palette");
  });

  it("refuses a color that leaves text hard to read: the deck keeps its palette and the problem is said twice", () => {
    pick("evidence", "#0044cc");
    const swatch = pick("text", "#f5f2ea");
    expect(deck().palette).toEqual({ evidence: "#0044cc" });
    expect(swatch.getAttribute("aria-invalid")).toBe("true");
    const said = swatch.closest(".ed-color")?.querySelector(".ed-problem") as HTMLElement;
    expect(said.hidden).toBe(false);
    expect(said.textContent).toMatch(/contrast/);
    expect(host.querySelector(".ed-hint")?.hasAttribute("data-problem")).toBe(true);
    // Closing the picker shows what the deck still has.
    swatch.dispatchEvent(new Event("change", { bubbles: true }));
    expect(swatch.value).toBe(PRESETS.paper.text.toLowerCase());
    expect(swatch.hasAttribute("aria-invalid")).toBe(false);
    expect(host.querySelector(".ed-hint")?.hasAttribute("data-problem")).toBe(false);
  });

  it("takes a dark background once the Ink preset is chosen first", () => {
    pick("bg", "#10141c");
    expect(deck()).not.toHaveProperty("palette");
    choose(control<HTMLSelectElement>("panel:deck:theme"), "ink");
    pick("bg", "#10141c");
    expect(deck().palette).toEqual({ bg: "#10141c" });
  });

  it("keeps the palette when the preset changes, so the swatch the person set stays set", () => {
    pick("line", "#888888");
    choose(control<HTMLSelectElement>("panel:deck:theme"), "ink");
    expect(deck().theme).toBe("ink");
    expect(deck().palette).toEqual({ line: "#888888" });
    expect(control("panel:deck:palette:line").value).toBe("#888888");
    expect(control("panel:deck:palette:bg").value).toBe(PRESETS.ink.bg.toLowerCase());
  });

  it("refuses a preset that the palette's colors would not be readable on, and says which color", () => {
    pick("evidence", "#0044cc");
    const select = control<HTMLSelectElement>("panel:deck:theme");
    choose(select, "ink");
    expect(deck().theme).toBe("paper");
    expect(select.value).toBe("paper");
    expect(select.closest(".ed-field")?.querySelector(".ed-problem")?.textContent).toMatch(/evidence/);
  });

  it("offers each font pair set in its own fonts, with the deck's pair chosen", () => {
    expect(choice("editorial").checked).toBe(true);
    for (const pair of FONT_PAIRS) {
      const row = choice(pair).closest("label");
      expect(row?.getAttribute("data-fonts")).toBe(pair);
      expect(row?.textContent).toContain(FONT_LABEL[pair].label);
    }
  });

  it("sets the font pair on a click, as one undo step, and the slide takes it", () => {
    choice("technical").click();
    expect(deck().fonts).toBe("technical");
    expect(frame().dataset.fonts).toBe("technical");
    expect(choice("technical").checked).toBe(true);
    store.session.undo();
    expect(deck()).not.toHaveProperty("fonts");
    expect(frame().hasAttribute("data-fonts")).toBe(false);
    expect(choice("editorial").checked).toBe(true);
  });

  it("is saved to the files", async () => {
    pick("evidence", "#0044cc");
    choice("classic").click();
    await store.save();
    const saved = JSON.parse(server.text["deck.json"] as string);
    expect(saved.palette).toEqual({ evidence: "#0044cc" });
    expect(saved.fonts).toBe("classic");
  });

  it("keeps the Style section open while the deck changes under it", () => {
    const section = pop().querySelector("details[data-section='style']") as HTMLDetailsElement;
    section.open = true;
    choice("modern").click();
    expect(pop().querySelector("details[data-section='style']")).toBe(section);
    expect(section.open).toBe(true);
  });

  it("opens from the Deck style command of the palette, with the keyboard in the section", () => {
    chip().click();
    expect(pop().hidden).toBe(true);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    (host.querySelector(".ed-palette [data-command='deck-style']") as HTMLElement).click();
    expect(pop().hidden).toBe(false);
    const section = pop().querySelector("details[data-section='style']") as HTMLDetailsElement;
    expect(section.open).toBe(true);
    expect(section.contains(document.activeElement)).toBe(true);
  });

  it("names every font pair after the fonts the font manifest puts in it", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../brand/fonts/manifest.json"), "utf8"),
    ) as { pairs: Record<string, { display: string; body: string }> };
    expect(Object.keys(manifest.pairs).sort()).toEqual([...FONT_PAIRS].sort());
    for (const pair of FONT_PAIRS) {
      const { display, body } = manifest.pairs[pair] as { display: string; body: string };
      for (const family of new Set([display, body])) {
        const shortName = family.replace(/ (4|3)$/, "");
        expect(FONT_LABEL[pair].detail, `${pair} should say ${family}`).toContain(shortName);
      }
    }
  });
});
