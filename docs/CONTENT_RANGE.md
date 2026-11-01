# Content range

Status: approved 2026-11-01, campaign `depthcue-content-range`.

Goal: a person can make in the editor what they expect from PowerPoint (tables, several chart types, text styles,
colors and fonts), with a right-click menu on everything, and an agent can do the same through the same operations.

Before this work: 7 block types (heading, text, quote, image, bar-chart, caption, clip), 2 fixed themes (paper,
ink), plain text only, one font of each kind in one weight, no right-click menu, and no block copy, paste or
duplicate.

## Steps (one merge each)

1. **Contracts.** Schema 0.3 fixes every new field before any feature is built, so the parallel steps never edit the
   schema at the same time: the deck palette and font pair, text size, alignment and color, the inline text markup
   (its parser and the length rule live in core), the table block, and the chart block. A chart's data has the same
   shape as a table (columns and rows), so one grid edits both and changing a chart's type keeps its data. Old
   `bar-chart` blocks stay valid. A new scene is 0.3. An older one becomes 0.3 when it gains a 0.3 field, or by the
   `scene.upgrade` operation, and its text is escaped so it reads the same. The player shows a block it cannot draw
   yet as a labeled placeholder instead of failing. No editor work.
2. **Right-click menu.** It is built from the Ctrl K command list, filtered to what was clicked, so the two can never
   disagree. Targets: a block, an empty part of the slide, a scene in the strip. Adds block cut, copy, paste and
   duplicate. Opens with Shift+F10 or the Menu key, and with a long press on touch. While you type inside a text,
   the browser's own menu stays, so spelling suggestions keep working.
3. **Deck style.** The palette recolors the theme's named colors (`bg`, `surface`, `line`, `text`, `muted`, `action`,
   `evidence`), and paper and ink become two presets. Fonts come as 4 open-license pairs, with a bold weight for body
   text. Text chooses one of four tones by name (`text`, `muted`, `action`, `evidence`), never a raw hex, so changing
   the palette restyles the deck. `depthcue check` rejects text below 4.5:1 contrast on its background
   (3:1 for large text). An export carries only the deck's own fonts.
4. **Table block.** Up to 12 columns and 30 rows, an optional header row, number columns right-aligned with a unit.
   Paste from Excel, Google Sheets or CSV. Tab and Enter move between cells. Right-click a cell to insert or delete
   rows and columns. It is a real `<table>` in the player and the export, and the render check reports overflow.
5. **Text styles.** Bold, italic, links, colored text, bulleted and numbered lists, four sizes, and left, center or
   right alignment. Stored as a small Markdown subset inside the text (`**bold**`, `*italic*`, `[text](https://...)`,
   `[text]{action}`), which agents already write well and which diffs cleanly. Core turns it into DOM nodes, never
   into HTML, and links may only be https or mailto. Length limits count what the audience sees.
6. **Chart types.** Bar, stacked bar, line, area, scatter and donut (up to 6 parts), with up to 6 series, edited in
   the step 4 grid and switched from the right-click menu. A 0.3 file stores no series color: the chart derives each
   one from the deck's palette by series position, the same way every time. Every chart carries its data as a table
   for screen readers.
7. **Close-out.** The demo deck uses each new feature. Guides, changelog, budgets, bench, and a walkthrough at 1440
   and 1024 wide.

## How it runs

The steps run in waves. Steps in one wave touch different files, so they are built at the same time:

- Wave A: 1 contracts (core) and 2 right-click menu (editor).
- Wave B: 3 deck style and 4 table block.
- Wave C: 5 text styles and 6 chart types.
- Wave D: 7 close-out.

Who does what:

- The conductor (Opus) writes each brief, reviews every diff before it merges, looks at the screenshots, and
  settles conflicts between parallel branches.
- A builder (a Sonnet subagent, Opus for the contracts) builds one step in its own git worktree outside the
  repository folder, runs the full verify there, and opens the PR. It never merges, and never edits outside its
  step's files.
- A merge script, not a model, watches each PR: it brings the branch up to date with main, waits for CI on the
  branch's own commit, merges, then waits for CI on main. It costs no tokens, and when it exits the conductor is
  woken to start the next step.
- Haiku subagents do the bounded checks with a clear right answer: reading a red CI log down to the failing test
  and line, and the survey after each wave (main green by commit, branches and worktrees removed, no PR left open).
- Cod reviews the contracts PR, because the schema is the hardest thing to change later.

## What holds for every step

- Agent parity: every new property has an operation, an MCP description and a check. The same change made in the
  editor and through `depthcue apply` writes the same files, and a test proves it.
- Old decks: 0.1 and 0.2 decks load unchanged, and a file is rewritten as 0.3 only when it uses a new field.
- Each step adds its own e2e test file instead of growing a shared one, so parallel branches do not conflict there.
- A step is done when CI is green by commit on the PR and on main, its e2e test passes, and the conductor has looked
  at the screenshots.
- The plan has 7 steps and the campaign refuses an 8th, so a new step needs your OK. Bugs found on the way get
  their own fix, outside this plan.

## Budgets

- Chart module: 3 KB to 8 KB Brotli. New table module: 3 KB.
- Exported page script: 10 KB to 16 KB (it holds the player and its modules in one file).
- Editor script stays under 90 KB (61 KB before this work). Core runtime stays under 60 KB (34.6 KB before).
- Fonts are files beside the deck, not script, and an export copies only the pair the deck uses.

## Step 1 record: what the contracts fixed

