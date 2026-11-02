# Brands, templates and PowerPoint export

Status: approved 2026-11-01, campaign `depthcue-brands-pptx`.

Goal: a company defines its brand once (colors, fonts, logo, footer, slide templates and component styles), every
slide made in that brand follows it, a person and an agent both build slides from its templates, and any deck exports
to a PowerPoint file that people can keep editing.

Before this work: two presets (Paper, Ink) with a palette, four built-in font pairs, three flow layouts (title,
claim-evidence, text-media) plus pinned frames, no logo or footer on slides, no named block styles, and no export
besides the offline folder. Templates, theme authoring and editable PPTX were listed for 0.2, 0.6 and 0.7 in
`docs/PLAN.md`; this plan brings them forward.

Decisions (Dimitri, 2026-11-01):

- A brand is copied into each deck, so a deck stays self-contained for git, sharing and offline export. A person keeps
  one master brand folder and copies it in with `depthcue brand use`; running it again updates the copy.
- Templates are linked, like PowerPoint layouts. A scene names its template and each block names a slot. Changing a
  template or a style changes every slide that uses it. Agents fill slots by id and never set coordinates.
- The PowerPoint export is editable by default, and also gets: the brand as the PowerPoint slide master with each
  template as a New Slide layout, import of a brand from a `.potx` or `.pptx`, a picture mode, and embedded videos.

## The parts

**Brand.** A folder `brand/` inside the deck, named by `deck.json` as `"brand": "<id>"`. It holds `brand.json`,
`templates/<id>.json`, and its files under `fonts/`, `logos/` and `images/`. `brand.json` has:

- `colors`: a palette for `paper` and for `ink` (the same seven names as a deck palette), each optional, checked by the
  same contrast rules. The deck's own palette goes on top, unless the brand sets `lock`, which refuses deck-level
  palette and font changes so a deck cannot drift off brand. Each palette may carry `chart`: up to six series colors,
  each at least 3:1 against that palette's slide background (WCAG 1.4.11), so light and dark slides get their own.
  Without it, charts take their colors from the palette by position, as today.
- `fonts`: one of the four built-in pairs, or the brand's own display, body and (optional) mono faces. A face names its
  family and its files with weight and style, and a license when it carries files. A face may name no files, for a
  company font that is installed on its people's machines; it then names a built-in pair to fall back to, and `check`
  warns that the look depends on the viewer's machine.
- `logos`: one for light slides and one for dark, SVG or PNG, with alt text.
- `chrome`: what sits on every slide, like a PowerPoint master: the logo (corner and size), a footer line, the slide
  number, and an accent (none, a bar along the top, or a bar down the start side). A template says whether it shows
  the full chrome, a minimal one (logo only) or none.
- `styles`: the brand's components. A style is a named look for a block, chosen from a bounded list of properties:
  font (display, body, mono), size, weight, case, tone, fill (none, surface, action, evidence, text), border, an
  accent edge, corner radius, padding and alignment, and which block kinds it applies to. A block takes one with
  `"style": "callout"`. The block's own tone, size and align still win. Text on a fill is held to the same contrast
  rules, and reversed text (the background color on a dark fill) is allowed when it passes.

**Templates.** A template is a slide layout with named slots. Each slot has a frame (percent of the 16:9 slide, as
pinning uses), a role (title, subtitle, claim, body, picture, chart, table or content, which becomes the PowerPoint
placeholder type), what it accepts (text roles and block types), a vertical alignment, a default style, how many
blocks it stacks (one by default), whether it is required, and a hint that tells a person or an agent what goes there.
A template also has a background: a named color, or a brand image under a scrim color. A scene uses either a built-in
layout or a template, never both. Its blocks name their slot, and a scene's claim, with its evidence links, goes in the
template's claim slot. A pinned block keeps its slot and only takes its position from its own frame; a pinned block
with no slot floats over the template.

Depthcue ships a default brand with about ten templates (title, section, agenda, statement, big number, quote, two
columns, comparison, full image, closing) and about seven styles (callout, stat, kicker, card, highlight, pull quote,
label). Every deck can use them, drawn in its own brand's colors and fonts. A brand's template or style with the same
id replaces the built-in one, and a brand can hide the built-ins.

Changing a scene's template maps its blocks to the new slots by kind and order, through one core helper used by the
editor and agents alike. A block that fits no slot is reported, never dropped.

**PowerPoint export.** `depthcue export <deck> --format pptx` renders each scene in Chrome at 1280 by 720, as
`depthcue render` does, measures every block, and writes a `.pptx` with pptxgenjs (MIT):

| In Depthcue                       | In PowerPoint                                                                |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Text, claims, eyebrows            | Text boxes at the measured place, with bold, italic, links, colors and lists |
| Images                            | Pictures, with their alt text                                                |
| Tables                            | Native tables                                                                |
| Charts (all six kinds, bar-chart) | Native charts whose data can be edited, in the deck's series colors          |
| Clips                             | Embedded videos; `--posters` writes the poster and a link instead            |
| Speaker notes                     | Speaker notes (`--no-notes` leaves them out)                                 |
| Sources                           | A small line of links at the foot of the slide                               |
| Build steps                       | All shown on one slide; `--steps` writes one slide per click step            |
| Brand chrome and templates        | The slide master, and one PowerPoint layout per template                     |
| Fonts                             | Embedded where allowed; the report says why not, and what to install         |

`--pictures` writes each slide as one exact image with its notes, for when the look matters more than editing.
Interactive charts, the control lease, the presenter window and transitions have no PowerPoint form; the export says
what it left out of each slide. The same deck gives the same bytes every time.

**Brand import.** `depthcue brand import <file.potx|.pptx>` reads the file's theme colors, font names, master logo and
slide layouts into a brand folder. Layout placeholders become template slots. A color that fails the contrast rules
is reported and the preset's color is kept, and the report lists everything else it did not take.

## Steps (one merge each)

1. **Contracts.** Schema 0.4 fixes every new field before any feature is built: the brand file and its checks, the
   template file, the deck's `brand`, the scene's `template`, the block's `slot` and `style`, and the operations
   (`brand.set`, `style.set`, `template.set`, and slot changes through `block.set`). The deck revision covers the
   brand folder, so a stale save is refused when the brand changed. The template-change helper lives in core. The
   player shows a template scene as labeled slot boxes until step 3. Core only. This document lands here.
2. **PowerPoint export.** The editable export for everything a deck has today: text, images, tables, the six charts,
   notes, sources, pinned blocks, fonts named, a report of what was left out, and the same bytes every time.
3. **Brand in the player.** Brand colors, chart colors and fonts (custom faces served by the server and copied by the
   export), chrome, styles, template slots and backgrounds. `depthcue render` reports slot overflow, chrome overlap,
   and contrast of text on a background image, measured on the rendered pixels.
4. **Brand import.** `depthcue brand import`, tested on a fixture file generated in the test, and checked by hand on a
   theme that ships with PowerPoint on this PC.
5. **Default brand and brand commands.** The built-in templates and styles, `depthcue brand init`, `brand use`
   (copies a brand into a deck and refuses to overwrite local changes without `--force`), `brand check`, and
   `depthcue new --brand`. A fixture deck in a second, made-up brand with its own open-license fonts and logo.
6. **PowerPoint extras.** Slide master and template layouts, picture mode, embedded videos, `--steps`, an export
   endpoint for the editor, and the MCP export tool.
7. **Editor: use a brand.** A template picker with thumbnails when adding a scene, Change template with a preview of
   where each block goes, empty slots showing their hint (never in an export), a Style menu on the block toolbar and
   the right-click menu, the chrome on the slide, and Download PowerPoint.
8. **Editor: define a brand.** A Brand panel (logos, colors for both presets with refusals at the swatch, chart colors,
   fonts from a pair or uploaded files, chrome, styles with a live preview, the template list), Save scene as template,
   and Edit template, where slots are boxes you drag and resize with the pinning snap.
9. **Close-out.** Guides (brands, templates, PowerPoint with the supported subset), the demo in two brands, PowerPoint's
   own slide images next to the player's, changelog, budgets, bench and results.

