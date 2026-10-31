// @vitest-environment happy-dom
import { memoryDraftStore, TEXT_LIMITS } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { placeToolbar } from "../src/toolbar.ts";
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
  // Most of these tests work in the method scene: two texts, an image and no sources.
  editor.select("method");
});
afterEach(() => editor.destroy());

const toolbar = () => host.querySelector<HTMLElement>(".ed-toolbar") as HTMLElement;
const visible = () => !toolbar().hidden;
const part = <T extends HTMLElement = HTMLElement>(name: string) =>
  toolbar().querySelector(`[data-tb='${name}']`) as T;
// A text that cites a source is drawn inside a wrapper, so the editable part may sit under the block's element.
const textBox = (id: string) =>
  host.querySelector<HTMLElement>(
    `[data-id='${id}'] [data-edit], [data-id='${id}'][data-edit]`,
  ) as HTMLElement;
const frames = () => new Promise((done) => window.requestAnimationFrame(done));
const blockNode = (id: string) =>
  host.querySelector<HTMLElement>(`.ed-frame [data-id='${id}']`) as HTMLElement;
const method = () => store.session.doc.scenes.method;
const textOf = (id: string) => {
  const block = method()?.blocks.find((candidate) => candidate.id === id);
  return block?.type === "text" ? block : undefined;
};
const press = (node: Element, key: string, init: KeyboardEventInit = {}) =>
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const hintText = () => host.querySelector(".ed-hint")?.textContent ?? "";
const chooseRole = (value: string) => {
  const select = part<HTMLSelectElement>("role");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("where the toolbar goes", () => {
  const host = { width: 1000, height: 560 };
  const size = { width: 300, height: 40 };

  it("floats above the block, lined up with its left edge", () => {
    const spot = placeToolbar({ left: 120, top: 200, width: 400, height: 60 }, host, size);
    expect(spot).toEqual({ left: 120, top: 152, side: "above" });
  });

  it("flips below the block when there is no room above it", () => {
    const spot = placeToolbar({ left: 120, top: 30, width: 400, height: 60 }, host, size);
    expect(spot).toEqual({ left: 120, top: 98, side: "below" });
  });

  it("keeps itself inside the slide on the right and on the left", () => {
    expect(placeToolbar({ left: 900, top: 200, width: 80, height: 40 }, host, size).left).toBe(700);
    expect(placeToolbar({ left: -40, top: 200, width: 80, height: 40 }, host, size).left).toBe(0);
  });

  it("sits inside the top edge of a block that fills the slide", () => {
    const spot = placeToolbar({ left: 0, top: 0, width: 1000, height: 560 }, host, size);
    expect(spot).toEqual({ left: 0, top: 0, side: "inside" });
  });

  it("is placed against the block's real position on the next frame after the slide is drawn", async () => {
    textBox("method-body").focus();
    await frames();
    expect(toolbar().dataset.side).toMatch(/^(above|below|inside)$/);
    expect(toolbar().style.left).toMatch(/px$/);
  });

  it("does not report the last block's side while it still has to be placed for the next one", async () => {
    textBox("method-heading").focus();
    await frames();
    expect(toolbar().dataset.side).toBeDefined();
    textBox("method-body").focus();
    expect(toolbar().dataset.side).toBeUndefined();
    await frames();
    expect(toolbar().dataset.side).toBeDefined();
  });
});

describe("choosing text", () => {
  it("is hidden until something is chosen", () => {
    expect(visible()).toBe(false);
  });

  it("shows the toolbar for the text that is focused, with its role and its count against the limit", () => {
    textBox("method-body").focus();
    expect(editor.blockId).toBe("method-body");
    expect(visible()).toBe(true);
    expect(toolbar().getAttribute("role")).toBe("toolbar");
    expect(toolbar().getAttribute("aria-label")).toBe("Text options");
    expect(part<HTMLSelectElement>("role").value).toBe("body");
    expect(part("count").textContent).toBe(`94 / ${TEXT_LIMITS.body}`);
    expect(part("count").getAttribute("aria-label")).toBe(`94 of ${TEXT_LIMITS.body} characters`);
  });

  it("offers exactly the roles the core has, by name", () => {
    textBox("method-body").focus();
    const options = [...part<HTMLSelectElement>("role").options].map((option) => [option.value, option.text]);
    expect(options).toEqual([
      ["heading", "Heading"],
      ["body", "Body"],
      ["caption", "Caption"],
      ["quote", "Quote"],
    ]);
  });

  it("follows the choice to the next block and to the claim", () => {
    textBox("method-heading").focus();
    expect(part<HTMLSelectElement>("role").value).toBe("heading");
    expect(part("count").textContent).toBe(`35 / ${TEXT_LIMITS.heading}`);
    textBox("method-body").focus();
    expect(part<HTMLSelectElement>("role").value).toBe("body");
  });

  it("goes away when another scene is chosen, since the block is not in it", () => {
    textBox("method-body").focus();
    editor.select("opening");
    expect(editor.blockId).toBeUndefined();
    expect(visible()).toBe(false);
  });

  it("is chosen by a click on the slide, and a click on empty slide lets go of it", () => {
    textBox("method-body").focus();
    host.querySelector<HTMLElement>(".ed-main")?.click();
    expect(editor.blockId).toBeUndefined();
    expect(visible()).toBe(false);
  });

  it("stays when the toolbar itself is clicked", () => {
    textBox("method-body").focus();
    part("count").click();
    expect(editor.blockId).toBe("method-body");
    expect(visible()).toBe(true);
  });
});

describe("the count", () => {
  it("follows what is typed, and warns when it is over the limit without changing the deck", () => {
    textBox("method-heading").focus();
    const box = textBox("method-heading");
    box.textContent = "x".repeat(TEXT_LIMITS.heading + 5);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(part("count").textContent).toBe(`${TEXT_LIMITS.heading + 5} / ${TEXT_LIMITS.heading}`);
    expect(part("count").hasAttribute("data-over")).toBe(true);
    expect(hintText()).toContain("over the limit");
    expect(textOf("method-heading")?.text).not.toContain("xxxxx");

    box.textContent = "Short again";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(part("count").textContent).toBe(`11 / ${TEXT_LIMITS.heading}`);
    expect(part("count").hasAttribute("data-over")).toBe(false);
    expect(hintText()).toBe("");
  });

  it("does not repeat in the line under the slide, which is only for what was refused", () => {
    textBox("method-heading").focus();
    expect(hintText()).toBe("");
  });

  it("follows an undo", () => {
    textBox("method-heading").focus();
    chooseRole("caption");
    expect(part("count").textContent).toBe(`35 / ${TEXT_LIMITS.caption}`);
    store.session.undo();
    expect(part("count").textContent).toBe(`35 / ${TEXT_LIMITS.heading}`);
  });
});

describe("the role", () => {
  it("changes the block in one step, redraws it, and keeps the keyboard on the control", () => {
    textBox("method-heading").focus();
    const select = part<HTMLSelectElement>("role");
    select.focus();
    chooseRole("caption");
    expect(textOf("method-heading")?.role).toBe("caption");
    expect(part<HTMLSelectElement>("role")).toBe(select);
    expect(document.activeElement).toBe(select);
    expect(editor.blockId).toBe("method-heading");
    store.session.undo();
    expect(textOf("method-heading")?.role).toBe("heading");
    expect(part<HTMLSelectElement>("role").value).toBe("heading");
  });

  it("is refused when the text is too long for it, says why, and leaves the block as it was", () => {
    textBox("method-body").focus();
    chooseRole("heading");
    expect(textOf("method-body")?.role).toBe("body");
    expect(part<HTMLSelectElement>("role").value).toBe("body");
    expect(hintText()).toMatch(/\S/);
    expect(host.querySelector(".ed-hint")?.hasAttribute("data-problem")).toBe(true);
    expect(store.session.canUndo).toBe(false);
  });

  it("clears the message about an earlier refusal when the next change works", () => {
    textBox("method-body").focus();
    chooseRole("heading");
    expect(hintText()).toMatch(/\S/);
    chooseRole("quote");
    expect(hintText()).toBe("");
  });
});

describe("citing sources", () => {
  const withSources = () =>
    store.session.apply([
      {
        op: "scene.set",
        id: "method",
        set: {
          sources: [
            { id: "first-source", title: "First source" },
            { id: "second-source", title: "Second source" },
          ],
        },
      },
    ]);

  it("opens a list of the scene's sources from the chip, and closes it again", () => {
    withSources();
    textBox("method-body").focus();
    const chip = part<HTMLButtonElement>("cite");
    const pop = toolbar().querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
    expect(pop.hidden).toBe(true);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    chip.click();
    expect(pop.hidden).toBe(false);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect([...pop.querySelectorAll("label")].map((label) => label.textContent)).toEqual([
      "First source",
      "Second source",
    ]);
    chip.click();
    expect(pop.hidden).toBe(true);
  });

  it("cites and uncites a source on the block, one undo step each, and counts them on the chip", () => {
    withSources();
    textBox("method-body").focus();
    part("cite").click();
    const boxes = () => [...toolbar().querySelectorAll<HTMLInputElement>("input[data-tb='source']")];
    const second = boxes()[1] as HTMLInputElement;
    second.checked = true;
    second.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textOf("method-body")?.sourceIds).toEqual(["second-source"]);
    expect(part("cite").textContent).toContain("1");
    expect(part("cite").getAttribute("aria-label")).toBe("Cite a source, 1 cited");

    const first = boxes()[0] as HTMLInputElement;
    first.checked = true;
    first.dispatchEvent(new Event("change", { bubbles: true }));
    // The sources stay in the order the scene lists them, not the order they were ticked.
    expect(textOf("method-body")?.sourceIds).toEqual(["first-source", "second-source"]);

    second.checked = false;
    second.dispatchEvent(new Event("change", { bubbles: true }));
    first.checked = false;
    first.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textOf("method-body")?.sourceIds).toBeUndefined();
    expect(part("cite").getAttribute("aria-label")).toBe("Cite a source");

    store.session.undo();
    expect(textOf("method-body")?.sourceIds).toEqual(["first-source"]);
    expect(boxes().map((box) => box.checked)).toEqual([true, false]);
  });

  it("keeps the list open and its box focused while a source is ticked", () => {
    withSources();
    textBox("method-body").focus();
    part("cite").click();
    const box = toolbar().querySelector<HTMLInputElement>("input[data-tb='source']") as HTMLInputElement;
    box.focus();
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toolbar().querySelector<HTMLElement>(".ed-tb-pop")?.hidden).toBe(false);
    expect(toolbar().querySelector("input[data-tb='source']")).toBe(box);
    expect(document.activeElement).toBe(box);
  });

  it("says when the scene has no sources, and opens the scene panel where they are added", () => {
    textBox("method-body").focus();
    part("cite").click();
    expect(toolbar().querySelector(".ed-tb-pop")?.textContent).toContain("no sources");
    part("open-sources").click();
    const scenePop = host.querySelector<HTMLElement>(".ed-scene-tools .ed-tb-pop") as HTMLElement;
    expect(scenePop.hidden).toBe(false);
    expect(scenePop.querySelector<HTMLDetailsElement>("details[data-section='sources']")?.open).toBe(true);
  });

  it("shows the sources a block already cites", () => {
    withSources();
    store.session.apply([
      { op: "block.set", scene: "method", id: "method-body", set: { sourceIds: ["second-source"] } },
    ]);
    textBox("method-body").focus();
    part("cite").click();
    const checked = [...toolbar().querySelectorAll<HTMLInputElement>("input[data-tb='source']")].map(
      (box) => box.checked,
    );
    expect(checked).toEqual([false, true]);
  });
});

