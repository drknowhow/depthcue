# Changelog

Notable changes to Depthcue, newest first. Nothing has been released yet, so everything is under Unreleased.

## Unreleased

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

- The demo video and its scene text still show the v0.1 editor and say changes save only when you ask.
- Scene change time with default motion is probably still over its 50 ms budget on a 60 Hz display. See
  [Results](docs/EDITOR_REMAKE.md#results).

### Fixed

- A test of the edit API's token check failed about one run in 64, when the made-up wrong token happened to equal
  the real one.
