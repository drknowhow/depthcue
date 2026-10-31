# Editor remake

The v0.1 editor works but is hard to use: a form panel beside a small slide, only text editable on the slide,
no quick tools. This plan replaces it with a canvas-first editor. It is the working spec for the campaign
`depthcue-editor-remake`; each phase below lands as one or more pull requests.

The interaction details live in a working sketch, `docs/design/editor-remake/hybrid-sketch.html`. Open it in a
browser and click through it. It is a picture of the product, not product code: it has no deck behind it.

## Baseline

Measured on v0.1 at 1440 by 900:

- The slide is about 770 by 430 px. The right panel is about 1,250 px tall with six collapsible sections.
- Only text blocks are editable on the slide. Charts and images are edited through forms.
- There is no quick way to add a block, and Save is manual (a draft is kept in case of a crash).

## Decisions

- **Slots by default, pinning on request.** Blocks sit in the automatic slots of the three layouts (title,
  claim-evidence, text-media). A person can pin a block to give it a position and size. Pinning is explicit: the
  Free toggle in the block toolbar, or `P`. Dragging a block in a slot moves it between slots, it does not pin it.
- **Comments are for people and agents, and stay out of the deck.** They live in their own file. Exports and
  the presenter view never contain them.
- **Autosave replaces the Save button.** A stale `base_rev` surfaces as a conflict state with Reload and Keep
  mine as copy. Autosave never overwrites a newer revision. This was assumed from the sketch and is easy to
  reverse.
- **The thesis holds.** A model emits a spec and an engine lays it out. Agents keep writing automatic layouts;
  frames are a human override on top.

## Model

### Frames

A pinned block has an optional `frame`: `{ "x": 56, "y": 14, "w": 38, "h": 44 }`, in percent of a 16 by 9
slide. It is keyed by block id, so it survives an agent rewriting the scene as long as the id stays. Removing a
block drops its frame. Reading order is block order, never frame position. Schema version 0.2 adds `frame`;
v0.1 decks load unchanged.

`x` and `y` run from 0 to 100, `w` and `h` from 5 to 100 (the smallest a person can still grab), and the box stays
on the slide: `x + w` and `y + h` are at most 100, with a thousandth of slack for rounding. The schema checks the
ranges; `checkFrames` in `frames.ts` checks the sums. A file may declare `schemaVersion` 0.1 or 0.2, and a 0.1
scene with a frame is refused. Applying an operation that leaves a 0.1 scene with a frame rewrites it as 0.2, the
way the tool already sets the version of a new scene, so an agent never has to. Two operations write a frame by
block id, `block.frame` (all four numbers) and `block.unframe`; `block.set` with a `frame` key also works. A scene
stays at 0.2 after its last frame is cleared.

The player and an exported page draw a scene with a pinned block as a 16 by 9 slide, centered in the window. A
pinned block leaves the template's regions and sits at its frame in a layer over the slide, in block order; the
template lays out the other blocks as if it were not there, and a media column left with nothing is dropped.
Type scales with the slide's width, so a frame holds the same text on a laptop and a projector. In a window
narrower than 640 px a slide would be too small to read, so the pinned blocks follow the template in the flow
instead. The reading view ignores frames.

Three checks look at frames. `depthcue check` warns with `frame-outside-safe-area` when a text or chart frame reaches
into the 4% margin at any edge; a picture or a clip may bleed. `depthcue render` and `deck_render` measure the real
page: a pinned block that overlaps another block is a `frame-overlap` warning, since a label over a picture can be
on purpose, and a pinned block whose content is larger than its frame is a `frame-overflow` error. Two blocks in the
template that overlap stay an `overlap` error.

An agent sees frames too. `deck_get` lists a pinned count per scene in the outline and the `frame` of each pinned block
in the detailed block list; `deck_apply` pins and unpins with `block.frame` and `block.unframe`. `deck_render` returns
errors in `diagnostics` and advice in `warnings`, and `ok` is true when there are no errors, so a scene with only a
pinned overlap is done.

### Comments