describe("removing a block", () => {
  it("takes the block out in one step, chooses its neighbour, and undoes", () => {
    textBox("method-body").focus();
    part<HTMLButtonElement>("remove").click();
    expect(method()?.blocks.map((block) => block.id)).toEqual(["method-heading", "method-diagram"]);
    expect(editor.blockId).toBe("method-diagram");
    store.session.undo();
    expect(method()?.blocks.map((block) => block.id)).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
    ]);
  });

  it("names what it removes for a screen reader", () => {
    textBox("method-body").focus();
    expect(part("remove").getAttribute("aria-label")).toBe("Remove this text");
  });

  it("takes the claim out with the steps that revealed it, as one step", () => {
    editor.select("demand");
    textBox("claim-shift").focus();
    expect(toolbar().getAttribute("aria-label")).toBe("Claim options");
    expect(part("count").textContent).toBe("30 / 280");
    part<HTMLButtonElement>("remove").click();
    const demand = store.session.doc.scenes.demand;
    expect(demand?.summary).toBeUndefined();
    expect(demand?.steps?.some((step) => step.reveal.includes("claim-shift"))).toBe(false);
    expect(editor.blockId).toBeUndefined();
    expect(visible()).toBe(false);
    store.session.undo();
    expect(store.session.doc.scenes.demand?.summary?.id).toBe("claim-shift");
  });

  it("refuses to remove the last block of a scene, and says why", () => {
    editor.select("opening");
    textBox("opening-sub").focus();
    part<HTMLButtonElement>("remove").click();
    textBox("opening-title").focus();
    part<HTMLButtonElement>("remove").click();
    expect(store.session.doc.scenes.opening?.blocks).toHaveLength(1);
    expect(hintText()).toMatch(/\S/);
    expect(editor.blockId).toBe("opening-title");
  });

  it("acts on the scene being edited when two scenes use the same block id", () => {
    const opening = store.session.doc.scenes.opening;
    store.session.apply([
      {
        op: "block.add",
        scene: "method",
        block: { id: "twin", type: "text", role: "body", text: "In method" },
      },
      {
        op: "block.add",
        scene: "opening",
        block: { id: "twin", type: "text", role: "body", text: "In opening" },
      },
    ]);
    editor.select("method");
    textBox("twin").focus();
    part<HTMLButtonElement>("remove").click();
    expect(method()?.blocks.some((block) => block.id === "twin")).toBe(false);
    expect(store.session.doc.scenes.opening?.blocks.some((block) => block.id === "twin")).toBe(true);
    expect(opening).toBeDefined();
  });
});

