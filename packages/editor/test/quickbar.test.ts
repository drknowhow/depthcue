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
  // The method scene has a heading, a body text and an image, a reading version, and no claim or notes.
  editor.select("method");
});
afterEach(() => editor.destroy());

const bar = () => host.querySelector<HTMLElement>(".ed-quick") as HTMLElement;
const quick = (name: string) =>
  bar().querySelector<HTMLButtonElement>(`[data-quick='${name}']`) as HTMLButtonElement;
const method = () => store.session.doc.scenes.method;
const ids = () => method()?.blocks.map((block) => block.id);
const notesChip = () => bar().querySelector<HTMLButtonElement>("[data-tb='notes']") as HTMLButtonElement;
const notesPop = () =>
  notesChip().closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
const field = (key: string) =>
  notesPop().querySelector<HTMLTextAreaElement>(`[data-field="${key}"]`) as HTMLTextAreaElement;
const typeInto = (node: HTMLTextAreaElement | HTMLInputElement, text: string) => {
  node.focus();
  node.value = text;
  node.dispatchEvent(new Event("input", { bubbles: true }));
};
const hintText = () => host.querySelector(".ed-hint")?.textContent ?? "";
/** What a button says, without the key written on it. */
const nameOf = (node: Element) => {
  const copy = node.cloneNode(true) as Element;
  for (const key of copy.querySelectorAll(".ed-kbd")) key.remove();
  return copy.textContent;
};

