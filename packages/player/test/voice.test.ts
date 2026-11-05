// @vitest-environment happy-dom
import type { Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPlayer, type Player } from "../src/player.ts";
import { demoSource } from "./helpers.ts";

let host: HTMLElement;
let player: Player | undefined;
let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
let elements: HTMLAudioElement[];

beforeEach(() => {
  history.replaceState(null, "", "/");
  try {
    localStorage.clear();
  } catch {}
  elements = [];
  // A stand-in element that keeps a paused flag, so the player can tell playing from paused.
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLAudioElement) {
    Object.defineProperty(this, "paused", { value: false, configurable: true });
    if (!elements.includes(this)) elements.push(this);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLAudioElement) {
    Object.defineProperty(this, "paused", { value: true, configurable: true });
    this.dispatchEvent(new Event("pause"));
  });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  player?.destroy();
  player = undefined;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const words = {
  format: "depthcue-words/1",
  words: [
    { text: "One", start: 0, end: 0.3 },
    { text: "two", start: 0.3, end: 0.6 },
    { text: "Three", start: 2, end: 2.4 },
  ],
  marks: [1, 2.2],
};

/** The demo deck with a recording on its first scene and on `demand`, which has two steps. */
function mount(extra: Record<string, Partial<Scene>> = {}) {
  const source = demoSource();
  source.scenes = source.scenes.map((scene, index) => {
    const voiced =
      index === 0 || index === 1
        ? {
            ...scene,
            voiceover: {
              text: index === 1 ? "One two. {step} Three. {step}" : "Hello.",
              audio: `assets/s${index}.voice.wav`,
              words: `assets/s${index}.voice.words.json`,
            },
          }
        : scene;
    return { ...voiced, ...(extra[scene.id] ?? {}) } as Scene;
  });
  source.files = { "assets/s0.voice.words.json": words, "assets/s1.voice.words.json": words };
  player = mountPlayer(host, source, { reducedMotion: true });
  return player;
}

const group = () => host.querySelector<HTMLElement>(".dc-voice") as HTMLElement;
const pauseButton = () =>
  host.querySelector<HTMLButtonElement>("[data-action='voice-pause']") as HTMLButtonElement;
const captionsButton = () =>
  host.querySelector<HTMLButtonElement>("[data-action='voice-captions']") as HTMLButtonElement;
const autoButton = () =>
  host.querySelector<HTMLButtonElement>("[data-action='voice-auto']") as HTMLButtonElement;
const prompt = () =>
  host.querySelector<HTMLButtonElement>("[data-action='voice-start']") as HTMLButtonElement;
const captionBox = () => host.querySelector<HTMLElement>(".dc-captions") as HTMLElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const key = (name: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
const at = (element: HTMLAudioElement, seconds: number) => {
  element.currentTime = seconds;
  element.dispatchEvent(new Event("timeupdate"));
};
const refused = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));

describe("voice-over in the player", () => {
  it("plays the scene's recording and shows the controls only where there is one", () => {
    const p = mount();
    expect(play).toHaveBeenCalledTimes(1);
    expect(group().hidden).toBe(false);
    p.go({ scene: 2, step: 0 });
    expect(group().hidden).toBe(true);
    expect(pause).toHaveBeenCalled();
    p.go({ scene: 1, step: 0 });
    expect(play).toHaveBeenCalledTimes(2);
    expect(group().hidden).toBe(false);
  });

  it("stays silent in the reading view", () => {
    const p = mount();
    play.mockClear();
    p.setMode("read");
    expect(group().hidden).toBe(true);
    expect(captionBox().hidden).toBe(true);
  });

  it("keeps the same recording playing when the deck is updated", () => {
    const p = mount();
    play.mockClear();
    const next = demoSource();
    next.scenes = next.scenes.map((scene, index) =>
      index === 0 ? { ...scene, voiceover: { text: "Hello.", audio: "assets/s0.voice.wav" } } : scene,
    );
    p.update(next);
    expect(play).not.toHaveBeenCalled();
  });

  it("ignores an audio path that is not a safe asset path", () => {
    const source = demoSource();
    source.scenes[0] = {
      ...(source.scenes[0] as Scene),
      voiceover: { text: "Hello.", audio: "https://example.com/x.wav" as never },
    };
    player = mountPlayer(host, source, { reducedMotion: true });
    expect(play).not.toHaveBeenCalled();
    expect(group().hidden).toBe(true);
  });
});

