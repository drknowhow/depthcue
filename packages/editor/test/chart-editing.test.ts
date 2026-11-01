// @vitest-environment happy-dom
import { type Block, type ChartBlock, memoryDraftStore, type Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Editor, mountEditor } from "../src/app.ts";
import { type EditorStore, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

/*
 * A chart in the mounted editor: adding one, the grid of its Data popover, and the menu of a right-click. The grid's own
 * keys and its paste parser are in grid.test.ts, and what each kind of chart draws is in the player's chart.test.ts.
 */

const SCENE = "demand";

let host: HTMLElement;
let server: FakeServer;
let store: EditorStore;
let editor: Editor;

const SALES: ChartBlock = {
  id: "chart-sales",
  type: "chart",
  kind: "bar",
  title: "Sales",
  unit: "k",
  columns: [{ label: "Quarter" }, { label: "North" }, { label: "South" }],
  rows: [
    ["Q1", 4, 6],
    ["Q2", 5, 7],
    ["Q3", 9, 8],
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
const chart = (id = SALES.id) => {
  const found = scene().blocks.find((block) => block.id === id);
  if (found?.type !== "chart") throw new Error("the scene should have the chart");
  return found;
};
const withChart = (block: Block = SALES) => {
  const result = store.session.apply([{ op: "block.add", scene: SCENE, block }]);
  if (!result.ok) throw new Error(result.diagnostics.map((each) => each.message).join(" "));
  editor.select(SCENE);
  (host.querySelector(`.ed-frame [data-id='${block.id}']`) as HTMLElement).click();
};

const dataChip = () => host.querySelector<HTMLElement>(".ed-toolbar [data-tb='data']") as HTMLElement;
const openData = () => {
  dataChip().click();
  return dataChip().closest(".ed-tb-chip-wrap")?.querySelector(".ed-tb-pop") as HTMLElement;
};
const cell = (row: number, column: number) =>
  host.querySelector<HTMLElement>(`.ed-chart-grid [data-row="${row}"][data-col="${column}"]`) as HTMLElement;
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
const pasted = (node: Element, text: string) => {
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { files: [], getData: (kind: string) => (kind === "text/plain" ? text : ""), setData() {} },
  });
  node.dispatchEvent(paste);
};
const tool = (action: string) =>
  host.querySelector<HTMLElement>(`.ed-chart-data [data-chart='${action}']`) as HTMLElement;

const menu = () => host.querySelector<HTMLElement>(".ed-menu:not(.ed-menu-sub)") as HTMLElement;
const context = (node: Element) =>
  node.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 }),
  );
const rightClickChart = (id = SALES.id) =>
  context(host.querySelector(`.ed-frame [data-id='${id}']`) as Element);
const command = (id: string) => menu().querySelector<HTMLElement>(`[data-command='${id}']`) as HTMLElement;
const labels = () =>
  [...menu().children].map((child) =>
    child.classList.contains("ed-menu-sep")
      ? "-"
      : (child.querySelector(".ed-menu-label")?.textContent ?? ""),
  );

describe("adding a chart", () => {
  it("is a bar chart of three rows under a header row, in the grid that edits any chart", async () => {
    (host.querySelector("[data-quick='chart']") as HTMLElement).click();
    await vi.waitFor(() => expect(scene().blocks.some((block) => block.type === "chart")).toBe(true));
    const added = chart("demand-chart");
    expect(added.kind).toBe("bar");
    expect(added.rows).toHaveLength(3);
    expect(editor.blockId).toBe("demand-chart");
    // The chart on the slide draws it, and says it to a screen reader as a table.
    const drawn = host.querySelector(".ed-frame [data-id='demand-chart']");
    expect(drawn?.querySelector("svg.dc-plot[role='img']")).not.toBeNull();
    expect(drawn?.querySelectorAll(".dc-sr-only tbody tr")).toHaveLength(3);
  });

  it("is one step of Undo", async () => {
    const before = scene().blocks.length;
    (host.querySelector("[data-quick='chart']") as HTMLElement).click();
    await vi.waitFor(() => expect(scene().blocks.length).toBe(before + 1));
    store.session.undo();
    expect(scene().blocks).toHaveLength(before);
  });

  it("is a command of the palette, named Add a chart, and finds the chart by its kinds", () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(host.querySelector(".ed-palette [data-command='add-chart']")).not.toBeNull();
  });
});

