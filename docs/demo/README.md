# The demo video

`demo.mp4` is a 60-second, 1080p, silent video of Depthcue at work. [Kinescript](https://github.com/drknowhow/kinescript) renders it from `demo.json`, a scene that is generated from three things the repository already holds:

- `brand/tokens.json`, for the colors, type and spacing.
- `fixtures/decks/demo/`, the demo deck, whose demand scene is quoted on screen.
- `transcript.json`, what the built CLI printed when it ran `rev`, `apply`, a stale `apply`, `render` and `export` on a copy of that deck.

The footage in `assets/` is real. The slides come from `depthcue render`, the player and editor are screenshots of `depthcue serve` and `depthcue edit` in headless Chrome, and the exported page is the exported folder opened from disk. If the program changes, the video is meant to change with it.

## Rebuild it

Build the CLI first (`pnpm build`). Capture needs Chrome or Edge; set `DEPTHCUE_BROWSER` to use another browser. Rendering needs Kinescript; set `KINE` to its `kine` executable if it is not on the PATH.

```sh
pnpm demo:capture   # footage and transcript, into docs/demo/
pnpm demo:scene     # demo.json from the tokens, transcript and demand scene
pnpm demo:render    # demo.mp4, after `kine check` passes with no warnings
```

## What the tests guard

`tools/demo.test.mjs` fails when `demo.json` no longer matches its inputs, when the CLI prints something other than the recorded transcript, or when `demo.json` has changed since `demo.mp4` was rendered (`demo.sha256` holds the hash of the scene the video came from). Each failure names the command that fixes it. The `render` and `export` lines are not compared, because their sizes change whenever the player does.

## Limits

The video has no audio and its end card has no URL, because the repository is private. Add both before the first public release.