describe("pause, captions and auto", () => {
  it("pauses and plays from the button and the p key, and says which it will do", () => {
    const p = mount();
    expect(pauseButton().dataset.state).toBe("playing");
    expect(p.voiceState().playing).toBe(true);
    pauseButton().click();
    expect(p.voiceState().playing).toBe(false);
    expect(pauseButton().dataset.state).toBe("paused");
    expect(pauseButton().getAttribute("aria-label")).toBe("Play voice-over");
    key("p");
    expect(p.voiceState().playing).toBe(true);
    expect(pauseButton().getAttribute("aria-label")).toBe("Pause voice-over");
  });

  it("replays from the start once the recording has ended", () => {
    const p = mount();
    const el = elements[0] as HTMLAudioElement;
    Object.defineProperty(el, "ended", { value: true, configurable: true });
    Object.defineProperty(el, "paused", { value: true, configurable: true });
    el.currentTime = 6;
    el.dispatchEvent(new Event("ended"));
    expect(p.voiceState().ended).toBe(true);
    expect(pauseButton().getAttribute("aria-label")).toBe("Replay voice-over");
    pauseButton().click();
    expect(el.currentTime).toBe(0);
  });

  it("turns auto off from the button and the a key, remembers it, and then waits to be played", () => {
    const p = mount();
    expect(autoButton().getAttribute("aria-pressed")).toBe("true");
    autoButton().click();
    expect(autoButton().getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("depthcue.voice.auto")).toBe("0");
    play.mockClear();
    p.go({ scene: 1, step: 0 });
    expect(play).not.toHaveBeenCalled();
    expect(group().hidden).toBe(false);
    pauseButton().click();
    expect(play).toHaveBeenCalledTimes(1);
    key("a");
    expect(autoButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the caption for the moment of the recording, with the script's punctuation", () => {
    mount();
    return settle().then(() => {
      const el = elements[0] as HTMLAudioElement;
      expect(captionBox().hidden).toBe(true);
      expect(captionsButton().getAttribute("aria-pressed")).toBe("false");
      captionsButton().click();
      expect(captionsButton().getAttribute("aria-pressed")).toBe("true");
      // Scene 0 says "Hello." for three timed words, so the spoken words are used as they came.
      at(el, 0.4);
      expect(captionBox().hidden).toBe(false);
      expect(captionBox().textContent).toBe("One two");
      at(el, 2.1);
      expect(captionBox().textContent).toBe("Three");
      key("c");
      expect(captionBox().hidden).toBe(true);
      expect(localStorage.getItem("depthcue.voice.captions")).toBe("0");
    });
  });

  it("spreads the text over the recording when there are no word times", () => {
    localStorage.setItem("depthcue.voice.captions", "1");
    const source = demoSource();
    source.scenes[0] = {
      ...(source.scenes[0] as Scene),
      voiceover: { text: "Hello there.", audio: "assets/a.wav" },
    };
    player = mountPlayer(host, source, { reducedMotion: true });
    const el = elements[0] as HTMLAudioElement;
    Object.defineProperty(el, "duration", { value: 10, configurable: true });
    el.dispatchEvent(new Event("loadedmetadata"));
    at(el, 1);
    expect(captionBox().textContent).toBe("Hello there.");
  });
});

describe("the play prompt", () => {
  it("is offered when the browser holds the sound back, and starts it when pressed", async () => {
    play.mockImplementationOnce(refused);
    mount();
    await settle();
    expect(prompt().hidden).toBe(false);
    prompt().click();
    await settle();
    expect(play).toHaveBeenCalledTimes(2);
    expect(prompt().hidden).toBe(true);
  });

  it("goes away once the next scene starts by itself", async () => {
    play.mockImplementationOnce(refused);
    const p = mount();
    await settle();
    expect(prompt().hidden).toBe(false);
    p.go({ scene: 1, step: 0 });
    await settle();
    expect(prompt().hidden).toBe(true);
  });

  it("is not shown when the sound starts, or for a play that was cut short", async () => {
    mount();
    await settle();
    expect(prompt().hidden).toBe(true);
    player?.destroy();
    host.replaceChildren();
    play.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("cut"), { name: "AbortError" })),
    );
    mount();
    await settle();
    expect(prompt().hidden).toBe(true);
  });

  it("does not fail when the browser refuses to start sound", async () => {
    play.mockImplementation(refused);
    mount();
    await settle();
    expect(group().hidden).toBe(false);
  });
});

