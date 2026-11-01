import {
  applyOps,
  type Block,
  type ChartBlock,
  type Doc,
  loadDoc,
  type Op,
  revisionOf,
  type Scene,
} from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { CHART_LIMITS, changesOf, chartCommands, dataChange, gridOf, kindChange } from "../src/chartwire.ts";
import { menuFor } from "../src/contextmenu.ts";
import { problemOf } from "../src/fields.ts";
import { FakeServer } from "./helpers.ts";

function demo(): Doc {
  const server = new FakeServer();
  const { doc } = loadDoc({ text: server.text, assets: server.assets });
  if (!doc) throw new Error("the demo should load");
  return doc;
}

const SCENE = "demand";
const sales = (over: Partial<ChartBlock> = {}): ChartBlock => ({
  id: "sales",
  type: "chart",
  kind: "bar",
  columns: [{ label: "Quarter" }, { label: "North" }, { label: "South" }],
  rows: [
    ["Q1", 4, 6],
    ["Q2", 5, 7],
  ],
  ...over,
});
const parts = (over: Partial<ChartBlock> = {}): ChartBlock =>
  sales({
    columns: [{ label: "Part" }, { label: "Share", unit: "%" }],
    rows: [
      ["a", 1],
      ["b", 3],
    ],
    ...over,
  });

/** A deck with the chart in its demand scene, and that scene. */
function withChart(block: Block) {
  const doc = demo();
  const added = applyOps(doc, [{ op: "block.add", scene: SCENE, block }], revisionOf(doc));
  if (!added.ok) throw new Error(added.diagnostics.map((each) => each.message).join(" "));
  return { doc: added.doc, scene: added.doc.scenes[SCENE] as Scene };
}
const apply = (doc: Doc, ops: Op[]) => applyOps(doc, ops, revisionOf(doc));