## How it runs

Steps in one wave touch different files and are built at the same time:

- Wave A: 1 contracts and 2 PowerPoint export (it covers today's content, so it does not wait for the brand).
- Wave B: 3 brand in the player and 4 brand import.
- Wave C: 5 default brand and brand commands, and 6 PowerPoint extras.
- Wave D: 7 editor, use a brand. Wave E: 8 editor, define a brand. Wave F: 9 close-out.

The conductor (Opus) writes each brief, reviews every diff and screenshot before it merges, and settles conflicts. A
builder (a Sonnet subagent, Opus for the contracts) builds one step in its own worktree, runs the full verify, and
opens the PR without merging. A merge script with no model waits for CI on the branch's own commit, merges, and waits
for CI on main. Cod reviews the contracts PR. Every PowerPoint step is also checked by opening its file in PowerPoint
on this PC and exporting the slides to images, because CI can only read the file's XML.

## What holds for every step

- Agent parity: every new property has an operation, an MCP description and a check, and the same change made in the
  editor and through `depthcue apply` writes the same files.
- Old decks: 0.1 to 0.3 decks load and look unchanged, and a file becomes 0.4 only when it uses a new field.
- Each step adds its own e2e test file. Text-fit assertions in real-browser tests keep the headroom the earlier
  campaigns needed for CI's wider fonts.
- The plan has 9 steps. A new step needs Dimitri's OK; bugs found on the way get their own fix.

## Budgets

- Editor script stays under 90 KB (89.3 KB before). The brand panel, the template editor and other rarely used parts
  load on demand, each with its own budget row of at most 30 KB.
- Exported page script: 14 KB to 16 KB (the raise approved for the content range).
- Core runtime stays under 60 KB (45.2 KB before). Player styles stay under 30 KB.
- Fonts, logos and images are files beside the deck, not script. An export copies only what the deck uses.
- pptxgenjs is a dependency of the CLI only and never reaches a page.

## Not in this plan

PowerPoint animations for build steps, converting a font with CFF outlines to TrueType so PowerPoint can embed it,
subsetting the embedded fonts or compressing them as PowerPoint compresses its own (MicroType Express), importing a
whole `.pptx` deck as scenes (0.3 in `docs/PLAN.md`), a shared brand folder that decks point to, uploading a brand
from the editor to a library, and per-block raw hex colors.

## Step 1 record: what the contracts fixed

- **Files.** `brand/brand.json`, `brand/templates/<id>.json` (the file name is the template's id; a file whose `id`
  differs is `template-id-mismatch`; the loader reads every JSON file of that folder, and one not named for an id,
  such as `__proto__.json`, is `bad-template-name`), and the brand's own files under `brand/fonts/`, `brand/logos/` and
  `brand/images/`. Both kinds of JSON file say `"schemaVersion": "0.4"`, the only version they have. Their schemas are
  published as `packages/core/schema/brand.schema.json` and `template.schema.json`. A brand file names its files
  relative to `brand/`.
- **Schema 0.4.** deck.json gains `brand` (an id, which brand.json must repeat: `brand-id-mismatch`). A scene gains
  `template` and has exactly one of `layout` and `template` (`layout-and-template`; neither keeps the old
  `missing-property` at `/layout`). A block gains `slot` and `style`. A 0.4 field in a file that says an older version
  is `brand-needs-version`, `template-needs-version`, `slot-needs-version` or `style-needs-version`. A file becomes 0.4
  only when an operation gives it a 0.4 field; a scene below 0.3 is upgraded on the way, so its text is escaped. New
  scenes are written as 0.4. `scene.upgrade` still means 0.3.
- **Doc.** A Doc gains `brand`, `templates` (the brand's, by id) and `brandFiles` (the brand folder's other files).
  `DeckFiles` gains `brandFiles`; the CLI loader reads brand.json and the templates as text and lists the rest.
- **Built-ins and resolution.** `BUILT_IN_TEMPLATES` holds `section`, `two-column` and `statement` (a claim slot over
  an evidence slot of up to three blocks), `BUILT_IN_STYLES` holds `callout` and `stat`; step 5 adds the rest.
  `templatesOf` and `blockStylesOf` give the built-ins (unless the brand's `hideBuiltIn` names the set) with the
  brand's on top by id. `styleOf(deck, brand)` takes the preset, then the
  brand's palette for that preset, then the deck's palette; fonts are the deck's pair, then the brand's pair (or its
  faces' `fallback`), then `editorial`. A `lock`ed brand ignores the deck's palette and pair, and deck.json setting
  either is `brand-locked`.
- **Slots.** A slot has a `role`: `title`, `subtitle`, `claim`, `body`, `picture`, `chart`, `table` or `content`. The
  role is required, not defaulted to `content`, because step 6 writes it as the slide's placeholder type: a title
  slot becomes the slide's title, which PowerPoint's outline, accessibility checker and screen readers read, and a
  default would export every title nobody marked as a body box. 0.4 is unreleased, so no file has to change. Each
  role takes some kinds of block (title a heading; subtitle and body text; picture an image; chart a chart; table a
  table; content any), and `accepts` lists some of them: `slot-role-mismatch` otherwise. A `claim` slot is where a
  scene's `summary` is drawn; it takes no blocks and has no `accepts`, and a template has one at most
  (`two-claim-slots`). `valign` (`top`, `middle`, `bottom`; default `top`) places the slot's content in its frame.
- **One look function.** `lookOf(doc)` in `look.ts` gives the `DeckLook` declared in `exported.ts`: theme, resolved
  colors, chart colors (the brand palette's `chart` for the deck's preset: `colors.paper.chart`, `colors.ink.chart`;
  there is no top-level `chart`), the pair, the brand's faces as file paths, the chrome with the logo for the theme,
  and the styles and templates the scenes use. It is not wired yet; step 3 hands it to the player. The player imports neither
  it nor the registry: the player bundle has no built-in template or style in it.
- **Scene checks.** `unknown-template`, `unknown-slot`, `unknown-style`, `style-wrong-kind`, `slot-refuses-block`,
  `slot-over-max`, `missing-slot` (every block of a template scene names a slot, unless it is pinned),
  `slot-without-template`, `claim-without-slot` (a template scene keeps its `summary` only on a template with a claim
  slot; the fix names the deck's templates that have one, or says to remove the claim), and the warning `slot-empty`
  for a required slot, which the claim fills for a claim slot. A pinned block in a slot belongs to it like any other:
  it fills it, counts toward `max` and takes the slot's style; only its place comes from its frame. A pinned block
  with no slot is an overlay over the template: allowed, with no diagnostic, it fills no slot and is checked as any
  block is but for its slot.
- **Brand checks.** `unused-brand` (brand.json or templates while deck.json names no brand) is a warning in a deck
  folder, which then leaves those files unread, so a save that makes or takes off a brand can stop between deck.json
  and the brand's files and still load; in a Doc, whose brand would be used, it stays an error. Errors: `missing-brand`
  (deck.json names a brand the folder lacks), `missing-brand-file` (a font, logo or background image not on disk),
  `missing-logo` (logos that name no file, or chrome that places a logo the brand lacks), `palette-low-contrast` at
  `/colors/<preset>/<color>` with "On ink slides, " in front, `chart-low-contrast` at `/colors/<preset>/chart/<i>`
  (3:1 on that preset's background), `style-low-contrast` (text on a fill; reversed text in `bg` passes when it
  reaches the minimum). A face needs `license` only when it has `files` (the schema's `dependencies`, list form): a
  face with no files has nothing to license. Warnings: `face-without-files` (the look depends on the viewer's
  machine), `body-without-bold`, `chrome-crowded` (two chrome parts in one place), `background-unmeasured` (until
  step 3 measures text on an image). Templates: `duplicate-id` for slots, `frame-off-slide`, `slots-overlap`,
  `slot-role-mismatch`, `two-claim-slots`, `unknown-style`, `style-wrong-kind` (a claim slot's style must be for
  headings, as the claim is drawn as one) and `template-low-contrast` (text on a strong background is drawn in `bg`;
  at `/slots/<i>/style`, a slot style's tone with no fill under it on the background color, which is how a claim slot
  or a slot of charts, which no scene check reads, is held to it).
  The chart, style and template checks run on every preset the brand gives a palette for, and on the deck's theme
  (`looksOf`), so a brand that reads on paper and fails on ink fails in a paper deck too.
- **Styled blocks.** A text block with a style, its own or its slot's, or on a template's colored background, is
  checked in the colors it resolves to: the style's fill (or the template's background), the block's own `tone` and
  `size` over the style's. Too little contrast is `block-low-contrast` at `/blocks/<i>/tone`, `/style` or `/slot`,
  or `/text` for a span's tone. Large text needs 3:1; a style that passes at 3:1 because it is large asks 4.5:1 of a
  block that sets size `s`. Other blocks keep `tone-low-contrast` as before.
- **Validation.** Nothing is compiled any more. `schemacheck.ts` reads the schema objects of schema.ts at run time
  and checks deck.json, scenes, operations, comments, comment operations, brand.json and templates with them. With
  the 0.4 schema, Ajv's generated validators had pushed the editor's script to 97.2 KB brotli; without them it is
  88.6 KB. The checker reports the errors Ajv 8 reported with the old options (keyword, params, instance and schema
  paths, in order), so every diagnostic is unchanged; `schemacheck.test.ts` holds that by running both on every
  fixture and on about 65,000 one-change and seeded several-change copies of each kind of file, and checks that the
  copies reach every keyword. It knows only the keywords the schemas use (`oneOf` only with a `discriminator`,
  `uniqueItems` only on scalar items) and throws on any other, and on a form of a known one it does not read: a list
  of `items`, a boolean where a schema goes (but `additionalProperties: false`), and `dependencies` that name a
  schema. Ajv is a dev dependency of core now; `pnpm schema`
  writes only the published `.schema.json` files, which did not change, and `check:generated` still fails when one
  is stale. Checking a scene takes about 20 microseconds instead of 0.5.
- **Operations.** `brand.set` makes a brand (it needs `id` and `name`), edits brand.json keys (null deletes one) and,
  with `set: null`, takes the brand off: deck.json loses `brand`, and brand.json and the template files are removed;
  fonts, logos and images stay on disk. The id never changes. `deck.set` refuses `brand`, `brand.set` refuses `styles`.
  `style.set` and `template.set` write or remove one by id and need a brand (`no-brand`); `template.set` fills `id`
  and `schemaVersion`. Slot and style changes go through `block.set`. Removing a style or template still in use fails
  on the result as `invalid-deck`, with the scene's own error. `scene.set` that gives a scene below 0.3 a template
  upgrades it first, as `block.set` does for a slot, so text written in the same operations reads the same in either
  order. Every lookup by an id or a key from a file or an operation reads own properties only, so `constructor` as a
  template, style or `set` key gets the normal diagnostic.
- **Changing a template.** `retemplate(doc, scene, { template } | { layout })` returns the operations and the ids of
  blocks no slot takes, which are never dropped. A block keeps its slot when the new template has it; others go to the
  first slot that takes their kind and has room, in order. The claim stays the scene's `summary`, its `evidenceIds`
  with it, when the new template has a claim slot; when it has none, the claim's id is in the unplaced list, and the
  operations apply once it is decided. A claim is never turned into text. A pinned block needs a slot with room like
  any other; one that no slot takes loses its slot and stays pinned, over the template, as does an overlay already
  there. Moving to a layout clears every slot, and lists the claim as unplaced unless the layout is claim-evidence,
  the one layout that draws it.
- **Saving.** `saveDeckDir` writes the brand's new and changed files first (brand.json still holding each style it
  loses that a scene or template on disk names, and hiding or locking nothing new), then the scenes, deck.json, the
  removed templates, brand.json as it ends, and the other removals, brand.json's last, so a save stopped after any
  file leaves a deck that loads. A template goes before brand.json drops a style it names or hides the built-in set
  that has it. `save-crash.test.ts` stops twelve kinds of batch after every file. A brand taken off is, between its
  first write and deck.json, still the deck's brand but without `lock` and `hideBuiltIn`. Not covered: a template or
  style whose content changes under a scene; colors checked across the two files; a brand made with scenes that use
  it; a brand id changed in one save (`brand.set` null, then a new id), which stopped after brand.json is
  `brand-id-mismatch`, since the id is in both files, and whose fix names the hand edit (a test pins this); and, with
  the brand at 24 styles, a style a scene uses swapped for a new one, where brand.json has 25 (`too-many`) until the
  scenes are written. A save that would write under brand/ refuses, with `linked-brand-folder` and no file touched,
  when brand/ or brand/templates/ is a link or resolves outside the deck; reading through it is allowed. Making a
  brand over brand files left in the folder is refused as `leftover-brand-file`, except files the save writes with
  the same text, so a save that made a brand and stopped can run again.
- **Revision.** It covers brand.json and the templates, independent of formatting. A deck without a brand hashes as
  before: the v0-1 fixture stays `ec4e0cd5c59ef06a` and the demo `eb9d45889adffe19`, pinned in `brand.test.ts`. Brand
  binaries count no more than assets do. Drafts keep the brand; a review keeps the reviewed brand but lists no brand
  change, and accepting uses the current brand.
- **CLI, editor and MCP.** `loader.ts` reads the brand; `edit-api.ts` lets the editor save brand.json and templates and
  sends `brandFiles`; `deck-api.ts` puts the brand, every template with its slots (id, role, accepts, hint, max,
  required, style) and every style in the outline, and a block's slot and style in the detailed one. deck_get and
  deck_apply describe templates, slots with their role, styles and the three operations within the size test's
  limits: the tool list is 11,999 characters of 12,000, so a slot's role is how an agent learns where the claim goes. The editor loads and saves a branded deck and lists `deck.brand`, `scene.template`
  and each block's `slot` and `style` as `PENDING` for steps 7 and 8.
- **The editor's brand checks load on demand.** The changes above took the editor's script to 92,224 bytes, 64 over
  its limit. What moved: core's `brandcheck.ts`, the checks of brand.json and the template files (`readBrand`,
  `checkBrand`, `checkTemplate`, `checkBrandFile`, `checkTemplateFile`, `looksOf`), is now
  `dist/brandcheck.js`, 3.2 KB brotli with its own budget row of 6 KB. The editor's build puts
  `packages/editor/src/brandchecks.ts` where core imports it; that stand-in fetches the chunk the first time a check
  is wanted and, until it is in, answers with the error `brand-checks-loading`, so nothing passes unchecked. The store
  then waits for the chunk and reads the deck again; it does the same for a draft, which is not thrown away for it.
  A check that meets the error mid-edit starts the fetch and asks for another try. When the chunk does not arrive,
  the deck or draft does not open, or a reload or a read of the files after a change on disk stops with "Could not
  load the brand checks; reload the page." The chunk loads only for a deck with a brand: `unusedBrand`, the warning
  for brand files a deck without a brand leaves unread, is in brand.ts, and a template scene of a deck without a
  brand uses only the built-in templates, which tests check, so neither needs the chunk. `checkSceneBrand` (a scene against its template) stays in
  editor.js: it runs on every edit of a template scene. About 1.3 KB of what the checks use stays in editor.js too,
  because it sits in modules the editor needs anyway, above all the brand and template schemas in schema.ts; moving
  those out is the next lever. CLI, MCP and tests use core's module as before.
- **Player.** A template scene draws each slot as a dashed box with its id, its blocks stacked inside, until step 3
  places slots at their frames; the claim comes first, in a box for the `claim` slot, and an overlay sits only at its
  frame. The fixture's chart-and-note scene overflows that stack in `depthcue render`.
- **Sizes.** Core runtime 45.2 to 40.1 KB gzip (limit 60). Editor script 89.3 to 88.3 KB brotli (90,368 bytes of
  92,160): the review round took it to 92,224 bytes, and moving the brand checks to their chunk took 1.9 KB back out.
  The chunk is 3.2 KB (3,289 bytes of 6,144). Player script 10.1 to 10.3 KB (the placeholder), core code in the
  player 5.1 to 5.0 KB, exported page 13.3 KB.

### Cod's review

Changed: claims on template scenes, slot roles and `valign`, pinned blocks in their slots, `license` only with
`files`, chart colors per preset, and contrast on every palette and on styled blocks, as above. Decided, not changed:

- **The revision does not cover brand file bytes or the built-ins.** It is the concurrency token for JSON operations;
  brand files join it when step 8 adds the operations that upload them.
- **Brand and template changes are not separate review items yet.** Step 5 has `reviewChanges` list brand.json and
  each template, with accept and revert; step 8 shows them in the editor.
- **Two presets only, paper and ink.** Adding more later is compatible: a palette is keyed by preset.
- **No slot-level operations, no patch-style `template.set` or `style.set`.** They come with the editors that need
  them, in step 8.
- **No lock per capability, no `hideBuiltIn` per id.** Later, and compatible with today's `lock` and set names.
- **No localized brand strings.** Later, and compatible: a string can become a string or a map of languages.
- **No export severity profile.** Step 6, with the export it would govern.

Found, not fixed (older than the brand work):

- **File names that differ only in case, on Windows.** `brand/Brand.json` or `brand/Templates/x.json` is skipped when
  the folder is read (the loader matches exact case), but a later `brand.set` or `template.set` writes
  `brand/brand.json` or `brand/templates/x.json`, which NTFS resolves to the same file and overwrites unseen. `scenes/`
  has the same gap. Location: `walk` and `loadDeckDir` in `packages/cli/src/loader.ts`. Fix: compare each path's lower
  case with the known names (`deck.json`, `scenes/`, `brand/brand.json`, `brand/templates/`) and report a near miss
  as an error, `wrong-case-file`, so the deck does not load until the file is renamed.
- **`depthcue check` crashes on an object with a `toString` key where a scalar goes.** `{"theme": {"toString": 1}}`
  in deck.json exits 2 with "Cannot convert object to primitive value". Location: `display()` in
  `packages/core/src/diagnostics.ts` (line 101, `String(value)`), called from `explainOne`: the `enum` case here, and
  `const` and a discriminator's tag the same way. Fix: show objects and arrays with `JSON.stringify`, cut to a short
  length, and other values with `String`.
- **A scene named `constructor` crashes the review.** It passes the id pattern; `diffDocs` and `acceptChanges` read
  `base.scenes[id]` and get Object's constructor, then throw. Location: `packages/core/src/review.ts`, the scene
  lookups at lines 222, 237, 349, 394 and 397. Fix: the `own()` lookup this step added for kits.

## Step 2 record: PowerPoint export

- **Command.** `depthcue export <deck> --format pptx [--out <file.pptx>] [--no-notes] [--json]`; the file is
  `<deck folder name>.pptx` in the current directory unless `--out` names it. Exit codes: 0 done, 1 the deck has
  errors, 2 the export could not run. The errors that stop it are `no-browser`, `render-failed`, `bad-out`,
  `out-not-ours`, `out-edited` and `write-failed`, and `--json` prints each as `{ "ok": false, "code", "message" }`.
  `PptxErrorCode` also lists `player-not-built`, which nothing raises. An unbuilt player is not caught: the server's
  `realpathSync` throws a bare `ENOENT: no such file or directory, lstat '.../packages/player/dist'`, the exit code is
  2, and `--json` prints no JSON. Found while reviewing step 4, recorded as found and not fixed. `--json` prints the
  summary below as data.
- **How it is made.** The player draws each scene at full reveal in a headless Chromium at 1280 by 720, with
  animation off and the controls hidden. The browser is the executable in `DEPTHCUE_BROWSER` when that is set, else
  Chrome, Edge, or Playwright's own Chromium, whichever starts first. `measure.ts` reads what the page laid out (the
  box of each block, panel and picture; the face, size, color, line height and alignment of each text; a chart's
  series colors) and `build.ts` draws it with pptxgenjs, a dependency of the CLI only. 1 px is 9525 EMU, so the stage
  is PowerPoint's 13.333 by 7.5 inch widescreen slide. Words, marks, links and numbers come from the deck; where and
  how they sit comes from the page. A slide per scene, in deck order.
- **What is PowerPoint's own.** Text runs with their marks, links, colors and lists; tables; charts of all six kinds
  (`bar`, `stacked-bar`, `line`, `area`, `scatter`, `donut`) and the old `bar-chart`, each with its workbook; pictures
  with their alt text, drawn as PNG when PowerPoint would not show the type; speaker notes (one paragraph per line;
  `--no-notes` leaves them out, as anyone with the file can read them); the sources as one paragraph of numbered runs
  (`1. Title   2. Title`), of which only a source with a `url` or an `asset` is a link; panels, rules and dots as
  shapes. A clip is its poster picture linked to its source, or a labeled box linking to it when there is no poster;
  it is never embedded.
- **The report.** The summary has the file, the number of scenes and bytes, the fonts the file names with what each is
  used for (a viewer needs them installed to see the file as drawn), and for each slide a list of what had no
  PowerPoint form: the chart explorer, a series told apart by marker shape (color only here), a video that is not
  embedded, build steps (flattened, so every block shows at once), a picture hanging past the left or top edge (shown
  whole, inside the slide), a picture that could not be read (left off the slide), content that runs past the right
  or bottom edge of the slide, a block the player did not draw. One note holds for every slide: scenes change with no
  transition. Warnings the deck has are carried; errors stop the export. A box that is not a picture and hangs past
  the left or top edge is cut at the edge without a word in the report (`frameOf` in `build.ts`).
- **Overwriting.** The file carries a custom document property `DepthcueExport`, `v1:` and a sha256 digest of its
  parts, all but `[Content_Types].xml`, `_rels/.rels` and `docProps/custom.xml`, which the mark itself changes. At
  the output path there is nothing, a file Depthcue wrote and nobody changed, one it wrote and someone has edited
  since (usually in PowerPoint), or something else. Only the first two are written over; the other two are
  `out-edited` and `out-not-ours`, and nothing is touched.
- **Same bytes.** Every date in the file is 2000-01-01, parts are written in one fixed order, each slide's shapes are
  numbered again from 2, and charts are numbered from 1. Nothing is done about random numbers: the bytes are the same
  because pptxgenjs's random paths are not reached by anything an export draws. The same deck gives the same bytes.
- **Gaps found in real PowerPoint.** Headings fall back to an installed font when the deck's faces are not installed.
  Font embedding was moved into step 6 by the conductor; step 6 updates the plan's "Not in this plan" line, which
  still lists it. PowerPoint refuses a stacked bar chart whose data labels sit outside the bar end, so stacked bars
  label at `inEnd`. The report warns of content that runs past the slide only where the player's own page does, and
  only past the right or bottom edge. `panelOf` reads an element's top border alone and draws it as one outline on
  all four sides, so a panel with a border on one side gets a frame all round; it draws no gradients or shadows, and
  a dashed border comes out solid.

## Step 3 record: the brand in the player

- **One path to the page.** The server answers `/look.json` with `pageLook(lookOf(doc))`, built whenever `deck.json` and the
  brand parse (`lookOfFiles` in `cli/src/look.ts`), so a scene with an error does not take the brand off the page. While
  the brand or `deck.json` is broken the last good look is served, and the answer is 404 only before there has been one
  (the page then draws from `deck.json` alone, as before). The export works the look out once and puts it in
  `ExportData.look`. `pageLook` cuts the look to what the player reads: a template loses `schemaVersion`, `id`, `name`
  and `description`, a slot `accepts`, `hint`, `max` and `required`, a style `name` and `for`. It is a list of what is left
  out, so a field added later still reaches the page; a test draws the same scenes from the whole look and from the cut
  one. The player never imports `lookOf` or the registry; it is given a `PageLook`. `applyLook(element, look, base)` sets
  the theme and font pair as attributes and every color, the six chart colors and the brand's faces as custom
  properties, and takes off what an earlier look set that this one does not. A `Look` is a deck's theme, palette and
  fonts, or a `PageLook`; a deck before 0.4 is drawn exactly as before. `legacy.test.ts` compares the DOM of five old
  decks with and without a look, and the e2e file compares pictures of the v0-1, v0-2, v0-3, demo and charts decks with
  and without one. Pictures drawn by this branch are byte-identical to main at 225d8cd on Windows (the reviewer's 19
  old-deck renders; 38 of 38 of mine); that is a local check, and CI does not make it. The check CI makes allows at most
  64 pixels to differ, and none by a larger step than two drawings of the same page differ by (a control page is drawn
  the same way and photographed beside the pair), after up to three retakes; a test shows that a muted text color 16
  steps lighter in each channel fails it. Each scene is opened by a fresh load of each page. After an in-page change of
  scene, Chrome on Linux drew the donut of `v0-3` (19 pixels, at most 4 steps) and one text edge differently on the page
  with the look than on two pages without it, and now and then between two pages without it, though the DOM, computed
  styles and every box were the same and the difference did not change in 1.5 seconds; opened fresh, 60 of 60 pairs
  were equal. That is the drawing history of a page, not the look.
- **Faces.** `@font-face` rules go in a constructed stylesheet (`adoptedStyleSheets`), because the page's policy
  (`style-src 'self'`) refuses a `<style>` element, and are inserted one at a time, so a rule the browser refuses costs
  its own face and no other. A face is a safe family name and a file inside `brand/` (`brandUrl`). The player builds its
  family check from core's `FAMILY_PATTERN` (now exported), which leaves out a quote, backslash, semicolon, brace, angle
  bracket and any control character: a line break in a family name used to end the CSS string and empty the whole
  sheet. The heading weight is the file weight nearest 700 (a tie takes the lighter), set as `--dc-display-weight`.
  Without constructed stylesheets the built-in pair stays. `faceCss`, `brandUrl` and `lookKey` are exported for the
  editor and the tests.
- **Template scenes.** Each slot sits at its frame (percent of the stage), its blocks stacked by `valign`; a claim slot
  draws the scene's claim as one heading with its evidence linked by `data-evidence`; an overlay sits at its frame
  over the template. A slot's `style` and a block's own `style` give fill, border, edge, radius, case and weight, with
  reversed text (the theme's background color) on a strong fill. A panel drawn in the slide's own surface inside a
  strong background (a callout in a section, a quiet panel on a cover) is drawn in the slide's own ink: `.dc-player`
  keeps the slide's colors as `--dc-ink`, `--dc-ink-muted` and `--dc-ink-line`, the panel takes them back, and a block that
  names its own `tone` keeps it. Brand and block styles go through the CSSOM, never an inline `style` attribute. A
  template's background (a color, or an image under a scrim) and its chrome (`minimal` or `none`) are drawn too. Chrome
  is the logo, footer, slide number and accent bar in the corners and edges the brand names; it is never drawn over
  content on the three layouts. They grow their padding by `--room` when the logo is in a top corner: 3.5, 4.5 or 5.9 em
  for a small, medium or large logo. Every slide already has a 3.5 em margin, so a small logo adds nothing and the
  others add only what they reach past it. On a strong background the logo is drawn on a plate of the theme's
  background color instead of a second logo file: a brand's logo for the other theme is not chosen by the player.
- **Sources on template scenes** are one flowing line along the foot, above the footer, instead of the block under the
  content: the label and each source after it, a middle dot between them, as many lines as they take at the slide's
  width, growing upward from the foot. Under 640 px of container width they fall back to a block with a rule above.
  The line is out of the flow, so content that comes down to it is covered, and `depthcue render` says so with
  `sources-overlap` (the lines of the sources over a block's text, picture, chart or panel, or over the brand's logo,
  footer or slide number, with the overlap in pixels and a fix; a logo in a bottom corner is the usual one). A text
  line's box is taller than its letters, so a reach of less than a third of a line, as a citation and the sources
  set one under the other have, is not reported.
- **Export.** `index.html` carries the `PageLook`; `fonts/<pair>.css` goes for the look's pair (a brand's faces load over
  it) and the files under `brand/` are copied only when the look uses them: its faces, the logo for the deck's theme and
  the images of the templates in use. The `.txt` license text beside a copied font file is copied with it, and the
  built-in faces bring their own `<family>-OFL.txt` (`licenses.json`, written by `build-fonts.mjs`, says which); none of
  them is served. `isBrandFile` in `serve.ts` is the one rule for the server and the copy: the `BRAND_FILES` whitelist
  (fonts, logos, images; never `brand.json` or templates) and a path with no backslash, NUL, empty, `.` or `..` part
  once it is decoded, so `..%2f` and `%5c` get no further than `..` did. A brand file the look names that cannot be
  copied (a link to a file outside the brand folder, not a file, not a path a page may read) is a `brand-file-not-copied`
  warning that names the file, and the export goes on. `--json` lists `brandFiles` and `licenses`. An export opened in a
  real browser with every request that is not a file blocked loads the faces.
- **Render.** `depthcue render` draws the brand and `layout.ts` measures it: `slot-overflow` (a block outside its
  slot, measured on the block's own rectangle), `chrome-overlap` (the brand's logo, footer, number or accent over a
  block, with the overlap in pixels), `sources-overlap` (above) and `background-low-contrast`. For the last, the page is
  photographed a second time with its text made transparent, and each line's contrast is measured on the pixels under
  it (`measurePicture`), so text on a template's picture is judged on what is behind it; with scrim 0 a bright picture
  fails, with scrim 90 or a dark picture it passes. `brandcheck.ts` now says in `background-unmeasured` what render does
  (wording only).
- **Editor.** The canvas, the strip and the storyboard all draw from `lookFor(doc)` (one `DeckLook` per version of the
  document), so they show the brand the person will present. The frame now carries every color as an inline custom
  property and `data-fonts` always, where it used to carry only the palette's and the deck's pair; the slide is the
  same and the four Style tests that read those attributes now read the preset's value instead of nothing. Thumbnails
  draw logo, footer and accent but not the slide number (the budget below).
- **Sizes (brotli bytes, main to now).** Player script 10,539 to 11,977; player styles 4,862 to 5,864; exported page
  script 13,641 to 15,067 (limit 14,336 raised to 16,384, as approved); core code in the player 5,080 to 5,119 (limit
  6,144); editor script 90,368 to 92,153 (limit 92,160: 7 bytes of room); editor brand checks 3,328; core runtime gzip
  41,084 to 41,271 (limit 61,440; `pageLook` and the exported pattern). The editor is what is tight: Brotli moves 40 to
  60 bytes on a change of one name (a change that takes bytes out can add some), so the next step to touch it should
  look for room first. What bought room: no `data-st` attribute on styled blocks, no slide number on a thumbnail, no
  `format("woff2")` hint in `@font-face`.
- **Fixture.** `v0-4-brand` (Harbor Analytics) has two faces (Harbor Display, Harbor Sans) in two real woff2 files
  with their OFL text, a logo, two templates (cover, chart-and-note), two styles and three scenes. The cover template has chrome `none`
  (its light logo was unreadable on teal), the chart-and-note title is 76 wide so it clears the logo, and the logo is
  176 wide so "Analytics" is not cut.
  Scenarios beyond it (section, statement, two-column, a strong fill, a picture, a dark and a bright background) are
  built in temporary copies by `brand-player-e2e.test.ts`, because the MCP tests pin the fixture's three scenes.
- **Decided.** Heading weight nearest 700; evidence-linked blocks on a template scene get `data-evidence`; the
  presenter has no scene preview, so its colors and faces come through `applyLook` like the page's; the logo plate
  instead of a logo variant (see Risks); sources as a foot line; thumbnails without the number.
- **Risks for later steps.**
  - The plate is not a design answer for a brand whose logo only works on one background: a logo for dark backgrounds
    (`logos` per theme) is not read for a template's strong fill. Step 8's brand panel should say which logo goes where.
  - A logo in a top corner still pads the top of a layout scene by what it reaches past the margin (a large one, 2.4
    em), so a slide that just fits can overflow; render says `overflow`. The fix is a smaller logo or a shorter slide.
  - Step 4's `brand-import/fonts.ts` keeps its own copy of the family pattern, without the control characters. Core now
    exports `FAMILY_PATTERN`; step 4 should import it.
  - `packages/cli/src/pptx/measure.ts` counts the logo `<img>` as a picture; step 5 should skip `.dc-chrome img`.
  - The human summary of `depthcue export` in `cli/src/index.ts` does not list the brand files or licenses (`--json` does);
    it is outside this step's files. `docs/export.md` still gives the old exported-page budget in its table.
  - The editor has 7 bytes of room under its limit.
- **Outside the write-set.** `packages/editor/src/storyboard.ts` (the staleness key and the look, as `strip.ts`);
  `packages/core/test/brand.test.ts` and `packages/editor/test/brandchecks.test.ts` (the `background-unmeasured`
  wording); `packages/editor/test/deckpanel.test.ts` and `packages/cli/test/edit-style-e2e.test.ts` (the inline colors
  and `data-fonts` above); `packages/cli/test/layout.test.ts`, `export-brand.test.ts` and `serve-brand.test.ts` (the
  new checks, the export and the server); `packages/cli/test/export-command.test.ts` and `edit-style-e2e.test.ts` (an
  export now carries each family's license text); `packages/core/src/schema.ts` (`FAMILY_PATTERN` without control
  characters), `schema/brand.schema.json` (generated from it) and `index.ts` (exports `FAMILY_PATTERN` and the
  `PageLook` types).

## Step 4 record: brand import

- **Command.** `depthcue brand import <file.potx|.pptx|.thmx> [--out <dir>] [--json]`. The default folder is
  `<file name>-brand` in the current directory. It takes no other option. Exit codes: 0 done; 1 the file has no theme
  with a color scheme, no layout that can be a template, or slides that are portrait (or, a fault in the import, the
  brand it made failed the brand checks, and nothing was written); 2 the file could not be read, or the folder could
  not be written, which includes a folder that was refused. The refusals that exit 2 are `bad-file`, `unreadable`,
  `out-is-file`, `out-not-ours`, `out-edited`, `out-in-source` and `write-failed`. `--json` prints the report as data;
  without it the report is printed as lines.
- **Reading.** A `.potx`, `.pptx` or `.thmx` is a zip of XML parts, read with jszip (already a dependency, none added)
  and a small XML reader of its own that refuses a DOCTYPE and nesting past 100. The limits are `LIMITS` in
  `package.ts`: 4000 parts, 16 MB for an XML part, 32 MB for any other part, 128 MB unpacked in all, 300,000 elements
  in one XML part and 800,000 in all. They are counted as each part is unpacked, not read from the zip's directory,
  which a file can lie about, so a part that unpacks larger than it says is stopped when it passes the limit. A file
  over 256 MB is refused before it is read. The old `.ppt`, `.pot` and `.thm` are not zips and are refused with a
  word about that. A `.pptx` takes the master its first slide uses (the first listed when it has no slide); a
  `.thmx` takes the theme and, when it has them, the master and layouts under `theme/`. A `.thmx` with no layouts
  imports as a theme alone: colors and fonts, no templates. Slides, other masters and theme variants are counted in
  the report and not imported.
- **Colors.** The master's background says the preset: a dark one is `ink`, any other `paper`, and only that preset's
  palette is written, which is why the report says to set `"theme"` in deck.json to it. Each name takes the theme
  color that does the same job: `bg` the master's background when it is a plain color, else the theme's background;
  `surface` the second background (the first, when the master already uses the second); `text` and `muted` the two
  text colors; `evidence` the hyperlink color; `action` the first of accent 1 to 6 that reaches 3:1 on both `bg` and
  `surface` (accent 1 when none does); `line` is worked out, 14% of the way from `bg` to `text`. The chart colors are
  the accents in order that reach 3:1 on `bg`, no repeats, up to six, and none when no accent does. A background that
  is lightened or darkened is not worked out: the theme's own background color is used and the report says so. A
  gradient or a picture the master points at in the theme's fill list (`bgRef` 1002 and 1003) is painted in one
  color, the one the reference names, and that color is the background; the report says the fill was reduced to its
  base color. A gradient or picture the master holds itself is not a color, and the theme's background is used.
- **Colors that fail.** A theme color that would fail a contrast rule is not written. The text side of the failing
  pair goes back to the preset's color first, so a background the theme chose stays when the preset's text reads on
  it; each pass sends one color back; then every color sent back is tried again with the theme's value, and kept if
  the palette passes. If that gave up the background or the panel, the colors on it are tried once more, moved: where
  the preset's own color would fail too, the theme's link, muted or accent color is mixed toward the text color in
  steps of 5%, at most half way, until it reads (4.5:1, or 3:1 for the accent) on both the background and the panel;
  where the theme's cannot be moved that far, the preset's is moved the same way, at most three quarters of the way.
  That palette is used only if it gives up fewer. A moved color is `derived` in the report, with the share it moved.
  The report gives each color sent back: the theme color and where it came from, the ratio it had, the ratio it
  needed, the preset color used, and the partner it fails against in the palette as it ended, which can differ from
  the one it was tried on. The rules are the pairs of core's `checkBrandColors`, and a test compares the two on 400
  random palettes. In the 43 local themes 8 have a color moved and 25 keep a preset color for a failing theme color.
- **Fonts.** The theme's heading and body Latin fonts become the display and body faces by family name, with no
  files, so no `license`. The fallback is `classic` when the display face is a serif and `modern` otherwise; a face is
  a serif or a sans by its PANOSE number when that says, else by its name, else a sans is assumed, and the report
  names the rule for each. A name a brand cannot carry (a quote, brace or semicolon, or over 64 characters) is not used.
  Font files embedded in the file (`.fntdata`, Embedded OpenType, often licensed for that one file) are named in the
  report and never copied.
- **Logo.** The candidates are the pictures on the master, or else those on the title layout. A logo is not rotated
  or flipped, and neither is a group around it (a turned group turns what is inside it, so the picture is not upright
  either), not over 20% of the slide, not within 0.5% of a slide edge (artwork bleeds off the edge, as Ion's ribbons
  do; a logo is set in), and has its center in the outer 35% of the slide across and down; of those the smallest is
  the logo, and another is never put in its place. Its size is the nearest of `s`, `m` and `l`, which stand for 5%, 8%
  and 12% of the slide's height (`SIZE_HEIGHTS` in `logo.ts`, the one place to change if the player's sizes differ).
  A PNG or SVG is kept as it is, in `logos/logo.png` or `logos/logo.svg`, under `logos.light` for paper and
  `logos.dark` for ink. An SVG is read as XML (`svg.ts`) and refused for a script, `foreignObject`, animation or
  embedding element under any prefix, an event handler, a link to anything but a place in the file or a picture held
  in the link, a style that loads anything outside the file, `@import` or an escape, or a DOCTYPE with declarations;
  the report says which. A background picture that is an SVG goes through the same check. A JPEG goes unchanged inside
  an SVG, because a brand's logo is an SVG or a PNG and nothing here decodes a JPEG. EMF, WMF, GIF and unknown formats
  are refused, with the reason and what to do. The alt text is the picture's own, else its name when that says "logo",
  else "<brand> logo".
