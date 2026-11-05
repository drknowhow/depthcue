import type { Scene } from "@depthcue/core";
import { h } from "@depthcue/player";
import { notesPanel, type Panel, type PanelHost, voicePanel } from "./panels.ts";

export interface ScriptDrawer {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  /** Closes the drawer. `giveBack` puts the keyboard on the button that opened it, as Escape does. */
  close(giveBack?: boolean): void;
  toggle(): void;
  /** Brings what is written up to date with the scene. `typing` is true while a keystroke in it is being applied. */
  fill(scene: Scene, typing: boolean): void;
  /** What the button shows: how much of the script is written, and what a screen reader says for it. */
  state(scene: Scene): { badge: string; title: string };
}

export interface ScriptDrawerHooks {
  /** The drawer was opened, so another one over the same place can be put away. */
  opened(): void;
  /** The drawer was closed. `giveBack` is true when the keyboard should go back to its button. */
  closed(giveBack: boolean): void;
}

const TITLE = "Script: speaker notes, reading version and voice-over";

/**
 * The words that go with a slide, in one place beside it: the speaker notes, the reading version, and the voice-over
 * with the marks that move the slide and the button that makes the audio. It opens over the right of the stage like the
 * list of changes, so the slide stays in view while it is written.
 */
export function createScriptDrawer(
  host: PanelHost,
  current: () => string,
  hooks: ScriptDrawerHooks,
): ScriptDrawer {
  const notes: Panel = notesPanel(host, current);
  const voice: Panel = voicePanel(host, current);
  let open = false;

  const sceneTitle = h("span", { class: "ed-script-scene" });
  const close = h("button", {
    type: "button",
    "data-action": "close-script",
    "aria-label": "Close the script",
  });
  close.append(h("span", { class: "ed-icon ed-icon-close", "aria-hidden": "true" }));
  const mark = h("span", { class: "ed-tb-n" });
  const element = h(
    "aside",
    { class: "ed-script", id: "ed-script", "aria-label": TITLE, tabindex: "-1", hidden: true },
    h("div", { class: "ed-script-head" }, h("h2", {}, "Script"), sceneTitle, close),
    h(
      "div",
      { class: "ed-script-body" },
      h("section", { class: "ed-script-part", "data-part": "notes" }, notes.body),
      h(
        "section",
        { class: "ed-script-part", "data-part": "voice" },
        h("h3", {}, "Voice-over", mark),
        h(
          "p",
          { class: "ed-hint-text" },
          "Read aloud by Kokoro as the slide plays. Put a step mark where the slide should move on.",
        ),
        voice.body,
      ),
    ),
  );

  const shut = (giveBack: boolean) => {
    if (!open) return;
    open = false;
    element.hidden = true;
    hooks.closed(giveBack);
  };
  close.addEventListener("click", () => shut(true));
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    shut(true);
  });

  return {
    element,
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      element.hidden = false;
      hooks.opened();
      element.querySelector<HTMLElement>("textarea, input")?.focus({ preventScroll: true });
    },
    close: (giveBack = false) => shut(giveBack),
    toggle() {
      if (open) shut(true);
      else this.open();
    },
    fill(scene, typing) {
      sceneTitle.textContent = scene.title ?? scene.id;
      notes.fill(scene, typing);
      voice.fill(scene, typing);
      const state = voice.state?.(scene);
      mark.textContent = state?.badge ?? "";
      mark.title = state?.title ?? "";
    },
    state(scene) {
      const written = notes.state?.(scene);
      return {
        badge: written?.badge ?? "",
        title: written?.title ?? TITLE,
      };
    },
  };
}
