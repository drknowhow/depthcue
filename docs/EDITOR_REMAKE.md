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
slide. The frame belongs to the block, so an operation that names other fields leaves it: `block.set` with new
text, `block.move`, a change of the scene's layout. A block removed and added again is a new block and has no
frame unless the add gives one. Reading order is block order, never frame position. Schema version 0.2 adds
`frame`; v0.1 decks load unchanged.

`x` and `y` run from 0 to 100, `w` and `h` from 5 to 100 (the smallest a person can still grab), and the box stays
on the slide: `x + w` and `y + h` are at most 100, with a thousandth of slack for rounding. The schema checks the
ranges; `checkFrames` in `frames.ts` checks the sums. A file may declare `schemaVersion` 0.1 or 0.2, and a 0.1
scene with a frame is refused. Applying an operation that leaves a 0.1 scene with a frame rewrites it as 0.2, the
way the tool already sets the version of a new scene, so an agent never has to. Two operations write a frame by
block id, `block.frame` (all four numbers) and `block.unframe`; `block.set` with a `frame` key also works. A scene
stays at 0.2 after its last frame is cleared.

The player and an exported page draw a scene with a pinned block as a 16 by 9 slide, centered in the window. A
pinned block sits at its frame in a layer over the slide, in block order, and keeps its place in the template: the
template lays out every block as it would without the pins and leaves a gap where a pinned one was, so pinning a block
moves nothing else. The gap closes when the block goes back to its slot or is deleted. A media column that holds only
a pinned picture keeps its width. The gap is a copy of the block that has no id and is hidden from sight, readers and
keyboard. Type scales with the slide's width, so a frame holds the same text on a laptop and a projector. In a window
narrower than 640 px a slide would be too small to read, so the pinned blocks follow the template in the flow instead,
and no gap is kept. The reading view ignores frames.

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

`comments.json` sits beside `deck.json` and has its own revision (16 hex characters of its content, as for the
deck), so a comment never changes the deck revision. A comment has an id (`c1`, `c2`, or a name), the scene and block
it points at (a scene's claim counts as a block), an anchor as a fraction of the block (x and y from 0 to 1, kept to
thousandths), a thread of 1 to 50 messages, a resolved flag and an optional `ask` flag that marks an instruction to
the agent. A message has an author (`you` or `agent`), up to 2000 characters of text and the time it was written. A
file holds at most 500 comments.

Five operations change the file, all or none, against the revision it was read at: `comment.add`, `comment.reply`,
`comment.resolve`, `comment.reopen` and `comment.delete`. They are `applyCommentOps` in the core, with the schemas
`comments.schema.json` and `comment-ops.schema.json`. A stale revision is refused. An added comment must name a scene
and block the deck has now, and the refusal names the nearest id. A reply does not reopen a resolved comment, and
resolving a resolved comment changes nothing. A comment whose block or scene is later removed stays in the file,
gets an `orphaned-comment` warning from `commentWarnings`, and can still be answered, resolved or deleted.

The deck never sees the file. `loadDeckDir` lists only `deck.json`, `scenes/` and `assets/`; the server serves only
those, and a change to the comments file reloads no deck or presenter window; `export` copies referenced assets and
the runtime and puts only the deck in the page; and the player and presenter do not import the comments code. Tests
cover each of these: an export with comments is the same files and page as one without, `/comments.json` is a 404, the
deck and presenter windows in Chrome never request it, and the built player and standalone scripts contain none of
its code. In the CLI, `applyCommentsDir` writes the file atomically and refuses to overwrite one that is not valid
JSON.

The one exception is the editor. `depthcue edit` has a read and write route for the file, `/_depthcue/api/comments`
(GET gives the file and its revision; POST takes `ops` and `baseRev`, with 409 for a stale revision and 422 for
operations the core refuses). The editor opens `/_depthcue/events?comments=1`, and only the edit server answers that
with an `event: comments` when the file changes, so a comment an agent writes shows up in the open editor without a
reload. The read-only server ignores the flag.

### In the editor

