# Images

Status: approved 2026-11-04 with the recommended answer to each open decision (see the end), campaign
`depthcue-images`.

Goal: a person can add, crop, fit and place pictures on a slide the way they expect from PowerPoint, and can put a
picture behind a whole slide. An agent can add an image file and set the same properties through the same operations.
The PowerPoint export keeps every one of them.

## Today

- An image block has `asset`, `alt`, `caption`, `sourceIds`, `frame`, `slot`, `style` and `link` (`imageBlock` in
  `packages/core/src/schema.ts`).
- The player draws `<figure><img>` with `object-fit: contain`, at most 62% of the slide's height in a layout. A
  template's picture slot uses `cover`, always cut around the center (`packages/player/src/player.css`). Neither can
  be changed.
- The editor adds an image from the quick bar, the `I` key, an empty slot, a drop or a paste. The Edit popover changes
  the file, the alt text and the caption (`imagePanel` in `packages/editor/src/panels.ts`). A pinned image resizes as
  any frame does, in free proportions, so the picture letterboxes inside its box.
- Files come in only through the editor. `POST /_depthcue/api/asset` accepts PNG, JPEG, GIF, WebP or SVG without
  script, up to 15 MB, and names the file by a hash of its bytes (`packages/cli/src/edit-api.ts`). The MCP server has
  no tool that adds a file, so an agent can only name files already in `assets/`.
- A picture behind a whole slide comes only from a brand template's `background.image`, a file under `brand/images/`.
  A scene cannot set one from its own `assets/`.
- The PowerPoint export measures the page in Chrome and copies what it sees: `contain`, and `cover` as a source
  rectangle cut around the center (`pictureOf` in `packages/cli/src/pptx/measure.ts`).
- `depthcue check` reports a missing file. Nothing reports an unused file, a picture with too few pixels for its box,
  or a very large file.

## Contract (schema 0.6)

New optional fields on an image block:

- `fit`: `contain` (the whole picture shows, with empty room around it if its shape differs from the box) or `cover`
  (the picture fills the box and is cut to it). Left out, `contain`, except in a picture slot, where it stays `cover`.
- `crop`: `{ x, y, w, h }` in percent of the file's own width and height: the part of the picture that shows. It has
  the shape of a frame; `w` and `h` are at least 5, and `x + w` and `y + h` at most 100. PowerPoint's crop is the same
  rectangle (`<a:srcRect>`), so the export writes it unchanged.
- `focus`: `{ x, y }` in percent of the cropped picture: the point kept in view when `cover` cuts it. Left out, the
  center. It changes nothing under `contain`.
- `decorative`: `true` for a picture that carries no information, such as a texture or a mood photo. Its alt text may
  then be left out; the player gives it `alt=""`, the reading version leaves it out, and the export marks it
  decorative. On every other picture alt text stays required and the placeholder flag stays.

New optional field on a scene:

- `background`: `{ asset, scrim, color, focus, decorative, alt }`. A picture from `assets/` behind the whole slide,
  with a palette color (`bg` when left out, else one of the template background colors) laid over it at `scrim`
  percent, as a template background does today. A scene's background replaces its template's. `alt` is required
  unless `decorative` is true.

No new operations. `block.set` and `scene.set` carry the fields, so undo, the review drawer and stale-revision
refusal work as they do now. A scene becomes 0.6 when it gains one of these fields, as with earlier versions, and old
decks load unchanged. `assetRefs` in `packages/core/src/assets.ts` gains the scene background, so check, export and the
revert guard see it.

New checks:

- `image-crop-outside` (error): a crop that leaves the picture or is under 5% a side.
- No static scrim check. Text over a template's background image is checked today by measuring, not by a scrim level:
  the files alone get only the `background-unmeasured` warning (`brandcheck.ts`), and `depthcue render` photographs
  the page with its text made transparent and reports `background-low-contrast` for each line whose contrast on the
  pixels under it falls short of WCAG AA for its size (`layout.ts`). A fixed scrim level would refuse a dark picture
  that needs none and pass a busy one. Scene backgrounds get the same measured check in step 3, once the player draws
  them, with the message's fix naming the scene's scrim rather than the template's.
- `image-low-resolution` (warning): the box shows the picture at more than 1.5 times its own pixels on a 1920 by 1080
  slide. Only a drawn page knows the box, so it is a layout check: `depthcue render`, `deck_render` and the editor's
  layout checker report it from the `<img>` element's natural size and its box (step 3).
- `asset-unused` (info): a file in `assets/` that no block, source, link or background names.
- `asset-large` (warning): an image over 4 MB, which slows loading and grows exports.

## Steps (one merge each)

1. **Contracts.** Schema 0.6 with the fields and checks above, the version rules, the MCP tool descriptions, and
   tests that 0.1 to 0.5 decks load unchanged. Until step 3 the player ignores the new fields and draws as today. No
   editor work. Cod reviews this PR.