- **Chrome.** The logo's corner and size; the footer's words and place, from the master's footer placeholder or else
  the first layout's that has words, or else, for a `.pptx`, the first of its first 20 slides that has some (the
  report says when the words came from a slide; a template or a theme has none to read), cut at 120 characters; the
  place is the third of the slide it sits in; the slide number's place when the placeholder is a number field or
  empty. The date placeholder is reported and not taken. There is no accent bar.
- **Templates.** Each layout is a template, with the id its name makes (a slug; `-2`, `-3` when taken) and the
  placeholders as slots: `title` and `ctrTitle` a title slot taking a heading, `subTitle` a subtitle and `body` a body
  (text), `pic` a picture, `chart` a chart, `tbl` a table, and `obj` and any other type a `content` slot, which takes
  any block. Date, footer, slide number, header and slide image placeholders are chrome, not slots. A slot's frame is
  in percent of the slide, from the layout or else from the master's placeholder of the same family and index; its
  `valign` is the placeholder's anchor; its hint is the placeholder's prompt text unless that is PowerPoint's stock
  "Click to edit"; the title slot is required. A slot that passes a slide edge by 0.5% or less is trimmed to the edge
  and reported (Office's own picture layouts run to 100.13%). A layout's background is `bg`, `surface`, `text`,
  `action` or `evidence` when its solid color is exactly one of the brand's, a picture (copied to `images/`, with a
  scrim of 65), or reported and left out; one that points at the theme's gradient or picture fill is reduced to its
  base color, read through the layout's own color map when it overrides the master's, and matched the same way, and
  the report says it was reduced. A picture's file name in `images/` is its part's name made safe: runs of dots become
  one dot, it is cut at 100 characters, and two names that differ only in case get `-2` on the second, because a
  folder may sit on a disk that does not tell them apart. A layout that hides the master's shapes is
  `chrome: "none"`. No imported template has a claim slot, because PowerPoint has no placeholder for one; the report
  says so.