`comments.json` sits beside the deck and has its own revision, so a comment never changes the deck revision.
A comment has an id, an author (`you` or `agent`), a block id, an anchor as a fraction of the block, a thread of
messages, a resolved flag and an optional `ask` flag (an instruction to the agent). A comment whose block is gone
is kept and shown as orphaned.

### Checks

One rule set serves the editor, `depthcue check` and `deck_render`: text that does not fit, missing alt text,
missing source, and for pinned blocks overlap and outside the safe area (4% on each side). The problem ribbon
shows these; it has no rules of its own. A Fix button exists only where the fix is deterministic.

### Agents

`deck_get` returns frames and unresolved comments. Agents can set or clear a frame, add a comment, reply and
resolve, through the same core commands the editor uses. A stale revision is refused, never merged.

## Rules for every change

- Core commands stay the only way to change a deck, from the editor, the CLI and MCP.
- The editor script stays at or under 90 KB brotli and its styles at or under 30 KB (25.8 KB and 4.9 KB at the
  start of this work).
- Scene change time is re-measured when the player or layout code changes. At v0.1 it was a p95 of 66 ms with
  default motion and 49 ms with reduced motion, against a 50 ms budget. Report the number each time; do not
  hide a regression.
- A test walks the core schema and fails when a shipped property has no editing control on the canvas, in a
  floating toolbar or in a popover (`packages/editor/test/coverage.test.ts`). It also looks for each control in
  the mounted editor, so a control that was removed or renamed fails by the name of its property.
- Look at the editor in a real browser at 1440 by 900 and 1024 by 768 before merging an editor change.
- Keyboard shortcuts work when the pointer is over the editor or focus is inside it, and the panels keep focus
  when they redraw.
- An update during a drag changes the dragged element in place. Redrawing the whole stage stops the drag.
- Overflow is measured on a block's content, not on the selection handles drawn around it.

## Where each property is edited

Every property the schema defines gets a control on the slide, in a floating toolbar or in a popover. The details
panel that once held all of them is gone. This table says where each one is edited, for people. The schema-walk
test checks the same thing for the machine: its `WAYS` map names a control for each property, or says why a person
never edits it (ids, kinds and format markers). A new property in the schema fails that test until it has a way.

| Property                                      | Where                                                         |
| --------------------------------------------- | ------------------------------------------------------------- |
| text: `role`, `text`                          | Role menu in the toolbar; text typed on the slide             |
| text, chart, image, clip: `sourceIds`         | Cite chip in the toolbar                                      |
| chart: `title`, `unit`                        | Data popover: title and unit                                  |
| chart: `data` values                          | Drag a bar, or arrow keys on it (Shift moves five steps)      |
| chart: `data` labels                          | Typed on the slide, in the row's label                        |
| chart: `data` rows                            | Add bar and Sort in the toolbar; Data popover: remove, move   |
| image: `asset`                                | Drop or paste on the image; Edit popover: file, upload        |
| image: `alt`, `caption`                       | Edit popover: alt text (flagged until written), caption       |
| clip: `source`, `poster`, `alt`               | Edit popover: video menu, poster menu, alt text               |
| clip: markers in `<video>.cues.json`          | Cues popover: add at the playhead, rename, retime, remove     |
| block order                                   | Earlier and later buttons in the toolbar; the grip on a block |
| scenes: add, order, duplicate, delete         | Scene strip: Add scene, drag, and the buttons on each scene   |
| new blocks, claim: `summary`                  | Add row under the slide: Text, Image, Chart, Clip, Claim      |
| scene: `layout`, `lead`                       | Buttons in the top bar                                        |
| scene: `title`, `steps`, `sources`            | Scene popover in the top bar: title, steps, sources           |
| scene: `notes`, `reading`                     | Notes popover in the add row: speaker notes, reading version  |
| claim: `text`                                 | Typed on the slide                                            |
| claim: `evidenceIds`                          | Evidence chip in the claim's toolbar                          |
| deck: `title`, `language`, `theme`, `modules` | Deck popover in the top bar                                   |
| any block: `frame`                            | Not yet: drawn by the player, no editor control until step 12 |