2. **Image intake for agents and the CLI.** One module, `packages/cli/src/images.ts`, holds the type check, the
   hashed file name, and a reader for a file's size in pixels from its header (PNG, JPEG, GIF, WebP, SVG), with no new
   dependency. The editor's upload route uses it and also returns the size. A new MCP tool `deck_asset`: `add` (a
   local file path, or base64 bytes and a name; returns `assets/<name>` with width, height and bytes), `list` (every
   file with its size and what names it), and `remove` (refused while anything names the file). `deck_get` reports how
   many assets the deck has. The CLI gains `depthcue asset add|list|unused|remove`. `depthcue check` runs
   `asset-unused` and `asset-large`. A path is read only if it is a regular file, through the
   same type check and size limit; SVG with script is refused. No download from a URL in this plan.
3. **Player and exports.** The player draws crop and focus with a clipping box around the `<img>` and CSS custom
   properties, which works in every browser (`object-view-box` does not). A scene background uses the existing
   `.dc-backdrop`. The reading version leaves decorative pictures out. The offline export copies background files.
   In PowerPoint, `pictureOf` reads the crop and the focus to place the source rectangle instead of assuming the
   center, a scene background becomes the slide's `<p:bg>` with its scrim, and a decorative picture gets an empty
   description and PowerPoint's decorative mark. Golden tests for a cropped picture, a focused `cover` and a scene
   background. Picture mode is unchanged. The layout check gains `image-low-resolution`.
4. **Editor: controls on the slide.** A chosen image's toolbar gains Fit or Fill, Crop and Reset. Crop mode, entered
   by the button or a double click, shows the whole picture dimmed outside the crop, with a handle on each edge and
   corner; dragging inside the crop moves the picture under it. Enter or a click outside commits one `block.set`
   (one undo step); Escape cancels. In crop mode the arrow keys move the chosen edge and Shift moves it further, and
   every handle has a screen-reader name. A pinned image keeps its proportions when resized, and Shift frees them;
   other blocks resize as now. A "Fit box to picture" command. The Edit popover gains a Decorative checkbox. The
   right-click menu and Ctrl K gain Crop, Fit, Fill, Reset picture, Use as slide background and Remove background.
   The scene's Layout popover gains a Background section: file, scrim and color.
5. **Editor: image library.** A popover from the Image button and from the Edit popover's file field shows each image
   in `assets/` as a thumbnail with its name, size in pixels, file size and the slides that use it. From it a person
   inserts, replaces, or deletes an unused file (with a confirmation). Dropping several files adds one block each, up
   to the scene's limit of 12 blocks. It uses step 2's list and loads as its own chunk.
6. **Close-out.** The demo deck uses a cropped photo, a focused picture in a picture slot, a scene background with a
   scrim and a decorative picture. Guides (`deck-format` from the schema, `editor.md`, `placement.md`, `export.md`),
   changelog, budgets, bench, and a walkthrough at 1440 and 1024 wide.

## How it runs

The steps run in waves, as in `docs/CONTENT_RANGE.md`:

- Wave A: 1 contracts and 2 intake. Both touch `packages/mcp/src/server.ts`; 2 adds a tool and leaves the existing
  descriptions to 1, and is brought up to date with main after 1 merges.
- Wave B: 3 player and exports, 5 image library.
- Wave C: 4 controls on the slide, which needs 3's drawing of crop and focus.
- Wave D: 6 close-out.

Roles are the same: Opus writes the briefs and reviews each diff and its screenshots, a Sonnet builder makes one step
in its own worktree and opens the PR without merging, the merge script merges on green CI, and Haiku reads red CI logs
and runs the survey after each wave.

## What holds for every step

- Agent parity: each new property has an operation path, an MCP description and a check, and a test shows that the
  editor and `depthcue apply` write the same files for the same change.
- Old decks load unchanged and are rewritten as 0.6 only when they use a new field.
- Each step adds its own e2e test file.
- A step is done when CI is green by commit on the PR and on main, its e2e test passes, and the screenshots were
  looked at.
- The plan has 6 steps. A 7th needs your OK; bugs found on the way get their own fix.

## Budgets

The main editor script is close to its 92 KB limit after the link work, so steps 4 and 5 put their code in chunks the
editor fetches on first use (crop mode and the scene background section in one, the image library in another, each at
most 4 KB Brotli) and add to the main script only the buttons and menu entries that load them. Step 1 records the
main script's size before this work; the main script may grow by at most 1 KB in all. The player script and styles
grow by at most 1 KB together, and core stays under its 60 KB limit. Reading image headers adds no dependency.

## Not in this plan

