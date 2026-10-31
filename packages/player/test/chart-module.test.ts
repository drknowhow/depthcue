// @vitest-environment happy-dom
import type { Block, Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hydrate } from "../src/modules/chart.ts";
import type { HydrateContext, ModuleInstance } from "../src/modules.ts";
import { renderScene } from "../src/scene.ts";
import { demoSource, sceneWith } from "./helpers.ts";

type Rows = Array<{ label: string; value: number }>;

let root: HTMLElement;
let instance: ModuleInstance | undefined;

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  instance?.dispose?.();
  instance = undefined;
  root.remove();
});

function chartScene(data: Rows, unit?: string): Scene {
  return sceneWith({
    id: "charts",
    layout: "text-media",
    blocks: [{ id: "the-chart", type: "bar-chart", data, ...(unit ? { unit } : {}) }],
  });
}

/** Renders the block as the player does, then hydrates it. */
function mount(scene: Scene, id: string): HTMLElement {
  root.append(renderScene(scene, { assetBase: "." }));
  const node = root.querySelector<HTMLElement>(`[data-id="${id}"]`) as HTMLElement;
  const target = scene.blocks.find((block) => block.id === id) as Block;
  const context: HydrateContext = {
    block: target,
    node,
    scene,
    deck: demoSource().deck,
    assetBase: ".",
    reducedMotion: true,
    announce: () => {},
  };
  instance = hydrate(context) as ModuleInstance;
  return node;
}

const demo = () => {
  const scene = demoSource().scenes.find((candidate) => candidate.id === "demand") as Scene;
  return mount(scene, "chart-demand");
};

const rows = (node: HTMLElement) => [...node.querySelectorAll<HTMLTableRowElement>("tbody tr")];
const labels = (node: HTMLElement) => rows(node).map((row) => row.querySelector("th")?.textContent);
const readout = (node: HTMLElement) => node.querySelector(".dc-chart-readout")?.textContent;
const sortButton = (node: HTMLElement) => node.querySelector<HTMLButtonElement>("[data-chart='sort']");

