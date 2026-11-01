// @vitest-environment happy-dom
import type { Block } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hydrate } from "../src/modules/table.ts";
import type { HydrateContext, ModuleInstance } from "../src/modules.ts";
import { renderReading } from "../src/reading.ts";
import { renderScene } from "../src/scene.ts";
import { numberText, renderTable } from "../src/table.ts";
import { demoSource, sceneWith } from "./helpers.ts";

type Table = Extract<Block, { type: "table" }>;

const table: Table = {
  id: "t-table",
  type: "table",
  title: "Orders by channel",
  columns: [{ label: "Channel" }, { label: "Orders", kind: "number", unit: "units" }, { label: "Note" }],
  rows: [
    ["A", 4000, "steady"],
    ["B", 3.5, null],
    ["C", null, "new"],
  ],
  sourceIds: ["t-source"],
};

const scene = (block: Table = table) =>
  sceneWith({
    schemaVersion: "0.3",
    layout: "text-media",
    blocks: [block],
    sources: [{ id: "t-source", title: "Order snapshot" }],
  });

let root: HTMLElement;
let instance: ModuleInstance | undefined;
let announced: string[];

beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  announced = [];
});
afterEach(() => {
  instance?.dispose?.();
  instance = undefined;
  root.remove();
});

const cells = (row: Element) => [...row.children].map((cell) => cell.textContent);

describe("a table in the player", () => {
  it("is a real table with its title as the caption and a column header for each column", () => {
    const node = renderTable(table);
    expect(node.tagName).toBe("TABLE");
    expect(node.querySelector("caption")?.textContent).toBe("Orders by channel");
    const heads = [...node.querySelectorAll("thead th")];
    expect(heads.map((head) => head.getAttribute("scope"))).toEqual(["col", "col", "col"]);
    expect(heads.map((head) => head.textContent)).toEqual(["Channel", "Orders (units)", "Note"]);
    expect([...node.querySelectorAll("tbody tr")].map(cells)).toEqual([
      ["A", "4000", "steady"],
      ["B", "3.5", ""],
      ["C", "", "new"],
    ]);
  });

  it("aligns a number column to the right, in the header and in its cells, and no other", () => {
    const node = renderTable(table);
    const numeric = [...node.querySelectorAll(".dc-num")];
    expect(numeric).toHaveLength(1 + table.rows.length);
    expect(numeric.every((cell) => cell.matches("th:nth-child(2), td:nth-child(2)"))).toBe(true);
    expect(node.querySelector(".dc-unit")?.textContent).toBe(" (units)");
  });

  it("leaves the header out when the block hides it, and shows an empty cell as nothing", () => {
    const node = renderTable({ ...table, header: false });
    expect(node.querySelector("thead")).toBeNull();
    expect(node.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(renderTable({ ...table, header: true }).querySelector("thead")).not.toBeNull();
    expect(renderTable({ ...table, title: undefined }).querySelector("caption")).toBeNull();
  });

  it("sets every word as text, never as markup", () => {
    const hostile: Table = {
      ...table,
      title: "<img src=x onerror=boom()>",
      columns: [{ label: "<b>Channel</b>" }, { label: "&amp;", unit: "<i>" }],
      rows: [["<script>boom()</script>", null]],
    };
    const node = renderTable(hostile);
    expect(node.querySelector("img, b, i, script")).toBeNull();
    expect(node.querySelector("caption")?.textContent).toBe("<img src=x onerror=boom()>");
    expect(node.querySelector("td")?.textContent).toBe("<script>boom()</script>");
    expect(node.querySelector("th:nth-child(2)")?.textContent).toBe("&amp; (<i>)");
  });

  it("writes numbers with the deck's language: its decimal sign, and no thousands separator", () => {
    expect(numberText(1234567.25, "en")).toBe("1234567.25");
    expect(numberText(1234567.25, "de")).toBe("1234567,25");
    expect(numberText(2024, "pt-BR")).toBe("2024");
    expect(numberText(0.1 + 0.2, "en")).toBe("0.30000000000000004");
    expect(numberText(3.5, "not a language tag")).toBe("3.5");
    const node = renderTable(table, "de");
    expect(node.querySelector("tbody tr:nth-child(2) td:nth-child(2)")?.textContent).toBe("3,5");
  });

  it("takes the place of the block in a scene, and keeps its citation, step and frame", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.3",
        layout: "text-media",
        blocks: [{ ...table, frame: { x: 10, y: 10, w: 40, h: 40 } }],
        steps: [{ id: "t-step", reveal: ["t-table"] }],
        sources: [{ id: "t-source", title: "Order snapshot" }],
      }),
      { assetBase: ".", language: "en" },
    );
    const pinned = section.querySelector<HTMLElement>(".dc-pins [data-id='t-table']");
    expect(pinned?.querySelector("table.dc-table")).not.toBeNull();
    expect(pinned?.dataset.gated).toBe("");
    expect(pinned?.querySelector(".dc-cite")?.textContent).toBe("Source: Order snapshot");
    expect(section.querySelector(".dc-placeholder")).toBeNull();
    // The room it leaves in its region is a copy nobody can reach.
    expect(section.querySelector(".dc-ghost table")).not.toBeNull();
    expect(section.querySelector(".dc-ghost")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is in the reading view, as a table", () => {
    const source = demoSource();
    const reading = renderReading(source.deck, [scene()], { assetBase: ".", language: "en" });
    expect(reading.querySelector("figure table.dc-table caption")?.textContent).toBe("Orders by channel");
    expect(reading.querySelectorAll("tbody tr")).toHaveLength(3);
  });
});