Rotation and flipping, opacity, color filters (grayscale, or a duotone from the palette), crop shapes such as a
circle, labels and hotspots on a picture, a build step that zooms into part of a picture, downloading an image from a
URL, generating images, editing pixels, and controls for animated GIFs.

## Decisions (2026-11-04)

Dimitri approved the recommended answer to each:

1. **Crop model.** `crop`, `fit` and `focus` (recommended: it matches PowerPoint's Crop, Fill and Fit, and the export
   is exact), or `fit`, `zoom` and `focus` only (two fields fewer, but no exact crop and no exact match in PowerPoint).
2. **Pictures behind a slide.** A scene `background` (recommended: one picture, a scrim the contrast check can read,
   no stacking order to manage), or a "behind" layer for pinned images (more freedom, but it brings back the stacking
   order that Content range left out).
3. **Download from a URL** in `deck_asset`: left out (recommended: no network access from the tool and no fetch
   rules to get right), or added now with https only.
4. **Zoom into part of a picture as a build step.** Later (recommended), or a 7th step here. It suits Depthcue's cue,
   but it is per-block animation, which Content range left out.

## Step 1 record: what the contracts fixed

- **Schema.** `SCHEMA_VERSIONS` ends in 0.6 and so does `BRAND_SCHEMA_VERSIONS`; the comment above it said a test kept
  it the tail of the list from 0.4, and none did, so `frames.test.ts` now does. `SCHEMA_VERSION`, what a new scene
  gets, stays 0.4. An image block gains `fit` (`IMAGE_FITS`), `crop`, `focus` and `decorative`. `crop` is the same
  schema object as `frame`, so its bounds are a frame's: x and y 0 to 100, w and h 5 to 100. `alt` left
  the block's `required` list: an `if` on `decorative: true` with an `else` that requires `alt` takes its place, and
  the `else` names `alt` under `properties` too, as Ajv's strict mode wants and the template slot already does. A scene
  gains `background` with the same `if` and `else`. The type generator does not follow `if`, so `alt` is optional in
  the `Block` type.
- **Diagnostics.** A missing alt on a picture or a background that is not decorative says `Missing "alt": a picture
  needs alt text unless it is decorative.`, and the fix gives both ways out.
- **Versions.** `IMAGE_KEYS` in `versions.ts`. Each of the four on an image block, and a scene's `background`, needs
  0.6; a scene is raised only when it gains one, and a scene below 0.3 has its text escaped on the way, as for every
  part since 0.3. A file that says an older version gets `crop-needs-version`, `background-needs-version` and so on.
  Deleting the field with null leaves the scene at 0.6: versions are never lowered.
- **Operations.** None added. `background` joined `SCENE_KEYS`, so `scene.set` writes it and review compares it.
  `block.set` already took the image fields, since it checks the block it makes against the block's schema.
- **Checks.** `image-crop-outside` is in `checkFrames`, beside `frame-off-slide`: one error per edge, at
  `/blocks/<i>/crop/w` or `/h`, with "Make w at most 70, or make x smaller." A crop under 5% a side is the schema's
  `too-small`. `assetRefs` names `/background/asset`, so `missing-asset`, export copying and the revert guard cover it.
  `hasPlaceholderAlt` is false for a decorative picture.
- **Contrast.** No `background-scrim-low` (see New checks). A scene background gets no `background-unmeasured` warning
  either: until step 3 nothing draws it, so there is nothing to measure. Step 3 adds the measured check for it.
- **Other packages.** The player and the reading version give a decorative image `alt=""`, whatever alt text it has.
  The editor copies a decorative image without alt as empty text and labels it in lists by its file name. In
  PowerPoint, pptxgenjs writes the file name into `descr` for an empty alt, so `describeShape` with empty text empties
  it again for a decorative picture; the decorative mark itself is step 3. Nothing draws fit, crop, focus or a scene
  background yet.
- **MCP.** `deck_get` names the image fields and the background in one sentence. `deck_apply`'s `scene.set keys`
  gained `background`, because its test requires every settable scene key there; nothing else in `deck_apply` changed.
  The tool list cap went from 13,800 to 14,000 characters.
- **Site.** `docs/IMAGES.md` is in `LEFT_OFF` in `site/prepare.mjs`, as the other build records are, so the site build
  passes. The deck-format tables say an image's `alt` is required "unless `decorative` is true": `fieldTable` in
  `site/lib.mjs` now reads an `else` that requires a field, where it would have said "no".
- **Editor coverage.** `scene.background` and the four image fields are `PENDING` for step 4.
- **Size.** The main editor script was 93,331 bytes Brotli before this step (91.1 KB of its 92 KB limit) and is
  93,752 after it: 421 bytes of the 1 KB this plan allows, which leaves 456 bytes under the limit. The player script
  grew 20 bytes.