- **Layouts that are not templates.** Each is listed with its reason, and none is bent to fit: a placeholder with
  vertical text (Depthcue does not draw it), no placeholder, more than 12, a slot lying off the slide, or two slots
  that share more than 1% of the slide across and down. Slots sharing 1% or less are touching, and are kept at their
  frames, so core's `slots-overlap` warning still shows for them (Office's Comparison layout). A file where no layout
  can be a template exits 1 with the reasons. Everything else that is not taken is listed too: shapes and pictures on
  the master and layouts, the master's text styles, the date, embedded fonts, slides, other masters, theme variants.
- **Slides that are not 16:9.** A 4:3 or other landscape file, a `.thmx` too (it carries its own slide size), is
  imported with each frame kept as its share of the slide, which stretches the slide to 16:9 with it; the report says
  so. A portrait file exits 1 and says how to fix it.
- **Checked before written.** The brand and every template are checked as a deck would check them (`checkBrandFile`,
  `checkTemplateFile`, `checkBrand` with the brand's files) before any file is written. An error means nothing is
  written and the result is `brand-invalid`. The warnings are the report's: a face with no files (always, since fonts
  are by name), overlapping slots, and the like.
- **The folder.** The brand is `brand.json`, `templates/<id>.json`, `logos/` and `images/`, and
  `.depthcue-brand-import`, a marker `{ "format": "depthcue-brand-import/1", "files": { "<path>": "<sha256>" } }`
  that lists each file written with its hash. Importing again into a folder that has the marker replaces the listed
  files whose bytes still hash as written, and removes the listed ones the new import does not make; the report lists
  what it removed. A listed file that was changed since (a deck's apply edits `brand.json`) or is no longer a file
  is refused as `out-edited`, with nothing touched. A file the marker does not list is never replaced or removed: an
  import that would write over one is `out-not-ours`. While it writes, the marker holds both the old and the new hash
  of a path, so an import that stopped half way can be run again. A folder with other files in it, or one that holds
  the source file, is refused with nothing touched, and a file that cannot be imported leaves the earlier import
  alone. The report's `files` includes the marker. Copied into a deck as `brand/`, the marker is harmless:
  `depthcue check` ignores it, and a test holds that. Each of the earlier test decks is also given an imported brand in
  its `brand/` folder by the real command: nothing else in the deck changes, `rev` is the same, and `check` gives only
  the unused-brand warning; a deck with a brand of its own refuses the import.
- **Decisions the brief left open.** The 1% touching tolerance and the 0.5% edge trim above, which came from Office's
  own layouts; skipping vertical text; the logo's edge and size rules; the JPEG in an SVG; refusing EMF and WMF rather
  than converting them; the restoring pass over colors sent back; moving a color toward the text color, half way for
  the theme's and three quarters for the preset's, before giving up a background the theme chose; reducing a theme's
  gradient or picture to its base color; taking a `.thmx` with no layouts as a theme alone; the marker listing itself
  in `files`; never making a claim slot; scaling a 4:3 file rather than refusing it.
- **Checked by hand.** All 43 `.thmx` files in PowerPoint's `Document Themes 16` import with no failure and no
  `brand-invalid`, 802 templates in all. Six have a gradient or picture fill as the master's background, and after
  the review each keeps its color: Ion and Ion-new `#1E5155`, Slice `#146194`, Mesh-new `#363D46`, Gallery `#DFDBD5`,
  Wisp `#E3EACF`. Office Theme, Retrospect and Ion were imported into a scratch folder, built into decks and checked,
  and a contact sheet of each brand's slot frames was looked at. The player does not draw template frames, fonts or
  chrome until step 3, so the rendered slides show the labeled slot boxes, and the look of an imported brand on a
  slide is still to be checked after that step.
- **Known limits.** No stock Office theme has a logo, so the logo path is tested with generated files only. The Ion-style
  rule can still take artwork for a logo, or miss a logo set against the edge. The 34 layouts with East Asian
  vertical text in the 43 local themes are skipped. Theme fonts are names only: a viewer without them sees the fallback
  pair. A moved color is arithmetic, not a designer's choice: Slice keeps its blue because its link, muted and accent
  colors were mixed toward white, and its link comes out `#CBD7FF`, nearly white.

## Step 6 record: the PowerPoint extras

- **Master and layouts.** pptxgenjs has one master and no placeholder types or fields, so `pptx/master.ts` writes the
  master, the layouts and the slides' ties to them as XML in the package step, after the writer, the same way every
  time. A deck with a brand (or `--pictures`) gets one master: the deck's ground, the accent bar, the logo (the PNG the
  page drew, at three times its size), a footer placeholder with the brand's words and a slide-number placeholder with
  PowerPoint's own `slidenum` field; dates and headers are off. The theme's colors are the look's. The layouts are
  `Blank` (scenes on the built-in layouts) and one per template in order of first use, named by the template's
  `name`. Each slot is a placeholder at its frame. A layout has one title: the first title slot, or the first claim
  slot when no slot is a title; every other title or claim slot is a numbered `body`. Subtitle is `subTitle`, body
  `body`, picture `pic`, chart `chart`, table `tbl`, content `obj`. The slot's hint is the prompt, its `valign` the
  anchor, and the text style is the first slide's measured ink. Numbers: master body 1, footer 3, number 4; a
  layout's footer 11, number 12, slot n is 13 + n. A template with chrome `none` or `minimal`, or a ground that is not
  the deck's, turns the master's shapes off and draws its own copy of what it shows (the logo on its plate on a strong
  ground, and no accent bar for `minimal`), as the page does; its background (a color, or the picture with its scrim
  as one JPEG) is the layout's. A slide uses its scene's layout, and the first block in each slot (the claim in a
  claim slot) is that slot's placeholder, so PowerPoint's Reset puts it back. A deck with no brand keeps the file it
  had: one layout and no placeholders.
