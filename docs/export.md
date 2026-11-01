# Offline export

`depthcue export` turns a deck folder into a folder that opens by double-click. It needs no server, no network
and no install, so it works from a USB stick, from a mail attachment you unzipped, and in a room with no wifi.

```
depthcue export <deck-folder> [--out <dir>] [--no-notes] [--json]
```

It writes `<deck folder name>-export` in the current directory, or the folder you give to `--out`. Open
`index.html` in it. The command prints that path when it finishes.

## What is in the folder

| File               | What it is                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `index.html`       | The page. The whole deck is inside it as data.                                                      |
| `depthcue.js`      | The player and the chart, clip and table modules, in one script (13.3 KB Brotli).                   |
| `depthcue.css`     | The player's styles.                                                                                |
| `fonts/`           | The deck's font pair: `<pair>.css` and the font files it names. The other three pairs are left out. |
| `assets/`          | Only the files a scene names: images, clips and their posters, and source files.                    |
| `.depthcue-export` | A list of what the export wrote, so a later export can replace it safely.                           |

Assets that no scene names are left out, and the command lists them. A clip's cue map, the small file beside a
built clip that says where its parts begin, is put into the page and not copied.

Tables and charts need nothing extra. The player draws them from the deck's data as a real table and as SVG, so they
show in the export, in print and to a screen reader the way they do in `depthcue serve`. The fonts are loaded by
relative path, so the page keeps its look from a folder with no network. The pairs weigh 192 KB (editorial),
252 KB (modern), 293 KB (classic) and 262 KB (technical). See [Style](style.md).

## Why the page is built this way

Chrome will not load a module script from a page opened as a file, and it will not answer `fetch` for another
file in the same folder. Both are how the live player starts, so an export cannot use them. The page instead
holds the deck in a `<script type="application/json">` element and loads one classic script, which has every
module inside it. Nothing is requested except the page's own files and its assets, all by relative path, which is
also why the folder can be moved or renamed.

A deck with a bar chart, a clip or a table works the same as in `depthcue serve`: the modules start when a scene needs
them. They just come out of the one script instead of separate files.

## Notes

Speaker notes go into the page by default, because a person presenting offline wants them in the notes panel.
Anyone who has the folder can read them. If you are giving the folder to an audience, export with `--no-notes`.
The page then says "No notes for this scene." and no note text is in `index.html`.

## Exporting again

An export that you run again into the same `--out` replaces the earlier one. The command checks first, and only
touches files that the earlier export wrote:

- A new or empty folder is fine.
- A folder that has files in it and no `.depthcue-export` marker is refused, with nothing written or removed.
- Files you added to an exported folder are left alone. If one of them has the name of a file this export would
  write, the export is refused instead of overwriting it.
- Files an earlier export wrote that this one does not need, such as an asset no scene uses now, are removed,
  along with any folder that leaves empty.
- A folder inside the deck folder is refused, and so is one that contains it.

A deck with errors writes nothing and exits 1. Fix it with `depthcue check`, then export. The output is the same
bytes every time for the same deck, so an export can be committed or compared.

## Exit codes and `--json`

0 done, 1 the deck has errors, 2 the export could not run: the folder is not usable, or the player has not been
built. With `--json` the result is one object: on success, `out`, `index`, `scenes`, `assets`, `skipped`,
`cueMaps`, `notes`, `files`, `bytes` and any `diagnostics` (warnings); on failure, `ok: false` with a `code` and
a `message`.

## What an export does not have yet

- **No presenter view.** The second window talks to the first over a `BroadcastChannel`, which is not reliable
  between pages opened from files. See [the presenter view](presenter.md).
- **No live reload, no control lease.** Both need the server. An agent cannot be handed control of an exported
  page. See [the control lease](lease.md).
- **No single-file form.** The folder has several files, and videos stay as separate files because inlining them
  would double their size. A zip form for sharing is planned.
- **No PDF or PowerPoint.** Those are separate exports, planned for 0.7.

## What it costs

| File          | Budget  | Measured |
| ------------- | ------- | -------- |
| `depthcue.js` | 14.0 KB | 13.3 KB  |

The styles are the same file as the live player's, 4.7 KB. The budget is checked by `pnpm budgets`.

## How it is tested

`packages/cli/test/export.test.ts` covers what goes in the folder, notes, clips and their cue maps, escaping of
the title and the data, a deck with errors, each place the export refuses to write, exporting again, and that two
exports are identical. `export-command.test.ts` covers the command's output, `--json`, the exit codes and which
flags it accepts. `packages/player/test/standalone.test.ts` covers the page's script: it shows the deck from the
data, makes no request for it, and says what is wrong when the data is missing or in a format it does not know.

`export-e2e.test.ts` opens exported folders from `file://` in headless Chrome with the network off. Anything that
is not a file request is blocked and counted, and any console error fails the test. It checks the first scene,
keyboard moves and the address, an image, the chart and a clip's chips, the notes with and without `--no-notes`,
the reading view, a folder copied somewhere else, and a title written to break out of its script tag.