describe("blocks that are not text", () => {
  it("get a toolbar that names the block and removes it", () => {
    blockNode("method-diagram").click();
    expect(editor.blockId).toBe("method-diagram");
    expect(visible()).toBe(true);
    expect(toolbar().getAttribute("aria-label")).toBe("Block options");
    expect(toolbar().textContent).toContain("Image: Diagram");
    expect(toolbar().querySelector("[data-tb='role']")).toBeNull();
    part<HTMLButtonElement>("remove").click();
    expect(method()?.blocks.some((block) => block.id === "method-diagram")).toBe(false);
  });

  it("are removed by Delete or Backspace while focused, and the removal can be undone", () => {
    const node = blockNode("method-diagram");
    node.focus();
    press(node, "Delete");
    expect(method()?.blocks.some((block) => block.id === "method-diagram")).toBe(false);
    store.session.undo();
    expect(method()?.blocks.some((block) => block.id === "method-diagram")).toBe(true);
    press(blockNode("method-diagram"), "Backspace");
    expect(method()?.blocks.some((block) => block.id === "method-diagram")).toBe(false);
  });

  it("do not lose a character of text when Delete is pressed in a text field", () => {
    const box = textBox("method-body");
    box.focus();
    press(box, "Delete");
    expect(textOf("method-body")).toBeDefined();
    expect(method()?.blocks).toHaveLength(3);
  });
});

