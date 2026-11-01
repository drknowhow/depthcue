# Tables and charts

A table shows words and numbers in rows and columns. A chart draws numbers as bars, lines, areas, points or a ring.
Both are blocks like any other: you add them from the quick bar, edit them where they sit, and pin, cite and reorder
them the same way. Both keep their data as plain rows in the deck's files, so a person, an agent and `depthcue check`
read the same numbers, and the player draws them as text and shapes with no picture in between.

## Add a table

Press Table on the quick bar at the foot of the stage, or right-click an empty part of the slide and choose Add a
table here. A table of three columns and three rows appears, and the first cell is ready for typing. A table has no
key of its own.

You edit the cells the way you would in a small spreadsheet:

- **Move.** The arrow keys move over the cells, and `Home` and `End` go to the first and last cell of the row. `Tab`
  goes to the next cell and on to the next row, and `Enter` goes down. `Shift` with either goes the other way.
- **Type.** Start typing on a cell to replace what is in it. Click a cell, or press `F2` or `Space`, to edit what is
  there. `Enter` or `Tab` keeps it and moves on, and `Esc` drops it. `Delete` or `Backspace` empties the cell. `Esc` on a
  cell you are not editing leaves the grid.
- **Right-click.** A cell has its own menu, also on `Shift+F10` or the Menu key: Insert row above or below, Insert
  column left or right, Delete row, Delete column, Show or Hide header row, and Make column numbers or Make column
  text.

The first row is the header, and it holds the column labels. When the columns need no names, hide it with the Header
row box in the Table popover or with Hide header row on the cell menu. The Table popover also has the table's title,
which shows above it and is read first by a screen reader.

## Paste from Excel, Sheets or a CSV file

Copy cells in the program you have them in, click a cell and press `Ctrl+V`. The pasted cells fill the grid from that
cell, and it grows to take them. Cells from Excel and Google Sheets come as a table, and plain text with tabs, commas or
semicolons between the values comes as a table too, as long as every line has the same number of values. Only the words
are kept. No fonts, colors or formulas come with them.

In a new table that you have not typed in, paste at the first cell and the editor reads a header row when the top row
is words over a column of numbers, and makes that column a number column.

A few things stop a paste:

- A paste that puts words into a number column is refused whole, with the row and the word, and nothing changes.
- What does not fit is left out, and a note says how much: a table holds 12 columns and 30 rows.
- A cell holds 120 characters and a column label 40.

One paste is one step of Undo. `Ctrl+C` on a cell copies the whole table, as tab-separated text that any spreadsheet
takes and as a block that another deck's editor can paste.

## Number columns and units

A column that holds numbers takes numbers only, lines them up on the right with digits of equal width, and shows a unit
beside its label. Each column has a Words or Numbers menu in the Table popover, and Make column numbers is on the cell
menu. A column that has words in it cannot become a number column until they are numbers, and the message names the
cell. A Numbers column also gets a Unit box in the popover.

Type a number the way the deck's language writes it: `1.5` in English and `1,5` in German. A thousands separator is
accepted when it is in groups of three, so `1,200` is stored as 1200. The slide shows numbers without a separator, so
a year stays a year and a figure reads as it was typed.

Type the unit, such as `orders` or `%`, in the Unit box. It shows in the header as `Orders (orders)`, so a table with
its header row hidden shows no units.

## Add a chart

Press Chart on the quick bar (`C`) or choose Add a chart here from the right-click menu. A bar chart of three rows
appears, and the Data popover on its toolbar opens the data in the same kind of grid as a table.

Data holds a title, a unit for the values, and the grid. The first column is the categories, and every other column is
a series. Add row, Add series, Delete row and Delete series are buttons at the foot of the popover, which scrolls on a
small screen, and the grid takes the same keys as a table does. Paste works too, so a range copied from a spreadsheet
becomes a chart in one step.

A chart takes up to 6 series and 30 rows, with labels of 40 characters.

## Six kinds and the data each takes

| Kind        | Data                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Bar         | A category in the first column, one or more series of numbers. Several series sit side by side. |
| Stacked bar | The same data, with the series stacked on each other.                                           |
| Line        | The same data. The categories run left to right in the order of the rows.                       |
| Area        | The same data, filled under each line.                                                          |
| Scatter     | A number in the first column for the x value, then one or more series for y.                    |
| Donut       | One series of up to 6 parts, none below zero, adding to more than zero.                         |

