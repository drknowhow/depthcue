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
  the full chrome, a minimal one (logo only) or none. From schema 0.7, `bands` adds a header along the top and a footer
  along the bottom, each with `start`, `center` and `end` zones. A zone is text with fields in braces: `{number}`,
  `{count}`, `{section}`, `{title}`, `{deck}` and `{date}`. A zone of `bands` wins over the footer line and the slide
  number at the same place, and a brand written before `bands` reads as the same zones. A field with no value shows
  nothing; `{section}` is the title of the nearest slide at or before this one on the `section` template.
  `deck.json` takes `date` (text, never a clock) and `numbering` (`start`, and `skip`, template ids that show no
  number but still count); a scene takes `chrome` (`full`, `minimal` or `none`), which wins over its template's.
  `depthcue check` reports `chrome-unknown-field`, `chrome-no-date`, `chrome-no-section` and `chrome-no-number`.
  The player draws the header along the top and each zone of the footer along the bottom. The Brand panel's Chrome section has three zones for the header and three for the footer, buttons that put a field at the cursor, and a line that says what the first slide with chrome shows; the Deck popover has the date and the numbering, and the Scene popover has Header and footer for one slide. The PowerPoint export follows in the next step.
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

## Step 5 record: the default brand and the brand commands

- **The default brand.** `packages/core/src/builtins.ts` holds ten templates and seven block styles, merged under a
  brand's own by id unless it sets `hideBuiltIn`: templates `title`, `agenda`, `section`, `statement`, `big-number`,
  `quote`, `two-column`, `comparison`, `full-image`, `closing`; styles `callout`, `stat`, `kicker`, `card`,
  `highlight`, `pull-quote`, `label`. They use theme colors only, so they follow whatever palette and font pair the deck
  has. Frames leave the foot of the slide to the chrome and the sources band; `section` and `closing` are on the `text`
  color with minimal chrome, `full-image` has none. No check was changed to make one pass.
- **The built-ins' frames are not the layouts' areas.** A scene on a built-in template is placed by its frames, and they
  are smaller than the layouts they stand in for. The review measured the `statement` template's evidence slot at 43% of
  the slide's height where the `claim-evidence` layout's evidence area is 54%; the frames leave the foot to the chrome
  and the sources band. A deck moved from a layout to a template gets less room for its evidence, and its text may need
  to be cut.
- **`full-image` is not a full-bleed picture.** A title cannot be drawn over a picture: the render reports `overlap`
  for any block over an image block. The template is a picture band over the top 69% of the slide with the title on a
  plate below it. The first version said the picture filled its slot, and it did not: the player drew an image inside
  its slot with `contain`, a border, rounded corners and a background, so a wide slot showed a letterboxed picture.
  One rule in `player.css` now makes the image of a `picture` slot cover its frame, with no border, radius or
  background (`.dc-slot[data-role="picture"]`). The picture is cropped to the slot, which the hint says, and the
  Tidewell `feature` template's picture slot gets the same. `brand-commands-e2e.test.ts` checks the computed style
  and that the image is within a pixel of the slot's box.
- **Proof.** Every built-in, with a sample scene each (`brand-commands-fixtures.ts`), draws with no render finding on
  both presets, all four font pairs, with and without three sources, and under the Harbor and Tidewell brands, and each
  slot's box is within 1 px of its frame. The same scenes with half again as much text in every block that is not a
  heading also draw clean; at 1.8 times, on all eight preset and font-pair combinations, they still do. That is the
  headroom for a machine with wider fonts than this one.
- **Sizes.** The built-ins are a chunk of their own in the editor, fetched for a deck that names a template or style
  of Depthcue's, as the brand checks are (`packages/editor/src/brandchecks.ts` is the stand-in for both modules, and the
  store waits for the chunk and reads the deck again). Editor script 92,152 of 92,160 with step 3 merged, where main is at 92,153: the fix round
  added the built-ins load to
  eviewbook.ts, which took it to 92,206 after the merge, and moving the handling of a failed
  fetch into `loadBuiltIns` (below) brought it back; new row editor built-ins 1,983 of 4,096; core runtime 43,489 gzip of
  61,440 (41,084 before this step); the player styles are 5,895 of 30,720 with the picture rule. A search of the
  player files finds no built-in template and no review code in them.
- **Review.** A brand change is a set of changes in scope `deck`, one per thing a person would accept or refuse on its
  own: `deck/brand/<key>` for each property of `brand.json` (`name`, `colors`, `fonts`, `logos`, `chrome`, `lock`,
  `hideBuiltIn`, the `BRAND_KEYS` but `id`), `deck/style:<id>` for each style in it and `deck/template:<id>` for each
  template file, each `added`, `changed` or `removed`. The whole file is one change, `deck/brand`, only when a brand
  is made, taken off or given another id, which is not an edit to part of one. (The first version of this step made the
  whole file one change, so accepting a color accepted a style and a block that used it; the review of it blocked on
  that.) Revert puts the files back. An accept or revert that would leave a scene naming a template or style that only
  a change not chosen holds fails with the deck's own `unknown-template` or `unknown-style`; the command line's refusal
  (`cli/src/review-api.ts`) adds which changes to name in the same call to its hint. That hint is not in core, because
  core's code is in the editor's script, which had 54 bytes of room. The editor's review panel shows these as "Deck,
  brand" until step 8 draws them, and gives no such hint.
- **The editor and Depthcue's own templates.** A revert or an accept that puts a scene back on a template of Depthcue's
  failed in the editor when the built-ins chunk had never been fetched, because the checks read the kit from the chunk
  and a deck that names no built-in did not fetch it. `reviewbook.ts` now fetches the chunk whenever it reads a review,
  so the first revert is not the first fetch (`packages/editor/test/reviewbook-builtins.test.ts`). The chunk is
  now fetched for every deck that has a review, not only one that names a built-in. `loadBuiltIns` never rejects: a
  fetch that fails leaves the records empty and the next call tries again, so the caller needs no `.catch` and the
  store, which used to rely on the rejection, now tells a failed fetch by the records still being empty and says to
  reload the page as before (`brandchecks-retry.test.ts`, `store-builtins.test.ts`).