describe("the keyboard", () => {
  it("lets go of the choice on Escape from a text field, and from a block", () => {
    textBox("method-body").focus();
    press(textBox("method-body"), "Escape");
    expect(editor.blockId).toBeUndefined();
    expect(visible()).toBe(false);

    const node = blockNode("method-diagram");
    node.click();
    expect(visible()).toBe(true);
    press(node, "Escape");
    expect(editor.blockId).toBeUndefined();
    expect(visible()).toBe(false);
  });

  it("moves between blocks in the order the slide has them, which is how the browser tabs", () => {
    const order = [...host.querySelectorAll<HTMLElement>(".ed-frame [data-edit], .ed-frame [data-pick]")].map(
      (node) => node.dataset.id,
    );
    editor.select("method");
    const tabbable = [...host.querySelectorAll<HTMLElement>(".ed-frame [data-edit], .ed-frame [data-pick]")];
    expect(tabbable.every((node) => node.tabIndex === 0)).toBe(true);
    expect(tabbable.map((node) => node.dataset.id)).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
    ]);
    expect(order.length).toBeGreaterThan(0);
  });

  it("reaches the toolbar with Alt+F10, and Escape there gives the keyboard back to the block", () => {
    textBox("method-body").focus();
    press(document.body, "F10", { altKey: true });
    expect(document.activeElement).toBe(part("role"));
    press(part("role"), "Escape");
    expect(document.activeElement).toBe(textBox("method-body"));
    expect(editor.blockId).toBe("method-body");
  });

  it("does nothing on Alt+F10 when nothing is chosen", () => {
    const before = document.activeElement;
    press(document.body, "F10", { altKey: true });
    expect(document.activeElement).toBe(before);
  });

  it("closes the sources list first on Escape, and puts the keyboard back on the chip", () => {
    textBox("method-body").focus();
    part("cite").click();
    press(toolbar().querySelector("input, button[data-tb='open-sources']") as Element, "Escape");
    expect(toolbar().querySelector<HTMLElement>(".ed-tb-pop")?.hidden).toBe(true);
    expect(document.activeElement).toBe(part("cite"));
    expect(editor.blockId).toBe("method-body");
  });
});

