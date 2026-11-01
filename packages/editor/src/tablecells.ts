import { type ApplyResult, type Block, type BlockChanges, DATA_LIMITS, type Op } from "@depthcue/core";
import { problemOf } from "./fields.ts";
import {
  type GridData,
  type GridLimits,
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  type Spot,
  withNumeric,
} from "./grid.ts";
import type { Command } from "./palette.ts";

/*
 * What a table block is to the grid, and the changes its right-click menu makes. The grid knows nothing of tables, so
 * this is where its columns and rows become a block's, and where "insert a row" becomes one `block.set`.
 */

export type TableBlock = Extract<Block, { type: "table" }>;

export const TABLE_LIMITS: GridLimits = {
  columns: DATA_LIMITS.columns,
  rows: DATA_LIMITS.rows,
  cell: DATA_LIMITS.cell,
  label: DATA_LIMITS.label,
};

/** The columns and rows of a table, as the grid takes them. */
export const gridOf = (block: TableBlock): GridData => ({
  columns: block.columns.map((column) => ({
    label: column.label,
    unit: column.unit,
    numeric: column.kind === "number",
  })),
  rows: block.rows,
});

/**
 * The changes that put a grid's data into a table. A text column carries no kind, the way one an agent writes by hand
 * does not, and a column with no unit has none, so the same table is the same file whoever made it.
 */
export const changesOf = (data: GridData): BlockChanges => ({
  columns: data.columns.map((column) => ({
    label: column.label,
    ...(column.numeric ? { kind: "number" } : {}),
    ...(column.unit ? { unit: column.unit } : {}),
  })),
  rows: data.rows,
});

/** What the menu of a cell can do to the table it is in. */
export type CellAction =
  | "row-above"
  | "row-below"
  | "column-left"
  | "column-right"
  | "delete-row"
  | "delete-column"
  | "header"
  | "kind";

/**
 * The actions that can be done at a cell, in the order the menu lists them. One that cannot be done is left out: a row
 * or a column past the limit, the last row or column, a row above the header, and the row of the header itself.
 */
export function cellActions(block: TableBlock, at: Spot): CellAction[] {
  const rooms = block.rows.length < DATA_LIMITS.rows;
  const roomy = block.columns.length < DATA_LIMITS.columns;
  const data = at.row >= 0;
  return [
    ...(data && rooms ? (["row-above"] as const) : []),
    ...(rooms ? (["row-below"] as const) : []),
    ...(roomy ? (["column-left", "column-right"] as const) : []),
    ...(data && block.rows.length > 1 ? (["delete-row"] as const) : []),
    ...(block.columns.length > 1 ? (["delete-column"] as const) : []),
    "header",
    "kind",
  ];
}

/** The changes an action makes at a cell, or why it cannot be made. */
export function cellChange(
  block: TableBlock,
  action: CellAction,
  at: Spot,
  language?: string,
): { set: BlockChanges } | { problem: string } {
  const data = gridOf(block);
  switch (action) {
    case "row-above":
      return { set: changesOf(insertRow(data, at.row)) };
    case "row-below":
      return { set: changesOf(insertRow(data, at.row + 1)) };
    case "column-left":
      return { set: changesOf(insertColumn(data, at.column)) };
    case "column-right":
      return { set: changesOf(insertColumn(data, at.column + 1)) };
    case "delete-row":
      return { set: changesOf(removeRow(data, at.row)) };
    case "delete-column":
      return { set: changesOf(removeColumn(data, at.column)) };
    case "header":
      return { set: { header: block.header === false ? null : false } };
    case "kind": {
      const result = withNumeric(data, at.column, !data.columns[at.column]?.numeric, language);
      return "problem" in result ? result : { set: changesOf(result.data) };
    }
  }
}

/**
 * The commands of the cell menu, one for each action that can be done at a cell. The palette lists them too, for the
 * chosen table and the cell the keyboard is on. `run` does one action at the cell.
 */
