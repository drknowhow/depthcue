import type { Block } from "@depthcue/core";
import { h } from "./dom.ts";

type TableBlock = Extract<Block, { type: "table" }>;

/**
 * Turns a number into the words the deck's language writes it in: its decimal sign, no thousands separator, and every
 * digit it has. No separator keeps a year a year, and shows what was typed. A tag the browser does not know falls
 * back to English.
 */
export function numberText(value: number, language?: string): string {
  try {
    return new Intl.NumberFormat(language, { useGrouping: false, maximumFractionDigits: 20 }).format(value);
  } catch {
    return new Intl.NumberFormat("en", { useGrouping: false, maximumFractionDigits: 20 }).format(value);
  }
}

/**
 * The table as a table. This is its static form: it reads correctly with no script, to a screen reader, and in print,
 * and the table module only adds to it. Every cell is set as text. A number column is right-aligned, with its unit
 * in the header; an empty cell is empty. The title is the caption, and the header row shows unless the block hides it.
 */
export function renderTable(block: TableBlock, language?: string): HTMLTableElement {
  const numeric = block.columns.map((column) => column.kind === "number");
  const side = (at: number) => (numeric[at] ? "dc-num" : undefined);
  return h(
    "table",
    { class: "dc-table" },
    block.title && h("caption", {}, block.title),
    block.header !== false &&
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ...block.columns.map((column, at) =>
            h(
              "th",
              { scope: "col", class: side(at) },
              column.label,
              column.unit && h("span", { class: "dc-unit" }, ` (${column.unit})`),
            ),
          ),
        ),
      ),
    h(
      "tbody",
      {},
      ...block.rows.map((row) =>
        h(
          "tr",
          {},
          ...row.map((cell, at) =>
            h("td", { class: side(at) }, typeof cell === "number" ? numberText(cell, language) : cell),
          ),
        ),
      ),
    ),
  );
}
