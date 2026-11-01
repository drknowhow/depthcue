import { h, numberText } from "@depthcue/player";

/*
 * A grid that edits columns and rows, like a small spreadsheet. It knows nothing of tables: it takes the columns, the
 * rows, the limits and which columns hold numbers, and reports each change as the whole new pair. A table block wires
 * it up, and a chart's data, which has the same shape, can use it the same way.
 */

/** A cell: words, a number, or nothing. */
export type Cell = string | number | null;

export interface GridColumn {
  label: string;
  unit?: string | undefined;
  /** Whether the column takes numbers only. */
  numeric: boolean;
}

export interface GridData {
  columns: readonly GridColumn[];
  rows: readonly (readonly Cell[])[];
}

export interface GridLimits {
  columns: number;
  rows: number;
  /** The most characters a cell of words holds, and a column's label. */
  cell: number;
  label: number;
}

/** A place in the grid. Row -1 is the header, which holds the column labels. */
export interface Spot {
  row: number;
  column: number;
}

/* Numbers */

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The sign the deck's language writes a fraction with: the character after the 1 in 1.5. */
export const decimalOf = (language?: string): string => numberText(1.5, language).slice(1, 2);

export type Parsed = { value: number } | { why: string };

/**
 * A number as a person in the deck's language types it. The decimal sign is the language's own, and a thousands
 * separator is accepted only where it can only be one: in groups of three. Anything else is refused with the reason.
 */
export function parseNumber(text: string, language?: string): Parsed {
  const clean = text.trim().replace(/−/g, "-");
  const sign = decimalOf(language);
  const point = escaped(sign);
  const group = sign === "," ? "[. \\u00a0\\u202f]" : "[, \\u00a0\\u202f]";
  const plain = new RegExp(`^[+-]?(?:\\d+(?:${point}\\d+)?|${point}\\d+)$`);
  const grouped = new RegExp(`^[+-]?\\d{1,3}(?:${group}\\d{3})+(?:${point}\\d+)?$`);
  if (!plain.test(clean) && !grouped.test(clean)) {
    const shown = clean.length > 20 ? `${clean.slice(0, 19)}…` : clean;
    return { why: `"${shown}" is not a number. Use digits, with "${sign}" as the decimal sign.` };
  }
  const value = Number(clean.replace(new RegExp(group, "g"), "").replace(sign, "."));
  return Number.isFinite(value) ? { value } : { why: "That number is too large." };
}

const isNumber = (text: string, language?: string) => text !== "" && "value" in parseNumber(text, language);

/** What a cell says: its words, or its number as the deck's language writes it. */
export const cellText = (cell: Cell, language?: string): string =>
  cell === null ? "" : typeof cell === "number" ? numberText(cell, language) : cell;

/* Reading what was pasted */

/** Rows and cells from text with a delimiter. A quoted cell may hold the delimiter, a line break and "" for a quote. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[at + 1] === '"') {
        cell += '"';
        at++;
      } else quoted = false;
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[at + 1] === "\n") at++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/**
 * The cells in text that came from a spreadsheet or a CSV file. Tabs mean tab-separated, which is what Excel and Google
 * Sheets put on the clipboard. Otherwise commas or semicolons make columns only when two lines or more agree on how
 * many, so a sentence with a comma in it stays one cell.
 */
export function parseText(text: string): string[][] {
  if (text.includes("\t")) return parseDelimited(text, "\t");
  for (const delimiter of [",", ";"]) {
    const rows = parseDelimited(text, delimiter);
    const width = rows[0]?.length ?? 0;
    if (rows.length > 1 && width > 1 && rows.every((row) => row.length === width)) return rows;
  }
  return parseDelimited(text, "\u0000");
}

/** The first table in a clipboard's HTML, as the words of its cells. Only text is read: nothing of it is inserted. */
export function tableInHtml(html: string): string[][] | undefined {
  const table = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!table) return undefined;
  // The parser runs nothing, but the words of a script or a style are not words of the table.
  for (const hidden of table.querySelectorAll("script, style, noscript, template")) hidden.remove();
  const rows = [...table.rows].map((row) =>
    [...row.cells].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
  return rows.some((row) => row.length > 0) ? rows : undefined;
}

