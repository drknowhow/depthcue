// @vitest-environment happy-dom
import { memoryDraftStore } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { PARTS, part } from "../src/lazy.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

async function mount(setup?: (fake: FakeServer) => void, parts = PARTS) {
  server = new FakeServer();
  setup?.(server);
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store, parts);
  // The method scene has a heading, a body text and an image of method.svg.
  editor.select("method");
}

afterEach(() => editor.destroy());

const flush = () => new Promise((done) => setTimeout(done, 0));
const settle = async () => {
  await flush();
  await flush();
};
const method = () => store.session.doc.scenes.method;
const images = () => method()?.blocks.filter((block) => block.type === "image") ?? [];
const imageInput = () =>
  host.querySelector<HTMLInputElement>(".ed-quick .ed-button input[type='file']") as HTMLInputElement;
const library = () => host.querySelector<HTMLElement>("[data-library]");
const rows = () => [...(library()?.querySelectorAll<HTMLElement>(".ed-lib-row") ?? [])];
const row = (asset: string) => rows().find((node) => node.dataset.asset === asset) as HTMLElement;
const pick = (asset: string) =>
  row(asset).querySelector<HTMLButtonElement>(".ed-lib-pick") as HTMLButtonElement;
const del = (asset: string) => row(asset).querySelector<HTMLButtonElement>(".ed-lib-del");
const press = (node: Element, key: string) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const note = () => library()?.querySelector(".ed-lib-note")?.textContent;
/** Clicks the Image button the way a person does and says whether the file chooser was held back. */
const clickImage = () => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  imageInput().dispatchEvent(event);
  return event.defaultPrevented;
};
const confirmDelete = (asset: string) =>
  [...row(asset).querySelectorAll("button")].find((node) => node.textContent === "Delete");

describe("opening the library", () => {
  beforeEach(() => mount());

  it("opens from the Image button in place of the file chooser when the deck has pictures", async () => {
    expect(clickImage()).toBe(true);
    await settle();
    expect(library()?.dataset.library).toBe("add");
    expect(library()?.getAttribute("role")).toBe("dialog");
    expect(rows().map((node) => node.dataset.asset)).toEqual(["assets/method.svg"]);
    expect(server.listCalls).toBe(1);
  });

  it("shows the name, the size in pixels, the file size and where a picture is used", async () => {
    clickImage();
    await settle();
    expect(pick("assets/method.svg").getAttribute("aria-label")).toBe(
      "Add method.svg: 640 by 480 pixels, 2 KB, Used on 1 slide",
    );
    expect(pick("assets/method.svg").textContent).toContain("method.svg");
    // A thumbnail is fetched when it scrolls into view, and is not announced twice.
    const thumb = pick("assets/method.svg").querySelector("img") as HTMLImageElement;
    expect(thumb.getAttribute("loading")).toBe("lazy");
    expect(thumb.getAttribute("alt")).toBe("");
  });

  it("opens from the I key too", async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true }));
    await settle();
    expect(library()).not.toBeNull();
  });

  it("goes straight to the file chooser when the deck has no pictures", async () => {
    // The deck's only picture is gone, as a delete leaves the document's files.
    (store.session.doc.assets as Set<string>).delete("assets/method.svg");
    expect(clickImage()).toBe(false);
    await settle();
    expect(library()).toBeNull();
    expect(server.listCalls).toBe(0);
  });

  it("says in words when the part is not there, and the editor goes on", async () => {
    editor.destroy();
    await mount(undefined, { ...PARTS, library: part(() => Promise.reject(new Error("offline"))) });
    clickImage();
    await settle();
    expect(host.querySelector(".ed-hint")?.textContent).toContain("Could not load the image library");
  });
});