describe("adding to the slide", () => {
  it("floats at the foot of the stage, with a button for each kind of block and for the claim", () => {
    // Beside the scrolling slide and not in it, so the bar stays put while the slide scrolls under it.
    expect(bar().closest(".ed-stage")).not.toBeNull();
    expect(bar().closest(".ed-main")).toBeNull();
    expect(bar().getAttribute("aria-label")).toBe("Add to this slide");
    // Everything and the `?` button come last, and what the `?` is called is in its label and not in its text.
    const labels = [...bar().querySelectorAll("[data-quick], .ed-button")].map(
      (node) => node.getAttribute("aria-label") ?? nameOf(node),
    );
    expect(labels).toEqual([
      "Text",
      "Chart",
      "Table",
      "Image",
      "Clip",
      "Claim",
      "Build order",
      "Comment",
      "Everything",
      "Keyboard shortcuts",
    ]);
    expect(bar().querySelector("input[type='file']")).not.toBeNull();
    // The Everything button names its key for assistive technology, for both of the keys that open it.
    const everything = bar().querySelector("[data-quick='palette']");
    expect(everything?.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    expect(everything?.getAttribute("title")).toMatch(/^Find anything to do \(\w+ K\)$/);
  });

  it("writes the key of Text, Chart and Image on their buttons, and tells assistive technology the same", () => {
    const written = (node: Element) => node.querySelector(".ed-kbd")?.textContent;
    expect(written(quick("text"))).toBe("T");
    expect(written(quick("bar-chart"))).toBe("C");
    expect(written(bar().querySelector<HTMLElement>("label.ed-button") as HTMLElement)).toBe("I");
    expect(quick("text").getAttribute("aria-keyshortcuts")).toBe("T");
    expect(quick("bar-chart").getAttribute("aria-keyshortcuts")).toBe("C");
    expect(bar().querySelector("input[type='file']")?.getAttribute("aria-keyshortcuts")).toBe("I");
    // Written for the eye only: the name a screen reader reads has no stray letter in it.
    expect(bar().querySelector(".ed-kbd")?.getAttribute("aria-hidden")).toBe("true");
    // Claim, Clip and Build order have no key.
    for (const name of ["claim", "clip", "build"]) expect(quick(name).querySelector(".ed-kbd")).toBeNull();
  });

  it("adds a text after the last text of the slide when nothing is chosen, and chooses it", () => {
    quick("text").click();
    // The slide draws its texts in one area and its pictures in another, and the new text joins the texts.
    expect(ids()).toEqual(["method-heading", "method-body", "method-text", "method-diagram"]);
    expect(editor.blockId).toBe("method-text");
    expect(document.activeElement?.getAttribute("data-id")).toBe("method-text");
  });

  it("adds a text right after the chosen text", () => {
    // A text is chosen by putting the keyboard in it.
    host
      .querySelector<HTMLElement>(
        "[data-id='method-heading'] [data-edit], [data-id='method-heading'][data-edit]",
      )
      ?.focus();
    expect(editor.blockId).toBe("method-heading");
    quick("text").click();
    expect(ids()).toEqual(["method-heading", "method-text", "method-body", "method-diagram"]);
    expect(editor.blockId).toBe("method-text");
  });

  it("puts a chart in the area that takes charts, whatever is chosen, and after the chosen picture", () => {
    host
      .querySelector<HTMLElement>(
        "[data-id='method-heading'] [data-edit], [data-id='method-heading'][data-edit]",
      )
      ?.focus();
    quick("bar-chart").click();
    expect(ids()).toEqual(["method-heading", "method-body", "method-diagram", "method-chart"]);
    host.querySelector<HTMLElement>("[data-id='method-diagram']")?.click();
    expect(editor.blockId).toBe("method-diagram");
    quick("bar-chart").click();
    expect(ids()).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
      "method-chart-2",
      "method-chart",
    ]);
  });

  it("goes to the first empty area of a claim slide, and into the chosen block's area when one is chosen", () => {
    editor.select("demand");
    const demand = () => store.session.doc.scenes.demand;
    // The claim cites the chart, so Support is the empty area.
    quick("text").click();
    expect(demand()?.blocks.map((block) => block.id)).toEqual(["chart-demand", "demand-text"]);
    expect(demand()?.summary?.evidenceIds).toEqual(["chart-demand"]);
    // With the chart chosen, the text goes where the chart is, and the claim cites it.
    host.querySelector<HTMLElement>("[data-id='chart-demand']")?.click();
    quick("text").click();
    expect(demand()?.blocks.map((block) => block.id)).toEqual([
      "chart-demand",
      "demand-text-2",
      "demand-text",
    ]);
    expect(demand()?.summary?.evidenceIds).toEqual(["chart-demand", "demand-text-2"]);
    store.session.undo();
    expect(demand()?.summary?.evidenceIds).toEqual(["chart-demand"]);
  });

  it("is one undo step", () => {
    quick("text").click();
    store.session.undo();
    expect(ids()).toEqual(["method-heading", "method-body", "method-diagram"]);
  });

  it("says why when the scene is full, and changes nothing", () => {
    for (let n = 0; n < 9; n++) quick("text").click();
    expect(method()?.blocks).toHaveLength(12);
    quick("text").click();
    expect(method()?.blocks).toHaveLength(12);
    expect(hintText()).toMatch(/\S/);
    expect(host.querySelector(".ed-hint")?.hasAttribute("data-problem")).toBe(true);
  });

  it("adds an image from a file it stores in the deck", async () => {
    const input = bar().querySelector<HTMLInputElement>("input[type='file']") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "Chart Photo.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 0));
    expect(server.uploads).toEqual(["assets/chart-photo.png"]);
    const added = method()?.blocks.at(-1);
    expect(added).toMatchObject({ type: "image", asset: "assets/chart-photo.png" });
    expect(editor.blockId).toBe(added?.id);
  });

  it("says what went wrong when an upload fails, and adds nothing", async () => {
    server.uploadAsset = async () => {
      throw new Error("That file is too large.");
    };
    const input = bar().querySelector<HTMLInputElement>("input[type='file']") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File([new Uint8Array([1])], "big.png", { type: "image/png" })],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 0));
    expect(method()?.blocks).toHaveLength(3);
    expect(hintText()).toContain("too large");
  });

  it("cannot add a clip until the deck has a video, and then adds the first one", () => {
    expect(quick("clip").disabled).toBe(true);
    expect(quick("clip").title).toMatch(/mp4/);
    store.session.addAssets(["assets/b.webm", "assets/a.mp4"]);
    expect(quick("clip").disabled).toBe(false);
    quick("clip").click();
    expect(method()?.blocks.at(-1)).toMatchObject({ type: "clip", source: "assets/a.mp4" });
  });

  it("adds a claim once, and the button rests while the scene has one", () => {
    expect(quick("claim").disabled).toBe(false);
    quick("claim").click();
    expect(method()?.summary).toMatchObject({ text: "State the claim here.", evidenceIds: [] });
    expect(quick("claim").disabled).toBe(true);
    store.session.undo();
    expect(method()?.summary).toBeUndefined();
    expect(quick("claim").disabled).toBe(false);
  });

  it("gives a claim added to a scene that has a block called the same a different id", () => {
    store.session.apply([
      {
        op: "block.add",
        scene: "method",
        block: { id: "method-claim", type: "text", role: "body", text: "Taken" },
      },
    ]);
    quick("claim").click();
    expect(method()?.summary?.id).not.toBe("method-claim");
  });
});