// Typing and choosing in the toolbar's own forms, which are the details panel's fields in a popover.
const control = <T extends HTMLElement = HTMLInputElement>(key: string): T => {
  const found = toolbar().querySelector<T>(`[data-field="${key}"]`);
  if (!found) throw new Error(`no control with data-field ${key} in the toolbar`);
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
const popOf = (name: string) =>
  part(name).closest(".ed-tb-chip-wrap")?.querySelector<HTMLElement>(".ed-tb-pop") as HTMLElement;
const flush = () => new Promise((done) => setTimeout(done, 0));
const chooseFile = (key: string, file: File) => {
  const input = control(key);
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("a chart's toolbar", () => {
  const chart = () => {
    const block = store.session.doc.scenes.demand?.blocks.find(
      (candidate) => candidate.id === "chart-demand",
    );
    if (block?.type !== "bar-chart") throw new Error("the chart should be there");
    return block;
  };
  const labels = () => chart().data.map((row) => row.label);

  beforeEach(() => {
    editor.select("demand");
    blockNode("chart-demand").click();
  });

  it("has the data and the sources to cite, and nothing that is only for text", () => {
    expect(visible()).toBe(true);
    expect(toolbar().textContent).toContain("Chart: Share of orders");
    expect(part("data")).not.toBeNull();
    expect(part("cite")).not.toBeNull();
    expect(toolbar().querySelector("[data-tb='role']")).toBeNull();
    expect(popOf("data").hidden).toBe(true);
  });

  it("opens the data with the title, the unit and a line for each row", () => {
    part<HTMLButtonElement>("data").click();
    expect(popOf("data").hidden).toBe(false);
    expect(part("data").getAttribute("aria-expanded")).toBe("true");
    expect(control("chart:title").value).toBe("Share of orders, latest quarter");
    expect(control("chart:unit").value).toBe("%");
    expect(popOf("data").querySelectorAll(".ed-chart-row")).toHaveLength(2);
  });

  it("sets the title and the unit as they are typed, and drops each when it is emptied", () => {
    part<HTMLButtonElement>("data").click();
    typeInto(control("chart:title"), "Where orders come from");
    expect(chart().title).toBe("Where orders come from");
    typeInto(control("chart:title"), "");
    expect("title" in chart()).toBe(false);
    typeInto(control("chart:unit"), "pct");
    expect(chart().unit).toBe("pct");
    typeInto(control("chart:unit"), "");
    expect("unit" in chart()).toBe(false);
  });

  it("refuses a unit that is too long, says why, and keeps the old one", () => {
    part<HTMLButtonElement>("data").click();
    typeInto(control("chart:unit"), "x".repeat(17));
    expect(chart().unit).toBe("%");
    expect(control("chart:unit").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the field being typed in, so the caret stays where it is", () => {
    part<HTMLButtonElement>("data").click();
    const input = control("chart:title");
    typeInto(input, "A");
    typeInto(input, "AB");
    expect(control("chart:title")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("edits a row's label and value, and refuses a value that is not a number", () => {
    part<HTMLButtonElement>("data").click();
    typeInto(control("chart:row0:label"), "Alpha");
    typeInto(control("chart:row0:value"), "55");
    expect(chart().data[0]).toEqual({ label: "Alpha", value: 55 });
    typeInto(control("chart:row0:value"), "");
    expect(chart().data[0]).toEqual({ label: "Alpha", value: 55 });
    expect(control("chart:row0:value").getAttribute("aria-invalid")).toBe("true");
  });

  it("adds a row and puts the keyboard on its label", () => {
    part<HTMLButtonElement>("data").click();
    control<HTMLButtonElement>("chart:addrow").click();
    expect(chart().data[2]).toEqual({ label: "Item 3", value: 0 });
    expect(document.activeElement).toBe(control("chart:row2:label"));
  });

  it("removes a row, and never the last one", () => {
    part<HTMLButtonElement>("data").click();
    control<HTMLButtonElement>("chart:row0:remove").click();
    expect(labels()).toEqual(["Channel B"]);
    expect(control<HTMLButtonElement>("chart:row0:remove").disabled).toBe(true);
  });

  it("moves a row up or down, and disables the moves that go nowhere", () => {
    part<HTMLButtonElement>("data").click();
    expect(control<HTMLButtonElement>("chart:row0:up").disabled).toBe(true);
    expect(control<HTMLButtonElement>("chart:row1:down").disabled).toBe(true);
    control<HTMLButtonElement>("chart:row0:down").click();
    expect(labels()).toEqual(["Channel B", "Channel A"]);
    control<HTMLButtonElement>("chart:row1:up").click();
    expect(labels()).toEqual(["Channel A", "Channel B"]);
  });

  it("sorts by value, largest first, and the other way round when pressed again", () => {
    part<HTMLButtonElement>("data").click();
    control<HTMLButtonElement>("chart:sort").click();
    expect(chart().data.map((row) => row.value)).toEqual([60, 40]);
    control<HTMLButtonElement>("chart:sort").click();
    expect(chart().data.map((row) => row.value)).toEqual([40, 60]);
  });

  it("stops offering rows at the most a chart holds", () => {
    const many = Array.from({ length: 24 }, (_, index) => ({ label: `Row ${index}`, value: index }));
    store.session.apply([{ op: "block.set", scene: "demand", id: "chart-demand", set: { data: many } }]);
    part<HTMLButtonElement>("data").click();
    expect(control<HTMLButtonElement>("chart:addrow").disabled).toBe(true);
  });

  it("draws the rows again after an undo, without closing", () => {
    part<HTMLButtonElement>("data").click();
    control<HTMLButtonElement>("chart:addrow").click();
    expect(popOf("data").querySelectorAll(".ed-chart-row")).toHaveLength(3);
    store.session.undo();
    expect(popOf("data").querySelectorAll(".ed-chart-row")).toHaveLength(2);
    expect(popOf("data").hidden).toBe(false);
  });

  it("shows a typed change in the details panel too", () => {
    part<HTMLButtonElement>("data").click();
    typeInto(control("chart:title"), "Seen in both");
    const inspector = host.querySelector<HTMLInputElement>("[data-field='block:chart-demand:title']");
    expect(inspector?.value).toBe("Seen in both");
  });

  it("closes with Escape and gives the keyboard to its chip, and then to the block", () => {
    part<HTMLButtonElement>("data").click();
    press(control("chart:title"), "Escape");
    expect(popOf("data").hidden).toBe(true);
    expect(document.activeElement).toBe(part("data"));
    press(part("data"), "Escape");
    expect(document.activeElement).toBe(blockNode("chart-demand"));
  });

  it("closes when the pointer goes down anywhere else", () => {
    part<HTMLButtonElement>("data").click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(popOf("data").hidden).toBe(true);
  });

  it("opens one popover at a time", () => {
    part<HTMLButtonElement>("data").click();
    part<HTMLButtonElement>("cite").click();
    expect(popOf("data").hidden).toBe(true);
    expect(popOf("cite").hidden).toBe(false);
  });

  it("cites sources like any block, and says how many on the chip", () => {
    expect(part("cite").textContent).toContain("1");
    expect(part("cite").getAttribute("aria-label")).toBe("Cite a source, 1 cited");
    part<HTMLButtonElement>("cite").click();
    const box = popOf("cite").querySelector<HTMLInputElement>("input[data-tb='source']") as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect("sourceIds" in chart()).toBe(false);
    expect(part("cite").getAttribute("aria-label")).toBe("Cite a source");
  });
});

describe("an image's toolbar", () => {
  const image = () => {
    const block = method()?.blocks.find((candidate) => candidate.id === "method-diagram");
    if (block?.type !== "image") throw new Error("the image should be there");
    return block;
  };

  beforeEach(() => {
    blockNode("method-diagram").click();
    part<HTMLButtonElement>("edit").click();
  });

  it("offers the image files in the deck, and only those", () => {
    const select = control<HTMLSelectElement>("image:asset");
    expect([...select.options].map((option) => option.value)).toEqual(["assets/method.svg"]);
    expect(select.value).toBe("assets/method.svg");
  });

  it("changes the file to another image in the deck", () => {
    server.assets.push("assets/second.png");
    store.session.addAssets(["assets/second.png"]);
    choose(control<HTMLSelectElement>("image:asset"), "assets/second.png");
    expect(image().asset).toBe("assets/second.png");
  });

  it("requires alt text, and shows the new text on the toolbar's label", () => {
    typeInto(control("image:alt"), "");
    expect(image().alt).toMatch(/^Diagram/);
    expect(control("image:alt").getAttribute("aria-invalid")).toBe("true");
    typeInto(control("image:alt"), "Flow of the method");
    expect(image().alt).toBe("Flow of the method");
    expect(toolbar().textContent).toContain("Image: Flow of the method");
  });

  it("sets a caption and clears it again", () => {
    typeInto(control("image:caption"), "Figure 1");
    expect(image().caption).toBe("Figure 1");
    typeInto(control("image:caption"), "");
    expect("caption" in image()).toBe(false);
  });

  it("uploads a replacement and uses it", async () => {
    chooseFile("image:upload", new File(["x"], "new.png", { type: "image/png" }));
    await flush();
    expect(image().asset).toBe("assets/new.png");
  });

  it("says why an upload failed, and keeps the image", async () => {
    server.uploadAsset = async () => {
      throw new Error("That file is not an image the editor accepts.");
    };
    chooseFile("image:upload", new File(["x"], "notes.txt", { type: "text/plain" }));
    await flush();
    expect(image().asset).toBe("assets/method.svg");
    expect(hintText()).toBe("That file is not an image the editor accepts.");
  });
});

describe("a clip's toolbar", () => {
  const clip = () => {
    const block = method()?.blocks.find((candidate) => candidate.id === "method-clip");
    if (block?.type !== "clip") throw new Error("the clip should be there");
    return block;
  };

  beforeEach(() => {
    server.assets.push("assets/intro.mp4", "assets/intro.webm");
    store.session.addAssets(["assets/intro.mp4", "assets/intro.webm"]);
    store.session.apply([
      {
        op: "block.add",
        scene: "method",
        block: { id: "method-clip", type: "clip", source: "assets/intro.mp4", alt: "The intro" },
      },
    ]);
    blockNode("method-clip").click();
    part<HTMLButtonElement>("edit").click();
  });

  it("offers the video files in the deck, and only those", () => {
    const select = control<HTMLSelectElement>("clip:source");
    expect([...select.options].map((option) => option.value)).toEqual([
      "assets/intro.mp4",
      "assets/intro.webm",
    ]);
  });

  it("changes the video, sets a poster from the images and clears it again", () => {
    choose(control<HTMLSelectElement>("clip:source"), "assets/intro.webm");
    expect(clip().source).toBe("assets/intro.webm");
    expect([...control<HTMLSelectElement>("clip:poster").options].map((option) => option.value)).toEqual([
      "",
      "assets/method.svg",
    ]);
    choose(control<HTMLSelectElement>("clip:poster"), "assets/method.svg");
    expect(clip().poster).toBe("assets/method.svg");
    choose(control<HTMLSelectElement>("clip:poster"), "");
    expect("poster" in clip()).toBe(false);
  });

  it("requires alt text", () => {
    typeInto(control("clip:alt"), "");
    expect(clip().alt).toBe("The intro");
    expect(control("clip:alt").getAttribute("aria-invalid")).toBe("true");
    typeInto(control("clip:alt"), "A short intro");
    expect(clip().alt).toBe("A short intro");
  });
});

describe("a claim's toolbar", () => {
  const claim = () => store.session.doc.scenes.demand?.summary;

  beforeEach(() => {
    editor.select("demand");
    textBox("claim-shift").focus();
  });

  it("has an Evidence chip that says how many blocks it rests on", () => {
    expect(toolbar().getAttribute("aria-label")).toBe("Claim options");
    expect(part("evidence").textContent).toContain("1");
    expect(part("evidence").getAttribute("aria-label")).toBe("Evidence for the claim, 1 chosen");
  });

  it("lists the scene's blocks, with the ones that are evidence ticked", () => {
    part<HTMLButtonElement>("evidence").click();
    const boxes = [...popOf("evidence").querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
    expect(boxes.map((box) => [box.value, box.checked])).toEqual([["chart-demand", true]]);
  });

  it("takes a block out of the evidence and puts it back", () => {
    part<HTMLButtonElement>("evidence").click();
    const box = control<HTMLInputElement>("panel:evidence:chart-demand");
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(claim()?.evidenceIds).toEqual([]);
    expect(part("evidence").getAttribute("aria-label")).toBe("Evidence for the claim");
    control<HTMLInputElement>("panel:evidence:chart-demand").click();
    expect(claim()?.evidenceIds).toEqual(["chart-demand"]);
  });

  it("offers a block added to the scene afterwards", () => {
    store.session.apply([
      {
        op: "block.add",
        scene: "demand",
        block: { id: "demand-note", type: "text", role: "body", text: "A note" },
      },
    ]);
    part<HTMLButtonElement>("evidence").click();
    expect(control("panel:evidence:demand-note")).not.toBeNull();
  });
});
