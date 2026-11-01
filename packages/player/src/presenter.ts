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
import { LEAD_LABEL, nextPosition, stepCount } from "./model.ts";
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
      label: `Next click: step ${to.step} of ${stepCount(scene)}`,
      title: "",
      detail: `Reveals ${plural(reveals, "block")} on this scene.`,
    };
  }
  const next = scenes[to.scene] as Scene;
  return { label: "Next scene", title: next.title, detail: next.summary?.text ?? "" };
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
  const time = h("span", { class: "dc-pv-time", role: "timer", "aria-label": "Elapsed time" }, "0:00");
  const reset = h("button", { type: "button", class: "dc-btn", "data-pv": "reset" }, "Reset");
  const previous = h("button", { type: "button", class: "dc-btn", "data-pv": "previous" }, "Previous");
  const next = h("button", { type: "button", class: "dc-btn", "data-pv": "next" }, "Next");

  const root = h(
    "main",
    { class: "dc-presenter", "data-holder": "waiting" },
    h("header", { class: "dc-pv-head" }, deckTitle, holderText, takeOver),
    h("section", { class: "dc-pv-now", "aria-label": "On screen" }, where, sceneTitle, notes),
    h("aside", { class: "dc-pv-next", "aria-label": "Next" }, nextLabel, nextTitle, nextDetail),
    h("section", { class: "dc-pv-clock", "aria-label": "Timer" }, time, reset),
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
    applyLook(root, source.deck);
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
      return;
    }
    const steps = stepCount(here.scene);
    where.textContent = [
      `Scene ${here.index + 1} of ${source.scenes.length}`,
      steps > 0 ? `step ${shown.step} of ${steps}` : "",
      LEAD_LABEL[here.scene.lead ?? "human"],
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
    setDisabled(previous, at.scene === 0 && at.step === 0);
    setDisabled(next, nextPosition(source.scenes, at) === null);
  }

  const ask = (message: RequestMessage) => channel.postMessage(message);

  const tick = () => {
    time.textContent = formatElapsed(now() - startedAt);
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
  };
  document.addEventListener("keydown", onKey);

  paint();
  ask({ type: "hello" });

  return {
    update(fresh) {
      source = fresh;
      paint();
      // The scene on screen may now have another id; the deck window will say which one it is on.
      if (shown && !scene()) ask({ type: "hello" });
    },
    destroy() {
      clearInterval(clock);
      stopHello();
      document.removeEventListener("keydown", onKey);
      channel.removeEventListener("message", onMessage);
      channel.close();
      host.replaceChildren();
    },
  };
}
