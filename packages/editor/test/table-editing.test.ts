// @vitest-environment happy-dom
import { type Block, memoryDraftStore, type Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { copiedBlock, wordsOf } from "../src/clipboard.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import type { TableBlock } from "../src/tablecells.ts";
import { FakeServer } from "./helpers.ts";

/*
 * A table in the mounted editor: adding one, typing in its cells, the menu of a cell, the toolbar's Table chip, and the
 * table on the clipboard. The grid's own keys and the paste parser are in grid.test.ts.
 */

const SCENE = "demand";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

const REGIONS: TableBlock = {
  id: "table-regions",
  type: "table",
  title: "Demand by region",
  columns: [{ label: "Region" }, { label: "Share", kind: "number", unit: "%" }],
  rows: [
    ["North", 42],
    ["South", 58],
  ],
};

beforeEach(async () => {
  server = new FakeServer();
  store = await openStore(server, () => memoryDraftStore());
  host = document.createElement("div");
  document.body.replaceChildren(host);
  editor = mountEditor(host, store);
  editor.select(SCENE);
});
afterEach(() => {
  editor.destroy();
  vi.restoreAllMocks();
});

const scene = () => store.session.doc.scenes[SCENE] as Scene;
const tables = () => scene().blocks.filter((block): block is TableBlock => block.type === "table");
const only = () => {
  const [found] = tables();
  if (!found) throw new Error("the scene should have a table");
  return found;
};
const withTable = (block: Block = REGIONS) => {
  const result = store.session.apply([{ op: "block.add", scene: SCENE, block }]);
  if (!result.ok) throw new Error(result.diagnostics.map((each) => each.message).join(" "));
  editor.select(SCENE);
};

const cell = (row: number, column: number, id = tables()[0]?.id) =>
  host.querySelector<HTMLElement>(
    `.ed-frame [data-id='${id}'] [data-row="${row}"][data-col="${column}"]`,
  ) as HTMLElement;
const press = (node: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
};
const input = () => host.querySelector<HTMLInputElement>(".ed-grid-input") as HTMLInputElement;
const type = (text: string) => {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
};
const hint = () => host.querySelector(".ed-hint")?.textContent ?? "";

const menu = () => host.querySelector<HTMLElement>(".ed-menu:not(.ed-menu-sub)") as HTMLElement;
const labels = () =>
  [...menu().children].map((child) =>
    child.classList.contains("ed-menu-sep")
      ? "-"
      : (child.querySelector(".ed-menu-label")?.textContent ?? ""),
  );
const item = (name: string) =>
  [...menu().querySelectorAll<HTMLElement>(".ed-menu-item")].find(
    (node) => node.querySelector(".ed-menu-label")?.textContent === name,
  ) as HTMLElement;
const context = (node: Element) => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 300,
    clientY: 200,
  });
  node.dispatchEvent(event);
  return event;
};

/** Takes the table back to where it was by one step of Undo, and says whether that was all the edit took. */
const undone = () => {
  store.session.undo();
  return JSON.stringify(only());
};

describe("adding a table", () => {
  it("is a button of the quick bar that adds three columns and three empty rows, under a header row", async () => {
    (host.querySelector("[data-quick='table']") as HTMLElement).click();
    await vi.waitFor(() => expect(tables()).toHaveLength(1));
    expect(only()).toEqual({
      id: "demand-table",
      type: "table",
      columns: [{ label: "Column 1" }, { label: "Column 2" }, { label: "Column 3" }],
      rows: [
        [null, null, null],
        [null, null, null],
        [null, null, null],
      ],
    });
    const grid = host.querySelector(".ed-frame [data-id='demand-table'] [role='grid']");
    expect(grid).not.toBeNull();
    expect(host.querySelectorAll(".ed-frame [data-id='demand-table'] th[scope='col']")).toHaveLength(3);
    expect(editor.blockId).toBe("demand-table");
  });

  it("is one step of Undo", async () => {
    const before = scene().blocks.length;
    (host.querySelector("[data-quick='table']") as HTMLElement).click();
    await vi.waitFor(() => expect(tables()).toHaveLength(1));
    store.session.undo();
    expect(scene().blocks).toHaveLength(before);
  });

  it("is a command of the palette, named Add a table", async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    (host.querySelector(".ed-palette [data-command='add-table']") as HTMLElement).click();
    await vi.waitFor(() => expect(tables()).toHaveLength(1));
  });

  it("is on the menu of the empty slide, after the chart", () => {
    context(host.querySelector(".ed-canvas-host .dc-view") as HTMLElement);
    expect(labels()).toContain("Add a table here");
    expect(labels().indexOf("Add a table here")).toBe(labels().indexOf("Add a chart here") + 1);
  });
});

