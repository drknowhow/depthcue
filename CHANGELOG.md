# Changelog

Notable changes to Depthcue, newest first. Nothing has been released yet, so everything is under Unreleased.

## Unreleased

### Export button

The editor bar has an Export button. It opens one dialog where a person picks PowerPoint, PDF or HTML (a zip of the
offline page) and whether the speaker notes and the comments go in. PowerPoint gets the comments as PowerPoint comments
on each scene's first slide, the PDF gets a notes and comments section after the last page, and the zip gets
`comments.html` and `comments.json` beside the page. The page itself never carries comments. The live server has two new
calls, `/_depthcue/api/export.pdf` and `/_depthcue/api/export.html`, and the PowerPoint call takes `comments`.

### Images: crop, fit, focus, backgrounds and a library

A picture can be cropped, shown whole or made to fill its box around a point you choose, marked decorative, and put
behind a whole slide with a scrim. An agent can add the image file and set the same properties. The guides are
[the editor](docs/editor.md#pictures), [placing blocks](docs/placement.md#pictures-in-a-frame) and
[the export](docs/export.md#pictures). The build record is [docs/IMAGES.md](docs/IMAGES.md).

A person can:

- Crop a picture with handles on its edges and corners, move the picture under the crop, and choose the focus point that
  stays in view when a filled picture is cut. Enter or a click outside applies the crop as one step of Undo, and `Esc`
  cancels. The keyboard does all of it, and each handle has a spoken name.
- Switch a picture between Fit and Fill, reset it, and tick Decorative for a picture that carries no information.
- Resize a pinned picture by a corner and keep its shape (Shift frees it), and use Fit box to picture.
- Put a picture behind the whole slide from the right-click menu or the Scene popover's Background section, with a
  scrim, a scrim color and a focus point, and take it off again.
- Open an image library from the Image button, the `I` key or Edit's "Choose from library": thumbnails with each
  file's size, its size in pixels and the slides that use it, with add, replace and delete for a file nothing uses.
  Dropping several pictures adds one block each.

An agent can:

- Add an image file with the new `deck_asset` tool (or `depthcue asset add`), list what uses each file, and remove one
  that nothing names. `depthcue asset unused` lists files nothing names.
- Set `fit`, `crop`, `focus` and `decorative` on an image block and `background` on a scene with `block.set` and
  `scene.set`. No operation was added.
- Rely on new checks: `image-crop-outside` (error), `asset-unused` (info), `asset-large` (warning, over 4 MB) and, from
  `depthcue render`, `image-low-resolution` (warning). Text over a scene background gets the measured
  `background-low-contrast` check, whose fix names the scene's scrim.

The schema is 0.6. Decks and scenes written for 0.1 to 0.5 load and draw as they did, and a scene moves to 0.6 only
when it gains one of the new fields. A picture that is not decorative still needs alt text.

Changed:

- The player draws crop and focus with a clipping box and CSS container units, so no browser feature beyond those is
  needed. An export copies a scene's background file. In PowerPoint a crop is the picture's own source rectangle, a
  focused fill is cut around the focus, a scene background is the slide's background with the scrim laid over it, and a
  decorative picture gets PowerPoint's decorative mark.
- `depthcue render` no longer reports a cropped or filled picture as cut off, since its box clips the file on purpose.
- The demo deck has three more slides and a scene background, and the demo video was recorded again from it.
  Tests that need the old demo deck read `fixtures/decks/demo-0-3`.
- CI runs four test groups, and the groups were rebalanced.
- Sizes. The editor script is 93.5 KB (was 91.1), and its limit went from 92 to 93.5 KB, the most the plan allowed. Its
  styles are 15.1 KB (was 14.5). The two new chunks are 1.7 KB (image library) and 3.6 KB (crop mode and the
  background section), each against 4 KB. The player script is 12.5 KB (was 12.2) and its styles 6.0 KB (was 5.8). The
  exported page script is 15.8 KB (was 15.4) of 16 KB. The core runtime is 46.8 KB gzip (was 46.2).
- Tests. @@TESTS@@

Not done:

- The brand's logo plate on a template scene that has its own background still shows the template's plate.
- In crop mode on a very tall or very wide crop of a filled picture, a handle can lie outside the slide. Only the
  keyboard reaches it.
- Zooming into part of a picture as a build step, and adding an image from a URL with `deck_asset`.
- Rotation, flipping, opacity, color filters, crop shapes, and controls for animated GIFs.

### Tables, charts, text styles and a deck style

A deck can now hold a table, six kinds of chart and formatted text, and it can have its own colors and fonts. The
guides are [tables and charts](docs/tables-and-charts.md), [style](docs/style.md) and [the editor](docs/editor.md). The
build record is [docs/CONTENT_RANGE.md](docs/CONTENT_RANGE.md).

A person can:

- Add a table from the quick bar, type into its cells, paste cells from Excel, Google Sheets or a CSV file, and
  right-click a cell to insert or delete rows and columns, hide the header row, or make a column hold numbers with a unit.
- Add a chart, edit its rows and series in a grid, and change it between bar, stacked bar, line, area, scatter and
  donut from the right-click menu. An old bar chart becomes a chart of any kind under the same id.
- Make words bold, italic, linked or colored, and make bulleted or numbered lists, from a format bar under the text's
  toolbar and with `Ctrl+B`, `Ctrl+I` and `Ctrl+K`. A text's size, alignment and color are in a Style chip and in its
  right-click menu.
- Choose Paper or Ink, change any of seven palette colors and pick one of four font pairs in the Deck popover. A color
  that would leave text hard to read is refused, with the reason.
- Right-click more things: a text, a chart, a table cell, the empty slide (Deck style) and a scene saved before 0.3
  (Use text styles).

An agent can:

- Write `table` and `chart` blocks, markup in text (`**bold**`, `*italic*`, links, `[words]{tone}`, and `- ` and `1. `
  lists), and `tone`, `size` and `align` on a text block.
- Set `palette` and `fonts` with `deck.set`, and bring an older scene forward with the new `scene.upgrade` operation.
  `deck_get` and `deck_apply` describe all of it.
- Rely on new checks: `row-length`, `cell-kind`, `donut-shape` and `donut-value` for data, `palette-low-contrast` and
  `tone-low-contrast` for color, and `<part>-needs-version` for a 0.3 part in an older file.

The schema is 0.3. Decks and scenes written for 0.1 or 0.2 load and draw as they did. A scene moves to 0.3 when a block
gets a part that needs it, or with `scene.upgrade`, and its text is escaped so it reads the same. Markup is read only in
the text blocks of a 0.3 scene. A Depthcue that does not know a file's version refuses the file and writes nothing.
`bar-chart` is still valid.

Changed:

- Add chart adds a `chart` block, and not a `bar-chart`. Add bar and Sort stay on old bar charts only.
- In a 0.3 scene, a text's length limit counts the characters the audience sees, so `**bold**` counts four.
- The bar beside a quote and the dot on a title slide use the deck's accent color. With no palette that is a slightly
  different red from before.
- An export has a `fonts/` folder with the deck's font pair (192 to 293 KB), and its script is larger.
- `apply` refuses a change that holds an error, so a palette or tone that is too faint never reaches a file. The editor
  shows the reason in a hint, not in the problem ribbon.
- The demo deck has a fourth slide with a table and a line chart, and a list, a link and a colored phrase on the last
  one. The demo video was recorded again from it.
- Sizes. The core runtime is 45.2 KB gzip (was 34.6, budget 60). The player script is 10.1 KB brotli (was 5.7) and its
  styles 4.7 KB (was 3.8). The exported page script is 13.3 KB (was 8.4), so its limit went from 10 to 14 KB, and the
  core code inside the player is 5.1 KB, so that limit went from 5 to 6 KB. The editor script is 89.3 KB (was 61.0, budget
  90) and its styles 11.4 KB (was 9.4). The new table module is 0.6 KB of 3.0 KB.
- Tests. 3,479 passed and 7 skipped in 137 files (was 2,884 passed and 1 skipped in 116). The tests read a copy of the
  old sample deck, `fixtures/decks/v0-1`, so the sample deck can change without moving them.

Not done:

- A color for one block that is not in the palette, your own fonts, and per-block animation.
- Cell-level sources, and data from a CSV file or a URL. Both belong to 0.4 in [the plan](docs/PLAN.md).
- A chart's per-column unit can only be set by an agent.
- `depthcue apply` does not print warnings, so an agent that writes markup into a scene older than 0.3 sees no sign
  that it shows as typed. `deck_apply` returns it as `text-is-literal`.
- The fonts cover Latin letters. Text in another script is drawn in the viewer's own font.

### The editor was rebuilt around the slide

`depthcue edit` used to show a small slide beside a tall form panel. The slide now fills the window, and each block is
edited where it sits. The guides are [the editor](docs/editor.md), [placing blocks](docs/placement.md) and
[comments and review](docs/comments-and-review.md). The build record is [docs/EDITOR_REMAKE.md](docs/EDITOR_REMAKE.md).

Added:

- A slim top bar, a scene strip with a thumbnail for each scene, and a floating toolbar for the chosen block. The
  details panel is gone, and a test fails when a property in the schema has no control.
- Direct editing: drag a chart bar or move it with the arrow keys, drop or paste an image, add video cue markers,
  drag a block between the layout's areas by its grip, click an empty area to fill it, and set the build order with
  badges on the slide.
- Autosave, 0.8 seconds after you stop editing, in place of the Save button. When the files change under unsaved edits,
  saving stops and the editor offers Reload or Keep mine as copy. It never overwrites newer files.
- Free placement. A block can be pinned and given a position and size in percent of a 16 by 9 slide, moved and resized
  with snap guides, typed into a Pinned popover, or put back with Layout or Auto layout. Agents place blocks in areas
  as before and can pin with the new `block.frame` and `block.unframe` operations. The schema is 0.2; 0.1 decks load
  unchanged.
- A quick bar for adding blocks, the keys `T`, `C`, `I`, `M`, `P` and `G`, a `?` sheet that lists every key, and a
  `Ctrl+K` palette for everything the editor can do.
- A problem ribbon that lists what needs a look, one at a time, from the core checks and from a real render of the
  files on disk. It needs Chrome or Edge for the render checks.
- Comments pinned to blocks, kept in `comments.json` beside the deck and never in it. An agent reads and answers them
  with the new `deck_comment` tool, but cannot delete one or mark one as a request. `depthcue comments list` and
  `depthcue comments apply` do the same from a terminal.
- Review of an agent's changes, kept in `review.json`. The editor's Review button opens a drawer where each change can
  be accepted or reverted, and a revert can be undone. `depthcue diff` lists changes and accepts or reverts them.
- A storyboard of every scene on one screen, opened with `G`, with the lead, changes, open comments, pinned blocks and
  problems of each.
- Checks: `alt-is-filename`, `missing-source` and `frame-outside-safe-area` from `depthcue check`, and `frame-overlap`
  and `frame-overflow` from `depthcue render`.

Changed:

- The MCP server has five tools. `deck_comment` is new, and `deck_get` now shows comments and each pinned block's frame.
- The core runtime is 34.6 KB gzip (budget 60 KB), and comments and review added 8.1 KB of that. The editor script is
  61.0 KB brotli (budget 90 KB). [Results](docs/EDITOR_REMAKE.md#results) has the rest of the budgets.
- `depthcue edit` help, the README and the site now say that the editor saves by itself.

Not done:

- Scene change time with default motion is probably still over its 50 ms budget on a 60 Hz display. See
  [Results](docs/EDITOR_REMAKE.md#results).

### Fixed

- The demo video and its scene text still showed the v0.1 editor and said that changes save only when you ask. The video
  was recorded again and now shows the editor as it is.
- A test of the edit API's token check failed about one run in 64, when the made-up wrong token happened to equal
  the real one.