export function cellCommands(block: TableBlock, at: Spot, run: (action: CellAction) => void): Command[] {
  const numbers = block.columns[at.column]?.kind === "number";
  const text: Record<CellAction, { title: string; label: string; words: string; section: string }> = {
    "row-above": {
      title: "Insert a row above the cell",
      label: "Insert row above",
      words: "table add new",
      section: "cell-insert",
    },
    "row-below": {
      title: "Insert a row below the cell",
      label: "Insert row below",
      words: "table add new",
      section: "cell-insert",
    },
    "column-left": {
      title: "Insert a column left of the cell",
      label: "Insert column left",
      words: "table add new",
      section: "cell-insert",
    },
    "column-right": {
      title: "Insert a column right of the cell",
      label: "Insert column right",
      words: "table add new",
      section: "cell-insert",
    },
    "delete-row": {
      title: "Delete the row of the cell",
      label: "Delete row",
      words: "table remove",
      section: "cell-delete",
    },
    "delete-column": {
      title: "Delete the column of the cell",
      label: "Delete column",
      words: "table remove",
      section: "cell-delete",
    },
    header: {
      title: block.header === false ? "Show the header row of the table" : "Hide the header row of the table",
      label: block.header === false ? "Show header row" : "Hide header row",
      words: "table labels column names",
      section: "cell-table",
    },
    kind: {
      title: numbers ? "Make the column of the cell hold text" : "Make the column of the cell hold numbers",
      label: numbers ? "Make column text" : "Make column numbers",
      words: "table type number text unit",
      section: "cell-table",
    },
  };
  return cellActions(block, at).map((action) => ({
    id: `cell-${action}`,
    title: text[action].title,
    group: "The chosen table",
    words: text[action].words,
    targets: ["cell"],
    label: text[action].label,
    section: text[action].section,
    run: () => run(action),
  }));
}

/** The words of a cell for a spreadsheet: quoted when it holds a tab, a line break or a quote, the way Excel writes it. */
const quoted = (text: string) => (/[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** A table as tab-separated rows, header first when it shows, so it pastes into a spreadsheet as the table it is. */
export function tabSeparated(
  block: Pick<TableBlock, "columns" | "rows" | "header">,
  say: (value: number) => string,
): string {
  const rows = block.rows.map((row) =>
    row.map((cell) => (cell === null ? "" : typeof cell === "number" ? say(cell) : quoted(cell))),
  );
  const head = block.header === false ? [] : [block.columns.map((column) => quoted(column.label))];
  return [...head, ...rows].map((row) => row.join("\t")).join("\n");
}

/** What the editor needs of the chosen table to run a cell action as one undo step. */
export interface TableEditing {
  /** The cell the keyboard last was on in a table, or undefined when the block is not one with a grid. */
  cell(id: string | undefined): Spot | undefined;
  /** Runs an action on the table with this id at a cell, as one change. Says why when it cannot. */
  run(id: string, action: CellAction, at: Spot): void;
}

export interface TableEditingHooks {
  scene(): string;
  apply(ops: readonly Op[]): ApplyResult;
  block(id: string): Block | undefined;
  language(): string;
  /** The grid of a table block on the slide, for the cell the keyboard is on. */
  spot(id: string): Spot | undefined;
  problem(text: string | undefined): void;
}

export function createTableEditing(hooks: TableEditingHooks): TableEditing {
  return {
    cell: (id) => (id === undefined ? undefined : hooks.spot(id)),
    run(id, action, at) {
      const block = hooks.block(id);
      if (block?.type !== "table") return;
      const result = cellChange(block, action, at, hooks.language());
      if ("problem" in result) {
        hooks.problem(result.problem);
        return;
      }
      const applied = hooks.apply([{ op: "block.set", scene: hooks.scene(), id, set: result.set }]);
      hooks.problem(applied.ok ? undefined : problemOf(applied));
    },
  };
}
