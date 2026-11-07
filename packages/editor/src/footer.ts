import type { Scene } from "@depthcue/core";
import { h } from "@depthcue/player";
import { voiceStanding } from "./panels.ts";
import type { ScriptTab } from "./scriptdrawer.ts";

export interface FooterHooks {
  /** A part of the script was pressed: show the drawer on that part's tab. */
  script(tab: ScriptTab): void;
}

export interface Footer {
  readonly element: HTMLElement;
  /** Brings what it says about the slide on show up to date. */
  render(scene: Scene, position: number, count: number): void;
}

const VOICE_WORDS = {
  none: "No voice-over",
  missing: "Voice-over, no audio yet",
  current: "Voice-over ready",
  stale: "Voice-over out of date",
} as const;

/**
 * The strip along the foot of the editor. On the left it says what the slide on show holds: which slide it is, its
 * steps, and whether it has speaker notes, a reading version and a voice-over. Each of those opens the script drawer on
 * its own tab. On the right is the zoom, which is made elsewhere and put here.
 */
export function createFooter(controls: HTMLElement, hooks: FooterHooks): Footer {
  const where = h("span", { class: "ed-footer-where" });
  const part = (name: ScriptTab, className = "ed-footer-part") => {
    const node = h("button", { type: "button", class: className, "data-footer": name });
    node.addEventListener("click", () => hooks.script(name));
    return node;
  };
  const steps = part("steps", "ed-footer-part ed-footer-fact");
  const notes = part("notes");
  const reading = part("reading");
  const voice = part("voice");
  const facts = h("div", { class: "ed-footer-facts" }, where, steps, notes, reading, voice);
  const element = h(
    "footer",
    { class: "ed-footer", "aria-label": "Slide details and view" },
    facts,
    controls,
  );

  const mark = (node: HTMLElement, on: boolean, text: string, title: string) => {
    node.textContent = text;
    node.title = title;
    node.setAttribute("aria-label", title);
    node.toggleAttribute("data-on", on);
  };

  return {
    element,
    render(scene, position, count) {
      where.textContent = `Slide ${position} of ${count} · ${scene.title ?? scene.id}`;
      const n = scene.steps?.length ?? 0;
      steps.textContent = n === 0 ? "No steps" : n === 1 ? "1 step" : `${n} steps`;
      steps.setAttribute("aria-label", `${steps.textContent}: open the reveal order`);
      const hasNotes = Boolean(scene.notes);
      mark(
        notes,
        hasNotes,
        "Notes",
        hasNotes ? "Speaker notes written: open the script" : "No speaker notes: open the script",
      );
      const hasReading = Boolean(scene.reading?.text);
      mark(
        reading,
        hasReading,
        "Reading",
        hasReading ? "Reading version written: open the script" : "No reading version: open the script",
      );
      const standing = voiceStanding(scene);
      mark(
        voice,
        standing === "current",
        `Voice ${standing === "current" ? "✓" : standing === "stale" ? "!" : standing === "missing" ? "·" : "–"}`,
        `${VOICE_WORDS[standing]}: open the script`,
      );
      voice.toggleAttribute("data-stale", standing === "stale");
    },
  };
}
