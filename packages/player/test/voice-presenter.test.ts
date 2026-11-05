// @vitest-environment happy-dom
import type { Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Channel, mountBroadcast, readRequest, readState } from "../src/broadcast.ts";
import { mountPlayer, type Player } from "../src/player.ts";
import { mountPresenterView, type PresenterMount } from "../src/presenter.ts";
import { demoSource } from "./helpers.ts";

type Listener = (event: { data: unknown }) => void;

/** Two channel ends that hear each other, like two windows on one BroadcastChannel. */
function pair(): [Channel & { posted: unknown[] }, Channel & { posted: unknown[] }] {
  const ends: Array<{ listeners: Set<Listener>; posted: unknown[] }> = [];
  const make = () => {
    const listeners = new Set<Listener>();
    const posted: unknown[] = [];
    ends.push({ listeners, posted });
    const me = ends[ends.length - 1];
    return {
      posted,
      postMessage: (message: unknown) => {
        posted.push(message);
        for (const other of ends) {
          if (other === me) continue;
          for (const listener of [...other.listeners]) listener({ data: structuredClone(message) });
        }
      },
      addEventListener: (_type: "message", listener: Listener) => void listeners.add(listener),
      removeEventListener: (_type: "message", listener: Listener) => void listeners.delete(listener),
      close: () => {},
    };
  };
  return [make(), make()];
}

let deckHost: HTMLElement;
let presenterHost: HTMLElement;
let player: Player | undefined;
let view: PresenterMount | undefined;
let broadcast: ReturnType<typeof mountBroadcast> | undefined;
let paused: boolean;

beforeEach(() => {
  history.replaceState(null, "", "/");
  try {
    localStorage.clear();
  } catch {}
  paused = false;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLAudioElement) {
    paused = false;
    Object.defineProperty(this, "paused", { value: false, configurable: true });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLAudioElement) {
    paused = true;
    Object.defineProperty(this, "paused", { value: true, configurable: true });
    this.dispatchEvent(new Event("pause"));
  });
  deckHost = document.createElement("div");
  presenterHost = document.createElement("div");
  document.body.append(deckHost, presenterHost);
});

afterEach(() => {
  view?.destroy();
  broadcast?.destroy();
  player?.destroy();
  view = broadcast = player = undefined;
  deckHost.remove();
  presenterHost.remove();
  vi.restoreAllMocks();
});

function mount() {
  const source = demoSource();
  source.scenes[0] = {
    ...(source.scenes[0] as Scene),
    voiceover: { text: "Hello there.", audio: "assets/a.wav" },
  };
  const [deckEnd, presenterEnd] = pair();
  player = mountPlayer(deckHost, source, {
    reducedMotion: true,
    onChange: (state) => broadcast?.changed(state),
    onVoice: () => broadcast?.changed(player?.state as never),
  });
  broadcast = mountBroadcast({ player, source: () => source, channel: deckEnd });
  view = mountPresenterView({ host: presenterHost, source, channel: presenterEnd });
  return { deckEnd, presenterEnd, player };
}

const q = <T extends HTMLElement>(selector: string) => presenterHost.querySelector(selector) as T;

describe("voice-over in the presenter's window", () => {
  it("shows the controls only for a scene that has a recording", () => {
    const { player: p } = mount();
    expect(q(".dc-pv-voice").hidden).toBe(false);
    expect(q(".dc-pv-voice-status").textContent).toBe("Voice-over playing");
    p.go({ scene: 1, step: 0 });
    expect(q(".dc-pv-voice").hidden).toBe(true);
    p.go({ scene: 0, step: 0 });
    expect(q(".dc-pv-voice").hidden).toBe(false);
  });

  it("pauses and plays the deck window's recording, and shows which it is doing", () => {
    mount();
    q("[data-pv='voice-pause']").click();
    expect(paused).toBe(true);
    expect(q(".dc-pv-voice-status").textContent).toBe("Voice-over paused");
    expect(q("[data-pv='voice-pause']").textContent).toBe("Play");
    q("[data-pv='voice-pause']").click();
    expect(paused).toBe(false);
    expect(q("[data-pv='voice-pause']").textContent).toBe("Pause");
  });

  it("switches the captions and auto from the presenter's window", () => {
    const { player: p } = mount();
    q("[data-pv='voice-captions']").click();
    expect(p.voiceState().captions).toBe(true);
    expect(q("[data-pv='voice-captions']").getAttribute("aria-pressed")).toBe("true");
    q("[data-pv='voice-auto']").click();
    expect(p.voiceState().auto).toBe(false);
    expect(q("[data-pv='voice-auto']").getAttribute("aria-pressed")).toBe("false");
  });

  it("answers the p and c keys like the buttons", () => {
    const { player: p } = mount();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true }));
    expect(p.voiceState().playing).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    expect(p.voiceState().captions).toBe(true);
  });

  it("tells the presenter to press Play in the deck window when the browser held the sound back", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() =>
      Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" })),
    );
    mount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(q(".dc-pv-voice-status").textContent).toBe("Press Play in the deck window");
  });
});

describe("the voice messages", () => {
  it("reads a voice state and drops a malformed one without losing the scene", () => {
    const voice = {
      available: true,
      playing: false,
      ended: false,
      blocked: false,
      auto: true,
      captions: true,
    };
    const base = { type: "state", scene: "demand", step: 0, holder: "human" };
    expect(readState({ ...base, voice })?.voice).toEqual(voice);
    expect(readState({ ...base, voice: { available: true } })).toEqual(base);
    expect(readState(base)).toEqual(base);
  });

  it("reads a voice request and refuses an unknown action", () => {
    expect(readRequest({ type: "voice", action: "pause" })).toEqual({ type: "voice", action: "pause" });
    expect(readRequest({ type: "voice", action: "format-disk" })).toBeUndefined();
    expect(readRequest({ type: "voice" })).toBeUndefined();
  });
});