- **Fonts.** Every family the slides and charts draw that has files (the brand's faces, and the faces of the
  built-in pair the player ships) is embedded as PowerPoint embeds fonts: an EOT 2.2 part per face with no compression
  (`pptx/eot.ts`), listed in `<p:embeddedFontLst>` with `embedTrueTypeFonts`. WOFF2 and WOFF are decoded here
  (`pptx/sfnt.ts`, the `glyf` transform included, brotli from `node:zlib`): no new dependency. A face is left out and
  named when its `fsType` forbids embedding (restricted or bitmap only), when it has CFF outlines, when the file is
  not the face it stands for (IBM Plex Mono SemiBold calls itself "IBM Plex Mono SmBld" Regular, so it is no bold), or
  when its file cannot be read. Preview-and-print embedding is kept with a note that PowerPoint may open the file
  read-only. PowerPoint finds an embedded font by the name inside it, so the slides are written with that name and the
  report says so ("Harbor Sans" is "Space Grotesk" in its file). A family the page draws only from a bold file is bold
  in the slides. For a family split by `unicode-range`, the file covering the most of the slide's characters is
  embedded and the report lists the characters that come from another face. A brand face with no files is said once
  for the deck (`face-without-files`). The EOT header is written as PowerPoint writes its own (read from a file it
  saved): character set 0 for a Latin font, family and style names ending in a NUL their sizes count, root checksum
  key `0x50475342`, EUDC code page 1252, and the checksum of the font as written. `<p:font>` has `pitchFamily` (IBM
  Plex Mono 49, Instrument Serif 2, as PowerPoint wrote them) and leaves out a PANOSE of all zeros. Names are read
  from Windows English, then the Unicode platform, then other Windows languages, then Macintosh Roman; a file with no
  family name PowerPoint can read is not embedded and the slides keep the deck's name. A file over 32 MB, a WOFF or
  WOFF2 that would unpack past 64 MB or past the size its tables state, or a glyph of more than 65,535 points is
  refused before it is unpacked, named in the report and not embedded, and the export goes on. A face counts as
  embedded only when its own file is in the file. The report lists the embedded families apart from the ones a viewer
  needs installed, and `--json` has one `fonts` entry per family (roles, `as`, `embedded`, `notes`).
