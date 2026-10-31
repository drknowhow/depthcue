# Clips

A clip is a short video made from a [Kinescript](https://github.com/drknowhow/kinescript) scene and shown
in a deck. `depthcue clip build` renders the scene and writes a small cue map next to the video. The player
reads the cue map and puts one button under the clip for each part of the scene, so a presenter or an agent
can jump to "the title" or "the voice-over" instead of dragging a slider.

Depthcue does not depend on Kinescript. It runs the `kine` program you already have. A deck with clips in it
plays without Kinescript installed, because the video and the cue map are ordinary files.

## Quick start

```sh
pip install kinescript
depthcue clip build my-deck scenes/intro.json
```

```
Built assets/intro.mp4: 4.2 s, 1920x1080, 3 cues, 6.1 s with kinescript 1.2.0.
  poster assets/intro.png
  cues   assets/intro.cues.json
Add it to a scene as a block: {"type":"clip","source":"assets/intro.mp4","poster":"assets/intro.png","alt":"..."}
```

Put that block in a scene, give it an `id` and a real `alt`, and run `depthcue serve my-deck`. The chips
appear under the video once the cue map has loaded.

## What gets written

All three files go in the deck's `assets/` folder, named after the scene file (`Intro Title.json` becomes
`intro-title`) or after `--name`.

- `<name>.mp4`: the video.
- `<name>.png`: a poster taken halfway through, so the clip shows the scene before anyone presses play.
- `<name>.cues.json`: the cue map.

The build renders into a temporary `assets/.building-*` folder and moves the files into place only when all
of them exist. The cue map moves last, so a build that was stopped half way never looks finished. The
temporary folder is removed whether the build succeeds, fails or is interrupted.

## The cue map

```json
{
  "format": "depthcue-cues/1",
  "source": "assets/intro.mp4",
  "duration": 4.2,
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "cues": [
    { "id": "dot", "type": "circle", "in": 0, "out": 1.1 },
    { "id": "voice", "type": "audio", "in": 0.4, "out": 3.9 },
    { "id": "title", "type": "text", "in": 1, "out": 4.2 }
  ],
  "build": {
    "key": "9f2c…",
    "kinescript": "kinescript 1.2.0",
    "quality": "standard",
    "scale": 1,
    "scene": "intro.json"
  }
}
```

A cue is a top-level layer or a sound of the scene. A layer that has a parent moves with the parent, so it
does not get its own cue. Cues are sorted by start time, a repeated id keeps its first entry, and there are at
most 64. Times are seconds from the start of the video.

The player checks every field when it reads the file. A cue it cannot use is skipped. A file it cannot parse,
or one with no usable cues, leaves the clip as a plain video and sets `data-cues="none"` on the block.

The file sits next to the video under the video's name with `.cues.json` in place of the extension, so a clip
block needs no extra field to find it. You can write a cue map by hand for a video Kinescript did not make.
Leave `build` out. Do not run `clip build` with the same name afterwards, because it will replace the file.

## Rebuilding

`clip build` skips the render when nothing changed. The check is a hash of the cue map format, the `kine`
version, the quality, the scale, the scene file, and the bytes of every file the scene refers to that exists
next to it. Changing a picture or a sound rebuilds the clip even if the scene file is the same. If the video
or poster is missing, it rebuilds.

## Flags

| Flag                              | Meaning                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `--name <id>`                     | File name for the clip. Lowercase letters, digits and hyphens.                         |
| `--quality draft\|standard\|high` | Passed to `kine render -q`. Default `standard`.                                        |
| `--scale <0.1-1>`                 | Shrinks the render. `--quality draft --scale 0.5` is the fast way to try a scene.      |
| `--kine <path>`                   | The Kinescript program to run. Falls back to `DEPTHCUE_KINE`, then `kine` on the PATH. |
| `--json`                          | Prints one JSON object, for a program reading the result.                              |

Exit codes follow the rest of the CLI: 0 done, 1 when `kine` ran and failed, 2 when the build could not run
(no `kine`, a bad scene file, a bad name). Press Ctrl+C to stop; the running `kine` is killed and no file is
left behind.

## In the player

Each chip is a button labelled with the cue's id and start time. Pressing one jumps the video to that cue,
starts it playing and announces "Playing from <id>." for screen readers. While the video plays, the chip for
the latest cue that has started and not ended is marked `aria-current="true"`. The row scrolls sideways when
it is longer than the clip.

The row's space is reserved before the cue map loads, so the chips appearing does not move the page. If there
turn out to be no cues, the space is given back.

Turn the module off for a deck with `"modules": { "clip": "off" }` in `deck.json`, or use the module field in
the editor's deck settings. The block then shows as a plain video. The module's code is a separate file
(`clip.js`, under 3 KB compressed) that loads only for a scene that has a clip.

## For agents

The module registers three commands on every clip block that has cues:

```js
window.depthcue.invoke("intro-clip", "seek", { cue: "title" }); // jump, stay paused
window.depthcue.invoke("intro-clip", "play", { cue: "title" }); // jump and play; cue is optional
window.depthcue.invoke("intro-clip", "pause");
```

`invoke` returns `true` when the command ran. It returns `false` when the clip has no cues, the module has not
loaded for the block yet, or the command failed. A cue id that does not exist is a failure: the page logs a
console warning that lists the ids that do exist. Read them from `assets/<name>.cues.json` before the session.
Wait for `window.depthcue.settled()` after a scene appears, so the module has had its turn to load.

## Not yet

- Hotspots and steps that start a clip at a cue. A step cannot name a cue today; the chips and commands are
  the only way in.
- Cues for single words of a narration. The map has layers and whole sounds.
- Building without `kine`. If it is missing the command says how to install it and exits 2.
