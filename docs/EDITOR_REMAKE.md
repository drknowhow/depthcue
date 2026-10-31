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
- A test walks the core schema and fails when a shipped property has no editing control on the canvas or in a
  floating toolbar. It arrives in phase 2 and guards every later addition.
- Look at the editor in a real browser at 1440 by 900 and 1024 by 768 before merging an editor change.
- Keyboard shortcuts work when the pointer is over the editor or focus is inside it, and the panels keep focus
  when they redraw.
- An update during a drag changes the dragged element in place. Redrawing the whole stage stops the drag.
- Overflow is measured on a block's content, not on the selection handles drawn around it.

## Where each property is edited

Every property the schema defines gets a control on the slide or in a floating toolbar. The details panel keeps
all of them until phase 2 takes it out. This table says where each one is edited now, and each change that moves
a property updates it. The schema-walk test replaces it once phase 2 lands.

| Property                                      | Where                                               |
| --------------------------------------------- | --------------------------------------------------- |
| text: `role`, `text`                          | Role menu in the toolbar; text typed on the slide   |
| text, chart, image, clip: `sourceIds`         | Cite chip in the toolbar                            |
| chart: `title`, `unit`, `data`                | Data popover: fields, add, remove, move, sort       |
| image: `asset`, `alt`, `caption`              | Edit popover: file menu, upload, alt text, caption  |
| clip: `source`, `poster`, `alt`               | Edit popover: video menu, poster menu, alt text     |
| scene: `layout`, `lead`                       | Buttons in the top bar                              |
| scene: `title`, `steps`, `sources`            | Scene popover in the top bar: title, steps, sources |
| claim: `text`                                 | Typed on the slide                                  |
| claim: `evidenceIds`                          | Evidence chip in the claim's toolbar                |
| scene: `notes`, `reading`                     | Details panel                                       |
| deck: `title`, `language`, `theme`, `modules` | Details panel                                       |

## Phases

| Phase | What lands                                                              | PRs |
| ----- | ----------------------------------------------------------------------- | --- |
| 1     | Shell: slim top bar, thumbnail strip, large stage, autosave             | 2   |
| 2     | Selection, floating toolbars per block type, notes sheet, old panel out | 3   |
| 3     | Chart bars, image and clip editing in place, slot swap, ghost slots     | 3   |
| 4     | Schema 0.2, player and checks, pinning, layout interplay                | 4   |
| 5     | Quick bar, shortcuts, problem ribbon, Ctrl K palette                    | 2   |
| 6     | Comments: model, agent side, editor                                     | 3   |
| 7     | Review of agent changes, storyboard                                     | 3   |
| 8     | Docs, final measurements, walkthrough                                   | 1   |

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
