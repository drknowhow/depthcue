# Style

A deck's look has three parts: a preset (Paper or Ink), a palette of changes to the preset's colors, and a font pair.
Colors are named, never written as hex on a block. A block says its text is Muted or Action, and the deck says what
those look like, so one change restyles every slide. Setting the look needs a deck at schema 0.3; the first change
upgrades the deck file, and each scene upgrades when it needs to.

## Open the style

Open the Deck popover in the top bar and look for the Style section. The right-click menu of an empty part of the slide
has Deck style, and the palette has "Open the deck style".

## Preset

The Preset menu has Paper (light) and Ink (dark). The preset sets all seven colors, and a deck with no palette looks
exactly like its preset.

## The seven colors

Each swatch changes one color of the preset. Reset all colors puts the preset back.

| Swatch             | What it colors                                                                    | Paper     | Ink       |
| ------------------ | --------------------------------------------------------------------------------- | --------- | --------- |
| Background         | The slide                                                                         | `#F5F2EA` | `#0C0E12` |
| Panels and cards   | The evidence panel beside a claim, image frames, chips, the row marked in a table | `#FBF9F4` | `#161A21` |
| Lines and borders  | Table row lines, chart axes and grid, panel borders                               | `#D8D3C4` | `#2A303A` |
| Text               | Headings and body text                                                            | `#14161B` | `#F2EFE6` |
| Muted text         | Captions, small labels, source lines, the Muted tone                              | `#4B505B` | `#A5ABB8` |
| Accent             | The bar beside a quote, the dot on a title slide, the Action tone, chart series 2 | `#C73A18` | `#FF633F` |
| Evidence and links | Links, the Evidence tone, chart series 1                                          | `#2B55E6` | `#7C9BFF` |

The file calls them `bg`, `surface`, `line`, `text`, `muted`, `action` and `evidence`. Accent is `action`, which is also
the name the Color menu uses for the tone.

## Why a color is refused

Text has to stay readable, so a color that would leave it hard to read is not accepted. The editor refuses it at the
swatch and says why, and the deck keeps the palette it had. The rules are WCAG 2 contrast ratios:

- Text, Muted text and Evidence and links need 4.5 to 1 against Background and against Panels and cards, because the
  player draws body text, captions and links in them.
- Accent needs 3 to 1, the least WCAG allows for large text. A block that colors small text with it needs 4.5 to 1,
  and is refused otherwise. A heading, or text set to Large or Extra large, counts as large.
- Lines are not text, so they are not checked.

To go dark, choose Ink first and then change colors. Making Background dark on Paper is refused, because the text
colors on it would vanish, and switching preset is refused when a color you changed would be unreadable on the other
one. The message names both colors, their values and the ratio, and says which one to move.

## Font pairs

The Fonts choice has four pairs. Each is made of open-license fonts (SIL Open Font License 1.1) that travel with the
deck, so the slide looks the same on a machine that has none of them.

| Pair                | Headings               | Body                  | Where the fonts come from                                                                              |
| ------------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| Editorial (default) | Instrument Serif       | Space Grotesk         | The two fonts as released, cut down to Latin letters.                                                  |
| Modern              | Inter                  | Inter                 | Inter as released, cut down to Latin letters.                                                          |
| Classic             | Depthcue Classic Serif | Depthcue Classic Sans | Adobe's Source Serif 4 and Source Sans 3, cut down and renamed, because the license reserves "Source". |
| Technical           | IBM Plex Sans          | IBM Plex Sans         | IBM's own files, unchanged.                                                                            |

All four set small labels and source lines in IBM Plex Mono, which is also IBM's own files. The fonts cover Latin
letters, and text in another script is drawn in the viewer's own font.

