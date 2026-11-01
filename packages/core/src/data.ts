/**
 * Tables and charts: two blocks with one shape of data, columns and rows, so one grid edits both and a chart keeps
 * its data when its kind changes. The facts about that data a schema cannot state, such as one cell per column, are
 * checked here, and an old `bar-chart` can be turned into the equivalent `chart`.
 */
import type { Op } from "./apply.ts";
import { DATA_LIMITS } from "./schema.ts";
import type { Block, Diagnostic, Scene } from "./types.ts";

export type TableBlock = Extract<Block, { type: "table" }>;
export type ChartBlock = Extract<Block, { type: "chart" }>;
export type BarChartBlock = Extract<Block, { type: "bar-chart" }>;
export type ChartKind = ChartBlock["kind"];
export type Cell = string | number | null;
export type ColumnKind = "text" | "number";

/**
 * What each column holds. A table's column says so, and is text when it does not. A chart's first column holds the
 * categories, which are numbers on a scatter's x axis and text otherwise, and each column after it is a series of
 * numbers.
 */
export function columnKinds(block: TableBlock | ChartBlock): ColumnKind[] {
  if (block.type === "table") return block.columns.map((column) => column.kind ?? "text");
  return block.columns.map((_, i) => (i > 0 || block.kind === "scatter" ? "number" : "text"));
}

const display = (cell: Cell): string => (typeof cell === "string" ? `"${cell}"` : String(cell));

/**
 * Facts about the data of tables and charts that the schema cannot state, as errors: every row has one cell per
 * column (`row-length`), a cell holds what its column does (`cell-kind`; null is an empty cell anywhere but a
 * chart's categories), and a donut has one series of at most 6 parts (`donut-shape`) whose values are 0 or more and
 * add up to more than 0 (`donut-value`). Expects a scene that passed the structure check.
 */
export function checkData(scene: Scene, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const error = (path: string, code: string, message: string, fix: string) =>
    out.push({ severity: "error", code, file, path, message, fix });
  scene.blocks.forEach((block, b) => {
    if (block.type !== "table" && block.type !== "chart") return;
    const at = `/blocks/${b}`;
    const kinds = columnKinds(block);
    const labels = block.columns.map((column) => column.label);
    if (block.type === "chart" && block.kind === "donut" && block.columns.length !== 2) {
      error(
        `${at}/columns`,
        "donut-shape",
        `A donut shows one series, and this one has ${block.columns.length - 1}.`,
        "Keep the label column and one series, or choose another kind of chart.",
      );
    }
    if (block.type === "chart" && block.kind === "donut" && block.rows.length > DATA_LIMITS.donutParts) {
      error(
        `${at}/rows`,
        "donut-shape",
        `A donut has at most ${DATA_LIMITS.donutParts} parts, and this one has ${block.rows.length}.`,
        "Combine the smallest parts into one, or choose another kind of chart.",
      );
    }
    block.rows.forEach((row: readonly Cell[], r) => {
      if (row.length !== kinds.length) {
        error(
          `${at}/rows/${r}`,
          "row-length",
          `Row ${r + 1} has ${row.length} cell${row.length === 1 ? "" : "s"}, and the ${block.type} has ${kinds.length} column${kinds.length === 1 ? "" : "s"}.`,
          "Give every row one cell per column, in column order. Use null for an empty cell.",
        );
      }
      row.forEach((cell, c) => {
        const kind = kinds[c];
        if (kind === undefined) return;
        const path = `${at}/rows/${r}/${c}`;
        const column = `"${labels[c]}"`;
        if (cell === null) {
          if (block.type === "chart" && c === 0) {
            error(
              path,
              "cell-kind",
              `Row ${r + 1} has no ${block.kind === "scatter" ? "x value" : "category label"}.`,
              `Write the ${block.kind === "scatter" ? "number" : "label"} for this row, or remove the row.`,
            );
          }
          return;
        }
        if (kind === "number" && typeof cell !== "number") {
          error(
            path,
            "cell-kind",
            `${display(cell)} is text, in the number column ${column}.`,
            block.type === "table"
              ? `Write a number, use null for an empty cell, or make the column's kind "text".`
              : "Write a number, or use null for a missing value.",
          );
        } else if (kind === "text" && typeof cell !== "string") {
          error(
            path,
            "cell-kind",
            `${display(cell)} is a number, in the text column ${column}.`,
            block.type === "table"
              ? `Write it as text, such as "${cell}", or make the column's kind "number".`
              : `Write the label as text, such as "${cell}", or make the chart a scatter.`,
          );
        }
      });
    });
    if (block.type === "chart" && block.kind === "donut") {
      const values = block.rows.map((row: readonly Cell[]) => row[1]);
      values.forEach((value, r) => {
        if (value === null || (typeof value === "number" && value < 0)) {
          error(
            `${at}/rows/${r}/1`,
            "donut-value",
            `Part ${r + 1} of the donut is ${value === null ? "empty" : value}; each part needs a value of 0 or more.`,
            "Write the part's value, or remove the row.",
          );
        }
      });
      const total = values.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
      if (values.every((value) => typeof value === "number" && value >= 0) && total <= 0) {
        error(
          `${at}/rows`,
          "donut-value",
          "The donut's parts add up to 0, so there is nothing to draw.",
          "Write the values of its parts.",
        );
      }
    }
  });
  return out;
}

/**
 * The chart that shows what a bar chart shows: kind `bar`, the same id, title, unit, sources and frame, with its
 * labels as the first column and its values as the one series. Nothing else changes, so the claim's evidence and the
 * steps that name the block stay valid.
 */
export function chartFromBarChart(block: BarChartBlock): ChartBlock {
  return {
    id: block.id,
    type: "chart",
    kind: "bar",
    ...(block.title === undefined ? {} : { title: block.title }),
    ...(block.unit === undefined ? {} : { unit: block.unit }),
    columns: [{ label: "Label" }, { label: "Value" }],
    rows: block.data.map((entry) => [entry.label, entry.value]),
    ...(block.sourceIds === undefined ? {} : { sourceIds: block.sourceIds }),
    ...(block.frame === undefined ? {} : { frame: block.frame }),
  };
}

/**
 * The operations that put `block` in the place of the block with its id, which may be of another type: the old one is
 * removed and the new one added after the same neighbour, in one transaction. Ids never change, so whatever points at
 * the id points at the new block. Review shows it as one change, of `type`. Empty when the scene has no such block.
 */
export function replaceBlockOps(scene: Scene, block: Block): Op[] {
  const at = scene.blocks.findIndex((candidate) => candidate.id === block.id);
  if (at < 0) return [];
  return [
    { op: "block.remove", scene: scene.id, id: block.id },
    { op: "block.add", scene: scene.id, block, after: at === 0 ? null : (scene.blocks[at - 1] as Block).id },
  ];
}