- **`brand init <dir> [--name] [--json]`.** Writes `brand.json` alone: both presets' palettes, `fonts: "editorial"`,
  a footer with the brand's name, a slide number and the top accent. It refuses a folder with anything in it (exit 2,
  nothing written), makes the folder when it is missing, and checks its own output before it writes.
- **`brand check <brand folder | deck folder> [--json]`.** Exit 0 clean or warnings only, 1 errors, 2 unreadable.
  A deck folder that cannot be read as a deck (`{ not json`), or whose `brand.json` is broken, is 2 with the errors
  that stop it, and its brand is reported as not checked (`deck-unreadable`); a missing folder is 2 too. With `--json`
  it always prints JSON, `{ ok: false, message }` when there is nothing else to say. A brand folder with two file
  names that differ only in letter case is an error (`brand-file-case`).
  A deck folder reports only what is about its brand; a brand folder is checked on both presets, and Depthcue's own
  templates are then checked under the brand's styles as warnings (`built-in-*`), because a brand style that does not
  fit a built-in template breaks a deck that uses it. File-level errors (a template file named for another id) stop
  the colors from being checked, as in `depthcue check`.
- **`brand use <brand folder> <deck folder> [--force] [--json]`.** Copies `brand.json`, `templates/`, `fonts/`,
  `logos/` and `images/` as real files, never links; the import marker and anything else in the folder stay behind. A
  folder with a link in it, a name a brand cannot carry, more than 200 files or 64 MB is refused. The JSON goes in as
  `brand.set`, `style.set` and `template.set` operations against the deck's current revision through `saveDeckDir`, so
  a deck that changed meanwhile is refused (exit 3). A record, `brand/.depthcue-brand-use`, keeps a hash of every
  file, `[old, new]` while the copy is under way. Replacing a deck brand is refused when a recorded file differs from
  its record, a file was added, or there is no record at all, naming each file and why; `--force` replaces them and
  the result lists what it overwrote. A scene that uses a template the new brand lacks is refused with no override,
  naming the scene, the template and the `retemplate` operations to the kit template that leaves the fewest blocks
  unplaced; `--json` carries them with `unplaced`. A style a scene uses that the new brand lacks is a deck error and
  refused the same way, by the checks `apply` runs.
