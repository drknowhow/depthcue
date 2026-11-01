import {
  type Block,
  type BlockChanges,
  type Cell,
  CHART_KINDS,
  type ChartBlock,
  type ChartKind,
  chartFromBarChart,
  checkData,
  columnKinds,
  DATA_LIMITS,
  type Op,
  replaceBlockOps,
  type Scene,
} from "@depthcue/core";
import { CHART_KIND_LABELS, numberText } from "@depthcue/player";
import {
  type GridData,
  type GridLimits,
  insertColumn,
  insertRow,
  parseNumber,
  removeColumn,
  removeRow,
  type Spot,
} from "./grid.ts";
import type { Command } from "./palette.ts";

/*
 * What a chart block is to the grid, and what its right-click menu does. The grid is the one that edits a table, so this
 * is only where a chart's columns and rows become the grid's and back, and where "make it a line" becomes one change.
 */

/** A chart's first column holds its categories and each other one is a series, so it holds at most one more than that. */
export const CHART_LIMITS: GridLimits = {
  columns: DATA_LIMITS.series + 1,
  rows: DATA_LIMITS.rows,
  cell: DATA_LIMITS.cell,
  label: DATA_LIMITS.label,
};

/** The columns and rows of a chart, as the grid takes them: words for the categories, numbers for the rest. */
export function gridOf(block: ChartBlock): GridData {
  const kinds = columnKinds(block);
  return {
    columns: block.columns.map((column, at) => ({
      label: column.label,
      unit: column.unit,
      numeric: kinds[at] === "number",
    })),
    rows: block.rows,
  };
}

/** The changes that put a grid's data into a chart. A chart's columns carry only a label and a unit: their kind is the chart's. */
export const changesOf = (data: GridData): BlockChanges => ({
  columns: data.columns.map(({ label, unit }) => ({ label, ...(unit ? { unit } : {}) })),
  rows: data.rows,
});

/** The chart a block is, or would be once converted: an old bar chart becomes the chart that shows the same bars. */
const chartOf = (block: Block): ChartBlock | undefined =>
  block.type === "chart" ? block : block.type === "bar-chart" ? chartFromBarChart(block) : undefined;

/**
 * The chart as a chart of `kind`. A scatter's x values are numbers and the categories of the other kinds are words, so
 * going to or from a scatter turns the first column into the other, and the data is kept.
 */
function asKind(
  block: ChartBlock,
  kind: ChartKind,
  language?: string,
): { block: ChartBlock } | { problem: string } {
  if ((kind === "scatter") === (block.kind === "scatter")) return { block: { ...block, kind } };
  const rows: Cell[][] = [];
  for (const [r, row] of block.rows.entries()) {
    const first = row[0] ?? null;
    let next: Cell = first;
    if (kind === "scatter" && typeof first === "string") {
      const parsed = parseNumber(first, language);
      if ("why" in parsed) {
        return {
          problem: `Row ${r + 1} says "${first}", which is not a number, so it cannot be an x value.`,
        };
      }
      next = parsed.value;
    } else if (kind !== "scatter" && typeof first === "number") next = numberText(first, language);
    rows.push([next, ...row.slice(1)]);
  }
  return { block: { ...block, kind, rows } };
}

/**
 * What changing a chart to `kind` does, as one transaction, or why it cannot be done. The core's own check has the last
 * word, so a donut of two series is refused here for the reason `depthcue check` gives and the editor has no rules of
 * its own to drift. An old bar chart is replaced by the chart that shows it, under the same id.
 */
export function kindChange(
  scene: Scene,
  block: Block,
  kind: ChartKind,
  language?: string,
): { ops: Op[] } | { problem: string } {
  const chart = chartOf(block);
  if (!chart) return { problem: "That block is not a chart." };
  const made = asKind(chart, kind, language);
  if ("problem" in made) return made;
  const [bad] = checkData({ blocks: [made.block] } as unknown as Scene, "");
  if (bad) return { problem: bad.message };
  if (block.type !== "chart") return { ops: replaceBlockOps(scene, made.block) };
  const set: BlockChanges = { kind, ...(made.block.rows === chart.rows ? {} : { rows: made.block.rows }) };
  return { ops: [{ op: "block.set", scene: scene.id, id: block.id, set }] };
}

