/** What the parts of the brand chunk share: the host they are given, the context a section is drawn with, and helpers. */
import type { Brand, Frame, Op, PRESETS, Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Edits } from "./fields.ts";
import type { EditorStore } from "./store.ts";

/** What the panel, Save as template and the template editor need from the mounted editor. */
export interface BrandHost {
  readonly session: Session;
  readonly store: EditorStore;
  /** The editor's root, where dialogs go. */
  readonly root: HTMLElement;
  /** The stage, which the panel and the template editor sit over. */
  readonly floor: HTMLElement;
  /** The scene on show. */
  scene(): string;
  /** Where a block or the claim is on the slide on show, in percent of it. */
  measure(id: string): Frame | undefined;
  /** Shows a scene. */
  select(sceneId: string): void;
  /** Says a refusal in the editor's own line under the slide, or clears it. */
  problem(text: string | undefined): void;
}

export const TABS = {
  logos: "Logos",
  colors: "Colors",
  fonts: "Fonts",
  chrome: "Chrome",
  styles: "Styles",
  templates: "Templates",
} as const;
export type Tab = keyof typeof TABS;

export type Theme = keyof typeof PRESETS;
/** The presets, as the panel names them over a column and in a sentence. */
export const THEME_NAME: Record<Theme, string> = { paper: "Paper", ink: "Ink" };
export const THEMES = Object.keys(THEME_NAME) as Theme[];

/** What every section of the panel is drawn with. */
export interface BrandContext {
  readonly host: BrandHost;
  readonly session: Session;
  readonly edits: Edits;
  /** Applies a click or a choice as one step of Undo, and says a refusal at the top of the panel. True when applied. */
  run(ops: readonly Op[]): boolean;
  /** Says something at the top of the panel, or clears it. */
  say(text: string | undefined): void;
  /** Opens a section. */
  show(tab: Tab): void;
  /** Draws the section again, after something only the panel keeps changed, such as the style open for editing. */
  redraw(): void;
  /** The deck's brand. A section is drawn only while there is one. */
  brand(): Brand;
  /** What the panel keeps between drawings: the style open for editing, and the words typed into Start a brand. */
  readonly state: { style?: string | undefined; name?: string | undefined; id?: string | undefined };
}

/** A checkbox that writes one change, found again after a redraw by its `data-field`. */
export function toggle(
  ctx: BrandContext,
  key: string,
  label: string,
  on: boolean,
  commit: (on: boolean) => Op,
): HTMLElement {
  const box = h("input", { type: "checkbox", "data-field": key });
  box.checked = on;
  box.addEventListener("change", () => {
    if (!ctx.run([commit(box.checked)])) box.checked = !box.checked;
  });
  return h("label", { class: "ed-check" }, box, h("span", {}, label));
}

/** A part of a section, under its heading. */
export const part = (title: string, ...children: Array<Node | false | undefined>) =>
  h("section", { class: "ed-brand-part" }, h("h3", { class: "ed-label" }, title), ...children);

export const hint = (text: string) => h("p", { class: "ed-hint-text" }, text);

/** An object without one of its keys. */
export const without = <T extends object>(value: T, key: string): T =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as T;

/** Names in a sentence: "A", "A and B", "A, B and C". */
export const listed = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A list of choices from labels by value, in the order the labels are written. */
export const choices = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] as string }));