- **What `brand use` removes, and what it never does.** The review of the first version found ways it lost files or left
  a deck that did not check, and each is now a rule with a test (`brand-commands-safety.test.ts`,
  `brand-commands-failure.test.ts`).
  - _Never through a link._ A file of the old brand is removed only when no folder or name on the way to it is a link.
    A deck whose `brand/fonts` is a junction to a folder shared with other decks had that folder emptied, with
    `--force` too; now each file is kept and listed with why (`kept brand/fonts/X (is behind the link brand/fonts, so
    it was left where it is)`), and `--force` does not change that. A link on the way to a file the brand copies is a
    refusal as before.
  - _Letter case._ A deck on a computer that ignores case answers to `Bold.woff2` and `bold.woff2` alike. A file is
    compared with the record only under the letters it was written with, a file of the old brand whose lowercase
    name is a file of the new brand is never removed (it is listed as kept, `differs only in letter case from a file of
    the new brand`), and a file of the new brand that takes the place of one with other letters is written after the
    save and given the new letters, so `brand.json` and the font on disk agree. A brand folder that holds two names
    that differ only by case is refused by `brand check` (`brand-file-case`) and `brand use`. Before it says it is done,
    `brand use` checks that every file `brand.json` names is in the deck as the brand has it; a font renamed by case
    alone had left a deck that failed `depthcue check` and exit 0.
  - _Failure partway._ Everything before the save is done is put back if any step fails: the record, each font, logo
    and image, every JSON file the save wrote and the folders it made (`write-failed`, exit 2, nothing changed; it
    names any file it could not put back). A temporary file whose rename fails is deleted. After the save, a step that
    does not finish (a stale file that cannot be removed, the final record that cannot be written) is a warning
    `brand-use-incomplete` on a result that is `ok`; the review is still recorded, and the record still lists what was
    not removed, so the next `brand use` finishes it. The result is checked with `openDeck` last, and a deck that no
    longer passes is `incomplete` (exit 2).
  - _What an open review needs._ Files of the old brand that the new one lacks are removed (and their empty folders),
    unless changed since, when they are kept and listed with why. The review's baseline (`review.json`) holds the
    earlier brand, and a revert needs its fonts, logos and images; before, a revert of a brand replaced by `brand use`
    failed with `missing-brand-file`. Of the two ways to fix it, `brand use` now **keeps** the old brand's files that
    the baseline still names (`is named by the brand under review, which a revert brings back`) and leaves them in the
    record, so the next `brand use` after the review closed or moved on removes them. The other, putting them back
    on revert, would need the review code in the editor's script, which has 8 bytes of room. The result: `depthcue
    diff revert --all` after a `brand use` restores the old brand with its files. Known limit: after such a revert
    the record still describes the replaced brand, so the next `brand use` into that deck is refused for the files
    that differ until `--force`, once.
  - _Refused names._ `source.ts` refuses the Windows device names (`con`, `prn`, `aux`, `nul`, `com` or `lpt` and a
    digit, with or without an extension, any case) and names that end in a dot or a space, which a folder made on
    Linux holds and a Windows computer cannot. The 200 files and 64 MB caps are checked against the size on disk before
    a file is read.
- **Binary bytes and the revision.** Fonts, logos and images do not join the deck's revision: the revision guards edits
  by operation, no operation edits these files, the editor never holds their bytes, and assets are the same. What guards
  them is the record's hashes. A deck whose font was swapped by hand shows the same revision, and `brand use` still
  refuses to replace it. `brand use` records its change in the review as an agent write, as `apply` does.
- **`new <dir> [--brand <folder>] [--name <title>] [--json]`.** One deck and one scene, `opening`. With a brand, the
  folder is copied by the same code as `brand use` and the scene is put on the brand's `title` template, with a
  placeholder block (the slot's hint) in each other required slot; a title template that requires a picture, or a
  brand that hides the built-ins and has no `title`, is refused and no deck is left. No review is started.
- **The fixture.** `fixtures/decks/tidewell-press` (a made-up publisher, 11 scenes): its own `feature` template, its
  own `quote` over the built-in one, a `dateline` and `margin-note` style, two logos, an Instrument Serif display face
  and a Source Sans 3 body face (both OFL; the licence texts are in `brand/fonts/OFL.txt`, with the copyright line of
  each face as its name table has it), no mono face. The two logos have their words drawn as outlines of those faces,
  not as text in Georgia and Helvetica, so they look the same on any computer. It checks and renders with no finding on
  both presets.
- **`deck_get` is smaller.** With Depthcue's own templates and styles in every deck, the outline's kit was most of an
  answer. The short answer now lists the templates as `{ id, name }` (and `brand: true` on a brand's own) and the
  styles by id; the detailed answer has each template's description and slots (role, accepts, hint) and each style's
  name and kinds. For the `demo` fixture the short answer is 1,002 characters and the detailed one 7,105 (`getOutline`,
  `kitSummary` in `deck-api.ts`; `packages/cli/test/brand-commands-outline.test.ts`). The tool list is 11,997 of
  12,000 characters; the one sentence in `deck_get`'s description that named the slots now says `detailed adds slots`.
- **Revert writes the save layout.** A revert (and an accept) writes the files it changes in the layout `saveDeckDir`
  gives them, so a hand-formatted scene or template that a review reverts is rewritten in that layout. A file the
  review does not change keeps its formatting. Left as it is: the text is the same data.
- **Decisions the brief left open.** The record file's name and format; the transitional hashes; refusing a brand that
  does not pass `brand check`; refusing a brand folder with a link, and the 200 file and 64 MB caps; `use` is an agent
  write in the review and `new` is not; the suggestion for a missing template is the kit template with the fewest
  unplaced blocks; `--force` never lifts the missing-template refusal; `full-image`'s shape; the review's granularity
  (first one change for the whole file, now one per key, style and template); keeping the old brand's files for a
  review instead of putting them back on revert; the editor's built-ins as a second lazy chunk.
- **Outside the write-set.** `packages/cli/test/brand-import-command.test.ts` (the messages for `brand` with no
  subcommand and for `--name` on `brand import`); `packages/editor/src/store.ts` (waits for either lazy chunk);
  `packages/editor/test/{brandchecks,vite-config}.test.ts` and `packages/core/test/brand.test.ts`. In `index.ts`, which
  is in it, `report` and `summary` moved to `packages/cli/src/report.ts` (and are still exported from `index.ts`) so
  that `brand/check.ts` does not import `index.ts`, and `--brand`, `--force` and `--name` are read for `new` and
  `brand`, which is more than the usage text. Cleared in the fix round: `packages/editor/src/reviewbook.ts`,
  `packages/cli/src/deck-api.ts`, and one rule in `packages/player/src/player.css` after step 3 merged. Not cleared, and needed by the same change: the `deck_get` sentence in
  `packages/mcp/src/server.ts` and the test that reads the outline in `packages/mcp/test/server.test.ts`.
- **Risks for later steps.**
  - A logo in a bottom corner sits on the sources band; the checks do not flag it (the player places it).
  - An old layout scene under a brand with wider fonts can overflow: the demo deck's `trend` scene is 14 px over
    with Harbor's faces. `render` says so; `brand use` does not predict it.
  - Step 8 draws `deck/brand/<key>` and `deck/style:<id>` as their own rows; until then the editor shows each as
    "Deck, brand".
  - After a revert of a `brand use`, the next `brand use` into that deck needs `--force` once (the record describes the
    brand the revert took away).
  - `brand use` of a brand into a deck whose brand files have no record is refused until `--force`; a deck made by
    hand needs it once.

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
- **Picture slots and charts.** Since step 5, a template's picture slot fills its frame (`object-fit: cover`). The
  measure scales such a picture to fill and gives the frame as its `clip`, and the slide crops it there with its
  source rectangle, so PowerPoint's Crop gives the rest back. A video in such a slot is fitted inside the frame, all of
  it shown, and the report says so. A chart's box was the svg's, but the page keeps the plot's proportions at the svg's
  top left, so in a wide, short slot (Tidewell's statement template) the plot is a third of the slot's width and the
  native chart was stretched across all of it. The box is now the drawn plot and the words of the caption and legend,
  widened only as far as the chart's own title needs to stay on one line (LibreOffice wraps it at about four fifths of
  the chart's width). The native title is in the case it is written in, without the caption's capitals and letter
  spacing, as it has been since step 2.
- **Brand import's logo sizes and family names.** `SIZE_HEIGHTS` in `brand-import/logo.ts` is now 5%, 7.5% and 11%
  of the slide's height for `s`, `m` and `l`: the player draws them 2, 3 and 4.4 em high, and a scene's em is 2.5% of
  a 16:9 stage's height (a template scene's is 0.014 of its width, 2.49% of the height). Step 4's record gives the
  old 8% and 12%. A test reads `player.css` and fails, naming the table, when the two part. `brand-import/fonts.ts`
  checks a theme font's name with core's `FAMILY_PATTERN` instead of a copy, so a name with a control character is not
  used; the report quotes such a name as JSON, DEL included, so no control character reaches a terminal.
- **Checked.** Every file was opened in LibreOffice and turned to page images, one page per slide, compared with the
  player's: the brand deck, Tidewell Press (as it is and in picture mode), the demo, the demo in picture mode and with
  steps, v0-3 and the charts deck. LibreOffice draws the mono
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
  license allows it still puts a copy of the font in a file that travels; the report names each one. The MCP tool
  list is 13,118 of its 13,200 characters, so the next tool needs the limit raised.
- **Outside the write-set.** `packages/cli/package.json` (the `./export` and `./pptx` exports) and `vitest.config.ts`
  (their aliases), for the MCP tool; `tools/check-pptx-pages.mjs` and its `check:pptx-pages` script in the root
  `package.json`, which the review asked for; `brand-import/fonts.ts`, which the conductor asked for, and the tests
  of it and of the logo sizes (`brand-import-fonts.test.ts`, `brand-import-logo.test.ts`). `README.md` still says
  five MCP tools, for step 9.

## Step 7 record: the editor uses a brand

- **Room first.** The editor's script was 92,152 of 92,160 bytes. Four parts most sessions never open are now chunks
  fetched on first use, each with its own row: the review drawer and its view (`reviewdrawer.js`, 1,982 of 3,072), the
  storyboard (`storyboard.js`, 2,555 of 4,096), the comment pins and their thread (`commentpins.js`, 3,896 of 5,120)
  and the cue editor (`cuespanel.js`, 1,473 of 2,560). `packages/editor/src/lazy.ts` holds them: a part is fetched
  once, `mountEditor` takes others in its place so a test can hold one back or make it fail, a fetch that fails says
  "Could not load ... Check that depthcue edit is still running, then try again." where the person is looking, the
  editor goes on, and the next use tries again. What the person typed or chose is read after the part is in. Hide
  pins chosen before the pins part arrives holds once it does. The review button says it is busy (`aria-busy`) while
  its part loads, and a second press then does not cancel the first, so the drawer opens. The editor script is now
  88,664 with all of step 7, which leaves 3,496 bytes, and 424 above the 3 KB step 8 needs.
  `retemplate.ts` stays in the script: core's index exports it, and a chunk group that pulled it out pulled its
  imports with it.
- **The brand part.** Everything below is `branduse.js` (4,827 of 6,144), fetched with Depthcue's own templates and
  styles, since the picker, the slots and the styles list them; the part fails when they do not arrive. The script
  keeps only the hooks. It is fetched the first time a template scene is drawn (for its slots), a block's toolbar
  draws its Style chip, a right-click menu offers Style, or the picker or Change template is opened. A deck with no
  template scene opens without it. When it arrives after a block's toolbar is drawn, only the chip that waited for it
  is drawn again, so a field the person is typing in keeps its text and selection, and the cue count beside it is
  drawn again too. A right-click before it arrives shows "Loading the styles…" in the Style submenu, then fills the
  menu in place, keeping the open submenu and the focused item; a failed fetch says so there once and the next
  right-click tries again.
- **Template picker.** "From a template…" in the strip, the scene menu and the command palette ("Add scene from a
  template…"). A modal dialog named "Add a scene" lists the brand's templates under the brand's name, then "Built in"
  (none when the brand sets `hideBuiltIn`; one the brand replaces is listed once, as the brand's), then the three
  layouts. Each is a button named by its name and described by its description (`aria-labelledby`,
  `aria-describedby`), with a picture of the slide the player draws in the deck's look, with the template's
  background, chrome and its slots' hints. Arrow keys, Home and End move through them, Escape closes. A choice adds the
  scene with `scene.add` after the scene on show and goes to it. The new scene starts with one text, in the first slot
  that takes a heading, else one that takes text; a template with no slot for text gets it pinned near the top. A
  refusal is said in the dialog, which stays open. Opening a dialog that is already open replaces it, and closing the
  new one hands focus back where the first one would have.
- **Change template.** On a template scene the scene bar shows the template's name in place of the three layout
  buttons, so the bar is no wider, and pressing it opens the dialog. On a layout scene it is "Change template or
  layout…" in the Scene popover. It is also "Change template…" on the slide's and the scene's right-click menus and in
  the palette, and a layout chosen for a template scene from the right-click menu or the palette opens the dialog at
  that layout instead of moving blocks unseen. The dialog lists every template and layout, the current one marked
  "Now". Choosing one shows the slide as it will be, drawn by the player, under "Where each block goes" a line per
  block that a slot takes, and, under "Fits no slot", each block that fits none by name, with what happens to it: a
  block stays on the slide, pinned where it is now (its measured frame), to move or delete. A block is listed under
  one of the two, never both. The claim goes as core moves it, never as a block: it stays
  the scene's claim with its evidence links in a template with a claim slot; a layout that does not draw it leaves it
  in the scene, and the dialog says it will not show; a template with no claim slot is refused by core
  (`claim-without-slot`), so the change takes the claim off as the editor's own Remove does (out of the build order
  too), and the dialog names the claim, each block it links to as evidence, and the templates that would keep it
  ("To keep it, choose Statement, … or the layout Claim and evidence."). Required slots nothing fills are listed
  under "Left empty", and a refusal about one block, such as a contrast, names the block first. The operations are
  core's `retemplate`, the pins and that removal, applied as one step of Undo, so `depthcue apply` given them writes
  the same files.
- **Empty slots.** In the editor's canvas only, each empty slot of a template scene is a box at the slot's frame with
  its hint, "Required" on a required one, and an Add button (a menu of kinds when the slot takes more than one; a clip
  slot is off until the deck has a video). The boxes lie under the blocks (`z-index: -1` in an isolated scene), so a
  block pinned over an empty slot, or a text inside a slide-sized picture slot, takes the click and the slot takes the
  rest. A claim slot counts as filled when the scene has a claim. The add is `block.add` with the slot, as an agent
  writes it. Hints come from the deck's templates and Depthcue's own (`templatesOf`), never from `/look.json`. The
  strip's pictures, present mode, the exported page and the PowerPoint file never draw them, since only the canvas
  calls the hook.
- **Style menu.** The Style chip of a block's toolbar has the deck's styles for the block's kind after the text's own
  size, alignment and color, so the late list never moves a control the person is aiming at. The block's right-click
  menu has a Style submenu. Both list No style and each style for the kind (a brand override once; no Kicker on a
  quote), each drawn by the player as a sample "Aa" in that style, without the brand's chrome, the current one
  checked, and write `block.set` with `style`. A picture is 112 px wide, and its slide is that size too, so the sample
  is drawn at its true size and not as a whole slide scaled down: 13 CSS px times the style's own size, never under 12,
  the same for every kind, with the block across the picture and the slide's color round it, so the fill, edge,
  border, radius, face and tone show. In Chrome each picture's sample is measured at 12 px or more, its block at more
  than 80% of the picture's width and inside it, and No style, Callout, Quiet panel and Pull quote draw differently. After a choice the
  checks move in place, so focus stays on the item chosen; the pictures are drawn again only when the kind, the
  block's own color or the look they are drawn from changes, never while the person types. Once Depthcue's own are in,
  a block whose kind has no style gets no list. Given several blocks, `styleOps` styles each one the style is for and
  names the rest; the editor has no multiple selection yet, so it passes the one chosen block.
- **Lock.** A brand with `lock` turns off the Colors and Fonts controls of the Deck panel, each with the reason core's
  `checkBrandLock` gives for the refusal ("The brand "harbor" is locked, so the deck cannot set its own colors.").
- **Chrome.** The canvas already drew the brand's chrome after step 3, so this step adds the tests: nothing in it can
  be chosen, focused or dragged, a click on the footer chooses nothing or the block under it, and a drag snaps to the
  slide's safe margin under the footer, not to the chrome (snap targets are the slide's lines and the scene's blocks).
- **Fixed on the way: a branded deck that uses one of Depthcue's own styles did not open.** In a real browser the
  editor read the deck, waited for the brand checks, read it again, and stopped: only that second read reaches a style
  or template and finds Depthcue's own missing. `v0-4-brand` (its quote is a `callout`) said "The deck on disk does not
  pass validation." The store now waits for each chunk a read asks for, at most two, on open, on reload and on draft
  recovery (`store.ts`; `store-two-chunks.test.ts` fails with the old code). The unit tests had not caught it because
  they run core's modules, which wait for nothing.
- **Same files as an agent.** `packages/cli/test/editor-brand-use-e2e.test.ts`, in Chrome on copies of `v0-4-brand` and
  `v0-3`: a scene from the picker, Change template with a block that fits no slot, a block added from an empty slot,
  and a style from the menu each write the deck and scene files `depthcue apply` writes for the same operations,
  byte for byte (`review.json` aside). A deck with no brand gets "Built in" and "Layouts", drawn in its own action
  color and font pair, and its blocks get Depthcue's own styles. `v0-3` opened, browsed, with the picker, the Style
  menu and Change template opened and closed, is byte for byte the same with the same file times. The brand part and
  the built-ins chunk are each refused once (the message shows, the editor goes on, the next try opens the picker),
  and so is the storyboard.
- **Download PowerPoint.** "Download PowerPoint…" at the foot of the Deck popover and in the palette opens a dialog
  from `pptxdownload.js` (2,738 of 4,096), a part of its own; the main script holds the button, the command and the
  part's hook (185 bytes). The dialog offers "Each slide as one picture" (picture mode, off) and "Speaker notes" (on,
  "Anyone with the file can read them."), and calls step 6's `POST /_depthcue/api/export.pptx` with the editor's
  token and those two switches. The file is made from the deck on disk, so edits the autosave has not written yet are
  saved first; a save that fails, or files that changed on disk, are said and nothing is sent. While the file is made
  the dialog shows a progress bar and the seconds it has taken, Download is off and busy, and Cancel stops waiting.
  The browser saves the file under the server's name (its RFC 8187 `filename*`, so `<deck folder>.pptx`), and the
  dialog stays open with "Saved <name>, <size>, among your browser's downloads.", Save it again, and the export's
  report: what has no PowerPoint form, slide by slide (overflow past an edge is one of those lines), the lines for
  every slide, the fonts in the file and the ones a viewer needs installed, and the warnings. A refusal is said in
  the dialog in plain words: the server's own message, the deck's first three errors under a 422, "This depthcue
  edit cannot make PowerPoint files. …" for a server without the call, and "The editor could not reach the server.
  …" when it is gone. The editor writes nothing into the deck folder. In Chrome (`editor-brand-use-e2e.test.ts`):
  the Harbor deck's download equals `depthcue export --format pptx` beside the deck byte for byte, with the deck
  folder unchanged, file times included; picture mode with an edit typed just before it equals `--pictures` part for
  part (see Risks); and a refusal stays readable in the open dialog.
- **The report comes in a header.** Step 6's call sent the file and nothing else, so the export call in `serve.ts`
  (outside this step's files; the coordinator approved the change) now sends the summary `renderPptx` returns in an
  `X-Depthcue-Report` header: percent-encoded JSON, without `out`, and with no folder of this computer in it. The
  deck's folder is written `<deck>`, the player's `<player>`, the folder beside the deck `<beside the deck>` and the
  home folder `~`, in either slash, as a file URL and, on Windows, in any case. A report over 32 KB encoded keeps the
  counts and as many lines as fit, in the order the dialog lists them, with `shortened: true`, and the dialog then says
  "The full report is longer; run depthcue export --json to see all of it." The call stays same-origin: no CORS header
  is added, and it still needs the editor's token. A server without the header gets "This server sent no report with
  the file." `editor-brand-use-report.test.ts` checks the header against the summary, the labels (a font error that
  quotes a file's full path, a file URL, a path in upper case), a report of 400 slides cut to the limit and filled to
  within one line, and the live call: the header, no `access-control-*` header and no path. In Chrome the dialog lists
  every embedded family, every slide with something left out and each of its lines, as `depthcue export --json` gives
  them; the screenshot `download` is that.
- **Decisions.** The new scene goes after the scene on show; its first block is the template's heading slot's; the
  template's name takes the layout buttons' place in the scene bar, so the top bar keeps its width at 1024 (beside
  them it left the deck title 14 px wide); a layout chosen for a template scene opens Change template; the
  scene menu starts with Change template; a chosen block's Style chip fetches the brand part (the second fetch that
  `selectBlock` made is gone); the styles come after the text's own controls in the chip; No style is drawn as a plain
  block; a claim a new template cannot hold is taken off, named with its links, rather than the change refused;
  Download PowerPoint lives in the Deck popover and the palette (the top bar has no room at 1024), offers speaker
  notes beside picture mode, saves unsaved edits before it asks, and stays open after the download with the report.
- **Review fixes (of 812e364).** Each of the above that a review asked for has a test that fails on 812e364: two
  real-browser clicks on a block over an empty slot (a pinned chart, a title in a slide-sized picture slot), the
  claim's ops against core's and its links in the words, Left empty, the refusal's block name, focus in the Style list
  after a choice, no redraw while typing, the right-click loading state, two presses on Review, the replaced dialog's
  return, the picker's names, and the four changes a mutation pass found unguarded (Hide pins before the part, the
  claim filling its slot, Kicker on a quote, the late cue count).
- **Second review fixes.** The style pictures were a whole slide scaled to 80 px with the text about 5 px high, so
  Callout, Card, Pull quote and Quiet panel could not be told apart; they are now drawn at their true size (Style menu,
  above). Change template listed a block that fits no slot twice, once as pinned over the slide; it is now under
  "Fits no slot" only. The report is sent (above).
- **Risks.** Harbor's Quiet panel has Card's values, so their pictures are the same. Harbor has only a light logo, so on ink its word mark is dark on dark (the player's, from
  step 3). Step 8 has 424 bytes of the main script beyond its 3 KB. Picture mode is not byte-stable: two exports of
  `v0-3` with `--pictures`, one from the editor while its own Chrome ran, gave different PNGs for the chart slide
  (same parts otherwise, the pictures alike to the eye); three CLI runs alone gave the same bytes. Two tests this step
  does not change fail now and then in a full run: `edit-e2e`'s "moves freely while Alt is held", as step 6's record
  describes, and `chart-module-e2e`'s "does not move the page when it hydrates" (2 px, about one run in five alone).

## Step 8a record: brand operations and uploads

- **Slot operations.** `slot.add` (after a slot, or last), `slot.set` (a patch; null removes a field, `id` is refused
  with "Use slot.rename."), `slot.rename` (moves the blocks of every scene on the template; the result names the
  scenes it changed) and `slot.remove`. Remove is refused while the slot holds blocks, each named (`slot-in-use`),
  unless `to` names the slot they go to (its `max` and `accepts` hold) or is null, which pins each block at its old
  slot's frame. A built-in template is refused with the `template.set` call that copies it into the brand. The
  template is checked whole after each operation. Codes: `unknown-template`, `unknown-style`, `unknown-slot`.
- **Patch forms.** `template.set` and `style.set` take `set`: each key it names is replaced whole and null removes it;
  `id` (and a template's `schemaVersion`) cannot be set. The merged result is checked whole. The whole forms write
  the same bytes as before (tested).
- **Upload.** `POST /_depthcue/api/brand-file?kind=font|logo|image&name=<sent name>`, the raw file as the body, with
  the token and origin checks of the other write calls. The name is the base name only, with every run of other
  characters than `A-Za-z0-9._-` made one hyphen, leading dots and hyphens dropped, the stem cut at 100, and the
  extension of what the bytes are; Windows device names and names with no letter or digit are `bad-name`. Names
  compare without case: a file there in other letters is the same file and keeps its name. A font must be a font by
  its bytes and pass step 6's guard (`unpackFont`, `FONT_LIMITS`), have the `name`, `head`, `cmap`, `maxp` and `hhea`
  tables and outlines, and name a family. A WOFF or WOFF2 whose tables state over 1 MB and over 20 times the file's
  length is refused before it is unpacked: real fonts state at most 3.4 times. Step 6's four hostile fonts are each
  refused in under 200 ms, as a test holds, and the server keeps answering. Uploads and `brand add` are decoded one at a time, in the
  order they came. A logo is SVG or PNG, an image PNG, JPG, WebP or SVG, sniffed, within `MAX_ASSET_BYTES`. An SVG
  must be UTF-8 (a declaration may name no other encoding) with no NUL or other control character than tab, LF and
  CR, no DOCTYPE, entity or linked style sheet, parse as XML within 1 MiB and 20,000 elements with `svg` at its root,
  every element in the SVG namespace, and have no `script` or `foreignObject`, no `on*` attribute, no `href`,
  `xlink:href`, `src`, `srcset`, `action`, `formaction`, `data`, `poster`, `xml:base` or other loading attribute, no
  `url()` that does not start with `#`, no `image-set(` or `image(`, and no `@import`; a style element or attribute
  is at most 64 KiB, and `url(` is found by index, never a regular expression, with one left open refused. A MiB of
  open `url(` is refused in under 100 ms while a GET is answered (it took seconds before). Then step 4's check of
  imported SVGs runs too, whose `url()` search is the same scan now. An export leaves out, with a warning, a brand
  SVG this check refuses, whoever put it in the folder.
