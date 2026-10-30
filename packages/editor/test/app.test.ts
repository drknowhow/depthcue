// @vitest-environment happy-dom
import { type DraftStore, memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, openingTitle, retitle } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

async function mount(drafts: DraftStore = memoryDraftStore()) {
  server = new FakeServer();
  store = await openStore(server, () => drafts);
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
  it("shows the deck title and starts clean with nothing to undo or save", () => {
    expect(host.querySelector(".ed-deck")?.textContent).toBe(store.session.doc.deck.title);
    expect(document.title).toContain(store.session.doc.deck.title);
    expect(button("undo").disabled).toBe(true);
    expect(button("redo").disabled).toBe(true);
    expect(button("save").disabled).toBe(true);
    expect(status().dataset.state).toBe("saved");
    expect(status().textContent).toBe("Saved");
  });

  it("enables undo, redo and save as the work changes", () => {
    store.session.apply([retitle("Edited")]);
    expect(button("undo").disabled).toBe(false);
    expect(button("save").disabled).toBe(false);
    expect(status().textContent).toBe("Unsaved changes");
    button("undo").click();
    expect(button("redo").disabled).toBe(false);
    expect(openingTitle(store.session.doc)).not.toBe("Edited");
    expect(status().textContent).toBe("Saved");
    button("redo").click();
    expect(openingTitle(store.session.doc)).toBe("Edited");
  });

  it("saves from the button and says so", async () => {
    store.session.apply([retitle("Edited")]);
    button("save").click();
    expect(status().textContent).toBe("Saving…");
    await new Promise((done) => setTimeout(done, 0));
    expect(status().textContent).toBe("Saved");
    expect(server.saves).toHaveLength(1);
  });

  it("shows why a save failed", async () => {
    store.session.apply([retitle("Edited")]);
    server.nextSave = { ok: false, kind: "failed", message: "Could not reach the server.", diagnostics: [] };
    button("save").click();
    await new Promise((done) => setTimeout(done, 0));
    expect(status().dataset.state).toBe("error");
    expect(status().textContent).toBe("Could not reach the server.");
    expect(button("save").disabled).toBe(false);
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

  it("offers both versions when the files changed under unsaved edits, and blocks saving meanwhile", async () => {
    store.session.apply([retitle("Mine")]);
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.dataset.kind).toBe("conflict");
    expect(button("save").disabled).toBe(true);
    expect(host.querySelector("[data-action='take-disk']")).not.toBeNull();
    expect(host.querySelector("[data-action='keep-mine']")).not.toBeNull();
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

  it("keeps the visitor's version and saves it when asked", async () => {
    store.session.apply([retitle("Mine")]);
    server.external([retitle("Theirs")]);
    await store.syncFromDisk();
    choose("keep-mine");
    await settle();
    await settle();
    expect(notices()).toHaveLength(0);
    expect(status().textContent).toBe("Saved");
    expect(server.saves).toHaveLength(1);
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