/** What the commands of a chart call on. The mounted editor supplies both. */
export interface ChartSources {
  /** Changes the kind of the chart, or converts an old bar chart to a chart of that kind, as one change. */
  chartKind(id: string, kind: ChartKind): void;
  /** Opens the data of the chart, where its rows and series are edited. */
  editData?: ((id: string) => void) | undefined;
}

/**
 * The commands of a chosen chart: its data, and a submenu of the kinds with the one it is marked. A kind its data cannot
 * take is listed greyed with the reason, so nothing a person might look for is missing. An old bar chart lists the same
 * kinds, and choosing one converts it.
 */
export function chartCommands(scene: Scene, block: Block, from: ChartSources, language?: string): Command[] {
  if (block.type !== "chart" && block.type !== "bar-chart") return [];
  const chart = block.type === "chart" ? block : undefined;
  const out: Command[] = [];
  const editData = from.editData;
  if (chart && editData) {
    out.push({
      id: "chart-data",
      title: "Edit the data of the chart",
      group: "The chosen chart",
      words: "rows columns series numbers values grid table paste",
      targets: ["block"],
      label: "Edit data",
      section: "chart",
      run: () => editData(block.id),
    });
  }
  for (const kind of CHART_KINDS) {
    const change = kindChange(scene, block, kind, language);
    const label = CHART_KIND_LABELS[kind];
    out.push({
      id: `chart-${kind}`,
      title: `Chart type: ${label}`,
      group: "The chosen chart",
      words: `graph plot kind bar line area scatter donut pie stacked ${kind}`,
      targets: ["block"],
      label,
      section: "chart",
      submenu: "Chart type",
      ...(chart ? { checked: chart.kind === kind } : {}),
      ...("problem" in change ? { disabled: change.problem } : {}),
      run() {
        if (chart?.kind !== kind) from.chartKind(block.id, kind);
      },
    });
  }
  return out;
}

/** What the buttons of the data popover do to the chart, at the cell the keyboard last was on. Row -1 is the header. */
export type DataAction = "row" | "series" | "delete-row" | "delete-series";

/**
 * The change an action makes at a cell, with the cell the keyboard goes to after it, or why it cannot be made. A new row
 * starts with something in its first column, because a row with no category or x value is refused.
 */
export function dataChange(
  block: ChartBlock,
  action: DataAction,
  at: Spot,
): { set: BlockChanges; focus: Spot } | { problem: string } {
  const data = gridOf(block);
  const rows = data.rows.length;
  const columns = data.columns.length;
  switch (action) {
    case "row": {
      if (rows >= CHART_LIMITS.rows) return { problem: `A chart holds at most ${CHART_LIMITS.rows} rows.` };
      // Under the row the keyboard is on, and at the end when it is on the header.
      const place = at.row < 0 ? rows : at.row + 1;
      const first: Cell =
        block.kind === "scatter"
          ? Math.max(0, ...data.rows.map((row) => (typeof row[0] === "number" ? row[0] : 0))) + 1
          : `Row ${rows + 1}`;
      const grown = insertRow(data, place);
      const next = grown.rows.map((row, r) => (r === place ? [first, ...row.slice(1)] : row));
      return { set: changesOf({ columns: grown.columns, rows: next }), focus: { row: place, column: 0 } };
    }
    case "series": {
      if (columns >= CHART_LIMITS.columns)
        return { problem: `A chart holds at most ${DATA_LIMITS.series} series.` };
      const place = at.column < 1 ? columns : at.column + 1;
      const grown = insertColumn(data, place);
      const named = grown.columns.map((column, c) =>
        c === place ? { ...column, label: `Series ${columns}` } : column,
      );
      return {
        set: changesOf({ columns: named, rows: grown.rows }),
        focus: { row: -1, column: place },
      };
    }
    case "delete-row":
      if (rows < 2) return { problem: "A chart needs at least one row." };
      if (at.row < 0) return { problem: "Press a cell of the row first." };
      return {
        set: changesOf(removeRow(data, at.row)),
        focus: { row: Math.min(at.row, rows - 2), column: at.column },
      };
    case "delete-series":
      if (columns < 3) return { problem: "A chart needs at least one series." };
      if (at.column < 1)
        return { problem: "Press a cell of the series first. The first column holds the categories." };
      return {
        set: changesOf(removeColumn(data, at.column)),
        focus: { row: at.row, column: Math.min(at.column, columns - 2) },
      };
  }
}