describe("a chart as the grid takes it", () => {
  it("has words for the categories and numbers for every series, and a scatter's x values are numbers", () => {
    expect(gridOf(sales()).columns.map((column) => column.numeric)).toEqual([false, true, true]);
    expect(gridOf(sales({ kind: "scatter" })).columns.map((column) => column.numeric)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("is written back with a label and a unit for each column, and no kind", () => {
    const data = gridOf(parts());
    expect(changesOf(data)).toEqual({
      columns: [{ label: "Part" }, { label: "Share", unit: "%" }],
      rows: parts().rows,
    });
    expect(changesOf({ ...data, columns: data.columns.map((column) => ({ ...column, unit: "" })) })).toEqual({
      columns: [{ label: "Part" }, { label: "Share" }],
      rows: parts().rows,
    });
  });

  it("is limited to six series under a column of categories", () => {
    expect(CHART_LIMITS).toMatchObject({ columns: 7, rows: 30 });
  });
});

describe("changing the kind of a chart", () => {
  it("is one block.set of the kind, which keeps the data it was given", () => {
    const { doc, scene } = withChart(sales());
    const change = kindChange(scene, sales(), "line");
    expect(change).toEqual({
      ops: [{ op: "block.set", scene: SCENE, id: "sales", set: { kind: "line" } }],
    });
    const done = apply(doc, "ops" in change ? change.ops : []);
    expect(done.ok && done.doc.scenes[SCENE]?.blocks.find((block) => block.id === "sales")).toMatchObject({
      kind: "line",
      rows: sales().rows,
      columns: sales().columns,
    });
  });

  it("turns the categories into numbers for a scatter, and says which row is not a number when one is not", () => {
    const years = sales({
      columns: [{ label: "Year" }, { label: "Sales" }],
      rows: [
        ["2020", 3],
        ["1,5", 4],
      ],
    });
    const { scene } = withChart(years);
    // 1,5 is one and a half to a deck written in German, and not a number to one written in English.
    expect(kindChange(scene, years, "scatter", "de")).toEqual({
      ops: [
        {
          op: "block.set",
          scene: SCENE,
          id: "sales",
          set: {
            kind: "scatter",
            rows: [
              [2020, 3],
              [1.5, 4],
            ],
          },
        },
      ],
    });
    expect(kindChange(scene, years, "scatter", "en")).toEqual({
      problem: 'Row 2 says "1,5", which is not a number, so it cannot be an x value.',
    });
    const words = kindChange(scene, sales(), "scatter");
    expect(words).toEqual({ problem: 'Row 1 says "Q1", which is not a number, so it cannot be an x value.' });
  });

  it("turns a scatter's numbers back into words for the kinds that name their rows, written as the language writes them", () => {
    const xy = sales({
      kind: "scatter",
      columns: [{ label: "x" }, { label: "y" }],
      rows: [
        [1.5, 2],
        [3, 4],
      ],
    });
    const { scene } = withChart(xy);
    const comma = kindChange(scene, xy, "line", "de");
    expect(comma).toMatchObject({
      ops: [
        {
          set: {
            kind: "line",
            rows: [
              ["1,5", 2],
              ["3", 4],
            ],
          },
        },
      ],
    });
  });

  it("refuses a donut with the core's own reason, for each way the data can fail it", () => {
    const two = withChart(sales());
    expect(kindChange(two.scene, sales(), "donut")).toEqual({
      problem: "A donut shows one series, and this one has 2.",
    });
    const many = parts({ rows: Array.from({ length: 7 }, (_, at) => [`p${at}`, at + 1]) });
    expect(kindChange(withChart(many).scene, many, "donut")).toEqual({
      problem: "A donut has at most 6 parts, and this one has 7.",
    });
    const gap = parts({
      rows: [
        ["a", 1],
        ["b", null],
      ],
    });
    expect(kindChange(withChart(gap).scene, gap, "donut")).toEqual({
      problem: "Part 2 of the donut is empty; each part needs a value of 0 or more.",
    });
    const zero = parts({
      rows: [
        ["a", 0],
        ["b", 0],
      ],
    });
    expect(kindChange(withChart(zero).scene, zero, "donut")).toEqual({
      problem: "The donut's parts add up to 0, so there is nothing to draw.",
    });
    expect(kindChange(withChart(parts()).scene, parts(), "donut")).toHaveProperty("ops");
  });

  it("replaces an old bar chart by the chart that shows it, under the same id, in one transaction", () => {
    const old: Block = {
      id: "old",
      type: "bar-chart",
      title: "Visits",
      unit: "k",
      data: [
        { label: "Mon", value: 3 },
        { label: "Tue", value: 5 },
      ],
    };
    const { doc, scene } = withChart(old);
    const change = kindChange(scene, old, "area");
    if (!("ops" in change)) throw new Error("an old bar chart can be converted");
    expect(change.ops.map((op) => op.op)).toEqual(["block.remove", "block.add"]);
    const done = apply(doc, change.ops);
    if (!done.ok) throw new Error(done.diagnostics[0]?.message);
    const after = done.doc.scenes[SCENE]?.blocks.find((block) => block.id === "old");
    expect(after).toMatchObject({
      type: "chart",
      kind: "area",
      title: "Visits",
      unit: "k",
      columns: [{ label: "Label" }, { label: "Value" }],
      rows: [
        ["Mon", 3],
        ["Tue", 5],
      ],
    });
    // The block stays where it was in the scene's order.
    expect(done.doc.scenes[SCENE]?.blocks.map((block) => block.id)).toEqual(
      scene.blocks.map((block) => block.id),
    );
  });

  it("is not for a block that is not a chart", () => {
    const text: Block = { id: "words", type: "text", role: "body", text: "Words" };
    const { scene } = withChart(text);
    expect(kindChange(scene, text, "line")).toEqual({ problem: "That block is not a chart." });
    expect(chartCommands(scene, text, { chartKind() {} })).toEqual([]);
  });
});

describe("the commands of a chart", () => {
  const commands = (block: ChartBlock) =>
    chartCommands(withChart(block).scene, block, { chartKind() {}, editData() {} }, "en");

  it("are the data, then the six kinds in one submenu, in a section of their own", () => {
    const entries = menuFor(commands(sales()), "block");
    expect(
      entries.map((entry) =>
        entry.kind === "command" ? entry.command.label : entry.kind === "submenu" ? entry.name : "-",
      ),
    ).toEqual(["Edit data", "Chart type"]);
    const submenu = entries[1];
    expect(submenu?.kind === "submenu" && submenu.commands.map((command) => command.label)).toEqual([
      "Bar",
      "Stacked bar",
      "Line",
      "Area",
      "Scatter",
      "Donut",
    ]);
  });

  it("mark the kind the chart is, and grey the kinds it cannot take with the reason", () => {
    const list = commands(sales({ kind: "line" }));
    const by = (id: string) => list.find((command) => command.id === id);
    expect(list.filter((command) => command.checked).map((command) => command.id)).toEqual(["chart-line"]);
    expect(by("chart-donut")?.disabled).toBe("A donut shows one series, and this one has 2.");
    expect(by("chart-scatter")?.disabled).toContain("not a number");
    expect(by("chart-area")?.disabled).toBeUndefined();
  });

  it("do nothing for the kind the chart already is, and ask for the others by id", () => {
    const asked: string[] = [];
    const block = sales();
    const list = chartCommands(withChart(block).scene, block, {
      chartKind: (id, kind) => asked.push(`${id}:${kind}`),
    });
    list.find((command) => command.id === "chart-bar")?.run();
    list.find((command) => command.id === "chart-area")?.run();
    expect(asked).toEqual(["sales:area"]);
  });

  it("have no data command without a way to open it, and list an old bar chart's kinds unmarked", () => {
    const block = sales();
    const bare = chartCommands(withChart(block).scene, block, { chartKind() {} });
    expect(bare.map((command) => command.id)).not.toContain("chart-data");
    const old: Block = { id: "old", type: "bar-chart", data: [{ label: "a", value: 1 }] };
    const list = chartCommands(withChart(old).scene, old, { chartKind() {}, editData() {} });
    expect(list.map((command) => command.id)).not.toContain("chart-data");
    expect(list.every((command) => command.checked === undefined)).toBe(true);
    expect(list.map((command) => command.id)).toHaveLength(6);
  });
});

describe("the changes of the Data popover's buttons", () => {
  it("add a row under the one the keyboard is on, or at the end from the header, with a category to rename", () => {
    const block = sales();
    expect(dataChange(block, "row", { row: 0, column: 1 })).toEqual({
      set: {
        columns: block.columns,
        rows: [
          ["Q1", 4, 6],
          ["Row 3", null, null],
          ["Q2", 5, 7],
        ],
      },
      focus: { row: 1, column: 0 },
    });
    expect(dataChange(block, "row", { row: -1, column: 0 })).toMatchObject({ focus: { row: 2, column: 0 } });
  });

  it("start a scatter's new row one past its largest x", () => {
    const xy = sales({
      kind: "scatter",
      rows: [
        [2, 1, 1],
        [9, 1, 1],
      ],
    });
    expect(dataChange(xy, "row", { row: 0, column: 0 })).toMatchObject({
      set: {
        rows: [
          [2, 1, 1],
          [10, null, null],
          [9, 1, 1],
        ],
      },
    });
  });

  it("add a series after the column the keyboard is on, or last from the categories, named for its place", () => {
    const block = sales();
    expect(dataChange(block, "series", { row: 0, column: 1 })).toMatchObject({
      set: { columns: [{ label: "Quarter" }, { label: "North" }, { label: "Series 3" }, { label: "South" }] },
      focus: { row: -1, column: 2 },
    });
    expect(dataChange(block, "series", { row: 0, column: 0 })).toMatchObject({
      set: { columns: [{ label: "Quarter" }, { label: "North" }, { label: "South" }, { label: "Series 3" }] },
    });
  });

  it("take a row or a series away, and say why it cannot be done when it cannot", () => {
    const block = sales();
    expect(dataChange(block, "delete-row", { row: 0, column: 1 })).toMatchObject({
      set: { rows: [["Q2", 5, 7]] },
      focus: { row: 0, column: 1 },
    });
    expect(dataChange(block, "delete-row", { row: -1, column: 0 })).toEqual({
      problem: "Press a cell of the row first.",
    });
    expect(dataChange(sales({ rows: [["Q1", 1, 1]] }), "delete-row", { row: 0, column: 0 })).toEqual({
      problem: "A chart needs at least one row.",
    });
    expect(dataChange(block, "delete-series", { row: 0, column: 2 })).toMatchObject({
      set: {
        columns: [{ label: "Quarter" }, { label: "North" }],
        rows: [
          ["Q1", 4],
          ["Q2", 5],
        ],
      },
    });
    expect(dataChange(block, "delete-series", { row: 0, column: 0 })).toEqual({
      problem: "Press a cell of the series first. The first column holds the categories.",
    });
    expect(dataChange(parts(), "delete-series", { row: 0, column: 1 })).toEqual({
      problem: "A chart needs at least one series.",
    });
  });

  it("stop at the limits of a chart", () => {
    const full = sales({ rows: Array.from({ length: 30 }, (_, at) => [`r${at}`, 1, 1]) });
    expect(dataChange(full, "row", { row: 0, column: 0 })).toEqual({
      problem: "A chart holds at most 30 rows.",
    });
    const wide = sales({
      columns: Array.from({ length: 7 }, (_, at) => ({ label: `c${at}` })),
      rows: [["a", 1, 1, 1, 1, 1, 1]],
    });
    expect(dataChange(wide, "series", { row: 0, column: 1 })).toEqual({
      problem: "A chart holds at most 6 series.",
    });
  });
});

describe("what the core refuses in a chart's data, in the words the editor shows", () => {
  const refused = (block: ChartBlock, set: Record<string, unknown>) => {
    const { doc } = withChart(block);
    const result = apply(doc, [{ op: "block.set", scene: SCENE, id: block.id, set } as Op]);
    if (result.ok) throw new Error("the change should have been refused");
    expect(result.diagnostics[0]?.severity).toBe("error");
    return { code: result.diagnostics[0]?.code, text: problemOf(result) };
  };

  it("names a row with too few cells (row-length), and what to do", () => {
    const { code, text } = refused(sales(), { rows: [["Q1", 4]] });
    expect(code).toBe("row-length");
    expect(text).toContain("Row 1 has 2 cells, and the chart has 3 columns.");
    expect(text).toContain(
      "Give every row one cell per column, in column order. Use null for an empty cell.",
    );
  });

  it("names words in a series (cell-kind), and a number among the categories", () => {
    const words = refused(sales(), { rows: [["Q1", "lots", 6]] });
    expect(words.code).toBe("cell-kind");
    expect(words.text).toContain('"lots" is text, in the number column "North".');
    expect(words.text).toContain("Write a number, or use null for a missing value.");
    const number = refused(sales(), { rows: [[5, 4, 6]] });
    expect(number.text).toContain('5 is a number, in the text column "Quarter".');
    expect(number.text).toContain('Write the label as text, such as "5", or make the chart a scatter.');
  });

  it("names a donut with two series or too many parts (donut-shape)", () => {
    const series = refused(sales(), { kind: "donut" });
    expect(series.code).toBe("donut-shape");
    expect(series.text).toContain("A donut shows one series, and this one has 2.");
    expect(series.text).toContain("Keep the label column and one series, or choose another kind of chart.");
    const many = refused(parts(), {
      rows: Array.from({ length: 7 }, (_, at) => [`p${at}`, 1]),
      kind: "donut",
    });
    expect(many.text).toContain("A donut has at most 6 parts, and this one has 7.");
    expect(many.text).toContain("Combine the smallest parts into one, or choose another kind of chart.");
  });

  it("names a donut part that is empty or negative, or parts that add up to nothing (donut-value)", () => {
    const empty = refused(parts({ kind: "donut" }), {
      rows: [
        ["a", 1],
        ["b", null],
      ],
    });
    expect(empty.code).toBe("donut-value");
    expect(empty.text).toContain("Part 2 of the donut is empty; each part needs a value of 0 or more.");
    expect(empty.text).toContain("Write the part's value, or remove the row.");
    const negative = refused(parts({ kind: "donut" }), {
      rows: [
        ["a", 1],
        ["b", -2],
      ],
    });
    expect(negative.text).toContain("Part 2 of the donut is -2");
    const zero = refused(parts({ kind: "donut" }), {
      rows: [
        ["a", 0],
        ["b", 0],
      ],
    });
    expect(zero.text).toContain("The donut's parts add up to 0, so there is nothing to draw.");
    expect(zero.text).toContain("Write the values of its parts.");
  });
});