describe("typing in cells", () => {
  beforeEach(() =>
    withTable({ ...REGIONS, columns: [{ label: "A" }, { label: "B" }], rows: [[null, null]] }),
  );

  it("writes exactly what was typed after the three cells are typed with Tab, and each cell is one step of Undo", () => {
    const start = JSON.stringify(only());
    cell(0, 0).click();
    type("one");
    press(input(), "Tab");
    press(cell(0, 1), "t");
    press(input(), "Enter");
    expect(only().rows).toEqual([["one", "t"]]);
    expect(store.session.canUndo).toBe(true);
    // The first undo takes back the second cell alone, and the second takes back the first.
    store.session.undo();
    expect(only().rows).toEqual([["one", null]]);
    expect(undone()).toBe(start);
  });

  it("does not draw the slide again under the cell being typed in", () => {
    cell(0, 0).click();
    const before = cell(0, 0);
    type("kept");
    press(input(), "Enter");
    expect(cell(0, 0)).toBe(before);
    // The table has one row, so Enter has no row below to go to and stays on the cell it finished.
    expect(document.activeElement).toBe(cell(0, 0));
  });

  it("chooses the table when a cell is pressed", () => {
    cell(0, 0).click();
    expect(editor.blockId).toBe(only().id);
  });
});

describe("a column of numbers", () => {
  beforeEach(() => withTable());

  it("takes a number, and refuses words with the reason in the line under the slide", () => {
    cell(0, 1).click();
    type("4.5");
    press(input(), "Enter");
    expect(only().rows[0]).toEqual(["North", 4.5]);
    press(cell(1, 1), "F2");
    type("plenty");
    press(input(), "Enter");
    expect(hint()).toContain('"plenty" is not a number');
    expect(only().rows[1]).toEqual(["South", 58]);
  });
});

