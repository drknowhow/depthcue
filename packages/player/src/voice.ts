import { type Scene, splitMarks } from "@depthcue/core";
import { type Line, lineAt, linesFromText, linesFromWords, readMarks, readWords } from "./captions.ts";
import { assetUrl } from "./safe.ts";

const AUTO = "depthcue.voice.auto";
const CAPTIONS = "depthcue.voice.captions";

/** A stored on/off choice, or the default when nothing was stored or storage is closed. */
function remembered(key: string, otherwise: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? otherwise : stored === "1";
  } catch {
    return otherwise;
  }
}

function remember(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // Private windows and blocked storage: the choice lasts until the page closes.
  }
}

/** How often the clock is read while a recording plays, for the captions and the marks. `timeupdate` is too coarse. */
const TICK_MS = 100;

/** What the controls and the presenter's window show about the voice-over. */
export interface VoiceState {
  /** The scene on screen has a recording. */
  available: boolean;
  playing: boolean;
  /** The recording played to its end. */
  ended: boolean;
  /** The browser refused to start the sound because nothing has been pressed yet. */
  blocked: boolean;
  /** The voice leads: a scene's recording starts by itself, its marks move the slide, and its end moves on. */
  auto: boolean;
  captions: boolean;
}

export interface VoiceOptions {
  /** The state changed: a button should be redrawn. */
  onChange(): void;
  /** The caption to show changed. Undefined means none. */
  onCaption(text: string | undefined): void;
  /** The recording passed its `step`th mark (counting from 1). Only while the voice leads. */
  onMark(step: number): void;
  /** The recording ended. Only while the voice leads. */
  onEnd(): void;
}

export interface Voice {
  /** Plays the scene's voice-over, or stops the one that was playing when the scene has none. */
  attach(scene: Scene | undefined, assetBase: string, readJson: (path: string) => Promise<unknown>): void;
  state(): VoiceState;
  readonly available: boolean;
  readonly blocked: boolean;
  auto: boolean;
  captions: boolean;
  /** Plays, or starts again from the top when the recording has ended. Call it from a press. */
  start(): void;
  /** Pauses what plays, and plays what is paused. */
  togglePause(): void;
  /** Stops and releases the audio. */
  dispose(): void;
}

/**
 * Reads a scene's `voiceover.audio` while the scene is on screen. The audio is a plain asset written by
 * `depthcue voice build`; a scene without it, or one whose path is unsafe, stays silent. A browser refuses to
 * start sound before the visitor has pressed something, so a deck that opens on a voiced scene reports `blocked`
 * and the player offers a Play button; once anything has been pressed, later scenes start by themselves.
 * Captions come from the word times next to the audio, or from the text when there are none. The marks in that
 * file say when each step of the scene shows.
 */
