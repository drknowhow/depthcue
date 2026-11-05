import { h } from "./dom.ts";
import type { LeaseMount } from "./lease.ts";
import type { PlayerSource } from "./load.ts";
import type { Player, PlayerState } from "./player.ts";
import type { VoiceState } from "./voice.ts";

/** The name both windows listen on. A channel reaches only pages of the same origin, so one deck server at a time. */
export const CHANNEL_NAME = "depthcue-presenter";

/** The part of `BroadcastChannel` that the two windows use, so a test can stand a pair of fakes in its place. */
export interface Channel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export const openChannel = (): Channel => new BroadcastChannel(CHANNEL_NAME);

export type Holder = "human" | "agent";

/** What the deck window tells the presenter's window: the scene on screen, by id, and who is presenting. */
export interface StateMessage {
  type: "state";
  scene: string;
  step: number;
  holder: Holder;
  /** What the voice-over of that scene is doing. Left out for a scene without one. */
  voice?: VoiceState;
}

export type VoiceAction = "pause" | "captions" | "auto";

/** What the presenter's window asks of the deck window. `hello` asks for a fresh `state`. */
export type RequestMessage =
  | { type: "hello" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "takeover" }
  | { type: "voice"; action: VoiceAction };

const VOICE_KEYS = ["available", "playing", "ended", "blocked", "auto", "captions"] as const;

function readVoice(data: unknown): VoiceState | undefined {
  const voice = data as Record<string, unknown> | null;
  if (!voice || typeof voice !== "object") return undefined;
  if (!VOICE_KEYS.every((key) => typeof voice[key] === "boolean")) return undefined;
  return Object.fromEntries(VOICE_KEYS.map((key) => [key, voice[key]])) as unknown as VoiceState;
}

export function readState(data: unknown): StateMessage | undefined {
  const message = data as Partial<StateMessage> | null;
  if (message?.type !== "state") return undefined;
  if (typeof message.scene !== "string" || !Number.isInteger(message.step) || (message.step as number) < 0) {
    return undefined;
  }
  if (message.holder !== "human" && message.holder !== "agent") return undefined;
  const state: StateMessage = {
    type: "state",
    scene: message.scene,
    step: message.step as number,
    holder: message.holder,
  };
  const voice = message.voice === undefined ? undefined : readVoice(message.voice);
  if (voice) state.voice = voice;
  return state;
}

export function readRequest(data: unknown): RequestMessage | undefined {
  const message = data as { type?: unknown; action?: unknown } | null;
  const type = message?.type;
  if (type === "voice") {
    const action = message?.action;
    return action === "pause" || action === "captions" || action === "auto" ? { type, action } : undefined;
  }
  return type === "hello" || type === "next" || type === "previous" || type === "takeover"
    ? { type }
    : undefined;
}

export interface BroadcastOptions {
  player: Player;
  source: () => PlayerSource;
  /** Present when the page has a control lease. Without it the person is always the one presenting. */
  lease?: LeaseMount | undefined;
  /** Replaces the browser's channel. For tests. */
  channel?: Channel;
  /** Where the presenter's window opens. Default: this address with `?presenter` and no hash. */
  presenterUrl?: () => string;
}

export interface BroadcastMount {
  /** The page calls this whenever the player's state changes, whoever changed it. */
  changed(state: PlayerState): void;
  destroy(): void;
}

/**
 * The deck window's side of the presenter view. It tells the presenter's window where the deck is and who holds
 * control, and does what that window asks. A move the presenter's window asks for is a move like any other, so it
 * takes control back from an agent through the lease's own check.
 */
export function mountBroadcast(options: BroadcastOptions): BroadcastMount {
  const { player, lease } = options;
  const channel = options.channel ?? openChannel();
  const bar = document.querySelector<HTMLElement>(".dc-player .dc-controls");
  if (!bar) throw new Error("The presenter view needs a mounted player.");

  const holder = (): Holder => lease?.controller.state().holder ?? "human";
  let last = "";

  function post(force: boolean) {
    const state = player.state;
    const scene = options.source().scenes[state.position.scene];
    if (!scene) return;
    const message: StateMessage = {
      type: "state",
      scene: scene.id,
      step: state.position.step,
      holder: holder(),
    };
    const voice = player.voiceState?.();
    if (voice?.available) message.voice = voice;
    // Moves and hand-overs often arrive together, and the presenter's window needs each fact once.
    const key = JSON.stringify(message);
    if (key === last && !force) return;
    last = key;
    channel.postMessage(message);
  }

  const onMessage = (event: { data: unknown }) => {
    const request = readRequest(event.data);
    if (!request) return;
    if (request.type === "hello") post(true);
    else if (request.type === "next") player.next();
    else if (request.type === "previous") player.previous();
    else if (request.type === "voice") player.voiceControl(request.action);
    else lease?.controller.takeover();
  };
  channel.addEventListener("message", onMessage);

  const unsubscribe = lease?.controller.subscribe((event) => {
    if (event.type === "granted" || event.type === "revoked") post(false);
  });

  const open = h(
    "button",
    { type: "button", class: "dc-btn dc-presenter-open", "data-presenter-open": "" },
    "Presenter view",
  );
  const onOpen = () => {
    const url = options.presenterUrl?.() ?? `${location.pathname}?presenter`;
    window.open(url, "depthcue-presenter", "popup,width=1100,height=720");
  };
  open.addEventListener("click", onOpen);
  bar.insertBefore(open, bar.querySelector('[data-action="read"]'));

  post(false);

  return {
    changed: () => post(false),
    destroy() {
      unsubscribe?.();
      channel.removeEventListener("message", onMessage);
      channel.close();
      open.remove();
    },
  };
}
