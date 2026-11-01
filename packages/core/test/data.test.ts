import { describe, expect, it } from "vitest";
import {
  type ApplyResult,
  applyOps,
  type BarChartBlock,
  type Block,
  chartFromBarChart,
  checkData,
  checkScene,
  columnKinds,
  type Doc,
  diffDocs,
  replaceBlockOps,
  revisionOf,
  type Scene,
} from "../src/index.ts";
import { checkScenePart } from "../src/validate.ts";
import { demoDoc, scene } from "./helpers.ts";

const sceneWith = (...blocks: Record<string, unknown>[]): Scene =>
  scene({ schemaVersion: "0.3", blocks }) as unknown as Scene;
const codes = (found: { code: string; path: string }[]) => found.map((d) => [d.code, d.path]);
const run = (doc: Doc, ops: unknown): ApplyResult => applyOps(doc, ops, revisionOf(doc));

const table = (extra: Record<string, unknown> = {}) => ({
  id: "a-table",
  type: "table",
  columns: [{ label: "Channel" }, { label: "Orders", kind: "number" }],
  rows: [
    ["A", 4000],
    ["B", null],
  ],
  ...extra,
});
const chart = (extra: Record<string, unknown> = {}) => ({
  id: "a-chart",
  type: "chart",
  kind: "line",
  columns: [{ label: "Quarter" }, { label: "A" }, { label: "B", unit: "%" }],
  rows: [
    ["Q1", 1, 2],
    ["Q2", 3, null],
  ],
  ...extra,
});

describe("tables and charts in the schema", () => {
  it("accept a table and a chart of each kind", () => {
    expect(checkScene(sceneWith(table()), "x.json")).toEqual([]);
    for (const kind of ["bar", "stacked-bar", "line", "area", "scatter"]) {
      const rows = kind === "scatter" ? [[1, 2, 3]] : [["Q1", 2, 3]];
      expect(checkScene(sceneWith(chart({ kind, rows })), "x.json"), kind).toEqual([]);
    }
  });

  it("refuse a chart with no series, an unknown kind, a stored series color and an empty cell", () => {
    expect(codes(checkScene(sceneWith(chart({ columns: [{ label: "Only" }] })), "x.json"))).toContainEqual([
      "too-few",
      "/blocks/0/columns",
    ]);
    expect(codes(checkScene(sceneWith(chart({ kind: "pie" })), "x.json"))).toContainEqual([
      "bad-value",
      "/blocks/0/kind",
    ]);
    // A series takes its color from the deck's palette by position, so a stored one is an unknown field, not dropped.
    const colored = chart({ columns: [{ label: "Q" }, { label: "A", color: "action" }] });
    expect(codes(checkScene(sceneWith(colored), "x.json"))).toContainEqual([
      "unknown-property",
      "/blocks/0/columns/1/color",
    ]);
    expect(codes(checkScene(sceneWith(table({ rows: [["", 1]] })), "x.json"))).toContainEqual([
      "too-short",
      "/blocks/0/rows/0/0",
    ]);
  });
});