describe("adding from the library", () => {
  beforeEach(() => mount());

  it("inserts a new image block that names the chosen file, and Undo takes it back", async () => {
    const before = images().length;
    clickImage();
    await settle();
    pick("assets/method.svg").click();
    await settle();
    expect(library()).toBeNull();
    expect(images()).toHaveLength(before + 1);
    expect(server.uploads).toHaveLength(0);
    const added = images().at(-1);
    expect(added?.type === "image" && added.asset).toBe("assets/method.svg");
    (host.querySelector("[data-action='undo']") as HTMLButtonElement).click();
    await settle();
    expect(images()).toHaveLength(before);
  });

  it("keeps the upload path: a file chosen in the library is stored and added", async () => {
    clickImage();
    await settle();
    const input = library()?.querySelector<HTMLInputElement>("input[type='file']") as HTMLInputElement;
    const file = new File(["x"], "fresh.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(server.uploads).toEqual(["assets/fresh.png"]);
    expect(library()).toBeNull();
    expect(images().some((block) => block.type === "image" && block.asset === "assets/fresh.png")).toBe(true);
  });
});

const openEditPopover = () => {
  const block = images()[0];
  if (block?.type !== "image") throw new Error("the method scene should have an image");
  const node = host.querySelector<HTMLElement>(`.ed-frame [data-id='${block.id}']`);
  node?.click();
  const chip = host.querySelector<HTMLButtonElement>(".ed-toolbar [data-tb='edit']") as HTMLButtonElement;
  chip.click();
  return { block, chip };
};

describe("replacing from the Edit popover", () => {
  beforeEach(() =>
    mount((fake) => {
      fake.assets.push("assets/other.png");
    }),
  );

  it("sets the chosen image's file through the same operation as the file select, and Undo restores it", async () => {
    const { block } = openEditPopover();
    const choose = host.querySelector<HTMLButtonElement>("[data-field='image:library']");
    expect(choose?.textContent).toBe("Choose from library");
    choose?.click();
    await settle();
    expect(library()?.dataset.library).toBe("replace");
    expect(pick("assets/other.png").getAttribute("aria-label")).toMatch(/^Use other\.png/);
    pick("assets/other.png").click();
    await settle();
    const after = images()[0];
    expect(after?.type === "image" && after.asset).toBe("assets/other.png");
    expect(images()).toHaveLength(1);
    store.session.undo();
    const undone = images()[0];
    expect(undone?.type === "image" && undone.asset).toBe(block.type === "image" && block.asset);
  });

  it("gives the keyboard back to the Edit chip on Escape", async () => {
    const { chip } = openEditPopover();
    host.querySelector<HTMLButtonElement>("[data-field='image:library']")?.click();
    await settle();
    press(document.activeElement as Element, "Escape");
    expect(library()).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

describe("keyboard", () => {
  beforeEach(() =>
    mount((fake) => {
      fake.assets.push("assets/other.png", "assets/spare.png");
    }),
  );

  it("moves between pictures with the arrow keys, and Home and End", async () => {
    clickImage();
    await settle();
    const [first, second, third] = rows().map(
      (node) => node.querySelector<HTMLElement>(".ed-lib-pick") as HTMLElement,
    ) as [HTMLElement, HTMLElement, HTMLElement];
    expect(document.activeElement).toBe(first);
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    press(second, "End");
    expect(document.activeElement).toBe(third);
    press(third, "ArrowDown");
    expect(document.activeElement).toBe(third);
    press(third, "ArrowUp");
    expect(document.activeElement).toBe(second);
    press(second, "Home");
    expect(document.activeElement).toBe(first);
  });

  it("closes on Escape and gives the keyboard back to the Image button", async () => {
    clickImage();
    await settle();
    press(document.activeElement as Element, "Escape");
    expect(library()).toBeNull();
    expect(document.activeElement).toBe(imageInput());
  });

  it("gives every control a name a screen reader can say", async () => {
    clickImage();
    await settle();
    const controls = [...(library()?.querySelectorAll<HTMLElement>("button, input, ul") ?? [])];
    expect(controls.length).toBeGreaterThan(4);
    const unnamed = controls.filter(
      (node) => !(node.getAttribute("aria-label") || node.textContent?.trim() || node.closest("label")),
    );
    expect(unnamed).toEqual([]);
    expect(library()?.getAttribute("aria-labelledby")).toBe("ed-lib-title");
    expect(host.querySelector("#ed-lib-title")?.textContent).toBe("Add an image");
  });
});

describe("deleting", () => {
  beforeEach(() =>
    mount((fake) => {
      fake.assets.push("assets/spare.png", "assets/named-in-server.png");
      fake.uses["assets/named-in-server.png"] = [{ scene: "opening", path: "/blocks/0/asset" }];
    }),
  );

  it("offers Delete only for a picture that nothing names", async () => {
    clickImage();
    await settle();
    expect(del("assets/spare.png")).not.toBeNull();
    expect(del("assets/method.svg")).toBeNull();
    expect(del("assets/named-in-server.png")).toBeNull();
    expect(row("assets/spare.png").textContent).toContain("Not used");
  });

  it("does not offer Delete for a picture only the unsaved document names", async () => {
    const result = store.session.apply([
      {
        op: "block.add",
        scene: "method",
        block: { id: "method-spare", type: "image", asset: "assets/spare.png", alt: "A spare" },
      },
    ]);
    expect(result.ok).toBe(true);
    expect(server.uses["assets/spare.png"]).toBeUndefined();
    clickImage();
    await settle();
    expect(del("assets/spare.png")).toBeNull();
    expect(row("assets/spare.png").textContent).toContain("Used on 1 slide");
  });

  it("asks inside the popover first, and Keep puts the row back", async () => {
    clickImage();
    await settle();
    del("assets/spare.png")?.click();
    expect(row("assets/spare.png").textContent).toContain("Delete spare.png? It cannot be brought back.");
    expect(document.activeElement?.textContent).toBe("Keep");
    expect(server.removed).toEqual([]);
    (document.activeElement as HTMLElement).click();
    expect(del("assets/spare.png")).not.toBeNull();
    expect(document.activeElement).toBe(del("assets/spare.png"));
    expect(library()).not.toBeNull();
  });

  it("Escape in the question cancels only the question", async () => {
    clickImage();
    await settle();
    del("assets/spare.png")?.click();
    press(document.activeElement as Element, "Escape");
    expect(library()).not.toBeNull();
    expect(del("assets/spare.png")).not.toBeNull();
    expect(server.removed).toEqual([]);
  });

  it("deletes once asked twice, refreshes the list and takes the file off the deck's files", async () => {
    clickImage();
    await settle();
    del("assets/spare.png")?.click();
    confirmDelete("assets/spare.png")?.click();
    await settle();
    expect(server.removed).toEqual(["assets/spare.png"]);
    expect(rows().map((node) => node.dataset.asset)).not.toContain("assets/spare.png");
    expect(note()).toBe("Deleted spare.png.");
    expect(store.session.doc.assets.has("assets/spare.png")).toBe(false);
    expect(server.listCalls).toBe(2);
  });

  it("says the server's reason when it refuses, and keeps the file", async () => {
    server.refuseRemove = "assets/spare.png is used 1 time, so it was not removed.";
    clickImage();
    await settle();
    del("assets/spare.png")?.click();
    confirmDelete("assets/spare.png")?.click();
    await settle();
    expect(note()).toContain("was not removed");
    expect(del("assets/spare.png")).not.toBeNull();
    expect(store.session.doc.assets.has("assets/spare.png")).toBe(true);
  });
});