- **Writes and races.** The same bytes give back the existing path and write nothing (`written: false`). Other bytes
  under the name are `exists` (409, with the existing path) unless `replace=1` comes with `baseRev`, and a `baseRev`
  that is not the deck's revision is `stale` (409, with the revision now) and writes nothing. The file there under
  another case is compared by its bytes on disk, never by the listing; one whose name brand.json cannot take (such
  as `ARIAL.TTF`) is `exists`, "Rename or remove it first", and is never written over. A file is written to a
  temporary file at the deck's top (`wx`) and renamed into place, retried briefly, without blocking, on Windows'
  sharing errors; temporaries over ten minutes old are swept first. A brand folder that is a link, out of the deck or
  not, is refused. The answer is the path in `brand/`, `file` (the deck path, `brand/fonts/X.woff2`), `hash` (its
  SHA-256, which the revision counts), the kind, what was sniffed (format; a font's family, style, weight and italic;
  an SVG's element count), bytes, `written`, `replaced`, `prevRev` and `rev`, the revision read back after the
  write. Codes: `bad-request` and `bad-name` 400, `too-large` 413, `not-a-font` and `unsupported` 415, `unsafe-svg`,
  `unreadable-deck` and `linked-brand-folder` 422, `exists`, `stale` and `in-use` 409, `not-found` 404,
  `write-failed` 500.
- **Removal.** `POST /_depthcue/api/brand-file/remove` with `{path, baseRev}`. `baseRev` is required, since removing
  a file is a change to the deck. Refused while brand.json or a template names the file (`in-use`, each place as a
  file and a JSON pointer, compared without case), and for any path that is not a font, logo or image in `brand/`.
  The answer has `file`, `hash: null`, `prevRev` and `rev`.
- **CLI.** `depthcue brand add <file> <deck> --kind font|logo|image [--name] [--replace --base-rev] [--json]` and
  `depthcue brand remove <path> <deck> --base-rev [--json]` call the same code as the route, so the path, the bytes
  and the JSON are the same (tested byte for byte). Exit codes as `brand use` has them: 3 for `stale`; 2 for usage, a
  file that cannot be read, `unreadable-deck`, `linked-brand-folder` and `write-failed`; 1 for every other refusal.
  A file the CLI adds is the agent's change in review; one a person uploads in the editor is folded into the
  reviewed deck, as a save is.
- **The revision.** A deck with a brand counts its fonts, logos and images: the revision is the first 16 hex digits
  of SHA-256 over the JSON revision, a newline, and the canonical JSON of `{path: SHA-256 of the file}`. Only files
  brand.json could name count (`fonts/`, `logos/`, `images/` by their patterns), so `OFL.txt` and the record of
  `brand use` do not, nor do the files of a brand folder in a deck with no brand. The loader hashes a file once per
  change, cached by size, mtime, ctime and inode, and not cached at all while its times are under 3 s old, since a
  second write in the same tick of the clock keeps all four. The edit API sends the hashes in `text`, so the editor
  computes the same revision with no change of its own; every reader of `text` takes only the JSON paths it knows,
  so a hash is never parsed or written (`DeckFiles` says so, and a test holds each reader and the save route to it).
  A file replaced on disk makes the next save and the next apply stale.
  Unchanged: v0-1 `ec4e0cd5c59ef06a`, v0-2 `5ba3679835bdb955`, v0-3 `b2c39f24e9089ee9`, demo `eb9d45889adffe19`,
  charts `468152e3f5f8027b`, and the brand deck with its fonts and logo taken out `3b25c7e19e33f331`. Changed:
  v0-4-brand `325c6bcdb08ac4a2` to `3615e932844d6f4a`, Tidewell Press `d35e78e6dc040fbb` to `253f1a61dd25dc7c`.
  Opening Tidewell Press as the editor's `/deck` does, on this PC: 11.1 to 12.0 ms cold and a median of 3.0 ms warm,
  against 10 to 12 ms and 3.2 to 3.5 ms before; the hashing is within the noise.
- **Saved work.** A review.json from before has no `files`; its reviewed deck takes the folder's files as they are, so
  no file shows as a change, and the agent's next write records them and moves its revision to the new form. A
  pending agent change in such a review stays to accept or revert. A draft now holds the files' hashes. A draft from
  before is compared with the files now folded into its saved revision, so it recovers with no warning, and a hand
  edit since still warns. It cannot tell that a brand file was replaced while it waited, since it holds no hashes.
- **Review.** Each added, replaced or removed file is its own change, `deck/file:<path in brand/>`, by the agent or
  outside. Accept takes it. Revert never claims to restore the old bytes: it leaves the change and says why in `left`
  (`FILE_REVERT_REASON`; the CLI prints `left <id>: <why>`). A change whose reviewed value names a file that is gone
  (the agent un-named a logo and removed it) is left too, "brand/logos/dark.svg does not exist. Put the file back,
  then revert this change.", and the rest revert; `revertOps` gives the editor the same split as `[id, gone files]`.
  While either side has a brand the files compare as they are, so making a brand or taking it off lists no font
  already in the folder. Accepting a brand change that names a new file without the file's change is
  `missing-brand-file`, and the review API's hint names the file change to accept with it.
- **Contrast advice.** `palette-low-contrast` says to make a color lighter only when white would reach the minimum
  against the other color, darker only when black would, and when both would, the way it already leans, which is
  the nearer by contrast (`contrastWay`); both colors print in capitals. No color is out of reach both ways of a
  need under 4.58:1, so at 4.5 and 3 there is always a way; `contrastWay` says neither for a higher need.
- **MCP.** `deck_apply` describes the slot operations and `set`. Its copy of the operations schema leaves out the id
  pattern on every id and each operation's `type: "object"`, which `items` says; the core refuses a bad id with what
  an id is, and a test compares the copy with the schema. The tool list is 13,142 of its 13,200 characters,
  `deck_apply`'s description 971 of 1,100.
- **Sizes.** The editor's main script gains 1,488 bytes brotli from core (88,664 to 90,152 on step 7's editor), of
  the 1,500 the brief allows; two refusal fixes were shortened to stay inside it. No budget row moved.