describe("the voice leads the deck", () => {
  const onDemand = async () => {
    const p = mount();
    p.go({ scene: 1, step: 0 });
    await settle();
    return { p, el: elements[elements.length - 1] as HTMLAudioElement };
  };

  it("shows each step as the recording passes its mark", async () => {
    const { p, el } = await onDemand();
    expect(p.state.position).toEqual({ scene: 1, step: 0 });
    at(el, 0.5);
    expect(p.state.position).toEqual({ scene: 1, step: 0 });
    at(el, 1.05);
    expect(p.state.position).toEqual({ scene: 1, step: 1 });
    at(el, 2.3);
    expect(p.state.position).toEqual({ scene: 1, step: 2 });
    expect(host.querySelector("[data-id='chart-demand']")?.getAttribute("data-revealed")).toBe("true");
  });

  it("does not move the slide when auto is off", async () => {
    const { p, el } = await onDemand();
    autoButton().click();
    at(el, 2.3);
    expect(p.state.position).toEqual({ scene: 1, step: 0 });
  });

  it("does not move the slide while paused, and picks up from where it was", async () => {
    const { p, el } = await onDemand();
    at(el, 1.05);
    pauseButton().click();
    expect(p.state.position.step).toBe(1);
    key("p");
    at(el, 2.3);
    expect(p.state.position.step).toBe(2);
  });

  it("shows the steps again, in order, when the recording is replayed", async () => {
    const { p, el } = await onDemand();
    at(el, 2.3);
    expect(p.state.position.step).toBe(2);
    Object.defineProperty(el, "ended", { value: true, configurable: true });
    Object.defineProperty(el, "paused", { value: true, configurable: true });
    pauseButton().click();
    Object.defineProperty(el, "ended", { value: false, configurable: true });
    at(el, 1.05);
    expect(p.state.position.step).toBe(1);
  });

  it("moves to the next scene a beat after the recording ends", async () => {
    vi.useFakeTimers();
    const p = mount();
    p.go({ scene: 1, step: 0 });
    const el = elements[elements.length - 1] as HTMLAudioElement;
    Object.defineProperty(el, "ended", { value: true, configurable: true });
    Object.defineProperty(el, "paused", { value: true, configurable: true });
    el.dispatchEvent(new Event("ended"));
    expect(p.state.position.scene).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(p.state.position).toEqual({ scene: 2, step: 0 });
  });

  it("stays on the scene when auto is off, or when the person moved on first", async () => {
    vi.useFakeTimers();
    const p = mount();
    p.go({ scene: 1, step: 0 });
    const el = elements[elements.length - 1] as HTMLAudioElement;
    Object.defineProperty(el, "ended", { value: true, configurable: true });
    Object.defineProperty(el, "paused", { value: true, configurable: true });
    autoButton().click();
    el.dispatchEvent(new Event("ended"));
    vi.advanceTimersByTime(1000);
    expect(p.state.position.scene).toBe(1);
    autoButton().click();
    el.dispatchEvent(new Event("ended"));
    p.go({ scene: 0, step: 0 });
    vi.advanceTimersByTime(1000);
    expect(p.state.position.scene).toBe(0);
  });

  it("does nothing at a mark when the scene has fewer steps than marks", async () => {
    const { p, el } = await onDemand();
    at(el, 9);
    expect(p.state.position.step).toBe(2);
  });
});
