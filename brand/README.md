# Brand

The tokens, the mark and the fonts that Depthcue's own pages use. `tokens.css` and the SVGs are generated, so edit
`tokens.json` or `tools/brand.mjs` and run the command; do not edit them by hand.

| File                                         | What it is                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tokens.json`                                | The design tokens in DTCG form. The one file to edit for color, type, space and motion. |
| `tokens.css`                                 | The same tokens as CSS custom properties. `pnpm tokens` writes it.                      |
| `mark.svg`, `mark-on-dark.svg`               | The mark alone, for a favicon or an avatar.                                             |
| `logo.svg`, `logo-on-dark.svg`               | The mark and the name.                                                                  |
| `social-card.svg`, `social-card-on-dark.svg` | The 1280 by 640 card a link preview shows.                                              |
| `fonts/`                                     | Instrument Serif, Space Grotesk and IBM Plex Mono, each with its SIL Open Font License. |

`pnpm brand` draws the six SVGs with `tools/brand.mjs`, from `tokens.json` and the font files in `fonts/`.
`pnpm check:generated` fails if any of them is out of date, as it does for `tokens.css`.

## The mark

Three planes recede up and to the right. Each one behind is smaller and fainter than the one in front, which is the
depth cue the name points at. The front plane carries the cue dot, in the vermilion `#FF633F` that the tokens
reserve for the cue. The planes behind are cut where they are covered, so the mark has no background and sits on
any surface.

- Use the `-on-dark` files on a dark surface and the others on a light one. Do not recolor them.
- The smallest size is 16 px, where the planes behind blur into a faint edge and the dot is a pixel or two. Below
  32 px use `mark.svg` alone, not the logo.
- Keep clear space around it of at least a quarter of its width.
- Never crop it. With the back planes cut off at an edge, it reads as the handle of a bag.
- Letters are outlines, so an SVG looks the same without the fonts installed.

The cue dot is 6.1:1 against the plane in the light mark and 2.6:1 in the dark one, below the 3:1 that WCAG asks of
a graphic that carries meaning. A logo is exempt, and the SVG carries `aria-label="Depthcue"`, but do not reuse the
dark pairing for a control or a state.

## Type

Instrument Serif for headlines and the name, Space Grotesk for interface text, IBM Plex Mono for ids, cues and data.
All three are under the SIL Open Font License 1.1. The license texts in `fonts/` must stay beside the font files.

## Social preview image

GitHub takes the repository's social preview as a PNG that someone uploads in the repository settings. Render
`social-card.svg` at 1280 by 640 and upload the result; the repository does not keep a PNG, because a PNG drawn by a
browser differs from one machine to the next and could not be checked for staleness.
