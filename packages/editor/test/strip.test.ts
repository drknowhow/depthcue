// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer, retitle } from "./helpers.ts";

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

const rows = () => [...host.querySelectorAll<HTMLLIElement>(".ed-scene-list > li")];
const row = (id: string) => host.querySelector<HTMLLIElement>(`.ed-scene-list > li[data-id='${id}']`);
const thumb = (id: string) => row(id)?.querySelector<HTMLElement>(".ed-thumb") as HTMLElement;
const frameOf = (id: string) => thumb(id).querySelector(".ed-thumb-frame");
const order = () => store.session.doc.deck.scenes;
const click = (selector: string, within: ParentNode = host) =>
  (within.querySelector(selector) as HTMLElement).click();
const until = async (test: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((done) => setTimeout(done, 10));
  expect(test()).toBe(true);
};

describe("thumbnails", () => {
  it("draw each scene with its real content, a few at a time, and stay out of the way of assistive tech", async () => {
    // The strip draws on the next frame, not while the editor is being built.
    expect(host.querySelectorAll(".ed-thumb-frame")).toHaveLength(0);
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    expect(thumb("opening").textContent).toContain("Channel B now leads demand");
    for (const node of host.querySelectorAll<HTMLElement>(".ed-thumb")) {
      expect(node.getAttribute("aria-hidden")).toBe("true");
      // The picture is inert; the thumbnail around it is not, or a click on it would reach nothing.
      expect(node.hasAttribute("inert")).toBe(false);
      expect(node.querySelector(".ed-thumb-frame")?.hasAttribute("inert")).toBe(true);
    }
    expect(host.querySelector(".ed-thumb-frame")?.getAttribute("data-theme")).toBe(
      store.session.doc.deck.theme,
    );
  });

  it("show every step revealed, and leave controls and pictures lazy", async () => {
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    for (const node of host.querySelectorAll<HTMLElement>(".ed-thumb [data-gated]")) {
      expect(node.dataset.revealed).toBe("true");
    }
    for (const image of host.querySelectorAll<HTMLImageElement>(".ed-thumb img")) {
      expect(image.loading).toBe("lazy");
    }
  });

  it("are not counted in the scene buttons' names", async () => {
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    const buttons = host.querySelectorAll<HTMLButtonElement>(".ed-scene");
    expect(buttons).toHaveLength(3);
    for (const node of buttons) expect(node.querySelector(".ed-thumb")).toBeNull();
  });

  it("are drawn again for the scene that changed, after typing pauses, and for no other", async () => {
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    const before = {
      opening: frameOf("opening"),
      demand: frameOf("demand"),
      method: frameOf("method"),
    };
    store.session.apply([retitle("Rewritten headline")]);
    // Typing is still going on as far as the strip knows, so nothing is drawn yet.
    expect(thumb("opening").textContent).not.toContain("Rewritten headline");
    await until(() => thumb("opening").textContent?.includes("Rewritten headline") === true);
    expect(frameOf("opening")).not.toBe(before.opening);
    expect(frameOf("demand")).toBe(before.demand);
    expect(frameOf("method")).toBe(before.method);
  });

  it("follow a change of theme", async () => {
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    store.session.apply([{ op: "deck.set", set: { theme: "ink" } }]);
    await until(() =>
      [...host.querySelectorAll(".ed-thumb-frame")].every(
        (frame) => frame.getAttribute("data-theme") === "ink",
      ),
    );
  });

  it("are not redrawn when a scene is only selected", async () => {
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    const before = frameOf("method");
    editor.select("method");
    editor.select("opening");
    await new Promise((done) => setTimeout(done, 300));
    expect(frameOf("method")).toBe(before);
  });

  it("are drawn by a click on the picture as well, which chooses the scene", async () => {
    await until(() => host.querySelectorAll(".ed-thumb-frame").length === 3);
    thumb("method").click();
    expect(editor.sceneId).toBe("method");
    expect(row("method")?.hasAttribute("data-current")).toBe(true);
    expect(row("opening")?.hasAttribute("data-current")).toBe(false);
  });
});