Comments are made and read on the slide. The Comment button on the quick bar, or `M`, turns the comment tool on for
one comment: the cursor changes, a banner says so, and pressing a block opens a box beside the point that was pressed,
marked by a dashed empty pin. The anchor is where the press landed, as a fraction of the block, so the pin follows
the block when it is moved, resized or pinned. Without a pointer (the palette's Comment command), the pin goes at the
block's top right. The box has the keyboard, Comment saves, and Ask the agent saves with `ask` set. That is the only
place a person asks the agent; a later reply never does. `Esc` closes a thread and puts the keyboard back on its pin.

A pin is numbered by the comment's place in the file among the scene's comments, and resolved ones keep their numbers.
It shows its state in color and in its label: open, waiting for the agent, answered by the agent, resolved. Pressing
it opens the thread with a reply box, Resolve and Reopen, and a Delete that asks twice. After a reply the box is empty
and holds the keyboard again. A pin whose block is gone sits at the slide's top left with a dashed edge, and its thread
says the block is gone. Comments on a scene that was deleted are not shown or counted.

The top bar has a Comments button with the count of open comments (in the action color while any waits on the agent)
and a Resolved button with a count that shows or hides resolved pins, dimmed. Below 1280 px wide both keep only their
icon and count. Each thumbnail on the strip carries the scene's open count. Comments are not part of Undo, because a
reply may already have been read by an agent. A save against an old revision is read again and tried once more, so
a comment the agent wrote in between is kept, and a second stale answer is shown as a message, not retried.

### Checks

One rule set serves the editor, `depthcue check` and `deck_render`. `depthcue check` reads the deck's files and
gives the rules that need no layout: alt text that is still the name of its file (`alt-is-filename`), a chart that
cites no source (`missing-source`), and a pinned block that reaches into the 4% margin (`frame-outside-safe-area`).
All three are warnings, so a deck with them still loads and presents, and they come from `checkContent` and
`checkFrames` in the core. The rules that need a laid-out page (text that does not fit, overlap, a pinned block
larger than its frame) are judged from a render, so `depthcue render` and `deck_render` give them. The problem
ribbon shows both kinds; it has no rules of its own. A Fix button exists only where the fix is deterministic.
`depthcue edit` answers the render rules too: the editor asks `GET /_depthcue/api/layout?scene=<id>`, and the server
renders that scene from the files on disk with the same browser and rules as `depthcue render`.

### Agents

An agent sets or clears a frame with `deck_apply` (`block.frame`, `block.unframe`). Comments have a tool of their
own, `deck_comment`, because they have their own revision: sending both through `deck_apply` would put two revisions
in one call. The cost to the agent's context is about the same either way, and `deck_get` says where each
revision is.

`deck_get` carries `comments` in the outline: `rev`, the revision to pass as `deck_comment`'s `base_rev`, `open`, the
count of open comments, and `tasks`. A task is an open comment with `ask` set whose last message is the person's. Once
the agent replies it stops being a task, and it becomes one again when the person writes next. A task shows its scene,
block and the first 160 characters of the last message; `deck_get` with `view: "comments"` has the whole thread
(`resolved: true` adds the closed comments, `scene` narrows to one scene), and a scene view lists that scene's open
comments. A comment whose block is gone is flagged `orphaned`, and the outline warns.

`deck_comment` takes `ops` and `base_rev` and can add, reply, resolve and reopen. The agent never says who is writing:
the schema has no `author` or `ask`, the server writes `agent`, and an operation that carries either, or deletes a
comment, is refused with the reason and nothing is written. Only a person asks the agent to act, and only the person
who wrote a comment removes it. A stale revision, an unknown comment or a block the deck does not have is refused with
where and why. A `comments.json` that is not valid is never overwritten; `deck_get` still reads the deck and warns.

`depthcue comments list <deck-folder> [--all] [--json]` and `depthcue comments apply <deck-folder> <ops.json>
--base-rev <rev> [--json]` do the same from a terminal, with the exit codes of `apply` (3 for a stale revision). An
operations file there names its author, because the command does not know who is typing.

### Review

`review.json` sits beside `deck.json` and holds a copy of the deck as it was when somebody last reviewed it: `format`
(`depthcue-review/1`), `rev` (the revision of that copy), the `deck` manifest, the `scenes`, and `agent`, a sorted list
of the change ids an agent made. It stores no list of changes. A change is the difference between the copy and the deck
as it is now, worked out each time by `diffDocs`, so the list cannot go stale.

A change id is a path: `deck/title`, `deck/scenes` (the order of the scenes), `scene:<id>`, `scene:<id>/<field>`,
`scene:<id>/blocks` (the order of the blocks), `scene:<id>/block:<id>` and `scene:<id>/block:<id>/<field>`. A scene or
block that was added or removed is one change, and so is a block whose type changed. A change has a scope (`deck`,
`scene` or `block`), a kind (`added`, `removed`, `changed` or `moved`), the scene, block and field it applies to, the
value before and after, and `by`, which is `agent` or `outside`. The ids and fields are the format the drawer and the
storyboard read, so they stay as they are.

`acceptChanges` copies the chosen changes into the reviewed copy and leaves the deck alone; accepting all makes the copy
equal to the deck. `revertChanges` builds one batch of operations that puts the chosen changes back and applies it to
the current deck with `applyOps`, so a revert is a new revision and no revision is rewritten. An unknown id is refused,
and so is a revert that would leave an invalid deck, with the reason and nothing written. Each of the two leaves every
other change as it was.

Attribution has two sides. Agent writes (`deck_apply` and `depthcue apply`) go through `recordAgentWrite`, which starts
the review from the deck as it was before the first agent write and marks the changes that write touched. The editor's
save calls `recordPersonWrite`, which folds the person's change into the reviewed copy, so a person's own edit is never
something to review. A change nobody recorded, such as a hand edit to a file, shows as `outside`. A revert is written
directly and is not marked as agent work. If recording fails, the deck is still written and the result carries a
`review-not-recorded` warning.

`depthcue diff <deck-folder> [--json]` lists the changes. `depthcue diff <deck-folder> accept <ids…>` and `revert
<ids…>` act on the ids given, and `--all` acts on every change. A refusal exits with 1, and a deck that changed on disk
while the command ran exits with 3.

Like comments, the file stays out of the deck: `loadDeckDir` does not list it, the edit server's file watcher ignores
it, `export` does not copy it, and the player and presenter do not contain its code. The MCP tool definitions did not
change, so an agent finds the review through the editor and the terminal, not through a tool of its own. One limit: a
revert that would bring back a block naming an image file that has since been deleted from `assets/` is refused,
because the deck would not be valid.

### The review drawer

The top bar has a Review button. It reads "Agent changed 3" while the agent has changes nobody answered, "Changed 1"
when only hand edits are waiting, and "Reviewed" when nothing is. It opens a drawer over the right of the stage with a
row for each change: where it is, the old value struck out, the new value marked, and Accept and Revert. Accept all is at
the top, and Esc closes the drawer. A scene with changes shows a "Changed" mark on its thumbnail, and its name for a
screen reader gives the count. The palette has a command for the drawer too. In a window narrower than 1280 px the
button is left out while there is nothing to review, so the top bar keeps room for the deck's title.

The editor works the list out itself from the review file and the deck in the page, so an edit, an Undo or the agent's
next write shows at once. Edits the person has not saved yet are left out, because saving copies them into the review.
The editor asks the edit server for `?review=1` events and reads the file again on each one.

Accept writes the review file against the revision the editor read. If the agent wrote in between, the editor reads the
file again and makes the choice again, once. Revert runs the operations from `revertOps` as one ordinary edit, so the
Undo button and Ctrl+Z take it back and autosave saves it. Both are refused while the files changed on disk under unsaved
edits, because the review would then describe a deck that is not the one on disk.

Undo and Redo go through `history.ts`, which keeps an accept in line with the session's own steps. An accept is undone
by writing the earlier review back, and only while the review file is still as the accept left it. If an agent or a hand
edit changed it since, Undo says so and leaves the file alone. Loading the files again, which the editor does when an
agent writes the deck, forgets these steps along with the session's own.

Undoing a revert brings the change back as the agent's. Without help a save would copy it into the reviewed deck as the
person's own edit, and it would drop off the list. So the editor remembers the changes that were reverted and then undone,
and sends their ids with the next save (`keepAgent`); the server leaves them out of the fold and marks them as the agent's
again. The memory is dropped for a change the person edits again afterwards.

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

| Property                                      | Where                                                               |
| --------------------------------------------- | ------------------------------------------------------------------- |
| text: `role`, `text`                          | Role menu in the toolbar; text typed on the slide                   |
| text, chart, image, clip: `sourceIds`         | Cite chip in the toolbar                                            |
| chart: `title`, `unit`                        | Data popover: title and unit                                        |
| chart: `data` values                          | Drag a bar, or arrow keys on it (Shift moves five steps)            |
| chart: `data` labels                          | Typed on the slide, in the row's label                              |
| chart: `data` rows                            | Add bar and Sort in the toolbar; Data popover: remove, move         |
| image: `asset`                                | Drop or paste on the image; Edit popover: file, upload              |
| image: `alt`, `caption`                       | Edit popover: alt text (flagged until written), caption             |
| clip: `source`, `poster`, `alt`               | Edit popover: video menu, poster menu, alt text                     |
| clip: markers in `<video>.cues.json`          | Cues popover: add at the playhead, rename, retime, remove           |
| block order                                   | Earlier and later buttons in the toolbar; the grip on a block       |
| scenes: add, order, duplicate, delete         | Scene strip: Add scene, drag, and the buttons on each scene         |
| new blocks, claim: `summary`                  | Quick bar at the foot of the stage: Text, Chart, Image, Clip, Claim |
| scene: `layout`, `lead`                       | Buttons in the top bar                                              |
| scene: `title`, `steps`, `sources`            | Scene popover in the top bar: title, steps, sources                 |
| scene: `notes`, `reading`                     | Notes popover in the quick bar: speaker notes, reading version      |
| claim: `text`                                 | Typed on the slide                                                  |
| claim: `evidenceIds`                          | Evidence chip in the claim's toolbar                                |
| deck: `title`, `language`, `theme`, `modules` | Deck popover in the top bar                                         |
| any block: `frame`                            | Free button or P; drag, handles, Pinned popover, arrows             |

The Layout and Free buttons in a block's toolbar say where the block is. Free pins it where it stands: the frame is
measured from the block's box on the slide, so pinning does not move it, and Layout puts it back in its slot. `P`
does the same for the chosen block, except while a field has the keyboard. A pinned block gets a Pinned popover
with its left, top, width and height in percent of the slide, and Align left, center and right buttons that keep to
the 4% safe margin. The arrow keys move a chosen pinned block 1%, or 5% with Shift, and one run of presses is one
Undo step. A pinned text is chosen like an image, because a press on it starts a move: Enter or a double click types
in it, and Enter or Escape gives the keyboard back to the block.

A pinned block is moved by pressing it anywhere that has no caret or control of its own, or by its grip, and the
chosen one has a handle on each corner that resizes it from the opposite corner. While the pointer is down the block is
only drawn at its new place, and one `block.frame` goes to the deck when it is let go, so a whole drag is one Undo step.
Escape puts the block back. An edge or middle that comes within 1.1% of the slide's edge, a safe margin, its middle or
an edge or middle of another block snaps there, and a line is drawn where it has. Alt turns snapping off. A press that
moves less than 3 pixels is a click and changes nothing. On a slide narrower than 640 px, where pinned blocks flow
instead of sitting at their frames, the handles are hidden and a press does not move anything. A pinned video is moved
by its grip, because a press on the video belongs to its player.

Auto layout, in the top bar, shows only while the slide has a pinned block. It puts every pinned block of the slide
back in its slot as one Undo step. The blocks slide from where they stood, as they do when one goes back with Layout
or `P`, or when an Undo or a Redo pins or unpins one; a person who asks for less motion sees them jump. Auto layout is
a control and not a property of the scene, so nothing in the deck records that it was used. Changing the scene's
layout leaves the pins alone, because a frame belongs to its block. Deleting a pinned block takes its frame with it,
and Undo brings both back.

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

The quick bar floats at the foot of the stage, under the slide, so nothing of the slide is covered. It has a button
for each kind of block (Text, Chart, Image, Clip), Claim, the Notes popover and Build order. A new block goes into the
area of the chosen block, right after it, when that area takes the kind. With nothing chosen, or when the chosen
block's area does not take the kind, it goes to the first area that holds nothing and takes the kind, and when every
area holds something, to the end of the first one that takes it (`slotFor` in `adder.ts`). Evidence counts only while
the slide has a claim, and a block added there is cited in the same step (`addBlock` in `slots.ts`, which takes the
block to go after). The new block is chosen and has the keyboard, and one Undo takes it back. In a window narrower than
760 px the bar sits under the slide in the page's flow. The notes open upward and keep 8 px from the window's edge.

The keys the editor answers are one table in `shortcuts.ts`, and the key handler and the shortcut sheet both read it.
`T`, `C` and `I` add a text, a chart or an image (`I` opens the file chooser) just as the bar's buttons do, and each
button has its key written on it. `Ctrl+Z`, `Ctrl+Shift+Z` or `Ctrl+Y`, `Ctrl+S`, `Ctrl+K`, `P` and `Alt+F10` are in the table
too. `?`, or the `?` button at the end of the bar, opens the sheet: a dialog that lists every key, takes the keyboard
while it is open, gives it back on `Escape`, `?`, Close or a press outside the card, and lets no other key act behind
it. A letter key is a letter in a field or in text being edited on the slide, it acts once when held down, and a key
with Ctrl, Alt or Command that the table does not list is left to the browser. The keys are the editor's when the
keyboard is inside it, and also when the keyboard is nowhere in particular and the pointer was last over the editor (or
has not been seen). A page that holds the editor beside other things keeps its own keys. The keys that act where they
are pressed (Enter, Delete, the arrows and `Escape` on a block, the arrows on a chart bar) are in the table only so the
sheet is the whole list, and each one has a test that presses it.

The problem ribbon is a strip between the top bar and the slide, and it is always there, so a problem that appears
or goes moves nothing. It says "All clear", or how many things there are to check, and shows one at a time with
Previous and Next. Both walk the problems of every scene, in the order of the scenes and blocks, choose the scene and
the block, and leave the keyboard on the button so Next can be pressed again. A problem on another scene starts with
that scene's title. Pressing the sentence chooses the block and gives it the keyboard. The ribbon asks the core for
each scene's warnings (`adviceOf`), keeps the answer per scene object, and changes text and visibility without
rebuilding a control, so nothing under a drag or a caret is redrawn. A screen reader hears the count, the place and
the sentence through a status that is not repeated when nothing changed. Fix appears only for a problem that one
change settles the same way every time: a pinned block in the margin, or one that its frame is too small for, gets
Back to layout. Alt text and sources need a person, and so does text that does not fit, so those problems have no Fix.

What a render found is as of the last save, because a render shows the files on disk. The editor asks once the deck is
saved and has been still for a moment, the scene on show first and then the others in deck order, and it keeps the
last answer for a scene until the next one arrives, so a problem does not blink while someone types. An answer to a
deck that has changed since is dropped. The server starts a headless browser for the first question, answers one
question at a time, and closes the browser after 30 seconds with nothing to check. A machine with no browser says so
once, is left alone for a minute, and then the ribbon lists only what the core finds, as it did before.

`Ctrl+K` (`Command+K` on a Mac), or the Everything button in the bar, opens the palette: one field over a list of what
can be done now. It is a dialog whose field is a combobox that controls a listbox, so a screen reader reads each choice
as the arrow keys move over it. Typing narrows the list (`search` in `palette.ts`: every word must match, a word at the
start of a title counts most, then a word inside one, then its letters in order; extra words that the list does not
show count for half). The arrows go round at the ends, `Enter` closes the palette and then runs the command, so a
command that moves the keyboard has the last word, and `Escape` or `Ctrl+K` closes it and gives the keyboard back.
No key is heard behind it. Which commands exist is decided each time it opens (`listCommands` in `commands.ts`), and
one that cannot be done is left out and not greyed: Fix and Next or Previous problem, the three ways to add (and a
clip when the deck has a video, a claim when the scene has none), Pin or Put back and Remove for the chosen block,
Auto layout when something is pinned, the leads and layouts the scene does not have, Go to each other scene, Undo and
Redo when there is something to undo or redo, Save, Present from this scene and the shortcut sheet. The keys written
beside a command come from the table in `shortcuts.ts`. There is no align command because a block has no alignment
to set; position is a frame, and Pin and Auto layout are the two ways to change it.

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
