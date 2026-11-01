// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  type Cell,
  cellText,
  createGrid,
  decimalOf,
  type Grid,
  type GridColumn,
  type GridData,
  type GridLimits,
  hasHeaderRow,
  insertColumn,
  insertRow,
  parseDelimited,
  parseNumber,
  parseText,
  pasteAt,
  readClipboard,
  removeColumn,
  removeRow,
  type Spot,
  tableInHtml,
  withNumeric,
} from "../src/grid.ts";

const LIMITS: GridLimits = { columns: 4, rows: 5, cell: 10, label: 8 };

const words = (label: string): GridColumn => ({ label, numeric: false });
const numbers = (label: string, unit?: string): GridColumn => ({ label, numeric: true, unit });

const DATA: GridData = {
  columns: [words("Region"), numbers("Share", "%"), words("Note")],
  rows: [
    ["North", 42, "high"],
    ["South", 58, null],
  ],
};

/** A grid that has nothing in it yet: the columns the Add a table command makes, each with its default label. */
const EMPTY: GridData = {
  columns: [words("Column 1"), words("Column 2"), words("Column 3")],
  rows: [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ],
};

describe("parseNumber", () => {
  it("reads digits with the decimal sign of the deck's language", () => {
    expect(parseNumber("12.5", "en")).toEqual({ value: 12.5 });
    expect(parseNumber("12,5", "de")).toEqual({ value: 12.5 });
    expect(parseNumber("12,5", "pt-BR")).toEqual({ value: 12.5 });
    expect(parseNumber("-3", "en")).toEqual({ value: -3 });
    expect(parseNumber(".5", "en")).toEqual({ value: 0.5 });
    expect(parseNumber("−4", "en")).toEqual({ value: -4 });
  });

  it("refuses the other language's decimal sign, and says which one to use", () => {
    const refused = parseNumber("12,5", "en");
    expect("why" in refused && refused.why).toContain('"."');
    const german = parseNumber("12.5", "de");
    expect("why" in german && german.why).toContain('","');
  });

  it("takes a thousands separator only in groups of three", () => {
    expect(parseNumber("1,234", "en")).toEqual({ value: 1234 });
    expect(parseNumber("1,234,567.5", "en")).toEqual({ value: 1234567.5 });
    expect(parseNumber("1.234,5", "de")).toEqual({ value: 1234.5 });
    expect("why" in parseNumber("1,23", "en")).toBe(true);
    expect("why" in parseNumber("12,3456", "en")).toBe(true);
  });

  it("refuses words and empty text, naming what it was given", () => {
    const refused = parseNumber("about ten", "en");
    expect("why" in refused && refused.why).toContain("about ten");
    expect("why" in parseNumber("", "en")).toBe(true);
    expect("why" in parseNumber("1e5", "en")).toBe(true);
  });

  it("knows the decimal sign of a language", () => {
    expect(decimalOf("en")).toBe(".");
    expect(decimalOf("de")).toBe(",");
    expect(decimalOf(undefined)).toBe(".");
  });
});

describe("cellText", () => {
  it("shows a number the way the language writes it, with no thousands separator, and nothing for an empty cell", () => {
    expect(cellText(2024, "en")).toBe("2024");
    expect(cellText(12.5, "de")).toBe("12,5");
    expect(cellText(null, "en")).toBe("");
    expect(cellText("words", "en")).toBe("words");
  });
});