/** The cells a clipboard offers: the table in its HTML first, else its text. Undefined when there is nothing to paste. */
export function readClipboard(offered: { html?: string | undefined; plain?: string | undefined }) {
  const html = offered.html ? tableInHtml(offered.html) : undefined;
  if (html) return html;
  const rows = offered.plain?.trim() ? parseText(offered.plain) : [];
  return rows.length > 0 ? rows : undefined;
}

/* Changing the data */

const DEFAULT_LABEL = /^Column \d+$/;

/** The next label no column has: "Column 4", and then "Column 5". */
export function defaultLabel(columns: readonly GridColumn[]): string {
  const taken = new Set(columns.map((column) => column.label));
  let n = columns.length + 1;
  while (taken.has(`Column ${n}`)) n += 1;
  return `Column ${n}`;
}

const blank = (width: number): Cell[] => Array.from({ length: width }, () => null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A row with nothing in it, put at an index. */
export function insertRow(data: GridData, at: number): GridData {
  const rows = [...data.rows];
  rows.splice(Math.max(0, Math.min(at, rows.length)), 0, blank(data.columns.length));
  return { columns: data.columns, rows };
}

/** A column with nothing in it, put at an index. */
export function insertColumn(data: GridData, at: number): GridData {
  const place = Math.max(0, Math.min(at, data.columns.length));
  const columns = [...data.columns];
  columns.splice(place, 0, { label: defaultLabel(columns), numeric: false });
  return {
    columns,
    rows: data.rows.map((row) => [...row.slice(0, place), null, ...row.slice(place)]),
  };
}

export const removeRow = (data: GridData, at: number): GridData => ({
  columns: data.columns,
  rows: data.rows.filter((_row, index) => index !== at),
});

export const removeColumn = (data: GridData, at: number): GridData => ({
  columns: data.columns.filter((_column, index) => index !== at),
  rows: data.rows.map((row) => row.filter((_cell, index) => index !== at)),
});

/**
 * Makes a column hold numbers, or words. Words that read as numbers become them, and a number becomes the words it was
 * shown as. A column that has something that is not a number cannot hold numbers yet, and the problem says which.
 */
export function withNumeric(
  data: GridData,
  column: number,
  numeric: boolean,
  language?: string,
): { data: GridData } | { problem: string } {
  const rows: Cell[][] = [];
  for (const [r, row] of data.rows.entries()) {
    const cell = row[column] ?? null;
    let next: Cell = cell;
    if (numeric && typeof cell === "string") {
      const parsed = parseNumber(cell, language);
      if ("why" in parsed) {
        return {
          problem: `Row ${r + 1} of "${data.columns[column]?.label}" says "${cell}", which is not a number, so the column cannot hold numbers yet. Change it or clear it first.`,
        };
      }
      next = parsed.value;
    } else if (!numeric && typeof cell === "number") next = numberText(cell, language);
    rows.push(row.map((value, at) => (at === column ? next : value)));
  }
  const columns = data.columns.map((entry, at) => (at === column ? { ...entry, numeric } : entry));
  return { data: { columns, rows } };
}

/** Whether a header row can be read in what was pasted: words over a column of numbers, in a table that has none yet. */
export function hasHeaderRow(rows: readonly (readonly string[])[], language?: string): boolean {
  const [first, ...rest] = rows;
  if (!first || rest.length === 0) return false;
  if (first.some((text) => text === "" || isNumber(text, language))) return false;
  return first.some((_text, c) => {
    const below = rest.map((row) => row[c] ?? "").filter((text) => text !== "");
    return below.length > 0 && below.every((text) => isNumber(text, language));
  });
}

export interface PasteOptions {
  limits: GridLimits;
  language?: string | undefined;
}

export type Pasted = { data: GridData; note?: string } | { problem: string };

/** A grid that has nothing in it yet and has not been given labels: the one a header row may be read for. */
const isNew = (data: GridData) =>
  data.columns.every((column) => DEFAULT_LABEL.test(column.label)) &&
  data.rows.every((row) => row.every((cell) => cell === null));

/**
 * Pastes cells at a place, growing the grid up to its limits. What does not fit is left out, and the note says how
 * much. A pasted header row and the kind of each column are read only for a new, empty grid, pasted at its first cell:
 * anywhere else the grid's own columns say what goes in them. A number column takes numbers only, and a paste that has
 * something else for one is refused whole, so a paste is one change or none.
 */
export function pasteAt(
  data: GridData,
  at: Spot,
  pasted: readonly (readonly string[])[],
  { limits, language }: PasteOptions,
): Pasted {
  const flat = pasted.map((row) => row.map((text) => text.replace(/\s+/g, " ").trim()));
  const fresh = at.row <= 0 && at.column === 0 && isNew(data);
  const header = fresh && hasHeaderRow(flat, language);
  const body = header ? flat.slice(1) : flat;
  const row0 = Math.max(0, at.row);
  const width = Math.max(0, ...flat.map((row) => row.length));
  const lastColumn = Math.min(at.column + width, limits.columns);
  const lastRow = Math.min(row0 + body.length, limits.rows);
  const cutColumns = at.column + width - lastColumn;
  const cutRows = row0 + body.length - lastRow;

  const before = data.columns.length;
  const columns: GridColumn[] = [...data.columns];
  while (columns.length < lastColumn) columns.push({ label: defaultLabel(columns), numeric: false });
  const rows: Cell[][] = data.rows.map((row) => [...row, ...blank(columns.length - row.length)]);
  while (rows.length < lastRow) rows.push(blank(columns.length));

  // What a pasted column is, when the grid has nothing yet to say: numbers if every cell it has is one.
  for (let c = at.column; c < lastColumn; c++) {
    if (!fresh && c < before) continue;
    const cells = body.map((row) => row[c - at.column] ?? "").filter((text) => text !== "");
    const column = columns[c] as GridColumn;
    columns[c] = { ...column, numeric: cells.length > 0 && cells.every((text) => isNumber(text, language)) };
  }

  let cut = 0;
  for (let r = 0; r < lastRow - row0; r++) {
    for (let c = at.column; c < lastColumn; c++) {
      const text = body[r]?.[c - at.column] ?? "";
      const column = columns[c] as GridColumn;
      let cell: Cell = null;
      if (text !== "" && column.numeric) {
        const parsed = parseNumber(text, language);
        if ("why" in parsed) {
          return { problem: `Row ${row0 + r + 1} of "${column.label}": ${parsed.why} Nothing was pasted.` };
        }
        cell = parsed.value;
      } else if (text !== "") {
        if (text.length > limits.cell) cut += 1;
        cell = text.slice(0, limits.cell);
      }
      (rows[row0 + r] as Cell[])[c] = cell;
    }
  }
  if (header) {
    for (let c = at.column; c < lastColumn; c++) {
      const label = (flat[0]?.[c - at.column] ?? "").slice(0, limits.label);
      const column = columns[c] as GridColumn;
      columns[c] = { ...column, label: label === "" ? defaultLabel(columns) : label };
    }
  }

  const left: string[] = [];
  if (cutRows > 0) left.push(plural(cutRows, "row"));
  if (cutColumns > 0) left.push(plural(cutColumns, "column"));
  const notes: string[] = [];
  if (left.length > 0) {
    notes.push(
      `Left out ${left.join(" and ")} past the limit of ${plural(limits.rows, "row")} and ${plural(limits.columns, "column")}.`,
    );
  }
  if (cut > 0) notes.push(`${plural(cut, "cell")} cut to ${limits.cell} characters.`);
  return { data: { columns, rows }, ...(notes.length > 0 ? { note: notes.join(" ") } : {}) };
}

/* The grid on the page */

export interface GridOptions {
  data: GridData;
  limits: GridLimits;
  /** Whether the column labels show as a header row. They are edited there. */
  header: boolean;
  /** Whether the cells of the first column name their rows to a screen reader. */
  rowHeaders?: boolean;
  language?: string | undefined;
  /** What assistive technology calls the grid. */
  name: string;
  /** Takes a change, which is the whole new data. Answers with why it cannot be made, or nothing when it was. */
  change(next: GridData): string | undefined;
  /** Says what went wrong or what was left out; an empty text takes the message away. */
  say(text: string, problem: boolean): void;
  /** A cell has the keyboard, or was pressed. */
  chose?(spot: Spot): void;
  /** Esc was pressed on a cell that is not being edited. */
  leave?(): void;
}

export interface Grid {
  /** The table. A caption may be put before its head and body, and stays there. */
  readonly element: HTMLTableElement;
  /** The cell the arrow keys move from, and that Tab comes back to. */
  readonly active: Spot;
  readonly editing: boolean;
  /** Draws other data, keeping the active cell where it was and the keyboard where it is. */
  set(data: GridData, header: boolean): void;
  /** Puts the keyboard on a cell, or on the active one. */
  focus(spot?: Spot): void;
  destroy(): void;
}

const CARRIER = "data-depthcue-block";

export function createGrid(options: GridOptions): Grid {
  const { limits, language } = options;
  let { data, header } = options;
  let active: Spot = { row: header ? -1 : 0, column: 0 };
  let editing: { spot: Spot; input: HTMLInputElement } | undefined;
  let destroyed = false;

  const head = h("thead");
  const body = h("tbody");
  const element = h(
    "table",
    { class: "dc-table ed-grid", role: "grid", "aria-label": options.name },
    head,
    body,
  );

  const top = () => (header ? -1 : 0);
  const clamp = (spot: Spot): Spot => ({
    row: Math.max(top(), Math.min(spot.row, data.rows.length - 1)),
    column: Math.max(0, Math.min(spot.column, data.columns.length - 1)),
  });
  const same = (a: Spot, b: Spot) => a.row === b.row && a.column === b.column;

  const cellAt = (spot: Spot) =>
    element.querySelector<HTMLElement>(`[data-row="${spot.row}"][data-col="${spot.column}"]`) ?? undefined;
  const spotOf = (node: EventTarget | null): Spot | undefined => {
    const cell = node instanceof Element ? node.closest<HTMLElement>("[data-cell]") : null;
    return cell && element.contains(cell)
      ? { row: Number(cell.dataset.row), column: Number(cell.dataset.col) }
      : undefined;
  };

  /** What a cell says now, and what it is called to a screen reader while it is edited. */
  const textAt = (spot: Spot) =>
    spot.row < 0
      ? (data.columns[spot.column]?.label ?? "")
      : cellText(data.rows[spot.row]?.[spot.column] ?? null, language);
  const nameAt = (spot: Spot) =>
    spot.row < 0
      ? `Column ${spot.column + 1} label`
      : `${data.columns[spot.column]?.label}, row ${spot.row + 1}`;

  function fill(cell: HTMLElement, spot: Spot) {
    cell.removeAttribute("data-editing");
    if (spot.row < 0) {
      const unit = data.columns[spot.column]?.unit;
      cell.replaceChildren(textAt(spot), ...(unit ? [h("span", { class: "dc-unit" }, ` (${unit})`)] : []));
    } else cell.textContent = textAt(spot);
  }

  function node(spot: Spot): HTMLTableCellElement {
    const column = data.columns[spot.column] as GridColumn;
    const isHead = spot.row < 0;
    const cell = h(isHead ? "th" : "td", {
      role: isHead ? "columnheader" : options.rowHeaders && spot.column === 0 ? "rowheader" : "gridcell",
      scope: isHead ? "col" : undefined,
      class: column.numeric ? "dc-num" : undefined,
      tabindex: same(spot, active) ? 0 : -1,
      "data-cell": "",
      "data-row": spot.row,
      "data-col": spot.column,
      "aria-colindex": spot.column + 1,
    });
    fill(cell, spot);
    return cell;
  }

  /** Draws the head and the body again. The keyboard stays on the cell that had it. */
  function render() {
    const keep = element.contains(document.activeElement) && !editing;
    active = clamp(active);
    head.replaceChildren(
      ...(header
        ? [h("tr", { role: "row" }, ...data.columns.map((_column, c) => node({ row: -1, column: c })))]
        : []),
    );
    body.replaceChildren(
      ...data.rows.map((_row, r) =>
        h("tr", { role: "row" }, ...data.columns.map((_column, c) => node({ row: r, column: c }))),
      ),
    );
    element.setAttribute("aria-rowcount", String(data.rows.length + (header ? 1 : 0)));
    element.setAttribute("aria-colcount", String(data.columns.length));
    if (keep) cellAt(active)?.focus({ preventScroll: true });
  }

  function activate(spot: Spot) {
    if (same(spot, active)) return;
    cellAt(active)?.setAttribute("tabindex", "-1");
    active = spot;
    cellAt(active)?.setAttribute("tabindex", "0");
  }

  function focusCell(spot: Spot) {
    const target = clamp(spot);
    activate(target);
    cellAt(target)?.focus({ preventScroll: true });
  }

  /** What typing `text` into a cell would make of it: the cell, or the reason it cannot be. */
  function read(spot: Spot, text: string): { cell: Cell } | { label: string } | { problem: string } {
    const value = text.trim();
    if (spot.row < 0) {
      if (value === "") return { problem: "A column needs a label." };
      if (value.length > limits.label)
        return { problem: `${value.length - limits.label} over the limit of ${limits.label}.` };
      return { label: value };
    }
    if (value === "") return { cell: null };
    if (data.columns[spot.column]?.numeric) {
      const parsed = parseNumber(value, language);
      return "why" in parsed ? { problem: parsed.why } : { cell: parsed.value };
    }
    if (value.length > limits.cell)
      return { problem: `${value.length - limits.cell} over the limit of ${limits.cell}.` };
    return { cell: value };
  }

  /** Puts what was typed into the cell. False when it was refused, which is said, and the cell keeps what it had. */
  function put(spot: Spot, text: string): boolean {
    const result = read(spot, text);
    if ("problem" in result) {
      options.say(result.problem, true);
      return false;
    }
    let next: GridData;
    if ("label" in result) {
      if (result.label === data.columns[spot.column]?.label) return true;
      next = {
        columns: data.columns.map((column, c) =>
          c === spot.column ? { ...column, label: result.label } : column,
        ),
        rows: data.rows,
      };
    } else {
      if (result.cell === (data.rows[spot.row]?.[spot.column] ?? null)) return true;
      next = {
        columns: data.columns,
        rows: data.rows.map((row, r) =>
          r === spot.row ? row.map((cell, c) => (c === spot.column ? result.cell : cell)) : row,
        ),
      };
    }
    const refused = options.change(next);
    if (refused !== undefined) {
      options.say(refused, true);
      return false;
    }
    data = next;
    options.say("", false);
    return true;
  }

  /** Leaves editing, with the cell showing what the data says. `keep` takes what was typed. False when it was refused. */
  function finish(keep: boolean): boolean {
    const was = editing;
    if (!was) return true;
    const ok = keep ? put(was.spot, was.input.value) : true;
    if (!ok) return false;
    editing = undefined;
    const cell = cellAt(was.spot);
    if (cell) fill(cell, was.spot);
    return true;
  }

  function edit(spot: Spot, typed?: string) {
    if (editing && same(editing.spot, spot)) return;
    if (!finish(true)) return;
    const cell = cellAt(spot);
    if (!cell) return;
    const numeric = spot.row >= 0 && data.columns[spot.column]?.numeric === true;
    const input = h("input", {
      type: "text",
      class: "ed-grid-input",
      "aria-label": nameAt(spot),
      inputmode: numeric ? "decimal" : "text",
      autocomplete: "off",
    });
    input.value = typed ?? textAt(spot);
    input.spellcheck = !numeric;
    editing = { spot, input };
    activate(spot);
    // The words stay in the cell, unseen, so the cell keeps its size and the table does not move under the field, which
    // lies over them. What is typed is copied there, so the cell grows with it the way a spreadsheet's does.
    const ghost = h("span", { class: "ed-grid-ghost", "aria-hidden": "true" }, input.value);
    cell.dataset.editing = "";
    cell.replaceChildren(ghost, input);
    input.focus({ preventScroll: true });
    if (typed === undefined) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);

    // A number being typed is not a number yet, so only words are checked as they are typed.
    input.addEventListener("input", () => {
      ghost.textContent = input.value;
      const result = read(spot, input.value);
      const problem = "problem" in result && !numeric ? result.problem : undefined;
      if (problem === undefined) input.removeAttribute("aria-invalid");
      else input.setAttribute("aria-invalid", "true");
      options.say(problem ?? "", problem !== undefined);
    });
    input.addEventListener("keydown", (event) => onEditKey(event, spot));
    input.addEventListener("blur", () => {
      if (destroyed || editing?.input !== input) return;
      // Pressing away takes what was typed when it can, and shows what the data says when it cannot.
      if (!finish(true)) finish(false);
    });
  }

  /** The cell a key moves to, or undefined at the edge. Tab wraps from the end of a row to the start of the next. */
  function step(from: Spot, key: "Tab" | "Enter", back: boolean): Spot | undefined {
    const last = { row: data.rows.length - 1, column: data.columns.length - 1 };
    if (key === "Enter") {
      const row = from.row + (back ? -1 : 1);
      return row < top() || row > last.row ? undefined : { row, column: from.column };
    }
    if (back) {
      if (from.column > 0) return { row: from.row, column: from.column - 1 };
      return from.row > top() ? { row: from.row - 1, column: last.column } : undefined;
    }
    if (from.column < last.column) return { row: from.row, column: from.column + 1 };
    return from.row < last.row ? { row: from.row + 1, column: 0 } : undefined;
  }

  function onEditKey(event: KeyboardEvent, spot: Spot) {
    if (event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && ["z", "y"].includes(event.key.toLowerCase())) {
      // Undo inside the cell undoes the typing in it. The deck's own Undo is for after the edit.
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      options.say("", false);
      cellAt(spot)?.focus({ preventScroll: true });
    } else if (event.key === "Enter" || event.key === "Tab") {
      const to = step(spot, event.key, event.shiftKey);
      // At the very ends Tab goes on out of the grid, and Enter stays where it is.
      if (!to && event.key === "Tab") {
        if (finish(true)) cellAt(spot)?.focus({ preventScroll: true });
        else event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!finish(true)) return;
      focusCell(to ?? spot);
    }
  }

  function onCellKey(event: KeyboardEvent, spot: Spot) {
    if (event.isComposing || event.defaultPrevented) return;
    const { key } = event;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const last = { row: data.rows.length - 1, column: data.columns.length - 1 };
    const arrow: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (arrow[key]) {
      const [dr, dc] = arrow[key] as [number, number];
      focusCell({ row: spot.row + dr, column: spot.column + dc });
    } else if (key === "Home" || key === "End") {
      focusCell({ row: spot.row, column: key === "Home" ? 0 : last.column });
    } else if (key === "Tab" || key === "Enter") {
      const to = step(spot, key, event.shiftKey);
      if (!to) {
        if (key === "Tab") return;
      } else focusCell(to);
    } else if (key === "F2" || key === " ") {
      edit(spot);
    } else if (key === "Delete" || key === "Backspace") {
      put(spot, "");
      const cell = cellAt(spot);
      if (cell) fill(cell, spot);
    } else if (key === "Escape") {
      options.leave?.();
    } else if (key.length === 1) {
      edit(spot, key);
    } else return;
    event.preventDefault();
  }

  element.addEventListener("keydown", (event) => {
    if (editing && event.target === editing.input) return;
    const spot = spotOf(event.target);
    if (spot) onCellKey(event, spot);
  });
  element.addEventListener("focusin", (event) => {
    const spot = spotOf(event.target);
    if (!spot) return;
    activate(spot);
    options.chose?.(spot);
  });
  element.addEventListener("click", (event) => {
    const spot = spotOf(event.target);
    if (!spot || (editing && event.target === editing.input)) return;
    edit(spot);
  });
  element.addEventListener("paste", (event) => {
    const clip = event.clipboardData;
    if (!clip || (clip.files?.length ?? 0) > 0) return;
    const html = clip.getData("text/html");
    const plain = clip.getData("text/plain");
    // A block copied from Depthcue is a block to paste after this one, which the editor does.
    if (html.includes(CARRIER) || clip.getData("application/json") || plain.includes('"depthcue"')) return;
    const cells = readClipboard({ html, plain });
    if (!cells) return;
    // One cell's words go into the cell being typed in, the way the browser does it.
    if (editing && cells.length === 1 && cells[0]?.length === 1) return;
    event.preventDefault();
    const at = editing?.spot ?? active;
    finish(false);
    const result = pasteAt(data, at, cells, { limits, language });
    if ("problem" in result) {
      options.say(result.problem, true);
      return;
    }
    const refused = options.change(result.data);
    if (refused !== undefined) {
      options.say(refused, true);
      return;
    }
    data = result.data;
    render();
    options.say(result.note ?? "", result.note !== undefined);
  });

  render();

  return {
    element,
    get active() {
      return active;
    },
    get editing() {
      return editing !== undefined;
    },
    set(next, shown) {
      editing = undefined;
      data = next;
      header = shown;
      render();
    },
    focus: (spot) => focusCell(spot ?? active),
    destroy() {
      destroyed = true;
      editing = undefined;
    },
  };
}