- **Outside the brief's files.** `cli/src/loader.ts` (hashing), `cli/src/brand/use.ts` (brand use now records the
  files it copies, so its own save is not stale), `cli/src/index.ts` (the flags of brand add and remove, and revert's
  `left` lines), `cli/src/export.ts` and `core/src/style.ts` (asked for in review), and the MCP schema copy above.
- **For step 8b.** The upload route takes the raw file with `kind` and `name` in the query, and answers with the path
  to put in brand.json. An upload or removal changes the deck on disk, so run it as the store runs a save: one at a
  time with saves, and no `syncFromDisk` while it is out. On a good answer, call
  `session.brandFile(answer.file, answer.hash, answer)`: every undo state gets the file, the revisions move with it,
  and a session saved at `answer.prevRev` is saved at `answer.rev`, so it stays clean, while unsaved edits stay
  unsaved. Then take `answer.rev` as the disk's revision the next save names. A refused answer changes nothing. The
  session emits a `files` event; the History's steps are keyed by revision, which every revision's move breaks, so
  drop them on it. Taking `rev` without `brandFile` leaves the session a revision behind the disk, dirty after every
  save. Send `replace=1&baseRev=` only after asking the person. A removal needs the revision and is refused while
  anything names the file, so un-name it, save, then remove. Upload answers are the person's, so they never show in
  review. `sniffed` gives a font's family, style, weight and italic to check against the slot it fills. Tested over
  HTTP: upload, edit, save, an upload with unsaved edits, save, removal, reload, each leaving the session clean.