Bars and areas start at zero. A line starts at zero only when its smallest value is half its largest or less, so a line
that wanders between 96 and 104 is not flattened into a stripe.

## Change the kind

Right-click the chart, choose Chart type, and pick a kind. The kind the chart has is ticked. A kind the data cannot take
is greyed with the reason, for example that a donut holds one series. Going to or from scatter turns the first column
from words into numbers or back, and says which row cannot be a number when one cannot. One change is one step of Undo.

The same menu has Edit data, which opens the Data popover.

## Convert an old bar chart

Decks written before schema 0.3 draw bars with a `bar-chart` block, and that block still works. Its toolbar has Add bar
and Sort, and you drag a bar to change its value. Right-click it, choose Chart type and pick any kind, and it becomes
a `chart` block with the same id, title, unit, sources and place, so a claim that cites it still does. The values go
into a two-column grid headed Label and Value. The new block has no Sort, and bars are changed in the grid.

## Series colors

You do not choose a series color. Series 1 uses the deck's evidence color and series 2 its action color. Series 3 to 6
are mixes of the palette. A change to the palette in [Style](style.md) recolors every chart. Each series also has its
own mark shape and a legend names them when there are two or more, so the chart reads without color.

## Screen readers

A chart is an image labeled with its kind and title, such as "Line chart: Share of orders by quarter". Beside it sits a
real table of the same rows and columns, hidden from view and read out by a screen reader. A table is a table, with its
title as the caption and its header cells marked as column headers.

## Marking a row while presenting

The table module marks the row under the pointer while you present, and an agent that holds the lease can mark one row
and have it read out (`highlight`, counting data rows from 0). Without the module, or without a script, the table is
still a complete table. Turn it off with Table row marker in the Deck popover, or with `"modules": { "table": "off" }`
in `deck.json`.

## For an agent

An agent writes the same blocks with `block.add`, and changes them with `block.set`. A table or chart in a scene
written for an older schema upgrades that scene to 0.3 when it is added. This example adds a table and replaces
the bar chart in the demo's demand scene with a donut under the same id, in one transaction:

```json
[
  {
    "op": "block.add",
    "scene": "demand",
    "block": {
      "id": "table-orders-now",
      "type": "table",
      "title": "Orders, latest quarter",
      "columns": [{ "label": "Channel" }, { "label": "Orders", "kind": "number", "unit": "orders" }],
      "rows": [["Channel A", 4000], ["Channel B", 6000]],
      "sourceIds": ["source-report"]
    }
  },
  { "op": "block.remove", "scene": "demand", "id": "chart-demand" },
  {
    "op": "block.add",
    "scene": "demand",
    "after": null,
    "block": {
      "id": "chart-demand",
      "type": "chart",
      "kind": "donut",
      "title": "Share of orders, latest quarter",
      "unit": "%",
      "columns": [{ "label": "Channel" }, { "label": "Share" }],
      "rows": [["Channel A", 40], ["Channel B", 60]],
      "sourceIds": ["source-report"]
    }
  }
]
```

Save it as `ops.json` and apply it to a copy of `fixtures/decks/demo`:

```sh
depthcue apply my-deck ops.json --base-rev "$(depthcue rev my-deck)"
depthcue check my-deck
```

`apply` prints `Applied.` and the new revision, and `check` prints `0 errors, 0 warnings`. A number column holds JSON
numbers and a words column holds strings. An empty cell is `null`. Every row has one cell for each column.

`depthcue check` says what is wrong with the data, and `--json` adds a code to each message: `row-length` when a row has
the wrong number of cells, `cell-kind` when words sit in a number column, `donut-shape` for more than 6 parts or more
than one series, and `donut-value` for a part below zero or a sum of zero. A `table` or `chart` written by hand into a
scene file that still says 0.1 or 0.2 is a `table-needs-version` or `chart-needs-version` error. Remove the block and add
it again with `block.add`, which writes the scene as 0.3. See [Style](style.md#for-an-agent) and
[The editor](editor.md#for-an-agent) for the other operations.

## Related guides

- [The editor](editor.md): the right-click menu, formatting and keys.
- [Style](style.md): the palette, fonts, tones and sizes that charts and tables follow.
- [Export](export.md): what a table or chart is in an exported deck.
