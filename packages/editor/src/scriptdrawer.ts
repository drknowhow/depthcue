import type { Scene } from "@depthcue/core";
import { h } from "@depthcue/player";
import { type Panel, type PanelHost, readingPanel, speakerNotesPanel, voicePanel } from "./panels.ts";
import { describeBlock } from "./templates.ts";

/** The drawer's tabs, in the order they are drawn. */
export type ScriptTab = "notes" | "steps" | "reading" | "voice";
const TABS: readonly ScriptTab[] = ["notes", "steps", "reading", "voice"];

export interface ScriptDrawer {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  /** The tab on show, or the one that shows next time the drawer opens. */
  readonly tab: ScriptTab;
  /** Opens the drawer on `tab`, or on the tab it last showed, and puts the keyboard in it. */
  open(tab?: ScriptTab): void;
  /** Closes the drawer. `giveBack` puts the keyboard on the button that opened it, as Escape does. */
  close(giveBack?: boolean): void;
  /** Closes the drawer when it is open on `tab` (or on any tab, with none given); otherwise opens it on `tab`. */
  toggle(tab?: ScriptTab): void;
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
  /** The Reveal order tab's button was pressed: open the slide's steps, where they are changed. */
  steps?(): void;
}

const TITLE = "Script: speaker notes, reveal order, reading version and voice-over";
const LABELS: Record<ScriptTab, string> = {
  notes: "Speaker notes",
  steps: "Reveal order",
  reading: "Reading version",
  voice: "Voice-over",
};

/**
 * The words that go with a slide and the order it builds in, in one drawer along the foot of the stage: the speaker
 * notes, the reveal order, the reading version, and the voice-over with the marks that move the slide and the button
 * that makes the audio. Each is a tab, so the slide stays in view above whichever is being written.
 */
export function createScriptDrawer(
  host: PanelHost,
  current: () => string,
  hooks: ScriptDrawerHooks,
): ScriptDrawer {
  const notes: Panel = speakerNotesPanel(host, current);
  const reading: Panel = readingPanel(host, current);
  const voice: Panel = voicePanel(host, current);
  let open = false;
  let tab: ScriptTab = "notes";

  const badges = Object.fromEntries(TABS.map((name) => [name, h("span", { class: "ed-tb-n" })])) as Record<
    ScriptTab,
    HTMLElement
  >;
  const tabs = Object.fromEntries(
    TABS.map((name) => [
      name,
      h(
        "button",
        {
          type: "button",
          role: "tab",
          id: `ed-script-tab-${name}`,
          class: "ed-script-tab",
          "data-tab": name,
          "aria-controls": `ed-script-${name}`,
          "aria-selected": "false",
          tabindex: "-1",
        },
        LABELS[name],
        badges[name],
      ),
    ]),
  ) as Record<ScriptTab, HTMLButtonElement>;

  // The reveal order is changed with the slide's steps; here it is read, step by step, with a way to go and change it.
  const stepList = h("ol", { class: "ed-script-steps" });
  const noSteps = h(
    "p",
    { class: "ed-hint-text" },
    "This slide shows everything at once. Steps reveal its parts one press at a time.",
  );
  const editSteps = h(
    "button",
    { type: "button", class: "ed-button", "data-action": "edit-steps" },
    "Edit the steps",
  );
  editSteps.addEventListener("click", () => hooks.steps?.());

  const bodies: Record<ScriptTab, Node[]> = {
    notes: [notes.body],
    steps: [noSteps, stepList, editSteps],
    reading: [reading.body],
    voice: [
      h(
        "p",
        { class: "ed-hint-text" },
        "Read aloud by Kokoro as the slide plays. Put a step mark where the slide should move on.",
      ),
      voice.body,
    ],
  };
  const panels = Object.fromEntries(
    TABS.map((name) => [
      name,
      h(
        "section",
        {
          class: "ed-script-part",
          role: "tabpanel",
          id: `ed-script-${name}`,
          "data-part": name,
          "aria-labelledby": `ed-script-tab-${name}`,
          hidden: true,
        },
        ...bodies[name],
      ),
    ]),
  ) as Record<ScriptTab, HTMLElement>;

  const close = h("button", {
    type: "button",
    "data-action": "close-script",
    "aria-label": "Close the script",
  });
  close.append(h("span", { class: "ed-icon ed-icon-close", "aria-hidden": "true" }));
  const tablist = h(
    "div",
    { class: "ed-script-tabs", role: "tablist", "aria-label": "Script" },
    ...TABS.map((name) => tabs[name]),
  );
  const element = h(
    "aside",
    { class: "ed-script", id: "ed-script", "aria-label": TITLE, tabindex: "-1", hidden: true },
    h("div", { class: "ed-script-head" }, tablist, close),
    h("div", { class: "ed-script-body" }, ...TABS.map((name) => panels[name])),
  );

  const show = (name: ScriptTab) => {
    tab = name;
    for (const other of TABS) {
      const on = other === name;
      tabs[other].setAttribute("aria-selected", String(on));
      tabs[other].tabIndex = on ? 0 : -1;
      panels[other].hidden = !on;
    }
  };
  show(tab);
  const focusPanel = () =>
    panels[tab].querySelector<HTMLElement>("textarea, input, select, button")?.focus({ preventScroll: true });

  for (const name of TABS) tabs[name].addEventListener("click", () => show(name));
  // Arrows move along the tabs and show each one, as a tab list does; Home and End go to either end.
  tablist.addEventListener("keydown", (event) => {
    const at = TABS.indexOf(tab);
    const to =
      event.key === "ArrowRight"
        ? (at + 1) % TABS.length
        : event.key === "ArrowLeft"
          ? (at - 1 + TABS.length) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const name = TABS[to] as ScriptTab;
    show(name);
    tabs[name].focus();
  });

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

  const drawer: ScriptDrawer = {
    element,
    get isOpen() {
      return open;
    },
    get tab() {
      return tab;
    },
    open(name) {
      if (name) show(name);
      if (!open) {
        open = true;
        element.hidden = false;
        hooks.opened();
      }
      focusPanel();
    },
    close: (giveBack = false) => shut(giveBack),
    toggle(name) {
      if (open && (name === undefined || name === tab)) shut(true);
      else drawer.open(name);
    },
    fill(scene, typing) {
      notes.fill(scene, typing);
      reading.fill(scene, typing);
      voice.fill(scene, typing);
      const steps = scene.steps ?? [];
      const named = new Map<string, string>(
        scene.blocks.map((block) => [block.id, describeBlock(block, 28, scene)]),
      );
      if (scene.summary) named.set(scene.summary.id, "Claim");
      stepList.replaceChildren(
        ...steps.map((step, index) =>
          h(
            "li",
            {},
            h("span", { class: "ed-script-step-n" }, `Step ${index + 1}`),
            step.reveal.map((id) => named.get(id) ?? id).join(", "),
          ),
        ),
      );
      stepList.hidden = steps.length === 0;
      noSteps.hidden = steps.length > 0;
      badges.steps.textContent = steps.length > 0 ? String(steps.length) : "";
      const said = voice.state?.(scene);
      badges.voice.textContent = said?.badge ?? "";
      badges.voice.title = said?.title ?? "";
    },
    state(scene) {
      const n = Number(Boolean(scene.notes)) + Number(Boolean(scene.reading?.text));
      return {
        badge: n > 0 ? String(n) : "",
        title: n > 0 ? `${TITLE}. Speaker notes and reading version: ${n} of 2 written` : TITLE,
      };
    },
  };
  return drawer;
}