## Step 8b record: the editor defines a brand

- **The part.** The Brand panel, Save as template and the template editor are `branddefine.js` (14,944 of 16,384, a
  new row), fetched with Depthcue's own templates and styles and the brand checks. The main script holds the hooks:
  "Brand…" in the Deck popover and the palette, "Save as template…" in the Scene popover, the scene's and slide's
  right-click menus and the palette. A deck with no brand shows "Start a brand", which writes `brand.set` with the id
  and name the person gives. Every control writes one undo step.
- **Where it sits.** Down the right of the stage, with the slide moved over and still drawn as a slide at 1280 px.
  Under a 74rem window it is a drawer over the slide: Tab and Shift+Tab go round inside it, and Escape or a press
  outside it closes it and gives focus back to the Deck button. That press does nothing else, so the block under it is
  not chosen. The panel and the list of changes take turns at the right of the stage.
- **Logos.** The panel says where each logo shows, as the player draws it today, and when the brand has only a light
  logo it says that the logo draws with no plate on ink and can all but vanish, and asks for a dark one. "Choose a
  file…" (or "Another file…") sends an SVG or PNG to step 8a's route and names it for light or dark slides in one step,
  with the brand's name as alt text when there is none. Remove un-names it. "Files in the brand folder" lists the
  folder's logos and fonts; one that brand.json or a template names is "In use", and any other has Delete, which asks
  first, saves edits not yet saved and calls `/brand-file/remove` with the revision.
