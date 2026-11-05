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

## Exit codes and `--json`

0 done, 1 Kokoro failed, 2 it could not run: Python is missing, Kokoro is not installed, the deck has errors or a name
is wrong. With `--json` the result is one object: `ok: true` and `scenes`, one entry per scene with `scene`, `voice`,
`audio`, `words`, `built`, `duration` and `seconds`; or `ok: false` with a `code` and a `message`.

## Not yet

The player does not play the audio, the editor has no voice panel, and the exports do not carry it. Those are the next
steps; the PowerPoint export will need AAC, so it will also need `ffmpeg`.