- **PowerPoint and the fonts.** In the conductor's check, PowerPoint (Microsoft 365, Windows) listed the embedded
  fonts but drew their text in Arial. It did the same with its own embedding of Instrument Serif (a file it saved,
  EOT flags 5), so the cause is not known. The report says what is in the file and nothing about what PowerPoint
  draws.
- **`--pictures`.** Each slide is the page drawn at 1.5 times (1920 by 1080, PNG), with the notes, the scene's title
  as the picture's description, and the title in a hidden title placeholder for PowerPoint's outline, under the
  picture (LibreOffice draws hidden shapes). The layout is `Picture`.
- **Videos.** A clip that is an MP4 in the deck with H.264 video and AAC sound, read from its own boxes
  (`pptx/media.ts`), is embedded in the box the page draws it in, with the poster the page drew as its cover and its
  alt text as the description. A clip with no poster is drawn in the video's own shape (the MP4's `tkhd`, turned when
  its matrix turns it), with its first frame as the cover when the browser decodes it and a plain dark picture in
  that shape when it does not. Anything else, and every clip under `--posters`, is the poster with a link, and the
  report says why. The test video `packages/cli/test/fixtures/tiny.mp4` is 40 KB (2 s, 320 by 180).
- **`--steps`.** One slide per step of a scene with build steps, from the scene as it opens (`#/<scene>/<k>`), with
  the step in the report. Blocks the scene holds back are left off, and not reported as missing. Each step slide's
  number field holds its scene's number, as the player shows it; PowerPoint numbers every slide when it shows them,
  which the report says when the brand shows a number.