The widths differ. A heading or claim that just fits one pair can wrap in another, so run `depthcue render` after a
change (the editor's problem ribbon does it for the files on disk) and shorten the line if it reports overflow.

## Tone, size and alignment

Choose a text block and open Style on its toolbar:

- **Size.** Small, Medium (the default), Large or Extra large. They scale the role's size by 0.8, 1, 1.3 and 1.7. Large
  and Extra large also have a minimum size, so they stay large text in a small block.
- **Align.** Start, Center or End. Start and End are the side the language begins and ends on: left and right for English.
- **Color.** Default, Text, Muted, Action or Evidence. Default takes the setting off, so the block follows its role.

The same three are submenus of the block's right-click menu. For a few words, select them and press a color dot in the
format bar (see [The editor](editor.md#formatting-text)); pressing it again takes it off. A scene written before schema
0.3 upgrades itself the first time you set one of these on a block.

## What an export carries

The page holds the deck as data, with the preset, the palette and the font pair named in it, and the player draws the
look from them. The folder gets `fonts/<pair>.css` and the font files of the deck's pair, and none of the other three.
The pairs weigh 192 KB (Editorial), 252 KB (Modern), 293 KB (Classic) and 262 KB (Technical). Every file is loaded by
relative path, so the export still opens from a folder with no network. See [Offline export](export.md).

## For an agent

`deck.set` writes the preset, the palette and the fonts, and `block.set` writes a block's tone, size and align. This
sets the technical pair, two palette colors, and a muted, extra large, centered line on the demo's opening slide:

```json
[
  {
    "op": "deck.set",
    "set": { "fonts": "technical", "palette": { "action": "#B3261E", "evidence": "#1F4BCC" } }
  },
  {
    "op": "block.set",
    "scene": "opening",
    "id": "opening-sub",
    "set": { "tone": "muted", "size": "xl", "align": "center" }
  }
]
```

```sh
depthcue apply my-deck ops.json --base-rev "$(depthcue rev my-deck)"
depthcue check my-deck
depthcue render my-deck
```

`apply` lists `scenes/opening.json` and `deck.json` as written, and `deck.json` is now 0.3. `check` prints
`0 errors, 0 warnings`, and `render` reports every scene as `ok`. The values are `theme` of `paper` or `ink`, `fonts` of `editorial`, `modern`, `classic`
or `technical`, `tone` of `text`, `muted`, `action` or `evidence`, `size` of `s`, `m`, `l` or `xl`, and `align` of
`start`, `center` or `end`. A palette color is a six-digit `#rrggbb`.

`deck.set` replaces `palette` as a whole, so send every color you want to keep: a second call with only `action`
drops the `evidence` from the first. `"palette": null` and `"fonts": null` go back to the preset and the default pair.

A palette that fails the contrast rules is rejected and nothing is written. This example sets the text color to
the Paper background:

```json
[{ "op": "deck.set", "set": { "palette": { "text": "#F5F2EA" } } }]
```

```
"text" (#F5F2EA) on "bg" (#F5F2EA) has a contrast of 1:1, under the 4.5:1 that text needs.
  fix: Make "text" darker until the two reach 4.5:1.
"text" (#F5F2EA) on "surface" (#FBF9F4) has a contrast of 1.06:1, under the 4.5:1 that text needs.
  fix: Make "text" darker until the two reach 4.5:1.
Rejected (invalid-deck); nothing was written. 2 errors, 0 warnings
```

`apply` exits with 1. With `--json` the codes show: `palette-low-contrast` for a palette and `tone-low-contrast` for
a block whose small text takes a tone that is too faint. A `palette`, `fonts`, `tone`, `size` or `align` written by
hand into a file that says 0.1 or 0.2 is a `palette-needs-version`, `fonts-needs-version`, `tone-needs-version`,
`size-needs-version` or `align-needs-version` error. Remove it and set it again with `apply`, which writes the file
as 0.3.

## Related guides

- [The editor](editor.md): formatting text, and the right-click menu.
- [Tables and charts](tables-and-charts.md): how charts take their colors from the palette.
- [Offline export](export.md): what the folder holds.