describe("the menu of a cell", () => {
  beforeEach(() => withTable());

  it("is the cell menu, and lists what can be done to the row, the column and the table", () => {
    expect(context(cell(0, 0)).defaultPrevented).toBe(true);
    expect(menu().getAttribute("aria-label")).toBe("Cell menu");
    expect(labels()).toEqual([
      "Insert row above",
      "Insert row below",
      "Insert column left",
      "Insert column right",
      "-",
      "Delete row",
      "Delete column",
      "-",
      "Hide header row",
      "Make column numbers",
    ]);
  });

  it("leaves out what cannot be done at the header, and what the table cannot hold", () => {
    context(cell(-1, 1));
    expect(labels()).not.toContain("Insert row above");
    expect(labels()).not.toContain("Delete row");
    expect(labels()).toContain("Make column text");
  });

  it("leaves the menu of the block to the rest of the table", () => {
    context(host.querySelector(".ed-frame [data-id='table-regions'] caption") as HTMLElement);
    expect(menu().getAttribute("aria-label")).toBe("Block menu");
    expect(labels()).toContain("Delete");
    expect(labels()).not.toContain("Insert row below");
  });

  it("inserts a row below as one step of Undo, and puts the keyboard on the cell", () => {
    const before = JSON.stringify(only());
    context(cell(0, 0));
    item("Insert row below").click();
    expect(only().rows).toEqual([
      ["North", 42],
      [null, null],
      ["South", 58],
    ]);
    expect(document.activeElement).toBe(cell(0, 0));
    expect(undone()).toBe(before);
  });

  it("inserts a row above a row, and a column on either side, each with the cells it needs", () => {
    context(cell(1, 0));
    item("Insert row above").click();
    expect(only().rows).toEqual([
      ["North", 42],
      [null, null],
      ["South", 58],
    ]);
    context(cell(0, 1));
    item("Insert column left").click();
    expect(only().columns.map((column) => column.label)).toEqual(["Region", "Column 3", "Share"]);
    expect(only().rows[0]).toEqual(["North", null, 42]);
    context(cell(0, 2));
    item("Insert column right").click();
    expect(only().columns).toHaveLength(4);
    expect(only().columns[2]).toEqual({ label: "Share", kind: "number", unit: "%" });
  });

  it("deletes a row and a column, and is not offered the last of either", () => {
    context(cell(0, 0));
    item("Delete row").click();
    expect(only().rows).toEqual([["South", 58]]);
    context(cell(0, 0));
    expect(labels()).not.toContain("Delete row");
    item("Delete column").click();
    expect(only().columns).toEqual([{ label: "Share", kind: "number", unit: "%" }]);
    expect(only().rows).toEqual([[58]]);
    context(cell(0, 0));
    expect(labels()).not.toContain("Delete column");
  });

  it("hides and shows the header row", () => {
    context(cell(0, 0));
    item("Hide header row").click();
    expect(only().header).toBe(false);
    expect(host.querySelector(".ed-frame [data-id='table-regions'] thead tr")).toBeNull();
    context(cell(0, 0));
    item("Show header row").click();
    expect(only().header).toBeUndefined();
    expect(host.querySelector(".ed-frame [data-id='table-regions'] thead tr")).not.toBeNull();
  });

  it("makes a column hold numbers when its words are numbers, and refuses with the reason when they are not", () => {
    withTable({
      id: "table-words",
      type: "table",
      columns: [{ label: "Year" }, { label: "Note" }],
      rows: [
        ["2024", "fine"],
        ["2025", null],
      ],
    });
    const id = "table-words";
    context(cell(0, 0, id));
    item("Make column numbers").click();
    const table = tables().find((block) => block.id === id) as TableBlock;
    expect(table.columns[0]).toEqual({ label: "Year", kind: "number" });
    expect(table.rows).toEqual([
      [2024, "fine"],
      [2025, null],
    ]);
    context(cell(0, 1, id));
    item("Make column numbers").click();
    expect(hint()).toContain('"fine", which is not a number');
    expect((tables().find((block) => block.id === id) as TableBlock).columns[1]).toEqual({ label: "Note" });
  });

  it("is also in the palette for the chosen table, at the cell the keyboard is on", () => {
    cell(1, 0).focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    (host.querySelector(".ed-palette [data-command='cell-row-below']") as HTMLElement).click();
    expect(only().rows).toEqual([
      ["North", 42],
      ["South", 58],
      [null, null],
    ]);
  });

  it("opens from the keyboard on the cell that has it", () => {
    cell(1, 1).focus();
    const event = press(cell(1, 1), "F10", { shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(menu().getAttribute("aria-label")).toBe("Cell menu");
  });
});

describe("the Table chip of the toolbar", () => {
  beforeEach(() => withTable());

  const open = () => {
    cell(0, 0).click();
    const chip = host.querySelector<HTMLElement>(".ed-toolbar [data-tb='table']") as HTMLElement;
    chip.click();
    return chip.closest(".ed-tb-chip-wrap")?.querySelector(".ed-tb-pop") as HTMLElement;
  };
  const field = (pop: Element, key: string) => pop.querySelector(`[data-field="${key}"]`) as HTMLInputElement;

  it("sets the title, and takes it away when it is emptied", () => {
    const title = field(open(), "table:title");
    title.value = "Share of demand";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    expect(only().title).toBe("Share of demand");
    title.value = "";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    expect(only().title).toBeUndefined();
  });

  it("hides the header row with its checkbox, and shows it again", () => {
    const box = field(open(), "table:header:header");
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(only().header).toBe(false);
  });

  it("sets what a column holds, and the unit of a number column", () => {
    const pop = open();
    const unit = field(pop, "table:col1:unit");
    unit.value = "pts";
    unit.dispatchEvent(new Event("input", { bubbles: true }));
    expect(only().columns[1]).toEqual({ label: "Share", kind: "number", unit: "pts" });
    unit.value = "";
    unit.dispatchEvent(new Event("input", { bubbles: true }));
    expect(only().columns[1]).toEqual({ label: "Share", kind: "number" });
    expect(field(pop, "table:col0:unit")).toBeNull();
    const kind = field(pop, "table:col1:kind") as unknown as HTMLSelectElement;
    kind.value = "text";
    kind.dispatchEvent(new Event("change", { bubbles: true }));
    expect(only().columns[1]).toEqual({ label: "Share" });
    expect(only().rows[0]).toEqual(["North", "42"]);
  });
});

describe("a table on the clipboard", () => {
  beforeEach(() => withTable());

  it("is its rows, tab-separated with the header first, as plain text, and the whole block in the envelope", () => {
    const copied = copiedBlock(only(), "en");
    expect(copied.words).toBe("Region\tShare\nNorth\t42\nSouth\t58");
    expect(JSON.parse(copied.json).block).toEqual(only());
  });

  it("writes numbers the way the deck's language does, and leaves the header out when it is hidden", () => {
    const table: TableBlock = {
      ...only(),
      header: false,
      columns: [{ label: "A" }, { label: "B", kind: "number" }],
      rows: [["x", 1.5]],
    };
    expect(wordsOf(table, "de")).toBe("x\t1,5");
  });

  it("quotes a cell with a tab, a line break or a quote, the way a spreadsheet does", () => {
    const table: TableBlock = {
      ...only(),
      header: false,
      columns: [{ label: "A" }, { label: "B" }],
      rows: [['say "hi"', "a\tb"]],
    };
    expect(wordsOf(table)).toBe('"say ""hi"""\t"a\tb"');
  });

  it("is copied from a cell as the whole table, and the copy is pasted after it as a table of its own", () => {
    cell(0, 0).focus();
    const data = new Map<string, string>();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => data.get(type) ?? "",
        setData: (type: string, text: string) => data.set(type, text),
      },
    });
    cell(0, 0).dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(data.get("text/plain")).toBe("Region\tShare\nNorth\t42\nSouth\t58");
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], getData: (type: string) => data.get(type) ?? "", setData() {} },
    });
    cell(0, 0).dispatchEvent(paste);
    expect(tables()).toHaveLength(2);
    const [original, duplicate] = tables() as [TableBlock, TableBlock];
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.columns).toEqual(original.columns);
    expect(duplicate.rows).toEqual(original.rows);
    // The grid took the paste for the editor, so the table's own cells are as they were.
    expect(original.rows).toEqual(REGIONS.rows);
  });

  it("is pasted as cells, and not as a block, when it is tab-separated text from a spreadsheet", () => {
    withTable({
      id: "table-blank",
      type: "table",
      columns: [{ label: "Column 1" }, { label: "Column 2" }],
      rows: [
        [null, null],
        [null, null],
      ],
    });
    const id = "table-blank";
    cell(0, 0, id).focus();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        files: [],
        getData: (type: string) => (type === "text/plain" ? "Fruit\tCount\nApple\t3\nPear\t5" : ""),
        setData() {},
      },
    });
    cell(0, 0, id).dispatchEvent(paste);
    expect(tables()).toHaveLength(2);
    const filled = tables().find((block) => block.id === id) as TableBlock;
    expect(filled.columns).toEqual([{ label: "Fruit" }, { label: "Count", kind: "number" }]);
    expect(filled.rows).toEqual([
      ["Apple", 3],
      ["Pear", 5],
    ]);
  });
});