- **Versions.** Text below 0.3 is shown as written; from 0.3 it is markup. The operation that adds a 0.3 field
  upgrades the scene first, so the text it writes is read as markup. Review upgrades an older reviewed scene before
  copying newer text into it, and compares both sides in the newer form, so an upgrade alone is no change. A 0.3 field
  in a file that says an older version is an error named for it: `tone-needs-version`, `size-needs-version`,
  `align-needs-version`, `table-needs-version`, `chart-needs-version`, `palette-needs-version`,
  `fonts-needs-version`. Markup an operation writes into an older scene gets the warning `text-is-literal`.
- **Colors.** `state` and `on-state` are not in the palette: they mark live, current and done in Depthcue's own
  controls, never on a slide. The tones also color a `[label]{tone}` span. They are foreground roles with contrast
  duties, not a data palette, so a chart column takes no color; a stored override can come later as an added field.
  `styleOf(deck)` resolves the preset, the palette and the font pair (`editorial` when unset).
- **Contrast codes.** `palette-low-contrast` (deck.json): `text`, `muted` and `evidence` need 4.5:1 on `bg` and on
  `surface`, since the player draws body text, captions and source links in them; `action` needs 3:1.
  `tone-low-contrast` (scene): a tone on text that is not large needs 4.5:1 on both. Large text is a heading or size
  `l` or `xl`, so steps 3 and 5 must draw those at 24 CSS pixels or more.
- **Markup.** As planned, paired much the way CommonMark pairs stars, with two differences: a star opens or closes
  by the space next to it alone, so italic works inside a word, and what is left of a star run after it pairs counts
  as its own run. `serializeText` writes a tree back in one canonical form; a fuzz test holds that what it writes reads
  back with the same marks and is stable.
- **Markup scope.** Markup is read only in a text block's `text` in a scene of 0.3 or later. Every other string
  (titles, image captions, alt text, table cells, column labels, units, source labels, notes) is always literal.
- **Compatibility.** A Depthcue that does not know a file's version refuses the file and writes nothing. Unknown
  fields are rejected, never dropped. Each scene upgrades on its own, when it gains a 0.3 field or through
  `scene.upgrade`, so one transaction may upgrade some scenes and leave others.
- **Length.** The limits per role count what the audience sees in 0.3 (`too-long` says "as shown"), and text that
  shows nothing is `too-short`. The stored length is capped at more than twice that (heading 240, body 1600, caption
  400, quote 800), so an upgraded text always fits.
- **Data codes.** `row-length` (one cell per column), `cell-kind` (a cell holds its column's kind; null is an empty
  cell, except a chart's category), `donut-shape` (one series, at most 6 parts) and `donut-value` (each part 0 or
  more, adding up to more than 0). `missing-source` covers charts, not tables, which may hold only words.
- **Bar charts.** `bar-chart` stays valid. `chartFromBarChart` gives the equivalent `chart`, and `replaceBlockOps`
  swaps it in as `block.remove` and `block.add` with the same id in one transaction, so no new operation was needed;
  review shows the swap as one change of `type`.
- **Player and editor.** Tables and charts are labeled placeholders until steps 4 and 6. Until steps 3 and 5 the
  player draws 0.3 text as written and ignores tone, size, align, palette and fonts, and the editor shows and writes
  text as its raw source, which keeps an agent's markup intact. The editor's coverage test lists the new fields as
  `PENDING`, by the step that adds their controls; each step empties its part.
- **MCP.** deck_get and deck_apply now describe the markup, the text fields, tables, charts, the palette and
  `scene.upgrade`. The size test allows 1100 characters per description and 12000 for the tool list.

## Step 3 record: the deck's look

- **Fonts.** `brand/fonts/` holds 16 Latin and Latin Extended woff2 subsets of seven OFL families, listed with source,
  size and sha256 in `manifest.json` and rebuilt by `subset.py`. Editorial is Instrument Serif and Space Grotesk,
  modern is Inter, classic is Source Serif 4 and Source Sans 3, technical is IBM Plex Sans; all four set data in IBM
  Plex Mono. The player build writes `fonts/<pair>.css` and `all.css` from the manifest. The serve and editor shells
  link `all.css`; an export copies the one pair's sheet and the files it names, and opens from `file://`.
- **Look.** `applyLook` puts `data-theme`, `data-fonts` and an inline `--dc-<color>` for each color the palette names
  on the player, presenter, editor canvas and thumbnails. A heading's weight is `--dc-display-weight` (400 for the
  serifs, 700 for Inter and Plex Sans), so no face is made up by the browser.
- **A refused palette is not saved.** `apply` refuses any change whose diagnostics hold an error, and `checkManifest`
  holds `palette-low-contrast`, so a palette that fails contrast never reaches the file. The Style section says so at
  the swatch and in the editor's hint, and the deck keeps its last good palette. The plan had such a palette saved and
  shown in the problem ribbon; that needs core to make the code non-blocking in `apply` and `problemsOf` to read
  `checkPalette`. From Paper a dark `bg` is refused until Ink is chosen, and a preset switch is refused when a
  palette color would be unreadable on it.
- **Left as brand constants.** The vermilion accents of the quote rule, title dot and cue dot, and the mono weight
  600 of editor chrome (only Plex Mono Regular ships, so it is synthesized there).

## Not in this plan

Raw hex colors on a single block, uploading your own fonts, per-block animation, bring-to-front and send-to-back
(block order is reading order), donut charts beyond 6 parts, editable PPTX export (0.7 in `docs/PLAN.md`).

Declined in review:

- Stable ids for table rows and columns: data cells are edited as whole rows with `block.set`, and optional ids can
  be added later without breaking decks.
- A list block instead of `- ` lines: agents write markdown lists well, and a list block can be added later without
  breaking anything.
- Row-level and cell-level provenance: it belongs to the 0.4 data module in `docs/PLAN.md`.
