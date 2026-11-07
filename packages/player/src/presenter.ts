import type { Scene } from "@depthcue/core";
import {
  type Channel,
  type Holder,
  openChannel,
  type RequestMessage,
  readState,
  type StateMessage,
} from "./broadcast.ts";
import { h } from "./dom.ts";
import type { PlayerSource } from "./load.ts";
import { LEAD_LABEL, nextPosition, revealedIds, stepCount } from "./model.ts";
import { renderScene } from "./scene.ts";
import { applyLook } from "./style.ts";

export interface PresenterOptions {
  host: HTMLElement;
  source: PlayerSource;
  /** Replaces the browser's channel. For tests. */
  channel?: Channel;
  /** Replaces the clock the timer reads. For tests. */
  now?: () => number;
}

export interface PresenterMount {
  /** Swaps in changed deck content and keeps the place by scene id. For live reload. */
  update(source: PlayerSource): void;
  destroy(): void;
}

/** How often the window asks the deck window where it is, until the first answer. */
export const HELLO_EVERY_MS = 2000;

/** The timer as `m:ss`, or `h:mm:ss` from the first hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the next move shows. The next scene comes with its summary, so the presenter can lead into it. */
function upcoming(scenes: readonly Scene[], at: { scene: number; step: number }) {
  const to = nextPosition(scenes, at);
  const scene = scenes[at.scene] as Scene;
  if (!to) return { label: "End of the deck", title: "", detail: "Nothing follows this." };
  if (to.scene === at.scene) {
    const reveals = scene.steps?.[at.step]?.reveal.length ?? 0;
    return {
      label: `Next click: reveal ${to.step} of ${stepCount(scene)}`,
      title: "",
      detail: `Reveals ${plural(reveals, "block")} on this scene.`,
    };
  }
  const next = scenes[to.scene] as Scene;
  return { label: "Next scene", title: next.title, detail: next.summary?.text ?? "" };
}

/** The size a picture of a scene is drawn at before it is scaled to its box, so its type keeps the slide's proportions. */
const PICTURE_WIDTH = 1280;

/**
 * A picture of a scene at a step, as the audience sees it: the player draws it, then it is scaled down and made inert,
 * so nothing in it can be reached, played or read out twice.
 */
function picture(source: PlayerSource, index: number, step: number): HTMLElement {
  const scene = source.scenes[index] as Scene;
  const view = renderScene(scene, {
    assetBase: source.assetBase,
    language: source.deck.language,
    ...(source.look ? { look: source.look } : {}),
    number: index + 1,
    ...(source.deck.links ? { links: source.deck.links } : {}),
    scenes: source.scenes,
  });
  const shown = revealedIds(scene, step);
  for (const node of view.querySelectorAll<HTMLElement>("[data-gated]"))
    node.dataset.revealed = String(shown.has(node.dataset.id ?? ""));
  for (const node of view.querySelectorAll("[id]")) node.removeAttribute("id");
  const mini = h(
    "div",
    { class: "dc-player dc-pv-mini" },
    h("div", { class: "dc-stage" }, h("div", { class: "dc-view" }, view)),
  );
  applyLook(mini, source.look ?? source.deck, source.assetBase);
  // The box around it carries its name; the drawing itself cannot be focused, clicked or read.
  mini.setAttribute("inert", "");
  return mini;
}

/** A box that holds a picture of a scene, scaled to the box's width. */
function pictureBox(label: string) {
  const box = h("div", { class: "dc-pv-pic", role: "img", "aria-label": label });
  let key = "";
  const fit = () =>
    box.style.setProperty("--pv-scale", String((box.clientWidth || PICTURE_WIDTH) / PICTURE_WIDTH));
  const watch = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined;
  watch?.observe(box);
  return {
    box,
    /** Shows scene `index` at `step`, or nothing. It draws again only when what it shows has changed. */
    show(source: PlayerSource, at: { scene: number; step: number } | null, name: string) {
      box.hidden = at === null;
      const next = at ? `${at.scene}:${at.step}` : "";
      if (at && name) box.setAttribute("aria-label", `${label}: ${name}`);
      if (next === key) return;
      key = next;
      box.replaceChildren(...(at ? [picture(source, at.scene, at.step)] : []));
      fit();
    },
    /** Forgets what it shows, so new deck content is drawn. */
    reset() {
      key = "";
    },
    stop() {
      watch?.disconnect();
    },
  };
}