describe("the notes", () => {
  it("open upward from a Notes chip in the bar, with the speaker notes and the reading version", () => {
    expect(notesPop().hidden).toBe(true);
    notesChip().click();
    expect(notesPop().hidden).toBe(false);
    expect(notesPop().hasAttribute("data-up")).toBe(true);
    expect(field("panel:notes").value).toBe("");
    expect(field("panel:reading").value).toBe(method()?.reading?.text);
  });

  it("set the speaker notes as they are typed, and clear them when emptied", () => {
    notesChip().click();
    typeInto(field("panel:notes"), "Open with the sample size.");
    expect(method()?.notes).toBe("Open with the sample size.");
    typeInto(field("panel:notes"), "");
    expect(method()).not.toHaveProperty("notes");
  });

  it("set and clear the reading version", () => {
    notesChip().click();
    typeInto(field("panel:reading"), "A diagram of the method.");
    expect(method()?.reading).toEqual({ text: "A diagram of the method." });
    typeInto(field("panel:reading"), "");
    expect(method()).not.toHaveProperty("reading");
    store.session.undo();
    expect(method()?.reading).toBeDefined();
  });

  it("keep the field being typed in, and count what is written on the chip", () => {
    notesChip().click();
    const notes = field("panel:notes");
    typeInto(notes, "A");
    typeInto(notes, "AB");
    expect(field("panel:notes")).toBe(notes);
    expect(document.activeElement).toBe(notes);
    // The reading version the scene came with, and the notes just typed.
    expect(notesChip().querySelector(".ed-tb-n")?.textContent).toBe("2");
    expect(notesChip().getAttribute("aria-label")).toBe("Speaker notes and reading version, 2 written");
    typeInto(field("panel:notes"), "");
    expect(notesChip().querySelector(".ed-tb-n")?.textContent).toBe("1");
  });

  it("follow the scene chosen in the strip", () => {
    store.session.apply([{ op: "scene.set", id: "method", set: { notes: "Method notes" } }]);
    notesChip().click();
    expect(field("panel:notes").value).toBe("Method notes");
    editor.select("demand");
    expect(field("panel:notes").value).toBe(store.session.doc.scenes.demand?.notes ?? "");
  });

  it("refuse text over the limit, say so, and keep what was there", () => {
    notesChip().click();
    typeInto(field("panel:notes"), "Short notes.");
    typeInto(field("panel:notes"), "x".repeat(4001));
    expect(method()?.notes).toBe("Short notes.");
    expect(field("panel:notes").getAttribute("aria-invalid")).toBe("true");
    field("panel:notes").dispatchEvent(new Event("blur"));
    expect(field("panel:notes").value).toBe("Short notes.");
  });

  it("follow undo and redo", () => {
    notesChip().click();
    typeInto(field("panel:notes"), "Typed");
    store.session.undo();
    expect(field("panel:notes").value).toBe("");
    store.session.redo();
    expect(field("panel:notes").value).toBe("Typed");
  });

  it("follow a change of the files on disk", async () => {
    notesChip().click();
    server.external([{ op: "scene.set", id: "method", set: { notes: "Written elsewhere" } }]);
    await store.syncFromDisk();
    expect(field("panel:notes").value).toBe("Written elsewhere");
  });

  it("close with Escape, giving the keyboard back to the chip, and on a press elsewhere", () => {
    notesChip().click();
    field("panel:notes").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(notesPop().hidden).toBe(true);
    expect(document.activeElement).toBe(notesChip());
    notesChip().click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(notesPop().hidden).toBe(true);
  });
});
