# Plan: headers, footers, slide numbers and contents

Status: proposal. Nothing here is built.

## Goal

A deck can carry a header and a footer on every slide, each with text, the slide number, the section name and the
date, and can build its own table of contents that stays correct when slides move. The person sets this in the editor.
An agent can read what the audience sees on any slide and set all of it with the operations it already has.

## What exists

- `brand.chrome` (packages/core/src/schema.ts): `logo`, `footer {text, place}`, `number {place}`, `accent`. The footer is
  one fixed line along the bottom, `place` is `start`, `center` or `end`, and a footer and a number in the same place
  share a cell.
- The player draws it in `renderChrome` (packages/player/src/scene.ts). The number is the scene's position, from
  `RenderContext.number`. The chrome is `aria-hidden`.
- A template may set `chrome` to `full`, `minimal` (logo only) or `none`. A scene cannot.
- The Brand panel has a Chrome section for these (packages/editor/src/brandpanel.ts). An agent writes them with
  `brand.set` (`chrome`).
- PPTX export writes the footer and the number as master placeholders (`ftr`, `sldNum` field) in
  packages/cli/src/pptx/master.ts. A brand import reads the same two placeholders (brand-import/master.ts).
- The built-in `section` and `agenda` templates exist. The agenda is typed by hand, so it goes stale when slides move.
- Links to a scene exist (`RenderContext.scenes`).

## What is missing

1. No header. The footer is one line of fixed text.
2. The number cannot be formatted ("5 / 12"), cannot start elsewhere, and cannot be hidden on the title slide except
   through a template.
3. No fields: total, section, slide title, date.
4. No sections. Nothing knows which part of the deck a slide is in.
5. No contents. The agenda template is hand-typed.
6. A scene cannot turn the chrome off for itself.
7. An agent cannot see what text a slide shows in its header or footer, and nothing checks it.

## Design

### 1. One resolver in core

`resolveChrome(deck, scene)` in packages/core gives the text of each zone for one slide. The player, the PPTX export,
the thumbnails, `deck_get` and `check` all call it, so they cannot disagree about what a slide says.

### 2. Header and footer with zones