- **Export endpoint.** `POST /_depthcue/api/export.pptx` on an editing server, with the token and origin checks of
  the other write calls (403), POST only (405), the CLI's switches as JSON (415 for another content type; `notes`,
  `pictures`, `steps`, `posters`; 400 for anything else, 413 over 4 KB), one export at a time, and the file in the
  response (422 for a deck with errors, 503 without a browser), named with an RFC 8187 `filename*` that escapes
  `'()*` too. Nothing is written: links to deck files are made relative to
  `<deck folder>.pptx` beside the deck, so the bytes equal `depthcue export <deck> --format pptx --out` that path.
- **MCP.** `deck_export` writes the PowerPoint file or the offline page to an absolute `out`, one at a time after any
  render, with the same refusals as the CLI, and returns the per-slide report and the fonts. The CLI and the tool
  refuse a PowerPoint file inside the deck folder (`out-in-deck`), as the folder export refuses a folder there; the
  tool also refuses a network share (`\\server\share\…`, `\\?\UNC\…`). Six tools now; the
  tool-list limit is 13,200 characters (was 12,000, which the five tools filled to 11,999; `deck_export` is 1.1 KB).
  `@depthcue/cli` exports `./export` and `./pptx` for it.
- **Report.** Content past the slide is said for every edge it crosses, in pixels past that edge. That is not
  `depthcue render`'s number, which is how much taller the scene is than the stage, padding included: v0-3's `data`
  is "258px taller" in render and 195 px past the bottom here. A picture past an edge is cropped there with its source
  rectangle, so PowerPoint's Crop gives the rest back. What a panel has that a shape here does not draw (a gradient or
  picture, a shadow, an outline, see-through, a dashed, dotted or double border, unequal corners) is named per slide.
  `slot-empty` goes on its slide; `face-without-files` and `background-unmeasured` go on the deck. A player that is
  not built is `player-not-built`, as JSON under `--json`, exit 2. `measure.ts` skips `.dc-chrome`, and the folder
  export's human summary lists the brand files it copied.