/**
 * The presenter's window: the notes, a timer, what comes next and the moves, for a deck shown in another window.
 * It holds no place of its own. The deck window says where the deck is, and every move here is a request to it.
 */
export function mountPresenterView(options: PresenterOptions): PresenterMount {
  const { host } = options;
  const channel = options.channel ?? openChannel();
  const now = options.now ?? Date.now;
  let source = options.source;
  let shown: StateMessage | undefined;
  let startedAt = now();
  // The slide clock starts again whenever the deck window moves to another scene.
  let sceneStartedAt = startedAt;
  let sceneShown: string | undefined;

  const deckTitle = h("h1", { class: "dc-pv-deck" });
  const holderText = h("p", { class: "dc-pv-holder", role: "status" });
  const takeOver = h(
    "button",
    { type: "button", class: "dc-btn dc-pv-takeover", "data-pv": "takeover", hidden: true },
    "Take over",
    h("kbd", { class: "dc-lease-key" }, "Esc"),
  );
  const where = h("p", { class: "dc-pv-where" });
  const sceneTitle = h("h2", { class: "dc-pv-scene" });
  const notes = h("div", { class: "dc-pv-notes", tabindex: 0, role: "region", "aria-label": "Notes" });
  const nextLabel = h("p", { class: "dc-pv-label" });
  const nextTitle = h("h2", { class: "dc-pv-next-title" });
  const nextDetail = h("p", { class: "dc-pv-detail" });
  const nowPicture = pictureBox("On screen");
  const nextPicture = pictureBox("Next click");
  const laterPicture = pictureBox("After that");
  const laterLabel = h("p", { class: "dc-pv-later-label" }, "After that");
  const laterTitle = h("p", { class: "dc-pv-later-title" });
  const later = h("div", { class: "dc-pv-later" }, laterLabel, laterPicture.box, laterTitle);
  const time = h("span", { class: "dc-pv-time", role: "timer", "aria-label": "Elapsed time" }, "0:00");
  const slideTime = h(
    "span",
    { class: "dc-pv-slide-time", role: "timer", "aria-label": "Time on this scene" },
    "0:00",
  );
  const reset = h("button", { type: "button", class: "dc-btn", "data-pv": "reset" }, "Reset");
  const previous = h("button", { type: "button", class: "dc-btn", "data-pv": "previous" }, "Previous");
  const next = h("button", { type: "button", class: "dc-btn", "data-pv": "next" }, "Next");
  const voiceStatus = h("span", { class: "dc-pv-voice-status", role: "status" });
  const voicePause = h("button", { type: "button", class: "dc-btn", "data-pv": "voice-pause" }, "Pause");
  const voiceCaptions = h(
    "button",
    { type: "button", class: "dc-btn", "data-pv": "voice-captions", "aria-pressed": "false" },
    "Captions",
  );
  const voiceAuto = h(
    "button",
    {
      type: "button",
      class: "dc-btn",
      "data-pv": "voice-auto",
      "aria-pressed": "false",
      title: "Auto: the voice starts each scene, moves its steps and moves on",
    },
    "Auto",
  );
  // The recording plays in the deck window, where the audience is. These buttons only ask that window.
  const voicePanel = h(
    "div",
    { class: "dc-pv-voice", role: "group", "aria-label": "Voice-over", hidden: true },
    voiceStatus,
    voicePause,
    voiceCaptions,
    voiceAuto,
  );

  const root = h(
    "main",
    { class: "dc-presenter", "data-holder": "waiting" },
    h("header", { class: "dc-pv-head" }, deckTitle, holderText, takeOver),
    h(
      "section",
      { class: "dc-pv-now", "aria-label": "On screen" },
      where,
      h("div", { class: "dc-pv-now-top" }, nowPicture.box, h("div", {}, sceneTitle)),
      notes,
    ),
    h(
      "aside",
      { class: "dc-pv-next", "aria-label": "Next" },
      nextLabel,
      nextPicture.box,
      nextTitle,
      nextDetail,
      later,
    ),
    h(
      "section",
      { class: "dc-pv-clock", "aria-label": "Timers" },
      h("span", { class: "dc-pv-clock-part" }, h("span", { class: "dc-k" }, "Talk"), time, reset),
      h("span", { class: "dc-pv-clock-part" }, h("span", { class: "dc-k" }, "This scene"), slideTime),
      voicePanel,
    ),
    h("nav", { class: "dc-pv-moves", "aria-label": "Moves" }, previous, next),
  );
  host.replaceChildren(root);

  const scene = (): { index: number; scene: Scene } | undefined => {
    const index = shown ? source.scenes.findIndex((one) => one.id === shown?.scene) : -1;
    const found = source.scenes[index];
    return found ? { index, scene: found } : undefined;
  };

  const setDisabled = (button: HTMLElement, disabled: boolean) => {
    if (disabled) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  };

  function paint() {
    deckTitle.textContent = source.deck.title;
    document.title = `${source.deck.title} (presenter)`;
    applyLook(root, source.look ?? source.deck, source.assetBase);
    const here = scene();
    const holder: Holder | "waiting" = here && shown ? shown.holder : "waiting";
    root.dataset.holder = holder;
    holderText.textContent =
      holder === "agent"
        ? "Agent presenting"
        : holder === "human"
          ? "You present"
          : "Waiting for the deck window";
    takeOver.hidden = holder !== "agent";
    if (!here || !shown) {
      where.textContent = "Open the deck in another window and it will show up here.";
      sceneTitle.textContent = "";
      notes.textContent = "";
      notes.dataset.empty = "true";
      nextLabel.textContent = "";
      nextTitle.textContent = "";
      nextDetail.textContent = "";
      setDisabled(previous, true);
      setDisabled(next, true);
      voicePanel.hidden = true;
      nowPicture.show(source, null, "");
      nextPicture.show(source, null, "");
      laterPicture.show(source, null, "");
      later.hidden = true;
      return;
    }
    paintVoice(shown.voice);
    if (sceneShown !== here.scene.id) {
      sceneShown = here.scene.id;
      sceneStartedAt = now();
      tick();
    }
    const steps = stepCount(here.scene);
    where.textContent = [
      `Scene ${here.index + 1} of ${source.scenes.length}`,
      steps > 0 ? `reveal ${shown.step} of ${steps}` : "",
      `Planned: ${LEAD_LABEL[here.scene.lead ?? "human"]}`,
    ]
      .filter(Boolean)
      .join(" · ");
    sceneTitle.textContent = here.scene.title;
    const text = here.scene.notes?.trim() ?? "";
    notes.textContent = text || "No notes for this scene.";
    notes.dataset.empty = String(text === "");
    const after = upcoming(source.scenes, { scene: here.index, step: shown.step });
    nextLabel.textContent = after.label;
    nextTitle.textContent = after.title;
    nextTitle.hidden = after.title === "";
    nextDetail.textContent = after.detail;
    nextDetail.hidden = after.detail === "";
    const at = { scene: here.index, step: shown.step };
    const to = nextPosition(source.scenes, at);
    // After the next click: the scene that follows the one the next click shows.
    const laterIndex = to ? (to.scene === at.scene ? at.scene + 1 : to.scene + 1) : -1;
    const laterScene = source.scenes[laterIndex];
    nowPicture.show(source, at, here.scene.title);
    nextPicture.show(source, to, to ? (source.scenes[to.scene] as Scene).title : "");
    laterPicture.show(source, laterScene ? { scene: laterIndex, step: 0 } : null, laterScene?.title ?? "");
    later.hidden = !laterScene;
    laterTitle.textContent = laterScene ? `${laterIndex + 1}. ${laterScene.title}` : "";
    setDisabled(previous, at.scene === 0 && at.step === 0);
    setDisabled(next, to === null);
  }

  function paintVoice(voice: StateMessage["voice"]) {
    voicePanel.hidden = !voice;
    if (!voice) return;
    voiceStatus.textContent = voice.blocked
      ? "Press Play in the deck window"
      : voice.playing
        ? "Voice-over playing"
        : voice.ended
          ? "Voice-over finished"
          : "Voice-over paused";
    voicePause.textContent = voice.playing ? "Pause" : voice.ended ? "Replay" : "Play";
    voiceCaptions.setAttribute("aria-pressed", String(voice.captions));
    voiceAuto.setAttribute("aria-pressed", String(voice.auto));
  }

  const ask = (message: RequestMessage) => channel.postMessage(message);

  const tick = () => {
    const at = now();
    time.textContent = formatElapsed(at - startedAt);
    slideTime.textContent = formatElapsed(at - sceneStartedAt);
  };
  const clock = setInterval(tick, 1000);

  let hello: ReturnType<typeof setInterval> | undefined = setInterval(
    () => ask({ type: "hello" }),
    HELLO_EVERY_MS,
  );
  const stopHello = () => {
    if (hello !== undefined) clearInterval(hello);
    hello = undefined;
  };

  const onMessage = (event: { data: unknown }) => {
    const state = readState(event.data);
    if (!state) return;
    shown = state;
    stopHello();
    paint();
  };
  channel.addEventListener("message", onMessage);

  const move = (button: HTMLElement, type: "next" | "previous") => {
    if (button.getAttribute("aria-disabled") !== "true") ask({ type });
  };

  const onClick = (event: MouseEvent) => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-pv]") : null;
    const action = control?.dataset.pv;
    if (action === "next" || action === "previous") move(control as HTMLElement, action);
    else if (action === "takeover") ask({ type: "takeover" });
    else if (action === "voice-pause") ask({ type: "voice", action: "pause" });
    else if (action === "voice-captions") ask({ type: "voice", action: "captions" });
    else if (action === "voice-auto") ask({ type: "voice", action: "auto" });
    else if (action === "reset") {
      startedAt = now();
      tick();
    }
  };
  root.addEventListener("click", onClick);

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") move(next, "next");
    else if (event.key === "ArrowLeft" || event.key === "PageUp") move(previous, "previous");
    else if (event.key === "Escape" && shown?.holder === "agent") ask({ type: "takeover" });
    else if (shown?.voice && (event.key === "p" || event.key === "c" || event.key === "a"))
      ask({ type: "voice", action: event.key === "p" ? "pause" : event.key === "c" ? "captions" : "auto" });
  };
  document.addEventListener("keydown", onKey);

  paint();
  ask({ type: "hello" });

  return {
    update(fresh) {
      source = fresh;
      for (const box of [nowPicture, nextPicture, laterPicture]) box.reset();
      paint();
      // The scene on screen may now have another id; the deck window will say which one it is on.
      if (shown && !scene()) ask({ type: "hello" });
    },
    destroy() {
      clearInterval(clock);
      for (const box of [nowPicture, nextPicture, laterPicture]) box.stop();
      stopHello();
      document.removeEventListener("keydown", onKey);
      channel.removeEventListener("message", onMessage);
      channel.close();
      host.replaceChildren();
    },
  };
}