Clip markers are not part of the deck. They live in the cue map beside the video, so the schema-walk test does not
see them and they are not in the deck's Undo. The editor writes a marker to the file as soon as it is made, after
reading the file again so a rebuild since the last look is not overwritten. The Cues popover has its own Undo
marker change button, which takes back marker changes only. Cues that come from the scene are listed and can be
jumped to, but only markers are edited. A cue file the editor cannot read is left alone and named in the popover.

Blocks move between slots with the grip beside each block, which shows while the pointer is over the slide. Dropped
on another block of the same area, the dragged block goes before or after it. Dropped on a block of another area, the
two swap. Dropped on an empty part of an area, it moves there. The core decides (`placeBlock` in `slots.ts`), so
the editor and an agent get the same answer. Moving a block into Evidence adds it to the claim's `evidenceIds`, and
moving it out removes it, because that is what the layout draws. Text and media keep to their own areas, the claim
area takes no blocks, and a refused drop says why while the pointer is over it. One drop is one step of Undo. A grip
needs room beside its block, so a narrow slide (a phone, or a small window) shows none. The keyboard and a phone
reorder with the toolbar's earlier and later buttons, and cite with the Evidence chip.

An area that holds nothing gets a dashed place on the slide, drawn by the editor only, never by the player or the
export: Evidence while the claim cites nothing, Support when every block is cited, Media on a slide of text, Text on
a slide of pictures, and the claim itself where a slide has none. A click opens a menu of the kinds the area takes
(Text, Image, Chart, Clip), or adds text at once where text is the only kind. A block dragged over a place drops
into that area. The new block goes after the last one there, and in Evidence the claim cites it in the same step
(`addBlock` in `slots.ts`). A scene needs one block, so a title slide never has an empty area.

The Build order button under the slide puts a badge beside the claim and each block. A filled badge shows the step
that reveals the part (the first one that names it); a ring with a dot means the part is there from the start. A
badge opens a short list: From the start, each step of the scene, or A new step. The core decides (`placeInBuild`
in `build.ts`): a part goes to one step only, a step it leaves empty is removed so the steps after it count one
less, and a scene that ends with no steps drops the `steps` list. One choice is one step of Undo. A scene holds at
most 24 steps, and the editor says so when a new one would be the 25th. The badges are drawn by the editor only, and
the Scene popover's Steps section stays for putting steps in a different order and for removing one.

## Phases

| Phase | What lands                                                                     | PRs |
| ----- | ------------------------------------------------------------------------------ | --- |
| 1     | Shell: slim top bar, thumbnail strip, large stage, autosave                    | 2   |
| 2     | Selection, floating toolbars per block type, notes sheet, old panel out        | 3   |
| 3     | Done: chart bars, image drop, clip cues, slot grips, empty places, build order | 6   |
| 4     | Schema 0.2, player and checks, pinning, layout interplay                       | 4   |
| 5     | Quick bar, shortcuts, problem ribbon, Ctrl K palette                           | 2   |
| 6     | Comments: model, agent side, editor                                            | 3   |
| 7     | Review of agent changes, storyboard                                            | 3   |
| 8     | Docs, final measurements, walkthrough                                          | 1   |

## Done when

- At 1440 by 900 the slide is at least 1,000 px wide with no form panel, and the schema-walk test passes.
- In a real browser a block is pinned, moved with snap guides, resized and sent back to its slot. The saved scene
  holds a frame, and the player and an exported folder render it the same way.
- An agent edit through `deck_apply` keeps frames by block id. Overlap, outside-the-safe-area and overflow on
  pinned blocks are reported by `depthcue check` and `deck_render`.
- A comment made in the editor is read and answered by an agent through MCP and resolved in the editor. A test
  shows no comment text reaches an exported folder or the presenter view.
- Agent changes appear in a review drawer with Accept and Revert for each change, and the storyboard lists every
  scene with its lead, changes, comments, pins and problems.
- The editor is within budget, scene change time is reported, and screenshots at 1440 and 1024 wide were looked at.

## Not in this work

- Slide sizes other than 16 by 9. Frames are percent of a 16 by 9 slide; other ratios need their own frames.
- Free placement for agent-written layouts. Agents place blocks in slots.
- A public release. The repository stays private until the owner says otherwise.