describe("parseDelimited", () => {
  it("splits rows and cells, with Windows or Unix line ends", () => {
    expect(parseDelimited("a,b\r\nc,d\n", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a quoted cell whole, with its delimiter, line break and doubled quotes", () => {
    expect(parseDelimited('a,"b,c","line\nbreak","say ""hi"""', ",")).toEqual([
      ["a", "b,c", "line\nbreak", 'say "hi"'],
    ]);
  });

  it("keeps empty cells in the middle and at the end of a row", () => {
    expect(parseDelimited("a,,c,\nd,e,f,g", ",")).toEqual([
      ["a", "", "c", ""],
      ["d", "e", "f", "g"],
    ]);
  });
});

describe("parseText", () => {
  it("reads tab-separated text, which is what a spreadsheet copies", () => {
    expect(parseText("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("reads a quoted tab-separated cell with a line break the way Excel writes it", () => {
    expect(parseText('a\t"b\nc"\nd\te')).toEqual([
      ["a", "b\nc"],
      ["d", "e"],
    ]);
  });

  it("reads CSV with commas or semicolons when two lines or more agree on their width", () => {
    expect(parseText("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
    expect(parseText("a;b\n1;2\n3;4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(parseText('"Smith, J",5\n"Lee, K",7')).toEqual([
      ["Smith, J", "5"],
      ["Lee, K", "7"],
    ]);
  });

  it("leaves a sentence with a comma in it as one cell, and each line as a row of one", () => {
    expect(parseText("Well, maybe")).toEqual([["Well, maybe"]]);
    expect(parseText("one, two\nthree")).toEqual([["one, two"], ["three"]]);
  });
});

describe("tableInHtml", () => {
  it("reads the words of the cells of the first table, headers and all", () => {
    const html =
      "<meta charset='utf-8'><table><thead><tr><th>Name</th><th>Qty</th></tr></thead>" +
      "<tbody><tr><td>Pens</td><td> 4 </td></tr><tr><td>Ink <b>blue</b></td><td>2</td></tr></tbody></table>";
    expect(tableInHtml(html)).toEqual([
      ["Name", "Qty"],
      ["Pens", "4"],
      ["Ink blue", "2"],
    ]);
  });

  it("reads text only: markup, scripts and styles in a cell are not kept", () => {
    const html =
      "<table><tr><td><img src=x onerror=alert(1)>Safe<script>window.pwned=1</script></td>" +
      "<td style='color:red'><a href='https://example.com'>link</a></td></tr></table>";
    const cells = tableInHtml(html);
    expect(cells).toEqual([["Safe", "link"]]);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("is undefined when the HTML holds no table", () => {
    expect(tableInHtml("<p>Just words</p>")).toBeUndefined();
  });
});

describe("readClipboard", () => {
  it("prefers the table in the HTML to the plain text beside it", () => {
    expect(readClipboard({ html: "<table><tr><td>a</td><td>b</td></tr></table>", plain: "x\ty\tz" })).toEqual(
      [["a", "b"]],
    );
  });

  it("falls back to the text, and is undefined for nothing", () => {
    expect(readClipboard({ html: "<p>x</p>", plain: "a\tb" })).toEqual([["a", "b"]]);
    expect(readClipboard({ plain: "   " })).toBeUndefined();
    expect(readClipboard({})).toBeUndefined();
  });
});

describe("inserting and removing", () => {
  it("inserts a row of empty cells, and a column with a label that is free", () => {
    expect(insertRow(DATA, 1).rows).toEqual([
      ["North", 42, "high"],
      [null, null, null],
      ["South", 58, null],
    ]);
    const added = insertColumn(DATA, 1);
    expect(added.columns.map((column) => column.label)).toEqual(["Region", "Column 4", "Share", "Note"]);
    expect(added.columns[1]?.numeric).toBe(false);
    expect(added.rows[0]).toEqual(["North", null, 42, "high"]);
  });

  it("does not name a new column after one that has that name", () => {
    const data: GridData = { columns: [words("Column 2"), words("Column 3")], rows: [] };
    expect(insertColumn(data, 2).columns[2]?.label).toBe("Column 4");
    expect(insertColumn({ columns: [words("Column 3")], rows: [] }, 0).columns[0]?.label).toBe("Column 2");
  });

  it("removes a row and a column", () => {
    expect(removeRow(DATA, 0).rows).toEqual([["South", 58, null]]);
    const lessOne = removeColumn(DATA, 1);
    expect(lessOne.columns.map((column) => column.label)).toEqual(["Region", "Note"]);
    expect(lessOne.rows).toEqual([
      ["North", "high"],
      ["South", null],
    ]);
  });
});

describe("withNumeric", () => {
  it("turns words that read as numbers into numbers, and an empty cell stays empty", () => {
    const data: GridData = {
      columns: [words("Year")],
      rows: [["2024"], [null], ["1,500"]],
    };
    const result = withNumeric(data, 0, true, "en");
    expect("data" in result && result.data.rows).toEqual([[2024], [null], [1500]]);
    expect("data" in result && result.data.columns[0]?.numeric).toBe(true);
  });

  it("refuses a column with a cell that is not a number, and says which cell", () => {
    const result = withNumeric(DATA, 2, true, "en");
    expect("problem" in result && result.problem).toContain("Row 1");
    expect("problem" in result && result.problem).toContain("high");
  });

  it("turns numbers into the words they were shown as when a column goes back to words", () => {
    const result = withNumeric(DATA, 1, false, "de");
    expect("data" in result && result.data.rows.map((row) => row[1])).toEqual(["42", "58"]);
    expect("data" in result && result.data.columns[1]?.numeric).toBe(false);
  });
});

describe("hasHeaderRow", () => {
  it("is true for words over a column of numbers", () => {
    expect(
      hasHeaderRow([
        ["Region", "Share"],
        ["North", "42"],
        ["South", "58"],
      ]),
    ).toBe(true);
  });

  it("is false when the first row has a number or an empty cell, or nothing below is a number, or it is one row", () => {
    expect(
      hasHeaderRow([
        ["Year", "2024"],
        ["a", "1"],
      ]),
    ).toBe(false);
    expect(
      hasHeaderRow([
        ["Region", ""],
        ["a", "1"],
      ]),
    ).toBe(false);
    expect(
      hasHeaderRow([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe(false);
    expect(hasHeaderRow([["a", "b"]])).toBe(false);
  });
});

describe("pasteAt", () => {
  const options = { limits: LIMITS, language: "en" };

  it("writes cells at the place and leaves the rest as it was", () => {
    const result = pasteAt(DATA, { row: 1, column: 0 }, [["East", "7"]], options);
    if ("problem" in result) throw new Error(result.problem);
    // The Share column holds numbers, so its pasted words became a number.
    expect(result.data.rows).toEqual([
      ["North", 42, "high"],
      ["East", 7, null],
    ]);
    expect(result.note).toBeUndefined();
  });

  it("grows rows and columns to fit, with labels of their own", () => {
    const result = pasteAt(DATA, { row: 1, column: 2 }, [["x", "y"], ["z"]], options);
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.columns.map((column) => column.label)).toEqual([
      "Region",
      "Share",
      "Note",
      "Column 4",
    ]);
    expect(result.data.rows).toEqual([
      ["North", 42, "high", null],
      ["South", 58, "x", "y"],
      [null, null, "z", null],
    ]);
  });

  it("leaves out what is past the limits, and says how much", () => {
    const wide = [["a", "b", "c", "d", "e", "f"]];
    const tall = Array.from({ length: 9 }, (_, n) => [`r${n}`]);
    const columns = pasteAt(EMPTY, { row: 0, column: 0 }, wide, options);
    if ("problem" in columns) throw new Error(columns.problem);
    expect(columns.data.columns).toHaveLength(4);
    expect(columns.note).toBe("Left out 2 columns past the limit of 5 rows and 4 columns.");
    const rows = pasteAt(EMPTY, { row: 0, column: 0 }, tall, options);
    if ("problem" in rows) throw new Error(rows.problem);
    expect(rows.data.rows).toHaveLength(5);
    expect(rows.note).toBe("Left out 4 rows past the limit of 5 rows and 4 columns.");
  });

  it("cuts a cell of words that is too long, and says so", () => {
    const result = pasteAt(EMPTY, { row: 0, column: 0 }, [["abcdefghijklmnop", "ok"]], options);
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.rows[0]?.[0]).toBe("abcdefghij");
    expect(result.note).toBe("1 cell cut to 10 characters.");
  });

  it("reads a header row and the kind of each column when the table is new and empty", () => {
    const result = pasteAt(
      EMPTY,
      { row: 0, column: 0 },
      [
        ["Region", "Share"],
        ["North", "42"],
        ["South", "58"],
      ],
      options,
    );
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.columns.slice(0, 2)).toEqual([
      { label: "Region", numeric: false },
      { label: "Share", numeric: true },
    ]);
    expect(result.data.rows.slice(0, 2)).toEqual([
      ["North", 42, null],
      ["South", 58, null],
    ]);
  });

  it("treats the first row as a row of cells when the table is not new and empty", () => {
    const result = pasteAt(
      DATA,
      { row: 0, column: 0 },
      [
        ["Zone", "7"],
        ["East", "9"],
      ],
      options,
    );
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.columns.map((column) => column.label)).toEqual(["Region", "Share", "Note"]);
    expect(result.data.rows).toEqual([
      ["Zone", 7, "high"],
      ["East", 9, null],
    ]);
  });

  it("treats the first row as cells when the paste is not at the first cell, even in a new table", () => {
    const result = pasteAt(
      EMPTY,
      { row: 1, column: 0 },
      [
        ["Region", "Share"],
        ["North", "42"],
      ],
      options,
    );
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.columns.map((column) => column.label)).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(result.data.rows.slice(1, 3)).toEqual([
      ["Region", "Share", null],
      ["North", "42", null],
    ]);
  });

  it("makes a pasted column numeric only when every cell in it is a number", () => {
    const result = pasteAt(
      EMPTY,
      { row: 0, column: 0 },
      [
        ["1", "a"],
        ["2", "3"],
      ],
      options,
    );
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.columns.map((column) => column.numeric)).toEqual([true, false, false]);
    expect(result.data.rows[0]).toEqual([1, "a", null]);
  });

  it("refuses the whole paste when a number column would get something that is not a number", () => {
    const result = pasteAt(DATA, { row: 0, column: 0 }, [["East", "nine"]], options);
    expect("problem" in result && result.problem).toContain("nine");
    expect("problem" in result && result.problem).toContain("Nothing was pasted");
  });

  it("reads numbers the way the language writes them", () => {
    const result = pasteAt(EMPTY, { row: 0, column: 0 }, [["1,5"], ["2,5"]], {
      limits: LIMITS,
      language: "de",
    });
    if ("problem" in result) throw new Error(result.problem);
    expect(result.data.rows.map((row) => row[0])).toEqual([1.5, 2.5, null]);
  });

  it("does not change the data it was given", () => {
    const before = JSON.stringify(DATA);
    pasteAt(DATA, { row: 0, column: 0 }, [["x", "1", "y", "z"]], options);
    expect(JSON.stringify(DATA)).toBe(before);
  });
});

/* The grid on the page */

let grid: Grid | undefined;
afterEach(() => {
  grid?.destroy();
  grid = undefined;
  document.body.replaceChildren();
});

interface Made {
  grid: Grid;
  changes: GridData[];
  said: Array<[string, boolean]>;
  chose: Spot[];
  left: () => number;
  /** Makes the next change be refused with this reason. */
  refuse(reason: string): void;
}

function make(data: GridData = DATA, over: { header?: boolean; language?: string } = {}): Made {
  const changes: GridData[] = [];
  const said: Array<[string, boolean]> = [];
  const chose: Spot[] = [];
  let left = 0;
  let refusal: string | undefined;
  grid = createGrid({
    data,
    limits: { columns: 12, rows: 30, cell: 120, label: 40 },
    header: over.header ?? true,
    rowHeaders: true,
    language: over.language ?? "en",
    name: "Table",
    change(next) {
      if (refusal !== undefined) {
        const reason = refusal;
        refusal = undefined;
        return reason;
      }
      changes.push(next);
      return undefined;
    },
    say: (text, problem) => said.push([text, problem]),
    chose: (spot) => chose.push(spot),
    leave: () => {
      left += 1;
    },
  });
  document.body.replaceChildren(grid.element);
  return {
    grid,
    changes,
    said,
    chose,
    left: () => left,
    refuse: (reason) => {
      refusal = reason;
    },
  };
}

const cellAt = (row: number, column: number) =>
  document.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${column}"]`) as HTMLElement;
const press = (node: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  node.dispatchEvent(event);
  return event;
};
const input = () => document.querySelector<HTMLInputElement>(".ed-grid-input");
const type = (text: string) => {
  const field = input() as HTMLInputElement;
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
const paste = (data: { plain?: string; html?: string; json?: string }, target: Element = cellAt(0, 0)) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (kind: string) =>
        (kind === "text/plain" ? data.plain : kind === "text/html" ? data.html : data.json) ?? "",
    },
  });
  target.dispatchEvent(event);
  return event;
};
const texts = () =>
  [...document.querySelectorAll("tbody tr")].map((row) => [...row.children].map((cell) => cell.textContent));

describe("the grid's shape", () => {
  it("is a grid with column headers, a row header for the first column, and one cell the keyboard comes back to", () => {
    make();
    const table = grid?.element as HTMLTableElement;
    expect(table.getAttribute("role")).toBe("grid");
    expect(table.getAttribute("aria-label")).toBe("Table");
    expect(table.getAttribute("aria-rowcount")).toBe("3");
    expect(table.getAttribute("aria-colcount")).toBe("3");
    expect(cellAt(-1, 1).getAttribute("role")).toBe("columnheader");
    expect(cellAt(-1, 1).getAttribute("scope")).toBe("col");
    expect(cellAt(0, 0).getAttribute("role")).toBe("rowheader");
    expect(cellAt(0, 1).getAttribute("role")).toBe("gridcell");
    expect(table.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(table.querySelector('[tabindex="0"]')).toBe(cellAt(-1, 0));
  });

  it("shows numbers aligned and with the language's decimal sign, the unit in the header, and an empty cell as empty", () => {
    make({ ...DATA, rows: [["North", 4.5, null]] }, { language: "de" });
    expect(cellAt(0, 1).textContent).toBe("4,5");
    expect(cellAt(0, 1).classList.contains("dc-num")).toBe(true);
    expect(cellAt(-1, 1).textContent).toBe("Share (%)");
    expect(cellAt(0, 2).textContent).toBe("");
  });

  it("has no header row when the header is hidden, and starts on the first cell of the body", () => {
    make(DATA, { header: false });
    expect(document.querySelector("thead tr")).toBeNull();
    expect(grid?.active).toEqual({ row: 0, column: 0 });
    expect(grid?.element.getAttribute("aria-rowcount")).toBe("2");
  });
});

describe("moving between cells", () => {
  it("moves with the arrow keys, Home and End, and stops at the edges", () => {
    make();
    cellAt(0, 0).focus();
    press(cellAt(0, 0), "ArrowRight");
    expect(document.activeElement).toBe(cellAt(0, 1));
    press(cellAt(0, 1), "ArrowDown");
    expect(document.activeElement).toBe(cellAt(1, 1));
    press(cellAt(1, 1), "ArrowDown");
    expect(document.activeElement).toBe(cellAt(1, 1));
    press(cellAt(1, 1), "End");
    expect(document.activeElement).toBe(cellAt(1, 2));
    press(cellAt(1, 2), "Home");
    expect(document.activeElement).toBe(cellAt(1, 0));
    press(cellAt(1, 0), "ArrowUp");
    press(cellAt(0, 0), "ArrowUp");
    expect(document.activeElement).toBe(cellAt(-1, 0));
    press(cellAt(-1, 0), "ArrowUp");
    expect(document.activeElement).toBe(cellAt(-1, 0));
  });

  it("moves with Tab and Shift+Tab along a row and on to the next, and leaves at the ends", () => {
    make();
    cellAt(0, 2).focus();
    press(cellAt(0, 2), "Tab");
    expect(document.activeElement).toBe(cellAt(1, 0));
    press(cellAt(1, 0), "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(cellAt(0, 2));
    cellAt(1, 2).focus();
    // Past the last cell the key is the browser's, which takes the keyboard on out of the table.
    expect(press(cellAt(1, 2), "Tab").defaultPrevented).toBe(false);
    cellAt(-1, 0).focus();
    expect(press(cellAt(-1, 0), "Tab", { shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("moves down with Enter, and stays at the bottom", () => {
    make();
    cellAt(0, 1).focus();
    press(cellAt(0, 1), "Enter");
    expect(document.activeElement).toBe(cellAt(1, 1));
    press(cellAt(1, 1), "Enter");
    expect(document.activeElement).toBe(cellAt(1, 1));
    expect(grid?.editing).toBe(false);
  });

  it("reports the cell that has the keyboard, and goes back to the block on Escape", () => {
    const made = make();
    cellAt(1, 2).focus();
    expect(made.chose.at(-1)).toEqual({ row: 1, column: 2 });
    expect(grid?.active).toEqual({ row: 1, column: 2 });
    press(cellAt(1, 2), "Escape");
    expect(made.left()).toBe(1);
  });
});

describe("editing a cell", () => {
  it("starts when the cell is clicked, with its words selected, and commits on Enter as one change", () => {
    const made = make();
    cellAt(0, 0).click();
    expect(grid?.editing).toBe(true);
    expect(input()?.value).toBe("North");
    type("Northeast");
    // Nothing is applied while typing: a cell edit is one change, made when the edit ends.
    expect(made.changes).toHaveLength(0);
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes).toHaveLength(1);
    expect(made.changes[0]?.rows[0]).toEqual(["Northeast", 42, "high"]);
    expect(made.changes[0]?.rows[1]).toEqual(DATA.rows[1]);
    expect(grid?.editing).toBe(false);
    expect(document.activeElement).toBe(cellAt(1, 0));
    expect(cellAt(0, 0).textContent).toBe("Northeast");
  });

  it("starts on F2 and Space, and a letter replaces the cell's words", () => {
    make();
    cellAt(0, 0).focus();
    press(cellAt(0, 0), "F2");
    expect(input()?.value).toBe("North");
    press(input() as HTMLInputElement, "Escape");
    press(cellAt(0, 0), "x");
    expect(input()?.value).toBe("x");
  });

  it("commits on Tab and moves right, and Shift+Tab and Shift+Enter move left and up", () => {
    const made = make();
    cellAt(1, 0).click();
    type("Southwest");
    const tab = press(input() as HTMLInputElement, "Tab");
    expect(tab.defaultPrevented).toBe(true);
    expect(made.changes).toHaveLength(1);
    expect(document.activeElement).toBe(cellAt(1, 1));
    press(cellAt(1, 1), "F2");
    press(input() as HTMLInputElement, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(cellAt(1, 0));
    press(cellAt(1, 0), "F2");
    press(input() as HTMLInputElement, "Enter", { shiftKey: true });
    expect(document.activeElement).toBe(cellAt(0, 0));
    // Nothing was typed in the last two cells, so they made no changes.
    expect(made.changes).toHaveLength(1);
  });

  it("takes three cells typed with Tab as three changes, one for each, a letter on a cell starting the next", () => {
    const made = make(EMPTY);
    cellAt(0, 0).click();
    type("a");
    press(input() as HTMLInputElement, "Tab");
    // Tab lands on the next cell, and the next letter typed starts its edit, as in a spreadsheet.
    expect(grid?.editing).toBe(false);
    expect(document.activeElement).toBe(cellAt(0, 1));
    press(cellAt(0, 1), "b");
    press(input() as HTMLInputElement, "Tab");
    press(cellAt(0, 2), "c");
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes).toHaveLength(3);
    expect(made.changes.at(-1)?.rows[0]).toEqual(["a", "b", "c"]);
  });

  it("cancels on Escape, keeping what the cell had, and keeps the key from going further", () => {
    const made = make();
    cellAt(0, 0).click();
    type("Nowhere");
    const event = press(input() as HTMLInputElement, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(made.changes).toHaveLength(0);
    expect(cellAt(0, 0).textContent).toBe("North");
    expect(document.activeElement).toBe(cellAt(0, 0));
    expect(made.left()).toBe(0);
  });

  it("commits what was typed when the keyboard goes elsewhere", () => {
    const made = make();
    cellAt(0, 0).click();
    type("Elsewhere");
    (input() as HTMLInputElement).dispatchEvent(new Event("blur"));
    expect(made.changes).toHaveLength(1);
    expect(cellAt(0, 0).textContent).toBe("Elsewhere");
  });

  it("makes no change when nothing changed", () => {
    const made = make();
    cellAt(0, 0).click();
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes).toHaveLength(0);
  });

  it("clears a cell to nothing when its words are deleted, and on the Delete key", () => {
    const made = make();
    cellAt(0, 0).click();
    type("");
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes[0]?.rows[0]?.[0]).toBeNull();
    cellAt(1, 0).focus();
    press(cellAt(1, 0), "Delete");
    expect(made.changes[1]?.rows[1]?.[0]).toBeNull();
    expect(cellAt(1, 0).textContent).toBe("");
  });

  it("edits a column label in the header, and refuses an empty or a too long one", () => {
    const made = make();
    cellAt(-1, 0).click();
    type("Area");
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes[0]?.columns[0]?.label).toBe("Area");
    cellAt(-1, 2).click();
    type("   ");
    press(input() as HTMLInputElement, "Enter");
    expect(made.said.at(-1)).toEqual(["A column needs a label.", true]);
    expect(grid?.editing).toBe(true);
    type("x".repeat(41));
    press(input() as HTMLInputElement, "Enter");
    expect(made.said.at(-1)?.[0]).toBe("1 over the limit of 40.");
    expect(made.changes).toHaveLength(1);
  });

  it("says why a change was refused and stays in the cell, and leaves when pressed away", () => {
    const made = make();
    cellAt(0, 0).click();
    type("Nope");
    made.refuse("The deck changed under you.");
    press(input() as HTMLInputElement, "Enter");
    expect(made.said.at(-1)).toEqual(["The deck changed under you.", true]);
    expect(grid?.editing).toBe(true);
    // Pressing away after a refusal shows what the data still says.
    made.refuse("Still no.");
    (input() as HTMLInputElement).dispatchEvent(new Event("blur"));
    expect(grid?.editing).toBe(false);
    expect(cellAt(0, 0).textContent).toBe("North");
  });

  it("refuses words that are too long for a cell", () => {
    const made = make();
    cellAt(0, 0).click();
    type("x".repeat(121));
    press(input() as HTMLInputElement, "Enter");
    expect(made.said.at(-1)).toEqual(["1 over the limit of 120.", true]);
    expect(made.changes).toHaveLength(0);
  });
});

describe("a column of numbers", () => {
  it("takes a number in the deck's language and shows it the same way", () => {
    const made = make(DATA, { language: "de" });
    cellAt(0, 1).click();
    expect((input() as HTMLInputElement).inputMode).toBe("decimal");
    type("12,5");
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes[0]?.rows[0]?.[1]).toBe(12.5);
    expect(cellAt(0, 1).textContent).toBe("12,5");
  });

  it("refuses words, says why, and keeps the cell as it was", () => {
    const made = make();
    cellAt(0, 1).click();
    type("lots");
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes).toHaveLength(0);
    expect(made.said.at(-1)?.[1]).toBe(true);
    expect(made.said.at(-1)?.[0]).toContain('"lots" is not a number');
    expect(grid?.editing).toBe(true);
    press(input() as HTMLInputElement, "Escape");
    expect(cellAt(0, 1).textContent).toBe("42");
  });

  it("refuses the other language's decimal sign, naming the right one", () => {
    const made = make();
    cellAt(0, 1).click();
    type("1,5");
    press(input() as HTMLInputElement, "Enter");
    expect(made.said.at(-1)?.[0]).toContain('"." as the decimal sign');
  });

  it("does not tell a person off while a number is half typed", () => {
    const made = make();
    cellAt(0, 1).click();
    type("4.");
    expect(made.said.at(-1)).toEqual(["", false]);
    expect((input() as HTMLInputElement).getAttribute("aria-invalid")).toBeNull();
  });
});

describe("pasting into the grid", () => {
  it("fills cells from tab-separated text at the cell that has the keyboard, as one change", () => {
    const made = make();
    cellAt(0, 0).focus();
    const event = paste({ plain: "Alpha\t1\nBeta\t2" });
    expect(event.defaultPrevented).toBe(true);
    expect(made.changes).toHaveLength(1);
    expect(made.changes[0]?.rows).toEqual([
      ["Alpha", 1, "high"],
      ["Beta", 2, null],
    ]);
    expect(texts()).toEqual([
      ["Alpha", "1", "high"],
      ["Beta", "2", ""],
    ]);
  });

  it("reads the table in HTML and puts only its text in the cells", () => {
    const made = make();
    cellAt(1, 0).focus();
    paste({
      html: "<table><tr><td><b>East</b><script>window.pwned=1</script></td><td>7</td></tr></table>",
    });
    expect(made.changes[0]?.rows[1]).toEqual(["East", 7, null]);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("grows the table and says what was left out past the limits", () => {
    const made = make(EMPTY);
    cellAt(0, 0).focus();
    const rows = Array.from({ length: 33 }, (_, n) => `r${n}`).join("\n");
    paste({ plain: rows });
    expect(made.changes[0]?.rows).toHaveLength(30);
    expect(made.said.at(-1)).toEqual(["Left out 3 rows past the limit of 30 rows and 12 columns.", true]);
  });

  it("refuses a paste into a number column that has words in it, whole, and says why", () => {
    const made = make();
    cellAt(0, 0).focus();
    paste({ plain: "Alpha\tmany" });
    expect(made.changes).toHaveLength(0);
    expect(made.said.at(-1)?.[1]).toBe(true);
    expect(texts()[0]).toEqual(["North", "42", "high"]);
  });

  it("leaves a block copied from Depthcue to the editor, which pastes it after the table", () => {
    const made = make();
    cellAt(0, 0).focus();
    const envelope = JSON.stringify({ depthcue: "block", version: 1, block: { type: "text" } });
    expect(paste({ json: envelope, plain: envelope }).defaultPrevented).toBe(false);
    expect(
      paste({ html: `<span data-depthcue-block="x">Words</span>`, plain: "a\tb" }).defaultPrevented,
    ).toBe(false);
    expect(made.changes).toHaveLength(0);
  });

  it("leaves one cell's words to the browser while a cell is being typed in", () => {
    const made = make();
    cellAt(0, 0).click();
    expect(paste({ plain: "just words" }, input() as HTMLInputElement).defaultPrevented).toBe(false);
    expect(made.changes).toHaveLength(0);
    expect(grid?.editing).toBe(true);
  });

  it("takes several cells while a cell is being typed in, at that cell, and ends the typing", () => {
    const made = make();
    cellAt(0, 2).click();
    paste({ plain: "x\ny" }, input() as HTMLInputElement);
    expect(grid?.editing).toBe(false);
    expect(made.changes[0]?.rows.map((row) => row[2])).toEqual(["x", "y"]);
  });
});

describe("setting other data", () => {
  it("draws it, keeping the cell that had the keyboard", () => {
    make();
    cellAt(1, 1).focus();
    grid?.set({ ...DATA, rows: [...DATA.rows, ["West", 1, null]] }, true);
    expect(texts()).toHaveLength(3);
    expect(grid?.active).toEqual({ row: 1, column: 1 });
    expect(document.activeElement).toBe(cellAt(1, 1));
  });

  it("moves the keyboard to the nearest cell when the one it was on is gone", () => {
    make();
    grid?.focus({ row: 1, column: 2 });
    grid?.set({ columns: DATA.columns.slice(0, 2), rows: DATA.rows.slice(0, 1) }, true);
    expect(grid?.active).toEqual({ row: 0, column: 1 });
  });
});

describe("what a cell holds", () => {
  it("keeps words as words in a column of words, even when they look like a year", () => {
    const rows: Cell[][] = [["2024", 2024]];
    const made = make({ columns: [words("A"), numbers("B")], rows });
    cellAt(0, 0).click();
    type("2025");
    press(input() as HTMLInputElement, "Enter");
    expect(made.changes[0]?.rows[0]).toEqual(["2025", 2024]);
  });
});