`brand.chrome.header` and `brand.chrome.footer` each take up to three zones, `start`, `center` and `end` (these follow
the deck's language, as `place` does today). A zone is a short string with fields in braces:

| Field | Value |
|---|---|
| `{number}` | The slide's number. |
| `{count}` | The number of slides. |
| `{section}` | The name of the section the slide is in. |
| `{title}` | The slide's title. |
| `{deck}` | The deck's title. |
| `{date}` | The deck's date, a fixed text. |

A zone is at most 120 characters. An unknown field is a `check` error naming it. A field with no value (a slide before
the first section) leaves its zone empty.

Old decks keep working. `footer {text, place}` and `number {place}` stay valid, and one function reads them as zones.
`brand.set` writes the new form once the person edits it. The schema change is additive and every new key is optional.

### 3. Numbering

`deck.numbering`: `start` (the first slide's number, default 1) and `skip` (template ids that show no number, for
example `title` and `section`). A skipped slide still counts, as in PowerPoint, so the next slide's number does not
change. A scene may also set `chrome` to `full`, `minimal` or `none`, the same values a template takes, and it wins
over the template. That is the per-slide "hide header and footer".

### 4. Sections

A scene whose template is `section` starts a section, named by its title. Every slide after it belongs to that section
until the next one. No new field on the scene. Recommended over an explicit `section` field because the deck already
says where its parts begin, and one source cannot disagree with itself. The cost is that a brand which renames the
template loses it; the brand check reports that.

### 5. Contents

A new block type `contents`: it lists the deck's sections (or every slide), each with its number and a link to the
slide. The player builds it from the deck, so it is correct after any move. Settings: `of` (`sections` or `slides`),
`depth` and a heading. It is a real list with real links, not decoration, so a screen reader reads it. More than one
slide's worth of entries is a `check` warning that says to split it.

An "Insert contents" action adds a slide on the `agenda` template with a contents block in its items slot.

The PPTX export writes the entries as text with their numbers, linked to their slides, because PowerPoint has no live
contents.

### 6. Editor

- The Brand panel's Chrome section becomes Header and footer: two bands with three inputs each, a chip for each field
  that inserts it, and a line that shows what slide 1 would say.
- A Slide numbers switch for the common case: it sets the footer's `end` zone to `{number}`.
- Numbering: start at, and "not on title and section slides".
- Scene inspector: a Show header and footer control for the slide.
- Add slide menu: Insert contents.
- The editor's main script is 97.2 of 99.0 KB, so everything new is a lazy part, as the Settings dialog is.

### 7. Agent

No new tool. Every write is an operation the agent has: `brand.set` (`chrome`), `deck.set` (`numbering`), `scene.set`
(`chrome`), and the block operations for `contents`.

What is new is seeing it:

- The `outline` view of `deck_get` gives each slide its `number`, `section` and the resolved text of its header and
  footer, so the agent reads what the audience reads.
- `deck_render` already draws it.
- `check` reports: an unknown field, a number on a slide that skips it, a zone too long for its width, a pinned block
  inside the band, a contents block with no sections, and a contents block too long for one slide.
- The MCP tool descriptions are near their size limits (`deck_get` under 1100 characters, all tools under 15900), so
  the guidance goes into the server's instructions and docs/, not into more description text.

### 8. PPTX

- `{number}` becomes the `slidenum` field in the footer placeholder, as it is now.
- `{date}` becomes the `dt` placeholder.
- `{section}`, `{title}` and `{deck}` cannot be fields, so they are written as text on each slide, as the footer text
  already is.
- PowerPoint has no header placeholder on slides, so the header is drawn on the master as plain shapes.
- A brand import reads `ftr`, `sldNum` and `dt` into zones and reports any extra text it cannot place.

## Order of work (one PR each)

1. Core: the resolver, the fields, header and zone schema, legacy reading, `deck.numbering`, `scene.chrome`, sections,
   `check` rules, tests, docs. No visible change yet.
2. Player: draw the header and the zones, the numbering and the per-slide switch. Stylesheet, thumbnails, presenter.
3. Editor: the Header and footer panel, chips, preview, numbering, the per-slide control. A lazy part, with a budget.
4. Contents: the block in core and the player, the links, Insert contents, `check`.
5. PPTX export and brand import.
6. Agent: the outline fields in `deck_get`, the server instructions, a walkthrough that has an agent set up numbering
   and a contents slide on a copy of the demo deck.

## Tests

- Resolver: every field, a slide before the first section, a skipped slide, `start` above 1, a legacy footer and
  number reading as zones.
- Player: the same deck gives the same text in the DOM, the thumbnail and the PPTX.
- Editor: chips insert at the cursor, the preview matches the player, the per-slide control writes `scene.chrome`.
- Contents: it follows a `scene.move` and a `scene.remove`, and its links land on the right slides.
- Agent: `deck_get` outline text equals the player's text for every slide of the demo deck.
- Right-to-left deck: `start` and `end` swap.

## Risks and decisions

- Sections by template or by field. Recommended: by template (above). A field is more explicit and costs a schema key
  and an editor control.
- Contents as a live block or as a generated slide of text. Recommended: the live block. A generated slide is simpler
  and goes stale, which is the problem with the agenda today.
- `{date}` as fixed text or today's date. Recommended: fixed. A clock makes the same deck render differently on
  different days, and the audit and revision checks assume it does not.
- Long text in a zone overlapping its neighbour. The zones share the band's width in thirds; `check` warns when text
  will not fit, and the player ellipsizes rather than overlaps.
- A brand with `lock` set cannot have its chrome changed by the person; the panel must say so, as the other sections do.
