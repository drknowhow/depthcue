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
});
afterEach(() => editor.destroy());

const popOf = (selector: string) => {
  const chip = host.querySelector<HTMLButtonElement>(selector) as HTMLButtonElement;
  chip.click();
  return chip.closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
};
const deckPop = () => popOf(".ed-bar-deck [data-tb='deck']");
const control = <T extends HTMLElement = HTMLInputElement>(pop: HTMLElement, key: string): T => {
  const found = pop.querySelector<T>(`[data-field="${key}"]`);
  if (!found) throw new Error(`no control with data-field ${key}`);
  return found;
};
const typeInto = (node: HTMLInputElement, text: string) => {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};
const choose = (node: HTMLSelectElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event("change", { bubbles: true }));
};
const links = () => store.session.doc.deck.links ?? [];
const addLink = (id: string, target = "https://example.com") => {
  const result = store.session.apply([{ op: "link.add", link: { id, title: id, target } }]);
  expect(result.ok).toBe(true);
};

describe("the links section of the deck popover", () => {
  it("adds a saved link and puts the keyboard on its title", () => {
    const pop = deckPop();
    control<HTMLButtonElement>(pop, "panel:link:add").click();
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({ title: "New link", target: "https://example.com" });
    expect(document.activeElement).toBe(control(pop, `panel:link:${links()[0]?.id}:title`));
  });

  it("changes a target as it is typed, and refuses one that is not a target", () => {
    addLink("docs");
    const pop = deckPop();
    const target = control(pop, "panel:link:docs:target");
    typeInto(target, "https://example.org/a");
    expect(links()[0]?.target).toBe("https://example.org/a");
    typeInto(target, "javascript:alert(1)");
    expect(links()[0]?.target).toBe("https://example.org/a");
    expect(target.getAttribute("aria-invalid")).toBe("true");
  });

  it("points a link at a file of the deck from the list of files", () => {
    addLink("docs");
    const file = control<HTMLSelectElement>(deckPop(), "panel:link:docs:file");
    const asset = [...store.session.doc.assets].sort()[0] as string;
    choose(file, asset);
    expect(links()[0]?.target).toBe(asset);
  });

  it("keeps a link that a source uses, and removes it once nothing does", () => {
    addLink("docs");
    const scene = store.session.doc.deck.scenes.find((id) => store.session.doc.scenes[id]?.sources?.length);
    expect(scene).toBeDefined();
    const sourceId = store.session.doc.scenes[scene as string]?.sources?.[0]?.id as string;
    editor.select(scene as string);
    const scenePop = popOf(".ed-scene-tools [data-tb='scene']");
    choose(control<HTMLSelectElement>(scenePop, `panel:source:${sourceId}:link`), "docs");
    expect(store.session.doc.scenes[scene as string]?.sources?.[0]?.link).toBe("docs");

    const pop = deckPop();
    control<HTMLButtonElement>(pop, "panel:link-remove:docs").click();
    expect(links()).toHaveLength(1);

    choose(
      control<HTMLSelectElement>(popOf(".ed-scene-tools [data-tb='scene']"), `panel:source:${sourceId}:link`),
      "",
    );
    control<HTMLButtonElement>(deckPop(), "panel:link-remove:docs").click();
    expect(links()).toHaveLength(0);
  });
});