describe("the Data popover", () => {
  beforeEach(() => withChart());

  it("holds the chart's rows in the grid, with the categories naming the rows and the other columns as series", () => {
    openData();
    expect(host.querySelectorAll(".ed-chart-grid th[scope='col']")).toHaveLength(3);
    expect(cell(0, 0).getAttribute("role")).toBe("rowheader");
    expect(cell(0, 1).getAttribute("role")).toBe("gridcell");
    expect(cell(0, 1).classList.contains("dc-num")).toBe(true);
    expect(cell(0, 0).classList.contains("dc-num")).toBe(false);
    expect(cell(2, 2).textContent).toBe("8");
  });

  it("writes a typed cell as one change that the slide shows, and is one step of Undo each", () => {
    openData();
    const start = JSON.stringify(chart());
    cell(0, 1).click();
    type("12");
    press(input(), "Enter");
    expect(chart().rows[0]).toEqual(["Q1", 12, 6]);
    expect(host.querySelector(".ed-frame [data-id='chart-sales'] .dc-sr-only")?.textContent).toContain("12");
    cell(1, 0).click();
    type("Spring");
    press(input(), "Enter");
    expect(chart().rows[1]?.[0]).toBe("Spring");
    store.session.undo();
    expect(chart().rows[1]?.[0]).toBe("Q2");
    store.session.undo();
    expect(JSON.stringify(chart())).toBe(start);
  });

  it("shows what the deck has again after an undo that was not the grid's own edit", () => {
    openData();
    cell(1, 1).click();
    type("20");
    press(input(), "Enter");
    store.session.undo();
    // The grid is drawn again from the deck, and the number it shows is the one the deck has.
    expect(cell(1, 1).textContent).toBe("5");
  });

  it("takes a pasted 4 by 3 block of numbers as one change: words for the categories, numbers for the series", () => {
    withChart({ ...SALES, id: "chart-blank", columns: [{ label: "A" }, { label: "B" }], rows: [["x", 1]] });
    openData();
    cell(0, 0).focus();
    pasted(cell(0, 0), "1\t2\t3\n4\t5\t6\n7\t8\t9\n10\t11\t12");
    expect(chart("chart-blank").rows).toEqual([
      ["1", 2, 3],
      ["4", 5, 6],
      ["7", 8, 9],
      ["10", 11, 12],
    ]);
    expect(chart("chart-blank").columns).toHaveLength(3);
    store.session.undo();
    expect(chart("chart-blank").rows).toEqual([["x", 1]]);
  });

  it("refuses a paste that puts words in a series, with the grid's reason, and changes nothing", () => {
    openData();
    const before = JSON.stringify(chart());
    cell(0, 1).focus();
    pasted(cell(0, 1), "5\nplenty");
    expect(hint()).toContain("plenty");
    expect(JSON.stringify(chart())).toBe(before);
  });

  it("says why the core refused a cell, and the fix, in the line under the slide", () => {
    openData();
    cell(0, 0).click();
    type("");
    press(input(), "Enter");
    // A row with no category is refused by the core, in the words `depthcue check` uses.
    expect(hint()).toContain("Row 1 has no category label.");
    expect(hint()).toContain("Write the label for this row, or remove the row.");
    expect(chart().rows[0]?.[0]).toBe("Q1");
  });

  it("adds a row under the one the keyboard is on, with a category to rename", () => {
    openData();
    cell(1, 1).focus();
    tool("row").click();
    expect(chart().rows).toHaveLength(4);
    expect(chart().rows[2]).toEqual(["Row 4", null, null]);
    expect(document.activeElement).toBe(cell(2, 0));
    store.session.undo();
    expect(chart().rows).toHaveLength(3);
  });

  it("adds a series after the column the keyboard is on, and takes one away", () => {
    openData();
    cell(0, 1).focus();
    tool("series").click();
    expect(chart().columns.map((column) => column.label)).toEqual(["Quarter", "North", "Series 3", "South"]);
    expect(chart().rows[0]).toEqual(["Q1", 4, null, 6]);
    cell(0, 2).focus();
    tool("delete-series").click();
    expect(chart().columns.map((column) => column.label)).toEqual(["Quarter", "North", "South"]);
    expect(chart().rows[0]).toEqual(["Q1", 4, 6]);
  });

  it("will not take away the categories, or the last row, or the last series, and says so", () => {
    openData();
    cell(0, 0).focus();
    tool("delete-series").click();
    expect(hint()).toContain("Press a cell of the series first");
    expect(chart().columns).toHaveLength(3);
    withChart({
      id: "chart-one",
      type: "chart",
      kind: "bar",
      columns: [{ label: "A" }, { label: "B" }],
      rows: [["x", 1]],
    });
    openData();
    cell(0, 1).focus();
    tool("delete-series").click();
    expect(hint()).toBe("A chart needs at least one series.");
    tool("delete-row").click();
    expect(hint()).toBe("A chart needs at least one row.");
    expect(chart("chart-one").rows).toHaveLength(1);
  });

  it("refuses a second series on a donut, with the core's reason and its fix", () => {
    withChart({
      ...SALES,
      id: "chart-share",
      kind: "donut",
      columns: SALES.columns.slice(0, 2),
      rows: [["a", 1]],
    });
    openData();
    cell(0, 1).focus();
    tool("series").click();
    expect(hint()).toContain("A donut shows one series, and this one has 2.");
    expect(hint()).toContain("Keep the label column and one series, or choose another kind of chart.");
    expect(chart("chart-share").columns).toHaveLength(2);
  });

  it("holds the title and the unit, each a change of its own", () => {
    const pop = openData();
    const title = pop.querySelector<HTMLInputElement>("[data-field='data:title']") as HTMLInputElement;
    title.value = "Sales by quarter";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    expect(chart().title).toBe("Sales by quarter");
    const unit = pop.querySelector<HTMLInputElement>("[data-field='data:unit']") as HTMLInputElement;
    unit.value = "";
    unit.dispatchEvent(new Event("input", { bubbles: true }));
    expect(chart().unit).toBeUndefined();
  });

  it("has a scatter's x values as numbers, and does not name its rows to a screen reader", () => {
    withChart({
      id: "chart-xy",
      type: "chart",
      kind: "scatter",
      columns: [{ label: "x" }, { label: "y" }],
      rows: [
        [1, 2],
        [3, 4],
      ],
    });
    openData();
    expect(cell(0, 0).classList.contains("dc-num")).toBe(true);
    expect(cell(0, 0).getAttribute("role")).toBe("gridcell");
    cell(0, 0).click();
    type("7");
    press(input(), "Enter");
    expect(chart("chart-xy").rows[0]).toEqual([7, 2]);
  });

  it("is drawn again, with the new kind's grid, when the kind changes under it", () => {
    openData();
    expect(cell(0, 0).getAttribute("role")).toBe("rowheader");
    store.session.apply([
      { op: "block.set", scene: SCENE, id: SALES.id, set: { kind: "scatter", rows: [[1, 2, 3]] } },
    ]);
    expect(cell(0, 0).getAttribute("role")).toBe("gridcell");
    expect(cell(0, 0).textContent).toBe("1");
  });
});