## Step 3 record: the player and the exports draw them

- **How crop, fit and focus are drawn.** An image with none of `fit`, `crop` and `focus` is the `<img>` in its figure,
  as before (`scene.ts` `renderBlock`). With any of them the img sits in a stage inside a clipping box:
  `span.dc-crop` (`container-type: size`, clips) holds `span.dc-crop-in` (the stage, `data-fit` when the block names a
  fit) holds the img. The box carries the crop as unitless numbers (`--cx --cy --cw --ch`, the whole file when there is
  no crop), the focus (`--gx --gy`), and `--a`, the cropped part's width over its height, which `watchAspect` sets from
  the file's natural size once it loads. The stylesheet does the rest in container units, so no browser needs
  `object-view-box`: the stage is `min(100cqw, 100cqh * a)` wide for contain and `max(...)` for cover, is placed in the
  box at `focus` percent of the room left over (50 for contain, so focus changes nothing there), and the img is
  `10000% / cw` wide and `10000% / ch` tall inside it, shifted by `-cx / cw` and `-cy / ch`. A picture slot's cover is
  `.dc-slot[data-role="picture"] .dc-crop-in:not([data-fit])`, so a block that names a fit replaces it and a block with
  only a focus keeps it. Outside a slot or a frame the box has the cropped part's own shape and at most 62cqh of
  height, as a plain img does, so cover and contain look alike there. A pinned block's ghost gets the same `--a`.
- **Scene background.** `backdrop()` draws it as the template's: `assets/` through `assetUrl`, the scrim at `--scrim`
  percent from the stylesheet, `background-position` from `focus`, `data-image` and `data-bg` on the section (the
  scene's `color`, `bg` when left out), and it replaces the template's picture.
- **Background alt.** A non-decorative background's backdrop is `role="img"` with `aria-label` set to the alt, instead
  of `aria-hidden`; it is the section's first child, so a reader meets it first. A decorative one stays `aria-hidden`.
  The reading version leaves decorative images out (blocks and background) and shows a non-decorative background as the
  first figure of its scene, with the alt, at the whole file.
- **Export.** `assetRefs` already named the background, so `depthcue export` copies it; `images-export.test.ts` proves
  it with a deck whose only picture is a background and an unnamed file that stays out.
- **Layout checks.** `background-low-contrast` now says "scene's background picture" and names the scene's scrim when
  the scene has one (the measure itself is unchanged: it photographs `.dc-backdrop`). `image-low-resolution` (warning)
  uses `LOW_RESOLUTION_RATIO = 1.5`: for each visible raster image in a block (not SVG, not the brand's logo) the page
  reports the pixels of the file that show (natural size times crop fraction) and the size they are drawn at on a
  1920-px-wide slide, from the stage for a cropped picture and from the box and `object-fit` for a plain one; it
  warns when either direction is over 1.5 times, with the pixels needed in the fix.
- **PowerPoint.** The page is the measure, so the crop needed no new maths: `pictureOf` reads the img whole (it is
  drawn at the scale of the crop) and cuts it to the overlap of the stage and the clipping box, and `addPicture`'s
  existing source rectangle follows from that, for contain and for a focused cover alike. A scene background becomes
  that slide's `<p:bg>` (the page's composed JPEG, scrim included, at the focus) through `applySceneBackgrounds`, which
  runs with or without a master; it replaces the color the slide had. On a template scene the layout is planned from
  the template's first scene without its own background, so one scene's picture never lands in the layout the others
  share. `describeShape` with an empty text writes the decorative extension inside `p:cNvPr` (after any link) as well as
  `descr=""`. Picture mode is untouched and writes no background part.
- **Fixture and tests.** `fixtures/decks/images` is nine scenes on one 1,284-byte 300 by 300 PNG, a 3 by 3 grid of
  distinct colors written by `tools/make-images-fixture.mjs`. `packages/player/test/images.test.ts` (elements and
  numbers), `packages/cli/test/images-player-e2e.test.ts` (real Chrome: the color at the middle of the box says which
  part of the file is there, for a crop, a focused cover at the top and at the bottom, contain, a slot with and without
  a fit, a background's focus and alt, its contrast, the low-resolution warning), `images-pptx-e2e.test.ts` (the XML:
  `srcRect`, `p:bg`, the decorative extension, a template scene), `images-export.test.ts`, and additions to
  `layout.test.ts`. None depends on text size.
- **Not done.** The brand chrome on a template scene with its own background keeps what the layout drew (a logo plate
  chosen for the template's ground), and the editor does not offer the fields yet (step 4).
- **Size.** Player script 12,463 to 12,833 bytes Brotli (+370), player styles 5,930 to 6,171 (+241): +611 bytes of
  the 1 KB. The exported page script is 15,864 to 16,204 of its 16,384 limit.