describe("the table module", () => {
  function mount(block: Table = table): HydrateContext {
    root.append(renderScene(scene(block), { assetBase: "." }));
    const node = root.querySelector<HTMLElement>("[data-id='t-table']") as HTMLElement;
    return {
      block,
      node,
      scene: scene(block),
      deck: demoSource().deck,
      assetBase: ".",
      readJson: () => Promise.reject(new Error("No files.")),
      reducedMotion: true,
      announce: (message) => announced.push(message),
    };
  }
  const rows = () => [...root.querySelectorAll("tbody tr")];
  const marked = () => rows().map((row) => row.hasAttribute("data-active"));

  it("marks the row under the pointer, and takes the mark off when the pointer leaves", () => {
    instance = hydrate(mount()) as ModuleInstance;
    rows()[1]
      ?.querySelector("td")
      ?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(marked()).toEqual([false, true, false]);
    expect(rows()[1]?.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector("[data-id='t-table']")?.hasAttribute("data-table-active")).toBe(true);
    root.querySelector("tbody")?.dispatchEvent(new Event("pointerleave"));
    expect(marked()).toEqual([false, false, false]);
    expect(root.querySelector("[data-id='t-table']")?.hasAttribute("data-table-active")).toBe(false);
  });

  it("marks a row on command, reads it out, and clears it", () => {
    instance = hydrate(mount()) as ModuleInstance;
    instance.commands?.highlight?.({ row: 0 });
    expect(marked()).toEqual([true, false, false]);
    expect(announced).toEqual(["Row 1: A, 4000, steady"]);
    instance.commands?.clear?.(undefined);
    expect(marked()).toEqual([false, false, false]);
  });

  it("refuses a row that is not there, and leaves the table as it was", () => {
    instance = hydrate(mount()) as ModuleInstance;
    for (const bad of [{ row: 3 }, { row: -1 }, { row: 1.5 }, { row: "1" }, null, {}]) {
      expect(() => instance?.commands?.highlight?.(bad), JSON.stringify(bad)).toThrow(/highlight needs/);
    }
    expect(marked()).toEqual([false, false, false]);
    expect(announced).toEqual([]);
  });

  it("leaves the table as it found it when it is disposed", () => {
    const context = mount();
    const before = root.innerHTML;
    instance = hydrate(context) as ModuleInstance;
    instance.commands?.highlight?.({ row: 2 });
    instance.dispose?.();
    expect(root.innerHTML).toBe(before);
    // No pointer handler is left behind.
    rows()[0]
      ?.querySelector("td")
      ?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(marked()).toEqual([false, false, false]);
  });

  it("throws for a block that is not a table, or a table that does not match, so the player keeps the static form", () => {
    const context = mount();
    expect(() => hydrate({ ...context, block: { ...table, rows: [["A", 1, null]] } })).toThrow(
      /does not match/,
    );
    expect(() => hydrate({ ...context, block: { id: "x", type: "text", role: "body", text: "Hi" } })).toThrow(
      /only takes table blocks/,
    );
  });
});