describe("the menu of a right-click on a chart", () => {
  beforeEach(() => withChart());

  it("lists the data first, then a submenu of the six kinds with the chart's own marked", () => {
    rightClickChart();
    expect(menu().getAttribute("aria-label")).toBe("Block menu");
    expect(labels().slice(0, 3)).toEqual(["Edit data", "Chart type", "-"]);
    const kinds = [
      ...menu().querySelectorAll<HTMLElement>("[data-command^='chart-'][role^='menuitem']"),
    ].filter((node) => node.dataset.command !== "chart-data");
    expect(kinds.map((node) => node.querySelector(".ed-menu-label")?.textContent)).toEqual([
      "Bar",
      "Stacked bar",
      "Line",
      "Area",
      "Scatter",
      "Donut",
    ]);
    expect(kinds.map((node) => node.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(kinds.every((node) => node.getAttribute("role") === "menuitemradio")).toBe(true);
  });

  it("greys a kind the data cannot take, says why, and does nothing when it is chosen", () => {
    rightClickChart();
    const donut = command("chart-donut");
    expect(donut.getAttribute("aria-disabled")).toBe("true");
    expect(donut.querySelector(".ed-menu-why")?.textContent).toBe(
      "A donut shows one series, and this one has 2.",
    );
    const scatter = command("chart-scatter");
    expect(scatter.getAttribute("aria-disabled")).toBe("true");
    expect(scatter.querySelector(".ed-menu-why")?.textContent).toContain('"Q1", which is not a number');
    donut.click();
    // The menu stays open and the chart stays as it was.
    expect(menu().hidden).toBe(false);
    expect(chart().kind).toBe("bar");
    expect(command("chart-line").getAttribute("aria-disabled")).toBeNull();
  });

  it("lets the keyboard reach a greyed kind, reads its reason, and does nothing on Enter", () => {
    rightClickChart();
    const donut = command("chart-donut");
    donut.focus();
    expect(document.activeElement).toBe(donut);
    // The reason is part of what a screen reader reads for the item.
    expect(donut.textContent).toContain("A donut shows one series");
    press(donut, "Enter");
    press(donut, " ");
    expect(menu().hidden).toBe(false);
    expect(chart().kind).toBe("bar");
  });

  it("changes the kind keeping the data, as one step of Undo each, and the slide shows the new kind", () => {
    rightClickChart();
    command("chart-line").click();
    expect(chart().kind).toBe("line");
    expect(chart().rows).toEqual(SALES.rows);
    expect(chart().columns).toEqual(SALES.columns);
    const drawn = host.querySelector(".ed-frame [data-id='chart-sales']") as HTMLElement;
    expect(drawn.matches("[data-kind='line']") || drawn.querySelector("[data-kind='line']") !== null).toBe(
      true,
    );
    rightClickChart();
    command("chart-stacked-bar").click();
    expect(chart().kind).toBe("stacked-bar");
    expect(chart().rows).toEqual(SALES.rows);
    store.session.undo();
    expect(chart().kind).toBe("line");
    store.session.undo();
    expect(chart().kind).toBe("bar");
  });

  it("marks the kind it is, and does nothing for it", () => {
    rightClickChart();
    command("chart-line").click();
    rightClickChart();
    expect(command("chart-line").getAttribute("aria-checked")).toBe("true");
    expect(command("chart-bar").getAttribute("aria-checked")).toBe("false");
    const undoable = store.session.canUndo;
    command("chart-line").click();
    expect(store.session.canUndo).toBe(undoable);
    store.session.undo();
    expect(chart().kind).toBe("bar");
  });

  it("turns the categories into x values when the data allows a scatter, and back to words for another kind", () => {
    withChart({
      ...SALES,
      id: "chart-years",
      columns: [{ label: "Year" }, { label: "Sales" }],
      rows: [
        ["2020", 3],
        ["2021", 5],
      ],
    });
    rightClickChart("chart-years");
    command("chart-scatter").click();
    expect(chart("chart-years").kind).toBe("scatter");
    expect(chart("chart-years").rows).toEqual([
      [2020, 3],
      [2021, 5],
    ]);
    rightClickChart("chart-years");
    command("chart-area").click();
    expect(chart("chart-years").rows).toEqual([
      ["2020", 3],
      ["2021", 5],
    ]);
    // Undo takes back the kind and the first column together.
    store.session.undo();
    expect(chart("chart-years").kind).toBe("scatter");
    expect(chart("chart-years").rows[0]).toEqual([2020, 3]);
  });

  it("takes a donut when the data is one series of parts", () => {
    withChart({
      ...SALES,
      id: "chart-parts",
      columns: SALES.columns.slice(0, 2),
      rows: [
        ["a", 1],
        ["b", 3],
      ],
    });
    rightClickChart("chart-parts");
    expect(command("chart-donut").getAttribute("aria-disabled")).toBeNull();
    command("chart-donut").click();
    expect(chart("chart-parts").kind).toBe("donut");
  });

  it("opens the Data popover with the keyboard on its grid from Edit data", () => {
    rightClickChart();
    command("chart-data").click();
    expect(dataChip().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(cell(-1, 0));
  });

  it("leaves a greyed kind out of the palette, which lists only what works", () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const listed = [...host.querySelectorAll<HTMLElement>(".ed-palette [data-command]")].map(
      (node) => node.dataset.command,
    );
    expect(listed).toContain("chart-line");
    expect(listed).toContain("chart-data");
    expect(listed).not.toContain("chart-donut");
    expect(listed).not.toContain("chart-scatter");
  });
});

describe("an old bar chart", () => {
  it("keeps its bar dragging until it is converted, and the menu converts it to any kind as one step of Undo", () => {
    expect(scene().blocks.some((block) => block.id === "chart-demand" && block.type === "bar-chart")).toBe(
      true,
    );
    (host.querySelector(".ed-frame [data-id='chart-demand']") as HTMLElement).click();
    expect(host.querySelector(".ed-frame [data-id='chart-demand'] .dc-bar[role='slider']")).not.toBeNull();
    const before = scene().blocks.map((block) => block.id);
    rightClickChart("chart-demand");
    // The old chart has no data grid yet, and offers every kind, none marked.
    expect(labels()).toContain("Chart type");
    expect(menu().querySelector("[data-command='chart-data']")).toBeNull();
    expect(command("chart-line").getAttribute("aria-checked")).toBeNull();
    command("chart-line").click();
    expect(scene().blocks.map((block) => block.id)).toEqual(before);
    const converted = chart("chart-demand");
    expect(converted.kind).toBe("line");
    expect(converted.columns[0]?.label).toBe("Label");
    expect(host.querySelector(".ed-frame [data-id='chart-demand'] .dc-bar[role='slider']")).toBeNull();
    store.session.undo();
    expect(scene().blocks.find((block) => block.id === "chart-demand")?.type).toBe("bar-chart");
  });

  it("keeps what the claim cites and the steps that name it", () => {
    const before = scene();
    rightClickChart("chart-demand");
    command("chart-bar").click();
    expect(scene().summary).toEqual(before.summary);
    expect(scene().steps).toEqual(before.steps);
  });
});

describe("a chart on the clipboard", () => {
  it("is written as the table it is, with the header first", async () => {
    const { wordsOf } = await import("../src/clipboard.ts");
    expect(wordsOf(SALES, "en")).toBe("Quarter\tNorth\tSouth\nQ1\t4\t6\nQ2\t5\t7\nQ3\t9\t8");
  });
});
