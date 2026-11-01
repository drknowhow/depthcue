import type { BlockStyle, DeckLook, Template, TemplateSlot } from "@depthcue/core";

/** The nine colors of a theme, in values nothing else in a test uses, so a test can tell where each one landed. */
export const COLORS: DeckLook["colors"] = {
  bg: "#101820",
  surface: "#182430",
  line: "#304050",
  text: "#f0f4f8",
  muted: "#b0bcc8",
  action: "#ff7755",
  evidence: "#88aaff",
  state: "#445566",
  "on-state": "#f8f8f8",
};

/** A look with nothing a brand adds, which a test then adds to. */
export function lookWith(parts: Partial<DeckLook> = {}): DeckLook {
  return { theme: "ink", colors: COLORS, chart: [], fonts: "modern", styles: {}, templates: {}, ...parts };
}

export function slot(id: string, role: TemplateSlot["role"], frame: TemplateSlot["frame"], more: Partial<TemplateSlot> = {}) {
  return { id, role, frame, hint: `The ${id}.`, ...(role === "claim" ? {} : { accepts: ["text"] }), ...more } as TemplateSlot;
}

export function template(id: string, slots: TemplateSlot[], more: Partial<Template> = {}): Template {
  return { schemaVersion: "0.4", id, name: id, description: `The ${id} template.`, slots, ...more } as Template;
}

export const style = (parts: Partial<BlockStyle> = {}): BlockStyle =>
  ({ name: "A style", for: ["body"], ...parts }) as BlockStyle;

/** Two columns and a claim across the top: the shape most of the tests below draw. */
export const SPLIT = template("split", [
  slot("claim", "claim", { x: 6, y: 8, w: 88, h: 20 }),
  slot("left", "body", { x: 6, y: 34, w: 42, h: 50 }, { valign: "middle" }),
  slot("right", "content", { x: 52, y: 34, w: 42, h: 50 }),
]);
