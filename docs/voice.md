# Voice-over

A scene can have a voice-over: text that Kokoro reads aloud. `depthcue voice build` makes the audio and writes it into
the deck's `assets/` folder next to the scene's other files.

Depthcue does not bundle Kokoro. It runs the `kokoro` Python package as a separate program. A deck that has voice-over
plays and exports without Python, because the audio is an ordinary WAV file.

## Quick start

```sh
pip install kokoro soundfile
depthcue voice doctor
```

Kokoro needs Python 3.10 to 3.12 and `espeak-ng` on the PATH. Point to a Python that has them with `--python <path>`
or the `DEPTHCUE_PYTHON` variable. `voice doctor` says which modules that Python cannot import.

Give a scene a voice-over, for example with `depthcue apply` or in the scene file:

```json
{ "op": "scene.set", "id": "opening", "set": { "voiceover": { "text": "Channel B now leads, sixty to forty." } } }
```

Then build it:

```
$ depthcue voice build my-deck
Voiced opening: assets/opening.voice.wav, 3.4 s, af_heart, 5.2 s to make.
Up to date: demand. Nothing was made again.
```

`depthcue voice build my-deck opening --voice bf_emma` builds one scene with another voice.

## The voiceover field

| Field   | What it is                                                                          |
| ------- | ----------------------------------------------------------------------------------- |
| `text`  | What is read aloud, up to 4,000 characters. It is not the speaker notes.            |
| `voice` | A Kokoro voice such as `af_heart`, the default. `--voice` replaces it for one run.  |
| `audio` | Written by `voice build`: `assets/<scene>.voice.wav`.                               |
| `words` | Written by `voice build`: `assets/<scene>.voice.words.json`, the time of each word. |
| `key`   | Written by `voice build`: a hash of the text and voice that made the audio.         |

`voice build` skips a scene whose `key` still matches its text and voice and whose files are there. Changing the text or
the voice makes the next build read that scene again. The scene is saved through the same checks as `depthcue apply`,
so a deck that passed `check` still passes.

## The word times

```json
{ "format": "depthcue-words/1", "duration": 3.4, "words": [{ "text": "Channel", "start": 0.12, "end": 0.55 }] }
```

Times are seconds from the start of the audio. The helper reads them from Kokoro's English pipeline; if a voice gives none, the
list is empty.

## Moving the slide with the voice

Write `{step}` in the text where the next step of the scene should show:

```json
{ "voiceover": { "text": "Channel B overtook A last quarter. {step} The gap is still widening. {step} Here is why." } }
```

Kokoro does not read the marks. `voice build` finds the word after each mark and writes the time it is said, 0.1 s
early, as `marks` in the word times file. Mark N shows step N. A scene can have no more marks than steps, and `voice
build` says so if it has. Mark every step you want the voice to show: a step with no mark stays hidden until you press
Next.

```json
{ "format": "depthcue-words/1", "duration": 6.8, "words": [], "marks": [2.1, 4.4] }
```

## Exit codes and `--json`

0 done, 1 Kokoro failed, 2 it could not run: Python is missing, Kokoro is not installed, the deck has errors or a name
is wrong. With `--json` the result is one object: `ok: true` and `scenes`, one entry per scene with `scene`, `voice`,
`audio`, `words`, `built`, `duration` and `seconds`; or `ok: false` with a `code` and a `message`.

## In the player

A scene with a recording plays it when the scene shows, and stops when you leave. Three small buttons sit together in
the controls on those scenes:

- Play or pause (`p`) stops and restarts this scene's recording. After the recording ends it replays it.
- CC (`c`) shows captions at the foot of the slide. They follow the word times, with the script's own punctuation, and
  when a scene has no word times they are spread over the recording by the text.
- Auto (`a`) lets the voice lead. With it on, each scene's recording starts by itself, its marks show the steps, and a
  beat after it ends the deck moves to the next scene, so you do not press Next. With it off, nothing starts or moves
  until you press Play, and Next works as before.

Pausing holds the slide where it is. Next, Previous and the other keys work at any time, and the recording of the scene
you land on takes over. Captions and Auto are remembered in the browser. The reading view is silent.

A browser refuses to start sound before you have pressed anything, so a deck that opens on a voiced scene shows a Play
voice-over button over the slide until you press it. After that the rest of the deck runs by itself.

The presenter view has the same three controls beside the timer, and the `p`, `c` and `a` keys, with a line saying
whether the recording is playing, paused, finished or waiting for a press. The sound plays in the deck window, where the
audience is; the presenter's window only asks that window. If the deck window has had no press yet, the browser may
refuse, and the presenter view says to press Play there.

## In the editor

The Script button in the bar under the slide opens a drawer at the right of the stage, with the slide still in view. It
holds the speaker notes, the reading version and a Voice-over part: the text, the voice (any Kokoro voice name; common
ones are suggested), a Make audio button and a player for the result. Typing changes the scene as any edit does.

Insert {step} mark puts a step mark at the cursor, so you do not type the tag. It counts the marks against the scene's
steps, and is off when every step has one or the scene has none. Escape closes the drawer.

Make audio saves the deck first, then runs the same build as `voice build` for that scene on the machine that runs
`depthcue edit`, and reads the new audio back. It takes several seconds, the first time longer while Kokoro loads. If
Kokoro is not installed, the panel says so with the same message as `voice doctor`. Set `DEPTHCUE_PYTHON` before
starting `depthcue edit` to use a Python other than the one on the PATH.

The mark by the Voice-over title tells where the recording stands: a tick when the audio matches the text and voice, an
exclamation mark when either has changed since, a dot when there is a voice-over with no audio yet. Remove audio takes
the recording off the scene and leaves the text. The file stays in `assets/`.

The audio is a change by the person, so the review does not list it as the agent's.

## In the exports

- **Folder and zip** (`depthcue export`, and HTML in the editor). The recording is copied with the other assets, and the
  word times and marks go into the page, so the captions and the marks work from a double-click with no server.
- **Video** (`depthcue export <deck> --format mp4`, and Video in the editor). Each scene is pictures of the player with
  the recording under them. Mark N brings in step N at the time it is said; the last picture of a scene shows every step,
  since nobody can press Next in a video. A scene with no recording stays up for five seconds. The file is 1920x1080
  H.264 with AAC sound. It needs Chrome or Edge, as `render` does, and `ffmpeg` on the PATH (or `DEPTHCUE_FFMPEG`).
  `--captions` (the Captions box in the editor) draws the captions the player shows, cut and timed the same way, over the
  bottom of the slide. Without it the video has none.

## Not yet

The PowerPoint export does not carry the audio; it would need AAC in the file. The video has no transitions between scenes.