- **Fonts.** A built-in pair or the brand's own faces, each role a menu and each face shown in its own font with its
  license. "Add a font file" sends a WOFF2, WOFF, TrueType or OpenType file. The face takes the family the file names
  itself by, its weight to the nearest hundred and its style. A file of a family the brand has joins that face and
  keeps its license; a new family takes the License written beside the button (never filled in from other faces) and
  the role chosen ("Headings and text", "Headings", "Text", "Code and labels"). With no license the file stays in the
  folder and the panel says to write one and add it again. The first file makes the brand's own faces for headings
  and text, falling back on the deck's pair.
- **Colors, chrome, styles, templates.** Each swatch of paper and ink, and each chart color, is checked by the brand
  checks before anything is written; a refusal names the two colors and the contrast they reach. Chrome writes
  `brand.set` and the slide shows it at once. Styles list the brand's and Depthcue's (an override once), with Edit,
  Remove and "Copy into the brand"; the editor previews the style on a block of each kind in `for` on both presets.
  Each control writes the one key it changes with `style.set`'s `set`, and an empty one writes null. Templates show
  step 7's pictures, the name, the description and how many scenes use each; name and description go through
  `template.set`'s `set`. Remove is refused while a scene uses the template, naming the scenes.
- **Save as template.** Each block becomes a slot with its frame and a role from its kind; the person names the
  template, describes it and writes each slot's hint and whether it is required. The scene's background becomes the
  template's. Saving writes `template.set` and offers to put the scene on it through step 7's `retemplate`, so the
  blocks land in the slots they came from. On a deck with no brand it says a template belongs to a brand and offers
  to start one.