describe("what the schema cannot state about data", () => {
  it("says which kind each column holds", () => {
    expect(columnKinds(table() as never)).toEqual(["text", "number"]);
    expect(columnKinds(chart() as never)).toEqual(["text", "number", "number"]);
    expect(columnKinds(chart({ kind: "scatter" }) as never)).toEqual(["number", "number", "number"]);
  });

  it("holds every row to one cell per column", () => {
    const found = checkData(sceneWith(table({ rows: [["A", 1, 2], ["B"]] })), "x.json");
    expect(codes(found)).toEqual([
      ["row-length", "/blocks/0/rows/0"],
      ["row-length", "/blocks/0/rows/1"],
    ]);
    expect(found[1]?.message).toBe("Row 2 has 1 cell, and the table has 2 columns.");
  });

  it("holds every cell to its column's kind, with null for an empty cell", () => {
    const found = checkData(sceneWith(table({ rows: [[1, "many"]] })), "x.json");
    expect(codes(found)).toEqual([
      ["cell-kind", "/blocks/0/rows/0/0"],
      ["cell-kind", "/blocks/0/rows/0/1"],
    ]);
    expect(found[1]?.message).toBe('"many" is text, in the number column "Orders".');
    expect(checkData(sceneWith(table()), "x.json")).toEqual([]);
    const unlabeled = checkData(sceneWith(chart({ rows: [[null, 1, 2]] })), "x.json");
    expect(codes(unlabeled)).toEqual([["cell-kind", "/blocks/0/rows/0/0"]]);
  });

  it("gives a donut one series of at most 6 parts, 0 or more each, that add up to more than 0", () => {
    const donut = (rows: unknown[][], columns = [{ label: "Part" }, { label: "Share" }]) =>
      checkData(sceneWith(chart({ kind: "donut", columns, rows })), "x.json");
    expect(
      donut([
        ["A", 1],
        ["B", 0],
      ]),
    ).toEqual([]);
    expect(codes(donut([["A", 1, 2]], [{ label: "P" }, { label: "X" }, { label: "Y" }]))).toEqual([
      ["donut-shape", "/blocks/0/columns"],
    ]);
    const seven = Array.from({ length: 7 }, (_, i) => [`P${i}`, 1]);
    expect(codes(donut(seven))).toEqual([["donut-shape", "/blocks/0/rows"]]);
    expect(
      codes(
        donut([
          ["A", -1],
          ["B", null],
        ]),
      ),
    ).toEqual([
      ["donut-value", "/blocks/0/rows/0/1"],
      ["donut-value", "/blocks/0/rows/1/1"],
    ]);
    expect(codes(donut([["A", 0]]))).toEqual([["donut-value", "/blocks/0/rows"]]);
  });

  it("runs with the rest of a scene's checks", () => {
    const found = checkScenePart(
      sceneWith(table({ rows: [["A"]] })),
      "scenes/demo-scene.json",
      "demo-scene",
      new Set(),
    );
    expect(codes(found)).toEqual([["row-length", "/blocks/0/rows/0"]]);
  });
});

describe("a bar chart as a chart", () => {
  const barChart = (demoDoc().scenes.demand as Scene).blocks[0] as BarChartBlock;

  it("keeps the id, title, unit, sources and data", () => {
    expect(chartFromBarChart(barChart)).toEqual({
      id: "chart-demand",
      type: "chart",
      kind: "bar",
      title: "Share of orders, latest quarter",
      unit: "%",
      columns: [{ label: "Label" }, { label: "Value" }],
      rows: [
        ["Channel A", 40],
        ["Channel B", 60],
      ],
      sourceIds: ["source-report"],
    });
    const framed = chartFromBarChart({ ...barChart, frame: { x: 0, y: 0, w: 50, h: 50 } });
    expect(framed.frame).toEqual({ x: 0, y: 0, w: 50, h: 50 });
  });

  it("takes the bar chart's place in one transaction, with the claim and steps still pointing at it", () => {
    const doc = demoDoc();
    const demand = doc.scenes.demand as Scene;
    const ops = replaceBlockOps(demand, chartFromBarChart(barChart));
    expect(ops.map((op) => op.op)).toEqual(["block.remove", "block.add"]);
    const result = run(doc, ops);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const after = result.doc.scenes.demand as Scene;
    expect(after.schemaVersion).toBe("0.3");
    expect(after.blocks.map((block: Block) => [block.id, block.type])).toEqual([["chart-demand", "chart"]]);
    expect(after.summary?.evidenceIds).toEqual(["chart-demand"]);
    expect(diffDocs(doc, result.doc).map((change) => change.id)).toEqual([
      "scene:demand/block:chart-demand/type",
    ]);
  });

  it("has nothing to replace when the scene has no block with that id", () => {
    expect(replaceBlockOps(demoDoc().scenes.opening as Scene, chartFromBarChart(barChart))).toEqual([]);
  });
});
