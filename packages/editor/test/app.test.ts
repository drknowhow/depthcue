// @vitest-environment happy-dom
import { type DraftStore, loadDoc, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type DeckCopy, type EditorStore, openStore, type StoreOptions } from "../src/store.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

async function mount(drafts: DraftStore = memoryDraftStore(), options: StoreOptions = {}) {
  server = new FakeServer();
  store = await openStore(server, () => drafts, options);
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
}

beforeEach(() => mount());
afterEach(() => editor.destroy());

const button = (action: string) =>
  host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`) as HTMLButtonElement;
const status = () => host.querySelector<HTMLElement>(".ed-status") as HTMLElement;
const sceneButtons = () => [...host.querySelectorAll<HTMLButtonElement>(".ed-scene")];
const key = (init: KeyboardEventInit) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

describe("the scene list", () => {
  it("lists the scenes in deck order with their numbers, titles and who leads", () => {
    const rows = sceneButtons().map((node) => node.textContent);
    expect(rows).toHaveLength(store.session.doc.deck.scenes.length);
    expect(rows[0]).toContain("1");
    const leads = sceneButtons().map((node) => node.querySelector<HTMLElement>(".ed-lead")?.dataset.lead);
    expect(leads).toContain("agent");
    expect(leads).toContain("human");
  });

  it("shows the first scene, and another when it is chosen", () => {
    expect(host.querySelector("[data-scene='opening']")).not.toBeNull();
    expect(sceneButtons()[0]?.getAttribute("aria-current")).toBe("true");
    sceneButtons()[1]?.click();
    expect(editor.sceneId).toBe("demand");
    expect(host.querySelector("[data-scene='demand']")).not.toBeNull();
    expect(sceneButtons()[1]?.getAttribute("aria-current")).toBe("true");
    expect(sceneButtons()[0]?.getAttribute("aria-current")).toBe("false");
  });

  it("points Present at the scene being edited", () => {
    sceneButtons()[2]?.click();
    expect(host.querySelector(".ed-link")?.getAttribute("href")).toBe("/present#/method");
  });

  it("follows the files when they change on disk, and moves off a scene that is gone", async () => {
    sceneButtons()[2]?.click();
    server.external([{ op: "scene.remove", id: "method" }]);
    await store.syncFromDisk();
    expect(sceneButtons()).toHaveLength(2);
    expect(editor.sceneId).not.toBe("method");
    expect(host.querySelector("[data-scene='method']")).toBeNull();
    expect(host.querySelector(`[data-scene='${editor.sceneId}']`)).not.toBeNull();
  });
});

describe("the top bar", () => {
  it("shows the deck title and starts clean with nothing to undo, and no Save button", () => {
    expect(host.querySelector(".ed-deck")?.textContent).toBe(store.session.doc.deck.title);
    expect(document.title).toContain(store.session.doc.deck.title);
    expect(button("undo").disabled).toBe(true);
    expect(button("redo").disabled).toBe(true);
    expect(host.querySelector("[data-action='save']")).toBeNull();
    expect(button("retry").hidden).toBe(true);
    expect(status().dataset.state).toBe("saved");
    expect(status().textContent).toBe("Saved");
  });

  it("enables undo and redo as the work changes", () => {
    store.session.apply([retitle("Edited")]);
    expect(button("undo").disabled).toBe(false);
    expect(status().textContent).toBe("Unsaved changes");
    button("undo").click();
    expect(button("redo").disabled).toBe(false);
    expect(openingTitle(store.session.doc)).not.toBe("Edited");
    expect(status().textContent).toBe("Saved");
    button("redo").click();
    expect(openingTitle(store.session.doc)).toBe("Edited");
  });

  it("shows why a save failed and offers to try again", async () => {
    store.session.apply([retitle("Edited")]);
    server.nextSave = { ok: false, kind: "failed", message: "Could not reach the server.", diagnostics: [] };
    key({ key: "s", ctrlKey: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(status().dataset.state).toBe("error");
    expect(status().textContent).toBe("Could not reach the server.");
    expect(button("retry").hidden).toBe(false);
    button("retry").click();
    await new Promise((done) => setTimeout(done, 0));
    expect(status().textContent).toBe("Saved");
    expect(button("retry").hidden).toBe(true);
    expect(server.saves).toHaveLength(2);
  });
});

describe("autosave in the bar", () => {
  beforeEach(async () => {
    editor.destroy();
    await mount(memoryDraftStore(), { autosaveMs: 20 });
  });

  it("says Saving while an edit waits and Saved once it is on disk, with no click", async () => {
    store.session.apply([retitle("Edited")]);
    expect(status().textContent).toBe("Saving…");
    expect(server.saves).toHaveLength(0);
    await new Promise((done) => setTimeout(done, 80));
    expect(status().textContent).toBe("Saved");
    expect(server.saves).toHaveLength(1);
    expect(openingTitle(loadDoc({ text: server.text, assets: server.assets }).doc ?? ({} as never))).toBe(
      "Edited",
    );
  });

  it("does not rebuild the field being typed in when the save lands", async () => {
    const node = host.querySelector<HTMLElement>(".ed-frame [data-edit]") as HTMLElement;
    node.focus();
    node.textContent = "Typed in place";
    node.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 80));
    expect(server.saves).toHaveLength(1);
    expect(status().textContent).toBe("Saved");
    expect(host.querySelector(".ed-frame [data-edit]")).toBe(node);
    expect(document.activeElement).toBe(node);
  });

  it("does not rebuild a details field being typed in when the save lands", async () => {
    button("details").click();
    const field = host.querySelector<HTMLInputElement>("[data-field='scene:title']") as HTMLInputElement;
    field.focus();
    field.value = "Retitled while typing";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 80));
    expect(server.saves).toHaveLength(1);
    expect(host.querySelector("[data-field='scene:title']")).toBe(field);
    expect(document.activeElement).toBe(field);
  });
});

describe("the details panel", () => {
  const panel = () => host.querySelector<HTMLElement>(".ed-inspector") as HTMLElement;
  const app = () => host.querySelector<HTMLElement>(".ed-app") as HTMLElement;
  const pick = (id: string) =>
    [...host.querySelectorAll<HTMLElement>("[data-pick]")].find((node) => node.dataset.id === id);

  it("starts closed so the slide gets the room, and the button opens and closes it", () => {
    expect(panel().hidden).toBe(true);
    expect(app().dataset.details).toBe("closed");
    expect(button("details").getAttribute("aria-expanded")).toBe("false");
    expect(button("details").getAttribute("aria-controls")).toBe(panel().id);
    button("details").click();
    expect(panel().hidden).toBe(false);
    expect(app().dataset.details).toBe("open");
    expect(button("details").getAttribute("aria-expanded")).toBe("true");
    button("details").click();
    expect(panel().hidden).toBe(true);
    expect(app().dataset.details).toBe("closed");
  });

  it("stays closed when a block with no text on the slide is picked, since its toolbar edits it", () => {
    sceneButtons()[1]?.click();
    pick("chart-demand")?.click();
    expect(editor.blockId).toBe("chart-demand");
    expect(panel().hidden).toBe(true);
    expect(button("details").getAttribute("aria-expanded")).toBe("false");
  });

  it("stays closed when text is picked, since the slide edits it", () => {
    const heading = host.querySelector<HTMLElement>("[data-id='opening-title'] [data-edit], [data-edit]");
    heading?.dispatchEvent(new FocusEvent("focus"));
    expect(editor.blockId).not.toBeUndefined();
    expect(panel().hidden).toBe(true);
  });

  it("keeps the panel's content current while it is closed", () => {
    store.session.apply([{ op: "scene.set", id: "opening", set: { title: "Edited while closed" } }]);
    button("details").click();
    const field = host.querySelector<HTMLInputElement>("[data-field='scene:title']");
    expect(field?.value).toBe("Edited while closed");
  });
});

describe("typing into the preview", () => {
  it("edits in place without redrawing the field under the caret, and updates the bar", () => {
    const node = host.querySelector<HTMLElement>(".ed-frame [data-edit]") as HTMLElement;
    node.focus();
    node.textContent = "Typed in place";
    node.dispatchEvent(new Event("input", { bubbles: true }));
    expect(host.querySelector(".ed-frame [data-edit]")).toBe(node);
    expect(node.isConnected).toBe(true);
    expect(document.activeElement).toBe(node);
    expect(openingTitle(store.session.doc)).toBe("Typed in place");
    expect(status().textContent).toBe("Unsaved changes");
    expect(button("undo").disabled).toBe(false);
  });

  it("redraws the preview when the change did not come from typing", () => {
    const node = host.querySelector<HTMLElement>(".ed-frame [data-edit]") as HTMLElement;
    store.session.apply([retitle("From an agent")]);
    expect(host.querySelector(".ed-frame [data-edit]")).not.toBe(node);
    expect(host.querySelector(".ed-frame")?.textContent).toContain("From an agent");
  });
});

describe("shortcuts", () => {
  it("saves with Ctrl+S or Cmd+S", async () => {
    store.session.apply([retitle("Edited")]);
    key({ key: "s", ctrlKey: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(server.saves).toHaveLength(1);
    store.session.apply([retitle("Edited again")]);
    key({ key: "s", metaKey: true });
    await new Promise((done) => setTimeout(done, 0));
    expect(server.saves).toHaveLength(2);
  });

  it("undoes and redoes with Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y", () => {
    store.session.apply([retitle("Edited")]);
    key({ key: "z", ctrlKey: true });
    expect(openingTitle(store.session.doc)).not.toBe("Edited");
    key({ key: "z", ctrlKey: true, shiftKey: true });
    expect(openingTitle(store.session.doc)).toBe("Edited");
    key({ key: "z", ctrlKey: true });
    key({ key: "y", ctrlKey: true });
    expect(openingTitle(store.session.doc)).toBe("Edited");
  });

  it("takes the browser's shortcut away so the page does not also act on it", () => {
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves plain keys and other modifier combinations alone", () => {
    store.session.apply([retitle("Edited")]);
    key({ key: "z" });
    key({ key: "z", ctrlKey: true, altKey: true });
    key({ key: "s" });
    expect(openingTitle(store.session.doc)).toBe("Edited");
    expect(server.saves).toHaveLength(0);
  });

  it("stops listening when the editor is taken down", () => {
    editor.destroy();
    store.session.apply([retitle("Edited")]);
    key({ key: "z", ctrlKey: true });
    expect(openingTitle(store.session.doc)).toBe("Edited");
  });
});

describe("notices", () => {
  const notices = () => [...host.querySelectorAll<HTMLElement>(".ed-notice")];
  const choose = (action: string) =>
    (host.querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
  const settle = () => new Promise((done) => setTimeout(done, 0));

  it("offers reload and a copy when the files changed under unsaved edits, and stops saving meanwhile", async () => {
    store.session.apply([retitle("Mine")]);
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.dataset.kind).toBe("conflict");
    expect(button("retry").hidden).toBe(true);
    expect(button("take-disk").textContent).toBe("Reload");
    expect(button("keep-mine").textContent).toBe("Keep mine as copy");
    key({ key: "s", ctrlKey: true });
    await settle();
    expect(server.saves).toHaveLength(0);
  });

  it("takes the disk version when asked", async () => {
    store.session.apply([retitle("Mine")]);
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    choose("take-disk");
    await settle();
    expect(notices()).toHaveLength(0);
    expect(openingTitle(store.session.doc)).toBe("Theirs");
    expect(host.querySelector(".ed-frame")?.textContent).toContain("Theirs");
  });

  it("hands over the visitor's version as a file and loads the disk version, saving nothing", async () => {
    const copies: DeckCopy[] = [];
    editor.destroy();
    await mount(memoryDraftStore(), { saveCopy: (copy) => copies.push(copy) });
    store.session.apply([retitle("Mine")]);
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    choose("keep-mine");
    await settle();
    await settle();
    expect(copies).toHaveLength(1);
    expect(copies[0]?.text).toContain("Mine");
    expect(notices()).toHaveLength(0);
    expect(openingTitle(store.session.doc)).toBe("Theirs");
    expect(status().textContent).toContain("Saved");
    expect(server.saves).toHaveLength(0);
  });

  it("explains a draft that came back and lets the visitor discard it", async () => {
    const first = new FakeServer();
    const drafts = memoryDraftStore();
    const earlier = await openStore(first, () => drafts);
    earlier.session.apply([retitle("Left unsaved")]);
    earlier.flush();
    earlier.dispose();
    editor.destroy();
    await mount(drafts);
    expect(notices()[0]?.dataset.kind).toBe("draft");
    expect(notices()[0]?.textContent).toContain("Unsaved changes from your last visit");
    expect(host.querySelector(".ed-frame")?.textContent).toContain("Left unsaved");
    choose("discard-draft");
    await settle();
    await settle();
    expect(notices()).toHaveLength(0);
    expect(host.querySelector(".ed-frame")?.textContent).not.toContain("Left unsaved");
  });

  it("dismisses a note that needs no answer", async () => {
    const drafts = memoryDraftStore('{"nonsense":true}');
    editor.destroy();
    await mount(drafts);
    expect(notices()[0]?.textContent).toContain("could not be used");
    choose("dismiss");
    expect(notices()).toHaveLength(0);
  });
});