- **Template editor.** "Edit slots" turns the canvas into the template: slots are boxes with their names, dragged and
  sized with the blocks' snapping guides (Alt turns snapping off), and the arrow keys move the chosen slot (with Ctrl
  or Cmd they size it). The side panel writes the slot's role, the kinds it takes, hint, required, alignment and frame
  with `slot.set`, a new name with `slot.rename` (core moves the blocks that name it), a new slot with `slot.add`
  after the chosen one, and the template's background and chrome with `template.set`'s `set`. Remove is refused
  before core is asked while a block is in the slot, naming each block and its scene, with "Pin them where the slot
  was", which sends `slot.remove` with `to: null`. A strip of the scenes on the template is drawn again after each
  change. Done goes back to the scene.
- **Uploads and the store.** `store.brandFile` runs an upload or removal as a save runs: after any save in flight, one
  at a time, with no `syncFromDisk` while it is out (one asked for runs after). On a good answer it brings the review
  up to date, folds the file into what is on disk, takes `answer.rev` as the next save's base, and calls
  `session.brandFile`; the History drops its steps on the session's `files` event. A refusal changes nothing and is
  said at the top of the panel as the server words it; `exists` adds "Replace it", which sends the file again with
  `replace=1&baseRev=` the disk's revision. Unsaved edits stay unsaved through an upload, and an upload never shows
  in the review.
- **Review drawer.** Rows for `deck/brand/<key>` ("Brand colors", "Brand name"), `deck/style:<id>` ("Style:
  Kicker", only the properties that changed), `deck/template:<id>` ("Template: Cover", added or removed as its name
  and slot count) and brand files ("Font file Inter-Bold.woff2", "Logo file", "Image file", with the file's path in
  `brand/` added or removed, or "Replaced with other bytes", never the hash). Each has Accept and Revert. An accept or
  revert that core refuses for `unknown-template`, `unknown-style`, `no-brand` or `missing-brand-file` offers the
  changes to choose together, as the command line hints. A revert that leaves changes says why under the list in core's words
  (`FILE_REVERT_REASON`, or "brand/logos/dark.svg does not exist. Put the file back, then revert this change."),
  each after its row's name when more than one is left. `review.revert` answers with `left` only when some are.
- **Same files as an agent.** `packages/cli/test/editor-brand-define-e2e.test.ts`, in Chrome on copies of
  `v0-4-brand`, `tidewell-press` and `v0-3`: Start a brand, chrome, a style edit, Save as template with the scene put
  on it, and a slot moved, sized and renamed each write what `depthcue apply` writes for the same operations, byte for
  byte (`review.json` aside). A logo upload named for dark slides equals `depthcue brand add --kind logo` and the
  matching `brand.set`, with the same file bytes; a font upload equals `brand add --kind font` and the faces it makes,
  and the slide's stylesheet then loads the face from that file. The refusal of an SVG with an `onload` is the
  CLI's `--json` message word for word, and nothing is written. The Delete flow saves an edit made just before it.
  Old decks opened with the panel looked through are unchanged, file times included.
- **Decisions.** The License field is never filled in for a new family. The face's family is the one the file names
  itself by: the test font, Tidewell Text's file, names itself Depthcue Classic Sans, so its face is named that. An
  upload asks before replacing a file with other bytes, never otherwise. A press outside the drawer closes it and does
  nothing else.
- **Sizes.** The editor's main script is 91,048 of 92,160, 896 bytes more than 8a left it (90,152), of the 1,000 the
  brief allows. `branddefine.js` 14,944 of 16,384, `reviewdrawer.js` 2,868 of 3,072, `editor.css` 14,793 of 30,720.
  No limit moved.
- **Risks.** A brand face may take the name of one of Depthcue's own families, as the test font does; its rule then
  likely serves that name to the whole page, the editor's own text included (not seen in the screenshots, not
  tested). With a long status ("Saved. Updated from the files on disk.") the top bar runs past the window at 1024 px,
  and at 1280 px with the list of changes open, hiding Present; this step does not change the bar. `edit-e2e`'s
  "moves freely while Alt is held" still fails now and then, as before.

## Header and footer step 4 record: the contents block

A scene block of type `contents` (`of`: `sections` or `slides`) draws a table of contents. It lists the slides on the `section` template, or every slide with the sections on top. It is built from `look.outline` each time the slide is drawn, so it is right after a slide moves. Each entry links to its slide (`#/<id>`) and shows the number that slide has (`numbering.start` plus its place; a slide that shows no number still has one to turn to). The slide holding the block is left out. `check` warns with `contents-empty` and `contents-too-long` (more than 14 entries). A deck with a contents block needs schema 0.7. The PowerPoint export does not draw it yet (step 5).