describe("rows", () => {
  it("are kept between renders, so a change in one scene does not rebuild the list", () => {
    const before = rows();
    store.session.apply([retitle("Edited")]);
    store.session.apply([{ op: "scene.set", id: "demand", set: { title: "Retitled" } }]);
    expect(rows()).toEqual(before);
    expect(row("demand")?.querySelector(".ed-title")?.textContent).toBe("Retitled");
  });

  it("keep their place in the order and the same nodes when scenes move", () => {
    const before = new Map(rows().map((node) => [node.dataset.id, node]));
    store.session.apply([{ op: "scene.move", id: "opening", after: "method" }]);
    expect(rows().map((node) => node.dataset.id)).toEqual(order());
    expect(order()[2]).toBe("opening");
    for (const node of rows()) expect(node).toBe(before.get(node.dataset.id));
    expect(rows().map((node) => node.querySelector(".ed-num")?.textContent)).toEqual(["1", "2", "3"]);
  });

  it("leave a focused button where it is while another scene is edited", () => {
    const button = row("method")?.querySelector<HTMLButtonElement>(".ed-scene") as HTMLButtonElement;
    button.focus();
    store.session.apply([retitle("Typed elsewhere")]);
    expect(document.activeElement).toBe(button);
  });

  it("drop out when a scene is removed on disk, and give the others their new numbers", () => {
    store.session.apply([{ op: "scene.remove", id: "opening" }]);
    expect(row("opening")).toBeNull();
    expect(rows().map((node) => node.querySelector(".ed-num")?.textContent)).toEqual(["1", "2"]);
  });

  it("mark the chosen scene on the row and on its button", () => {
    editor.select("demand");
    expect(row("demand")?.hasAttribute("data-current")).toBe(true);
    expect(row("demand")?.querySelector(".ed-scene")?.getAttribute("aria-current")).toBe("true");
    expect(row("opening")?.querySelector(".ed-scene")?.getAttribute("aria-current")).toBe("false");
  });
});

describe("duplicating a scene", () => {
  it("puts a copy right after it, chooses the copy, and undoes in one step", () => {
    const original = store.session.doc.scenes.demand;
    click("[data-action='duplicate-scene']", row("demand") as HTMLElement);
    expect(order()).toEqual(["opening", "demand", "demand-copy", "method"]);
    const copy = store.session.doc.scenes["demand-copy"];
    expect(copy?.title).toBe(`${original?.title} (copy)`);
    expect(copy?.blocks).toEqual(original?.blocks);
    expect(copy?.summary).toEqual(original?.summary);
    expect(copy?.steps).toEqual(original?.steps);
    expect(editor.sceneId).toBe("demand-copy");
    expect(store.session.doc.scenes.demand).toBe(original);

    store.session.undo();
    expect(order()).toEqual(["opening", "demand", "method"]);
  });

  it("gives every copy an id of its own", () => {
    click("[data-action='duplicate-scene']", row("demand") as HTMLElement);
    click("[data-action='duplicate-scene']", row("demand") as HTMLElement);
    expect(order()).toEqual(["opening", "demand", "demand-copy-2", "demand-copy", "method"]);
  });

  it("keeps the title inside the schema's limit", () => {
    const long = "T".repeat(120);
    store.session.apply([{ op: "scene.set", id: "demand", set: { title: long } }]);
    click("[data-action='duplicate-scene']", row("demand") as HTMLElement);
    const title = store.session.doc.scenes["demand-copy"]?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith(" (copy)")).toBe(true);
  });

  it("names the scene it copies for a screen reader", () => {
    const label = row("demand")?.querySelector("[data-action='duplicate-scene']")?.getAttribute("aria-label");
    expect(label).toBe(`Duplicate scene 2, ${store.session.doc.scenes.demand?.title}`);
  });
});

describe("deleting a scene", () => {
  it("removes it, chooses its neighbour, and undoes", () => {
    editor.select("demand");
    click("[data-action='delete-scene']", row("demand") as HTMLElement);
    expect(order()).toEqual(["opening", "method"]);
    expect(editor.sceneId).toBe("method");
    expect(row("demand")).toBeNull();
    store.session.undo();
    expect(order()).toEqual(["opening", "demand", "method"]);
  });

  it("falls back to the scene before when the last one goes", () => {
    editor.select("method");
    click("[data-action='delete-scene']", row("method") as HTMLElement);
    expect(editor.sceneId).toBe("demand");
  });

  it("can delete a scene that is not the one being edited, and keeps the edited one", () => {
    editor.select("opening");
    click("[data-action='delete-scene']", row("method") as HTMLElement);
    expect(order()).toEqual(["opening", "demand"]);
    expect(editor.sceneId).toBe("opening");
  });

  it("is disabled for the only scene left, because a deck needs one", () => {
    click("[data-action='delete-scene']", row("demand") as HTMLElement);
    click("[data-action='delete-scene']", row("method") as HTMLElement);
    expect(order()).toEqual(["opening"]);
    const only = row("opening")?.querySelector<HTMLButtonElement>("[data-action='delete-scene']");
    expect(only?.disabled).toBe(true);
    only?.click();
    expect(order()).toEqual(["opening"]);
  });
});