- **Found on the way.** A template scene's sources are a line at the foot (step 3), but the slide wrote them numbered
  in a box measured to the unnumbered line, so they wrapped into the footer. The measure now says whether the page
  numbers the list. Since step 3 merged, the page sets the foot line's label and sources as one run of text, a middle
  dot between sources, as many lines as it takes, growing upward from the foot. The measure gives that line's whole
  place (`flow`), and the slide draws it as one paragraph in that box, anchored at its foot, so a line PowerPoint adds
  in a wider face goes up, not into the footer.
- **Brand import's logo sizes and family names.** `SIZE_HEIGHTS` in `brand-import/logo.ts` is now 5%, 7.5% and 11%
  of the slide's height for `s`, `m` and `l`: the player draws them 2, 3 and 4.4 em high, and a scene's em is 2.5% of
  a 16:9 stage's height (a template scene's is 0.014 of its width, 2.49% of the height). Step 4's record gives the
  old 8% and 12%. A test reads `player.css` and fails, naming the table, when the two part. `brand-import/fonts.ts`
  checks a theme font's name with core's `FAMILY_PATTERN` instead of a copy, so a name with a control character is not
  used; the report quotes such a name as JSON, DEL included, so no control character reaches a terminal.
- **Checked.** Every file was opened in LibreOffice and turned to page images, one page per slide, compared with the
  player's: the brand deck, the demo, the demo in picture mode and with steps, and v0-3. LibreOffice draws the mono
  "Sources" label in another face, so it wraps there, as it did before this step. `pnpm check:pptx-pages`
  (`tools/check-pptx-pages.mjs`) exports every fixture deck as it is, with `--pictures` and with `--steps`, using the
  built CLI, has LibreOffice convert each file one at a time with a profile of its own, and checks that the pages
  equal the slides. Run it after the tests, never beside them: LibreOffice running beside the editor's real-browser
  tests on Windows failed edit-e2e's Alt-drag test (77 conversions beside it failed it; 16 busy processes did not).
  The reviewer's hypothesis is that `saved()` (`edit-e2e.test.ts:101`) waits for any "saved" status rather than a
  new save, so a slow machine reads the one before; it is not tested here. CI does not run the script. PowerPoint
  itself is the conductor's check.
- **Sizes.** No budget row moved: the work is in the CLI and the MCP server.
- **Risks.** The video goes in through pptxgenjs `addMedia`, whose shape ids the package step renumbers, and
  LibreOffice cannot say whether PowerPoint plays it. The fonts are embedded whole, not subset. Embedding a face whose
  licence allows it still puts a copy of the font in a file that travels; the report names each one.
- **Outside the write-set.** `packages/cli/package.json` (the `./export` and `./pptx` exports) and `vitest.config.ts`
  (their aliases), for the MCP tool; `tools/check-pptx-pages.mjs` and its `check:pptx-pages` script in the root
  `package.json`, which the review asked for; `brand-import/fonts.ts`, which the conductor asked for, and the tests
  of it and of the logo sizes (`brand-import-fonts.test.ts`, `brand-import-logo.test.ts`). `README.md` still says
  five MCP tools, for step 9.