export function createVoice({ onChange, onCaption, onMark, onEnd }: VoiceOptions): Voice {
  let audio: HTMLAudioElement | undefined;
  let playing: string | undefined;
  let auto = remembered(AUTO, true);
  let captions = remembered(CAPTIONS, false);
  let blocked = false;
  let lines: Line[] = [];
  let marks: number[] = [];
  let passed = 0;
  let shown: string | undefined;
  let script = "";
  let clock: ReturnType<typeof setInterval> | undefined;

  const stopClock = () => {
    if (clock !== undefined) clearInterval(clock);
    clock = undefined;
  };

  const caption = () => {
    const text = captions && audio ? lineAt(lines, audio.currentTime)?.text : undefined;
    if (text === shown) return;
    shown = text;
    onCaption(text);
  };

  const tick = () => {
    caption();
    if (!audio || !auto) return;
    // A recording started again from the top passes its marks again.
    while (passed > 0 && (marks[passed - 1] ?? 0) > audio.currentTime) passed -= 1;
    while (passed < marks.length && (marks[passed] ?? Number.POSITIVE_INFINITY) <= audio.currentTime) {
      passed += 1;
      onMark(passed);
    }
  };

  const setBlocked = (next: boolean) => {
    if (next === blocked) return;
    blocked = next;
    onChange();
  };

  const run = (element: HTMLAudioElement) => {
    void Promise.resolve(element.play()).then(
      () => {
        if (element === audio) setBlocked(false);
      },
      (error: unknown) => {
        // Only a refusal for want of a press is worth a prompt. A play cut short by the next scene is not.
        if (element === audio && (error as { name?: string } | null)?.name === "NotAllowedError")
          setBlocked(true);
      },
    );
  };

  const stop = () => {
    stopClock();
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load?.();
    }
    audio = undefined;
    playing = undefined;
    blocked = false;
    lines = [];
    marks = [];
    passed = 0;
    caption();
  };

  const state = (): VoiceState => ({
    available: playing !== undefined,
    playing: Boolean(audio && !audio.paused && !audio.ended),
    ended: Boolean(audio?.ended),
    blocked,
    auto,
    captions,
  });

  return {
    state,
    get available() {
      return playing !== undefined;
    },
    get blocked() {
      return blocked;
    },
    get auto() {
      return auto;
    },
    set auto(next: boolean) {
      if (next === auto) return;
      auto = next;
      remember(AUTO, auto);
      onChange();
    },
    get captions() {
      return captions;
    },
    set captions(next: boolean) {
      if (next === captions) return;
      captions = next;
      remember(CAPTIONS, captions);
      caption();
      onChange();
    },
    start() {
      if (!audio) return;
      if (audio.ended) {
        audio.currentTime = 0;
        passed = 0;
      }
      run(audio);
      onChange();
    },
    togglePause() {
      if (!audio) return;
      if (audio.paused || audio.ended) this.start();
      else {
        audio.pause();
        blocked = false;
        onChange();
      }
    },
    attach(scene, assetBase, readJson) {
      const path = scene?.voiceover?.audio;
      const url = path ? assetUrl(assetBase, path) : undefined;
      // The editor re-renders the scene on every change; the same recording keeps playing through that.
      if (url && url === playing) return;
      stop();
      if (!url) return;
      const element = document.createElement("audio");
      audio = element;
      element.preload = "auto";
      element.src = url;
      playing = url;
      script = splitMarks(scene?.voiceover?.text ?? "").spoken;
      const ifCurrent = (fn: () => void) => () => {
        if (element === audio) fn();
      };
      element.addEventListener(
        "play",
        ifCurrent(() => {
          stopClock();
          clock = setInterval(tick, TICK_MS);
          onChange();
        }),
      );
      element.addEventListener(
        "pause",
        ifCurrent(() => {
          stopClock();
          tick();
          onChange();
        }),
      );
      element.addEventListener(
        "ended",
        ifCurrent(() => {
          stopClock();
          tick();
          onChange();
          if (auto) onEnd();
        }),
      );
      for (const event of ["timeupdate", "seeked"]) element.addEventListener(event, ifCurrent(tick));
      // Without word times the captions are spread over the recording, which needs its length.
      let timed = false;
      element.addEventListener(
        "loadedmetadata",
        ifCurrent(() => {
          if (!timed) {
            lines = linesFromText(script, element.duration);
            caption();
          }
        }),
      );

      const wordsPath = scene?.voiceover?.words;
      if (wordsPath && assetUrl(assetBase, wordsPath)) {
        void readJson(wordsPath).then(
          (data) => {
            if (element !== audio) return;
            marks = readMarks(data);
            const words = readWords(data);
            if (!words || words.length === 0) return;
            timed = true;
            lines = linesFromWords(words, script);
            caption();
          },
          () => {
            // No word times: the captions are spread over the recording instead, and no mark moves the slide.
          },
        );
      }
      if (auto) run(element);
      onChange();
    },
    dispose() {
      stop();
    },
  };
}