function key(target: Element, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const over = (node: Element) => node.dispatchEvent(new Event("pointerover", { bubbles: true }));

describe("what hydrating adds", () => {
  it("adds a toolbar with a sort button and an empty live readout, and keeps the table", () => {
    const node = demo();
    expect(node.querySelector(".dc-chart-tools")).not.toBeNull();
    expect(sortButton(node)?.textContent).toBe("Sort by value");
    expect(sortButton(node)?.getAttribute("aria-pressed")).toBe("false");
    expect(node.querySelector(".dc-chart-readout")?.getAttribute("aria-live")).toBe("polite");
    expect(readout(node)).toBe("");
    expect(labels(node)).toEqual(["Channel A", "Channel B"]);
  });

  it("makes the first row the one tab stop and the rest reachable by arrow key", () => {
    const node = demo();
    expect(rows(node).map((row) => row.tabIndex)).toEqual([0, -1]);
  });
});

describe("marking a row", () => {
  it("marks the row under the pointer and reads out its value and rank", () => {
    const node = demo();
    over(rows(node)[1] as HTMLElement);
    expect(rows(node)[1]?.hasAttribute("data-active")).toBe(true);
    expect(rows(node)[1]?.getAttribute("aria-current")).toBe("true");
    expect(rows(node)[0]?.hasAttribute("data-active")).toBe(false);
    expect(node.hasAttribute("data-chart-active")).toBe(true);
    expect(readout(node)).toBe("Channel B: 60%. 1st of 2.");
  });

  it("moves the mark to another row and takes it off the first", () => {
    const node = demo();
    over(rows(node)[1] as HTMLElement);
    over(rows(node)[0] as HTMLElement);
    expect(rows(node).map((row) => row.hasAttribute("data-active"))).toEqual([true, false]);
    expect(rows(node).map((row) => row.getAttribute("aria-current"))).toEqual(["true", null]);
    expect(readout(node)).toBe("Channel A: 40%. 2nd of 2.");
  });

  it("clears the mark when the pointer leaves the table, but only a mark the pointer made", () => {
    const node = demo();
    const table = node.querySelector("table") as HTMLElement;
    over(rows(node)[0] as HTMLElement);
    table.dispatchEvent(new Event("pointerleave"));
    expect(node.hasAttribute("data-chart-active")).toBe(false);
    expect(readout(node)).toBe("");

    (rows(node)[1] as HTMLElement).focus();
    table.dispatchEvent(new Event("pointerleave"));
    expect(rows(node)[1]?.hasAttribute("data-active")).toBe(true);
  });

  it("treats a mark that focus took over as the keyboard's, so the pointer leaving does not clear it", () => {
    const node = demo();
    const table = node.querySelector("table") as HTMLElement;
    over(rows(node)[0] as HTMLElement);
    (rows(node)[1] as HTMLElement).focus();
    table.dispatchEvent(new Event("pointerleave"));
    expect(rows(node)[1]?.hasAttribute("data-active")).toBe(true);
    expect(readout(node)).toBe("Channel B: 60%. 1st of 2.");
  });

  it("marks the focused row and clears when focus leaves the chart", () => {
    const node = demo();
    (rows(node)[0] as HTMLElement).focus();
    expect(readout(node)).toBe("Channel A: 40%. 2nd of 2.");
    (rows(node)[0] as HTMLElement).blur();
    expect(node.hasAttribute("data-chart-active")).toBe(false);
  });

  it("does not clear the mark when focus is only moving to another row", () => {
    const node = demo();
    const [first, second] = rows(node) as HTMLElement[];
    (first as HTMLElement).focus();
    // happy-dom leaves relatedTarget empty on its own, so name where focus is going.
    (first as HTMLElement).dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: second as HTMLElement }),
    );
    expect(first?.hasAttribute("data-active")).toBe(true);
    (first as HTMLElement).dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }),
    );
    expect(first?.hasAttribute("data-active")).toBe(false);
  });

  it("gives equal values the same rank and numbers the rest after them", () => {
    const node = mount(
      chartScene([
        { label: "a", value: 5 },
        { label: "b", value: 5 },
        { label: "c", value: 1 },
      ]),
      "the-chart",
    );
    over(rows(node)[1] as HTMLElement);
    expect(readout(node)).toBe("b: 5. 1st of 3.");
    over(rows(node)[2] as HTMLElement);
    expect(readout(node)).toBe("c: 1. 3rd of 3.");
  });

  it("writes ordinals correctly, including the teens", () => {
    const data = Array.from({ length: 24 }, (_, i) => ({ label: `r${i}`, value: 100 - i }));
    const node = mount(chartScene(data), "the-chart");
    const said = (at: number) => {
      over(rows(node)[at] as HTMLElement);
      return readout(node);
    };
    expect(said(0)).toContain("1st of 24");
    expect(said(1)).toContain("2nd of 24");
    expect(said(2)).toContain("3rd of 24");
    expect(said(3)).toContain("4th of 24");
    expect(said(10)).toContain("11th of 24");
    expect(said(11)).toContain("12th of 24");
    expect(said(12)).toContain("13th of 24");
    expect(said(20)).toContain("21st of 24");
    expect(said(21)).toContain("22nd of 24");
    expect(said(22)).toContain("23rd of 24");
  });

  it("writes a value with its unit, a space before a word and none before a percent sign", () => {
    const node = mount(chartScene([{ label: "x", value: 3 }], "orders"), "the-chart");
    over(rows(node)[0] as HTMLElement);
    expect(readout(node)).toBe("x: 3 orders. 1st of 1.");
  });
});

describe("the keyboard", () => {
  it("moves focus down and up the rows without going past either end, and keeps the key from the player", () => {
    const node = demo();
    const first = rows(node)[0] as HTMLElement;
    const second = rows(node)[1] as HTMLElement;
    first.focus();
    const down = key(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    expect(down.defaultPrevented).toBe(true);
    key(second, "ArrowDown");
    expect(document.activeElement).toBe(second);
    key(second, "ArrowUp");
    expect(document.activeElement).toBe(first);
    key(first, "ArrowUp");
    expect(document.activeElement).toBe(first);
  });

  it("starts from the first row when an arrow key arrives from somewhere else in the table", () => {
    const node = demo();
    const cell = node.querySelector("td") as HTMLElement;
    key(cell, "ArrowDown");
    expect(document.activeElement).toBe(rows(node)[1]);
  });

  it("follows the order on screen once the rows are sorted", () => {
    const node = demo();
    (sortButton(node) as HTMLElement).click();
    const top = rows(node)[0] as HTMLElement;
    const next = rows(node)[1] as HTMLElement;
    expect(top.querySelector("th")?.textContent).toBe("Channel B");
    top.focus();
    key(top, "ArrowDown");
    expect(document.activeElement).toBe(next);
  });

  it("leaves every other key to the player, so Left and Right still change scenes", () => {
    const node = demo();
    const first = rows(node)[0] as HTMLElement;
    for (const name of ["ArrowRight", "ArrowLeft", "Enter", " ", "Home", "x"]) {
      expect(key(first, name).defaultPrevented, name).toBe(false);
    }
  });

  it("leaves a key with a modifier alone", () => {
    const node = demo();
    const first = rows(node)[0] as HTMLElement;
    first.focus();
    expect(key(first, "ArrowDown", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(first, "s", { metaKey: true }).defaultPrevented).toBe(false);
    expect(key(first, "ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
  });

  it("sorts with s and back again", () => {
    const node = demo();
    const first = rows(node)[0] as HTMLElement;
    expect(key(first, "s").defaultPrevented).toBe(true);
    expect(labels(node)).toEqual(["Channel B", "Channel A"]);
    key(first, "s");
    expect(labels(node)).toEqual(["Channel A", "Channel B"]);
  });

  it("clears the mark with Escape, and ignores Escape when nothing is marked", () => {
    const node = demo();
    const first = rows(node)[0] as HTMLElement;
    expect(key(first, "Escape").defaultPrevented).toBe(false);
    over(first);
    expect(key(first, "Escape").defaultPrevented).toBe(true);
    expect(node.hasAttribute("data-chart-active")).toBe(false);
  });
});

describe("sorting", () => {
  it("orders rows largest first, then restores the order given, and says which", () => {
    const node = demo();
    const button = sortButton(node) as HTMLButtonElement;
    button.click();
    expect(labels(node)).toEqual(["Channel B", "Channel A"]);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(readout(node)).toBe("Largest first.");
    button.click();
    expect(labels(node)).toEqual(["Channel A", "Channel B"]);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(readout(node)).toBe("In the order given.");
  });

  it("keeps equal values in the order given", () => {
    const node = mount(
      chartScene([
        { label: "a", value: 1 },
        { label: "b", value: 3 },
        { label: "c", value: 1 },
        { label: "d", value: 3 },
      ]),
      "the-chart",
    );
    (sortButton(node) as HTMLElement).click();
    expect(labels(node)).toEqual(["b", "d", "a", "c"]);
  });

  it("moves the tab stop to the new first row", () => {
    const node = demo();
    (sortButton(node) as HTMLElement).click();
    expect(rows(node).map((row) => row.tabIndex)).toEqual([0, -1]);
    expect(rows(node)[0]?.querySelector("th")?.textContent).toBe("Channel B");
  });

  it("says how it sorted and keeps the marked row in the readout", () => {
    const node = demo();
    over(rows(node)[0] as HTMLElement);
    (sortButton(node) as HTMLElement).click();
    expect(readout(node)).toBe("Largest first. Channel A: 40%. 2nd of 2.");
    (sortButton(node) as HTMLElement).click();
    expect(readout(node)).toBe("In the order given. Channel A: 40%. 2nd of 2.");
  });

  it("keeps focus on the row it was on when the rows are reordered under it", () => {
    const node = demo();
    const second = rows(node)[1] as HTMLElement;
    second.focus();
    key(second, "s");
    expect(document.activeElement).toBe(second);
    expect(second.hasAttribute("data-active")).toBe(true);
  });
});

describe("commands", () => {
  const run = (name: string, args?: unknown) => {
    const command = instance?.commands?.[name];
    if (!command) throw new Error(`no command ${name}`);
    command(args);
  };

  it("highlights a row by its place in the data, whatever the sort", () => {
    const node = demo();
    run("sort", { by: "value" });
    run("highlight", { row: 0 });
    expect(readout(node)).toBe("Channel A: 40%. 2nd of 2.");
    expect(node.querySelector("[data-active] th")?.textContent).toBe("Channel A");
  });

  it("sorts both ways and clears", () => {
    const node = demo();
    run("sort", { by: "value" });
    expect(labels(node)).toEqual(["Channel B", "Channel A"]);
    run("sort", { by: "original" });
    expect(labels(node)).toEqual(["Channel A", "Channel B"]);
    run("highlight", { row: 1 });
    run("clear");
    expect(node.hasAttribute("data-chart-active")).toBe(false);
    expect(readout(node)).toBe("");
  });

  it("refuses a row that is not a whole number inside the data, and says what it takes", () => {
    demo();
    for (const args of [{ row: 2 }, { row: -1 }, { row: 0.5 }, { row: "0" }, {}, null, undefined]) {
      expect(() => run("highlight", args), JSON.stringify(args)).toThrow(/from 0 to 1/);
    }
  });

  it("refuses an unknown way to sort, and says what it takes", () => {
    demo();
    for (const args of [{ by: "size" }, {}, null, undefined]) {
      expect(() => run("sort", args), JSON.stringify(args)).toThrow(/"by": "value"/);
    }
  });

  it("lists exactly the commands its manifest describes", async () => {
    demo();
    const { chartManifest } = await import("../src/modules/chart-manifest.ts");
    expect(Object.keys(instance?.commands ?? {}).sort()).toEqual(Object.keys(chartManifest.commands).sort());
  });
});

describe("refusing a block it cannot handle", () => {
  it("throws for a block of another type", () => {
    const scene = sceneWith({});
    root.append(renderScene(scene, { assetBase: "." }));
    expect(() =>
      hydrate({
        block: scene.blocks[0] as Block,
        node: root.querySelector("[data-id]") as HTMLElement,
        scene,
        deck: demoSource().deck,
        assetBase: ".",
        reducedMotion: false,
        announce: () => {},
      }),
    ).toThrow(/only takes bar-chart/);
  });

  it("throws when the table is not the one the data describes, so the player shows it unchanged", () => {
    const scene = chartScene([{ label: "a", value: 1 }]);
    root.append(renderScene(scene, { assetBase: "." }));
    const node = root.querySelector("[data-id='the-chart']") as HTMLElement;
    node.querySelector("tbody tr")?.remove();
    expect(() =>
      hydrate({
        block: scene.blocks[0] as Block,
        node,
        scene,
        deck: demoSource().deck,
        assetBase: ".",
        reducedMotion: false,
        announce: () => {},
      }),
    ).toThrow(/does not match its data/);
    expect(node.querySelector(".dc-chart-tools")).toBeNull();
  });
});

describe("disposing", () => {
  it("puts back the order, removes what it added, and stops listening", () => {
    const scene = demoSource().scenes.find((candidate) => candidate.id === "demand") as Scene;
    root.append(renderScene(scene, { assetBase: "." }));
    const node = root.querySelector("[data-id='chart-demand']") as HTMLElement;
    const before = node.outerHTML;
    instance = hydrate({
      block: scene.blocks.find((candidate) => candidate.id === "chart-demand") as Block,
      node,
      scene,
      deck: demoSource().deck,
      assetBase: ".",
      reducedMotion: true,
      announce: () => {},
    }) as ModuleInstance;
    (sortButton(node) as HTMLElement).click();
    over(rows(node)[0] as HTMLElement);
    instance?.dispose?.();
    instance = undefined;
    expect(node.outerHTML).toBe(before);
    expect(node.querySelector(".dc-chart-tools")).toBeNull();
    over(rows(node)[1] as HTMLElement);
    key(rows(node)[0] as HTMLElement, "s");
    expect(node.outerHTML).toBe(before);
  });
});
