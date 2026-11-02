import { describe, expect, it } from "vitest";
import {
  BRAND_LIMITS,
  BUILT_IN_STYLES,
  BUILT_IN_TEMPLATES,
  blockStylesOf,
  brandPartOf,
  checkTemplate,
  checkTemplateFile,
  PRESETS,
  styleOf,
  type Template,
} from "../src/index.ts";
import { brandDoc } from "./helpers.ts";

const templates = Object.values(BUILT_IN_TEMPLATES) as Template[];
const slotsOf = (id: string) => (BUILT_IN_TEMPLATES[id] as Template).slots;

describe("Depthcue's own templates", () => {
  it("are the ten a deck starts from, with the ids and slot ids earlier decks use kept", () => {
    expect(Object.keys(BUILT_IN_TEMPLATES)).toEqual([
      "title",
      "section",
      "agenda",
      "statement",
      "big-number",
      "quote",
      "two-column",
      "comparison",
      "full-image",
      "closing",
    ]);
    expect(slotsOf("section").map((slot) => slot.id)).toEqual(["kicker", "title", "lede"]);
    expect(slotsOf("statement").map((slot) => slot.id)).toEqual(["claim", "evidence"]);
    expect(slotsOf("two-column").map((slot) => slot.id)).toEqual(["title", "left", "right"]);
    for (const [id, template] of Object.entries(BUILT_IN_TEMPLATES)) expect(template.id).toBe(id);
  });

  it("keep every slot as its own: a role, a place for its blocks and words for whoever fills it", () => {
    for (const template of templates) {
      expect(template.description.length, template.id).toBeLessThanOrEqual(BRAND_LIMITS.description);
      for (const slot of template.slots) {
        const at = `${template.id}/${slot.id}`;
        expect(slot.valign, at).toBeDefined();
        expect(slot.hint, at).toBeTruthy();
        expect((slot.hint ?? "").length, at).toBeLessThanOrEqual(BRAND_LIMITS.hint);
      }
    }
  });

  it("put the claim in a claim slot on a statement and a big number, and nowhere else", () => {
    const withClaim = templates.filter((template) => template.slots.some((slot) => slot.role === "claim"));
    expect(withClaim.map((template) => template.id)).toEqual(["statement", "big-number"]);
    for (const template of withClaim) {
      const claims = template.slots.filter((slot) => slot.role === "claim");
      expect(claims, template.id).toHaveLength(1);
      expect(claims[0]?.accepts).toBeUndefined();
      expect(claims[0]?.required).toBe(true);
    }
  });

  it("pass their own checks on both presets", () => {
    const looks = (["paper", "ink"] as const).map((theme) => ({ theme, colors: PRESETS[theme] }));
    for (const template of templates) {
      expect(checkTemplateFile(template, template.id, "f"), template.id).toEqual([]);
      expect(checkTemplate(template, BUILT_IN_STYLES, looks, new Set(), "f"), template.id).toEqual([]);
    }
  });

  it("pass them under a brand's palettes and styles, where the brand's style of an id replaces Depthcue's", () => {
    const doc = brandDoc();
    const styles = blockStylesOf(brandPartOf(doc));
    // The brand's own kicker is not Depthcue's, so this is a different check from the one above.
    expect(styles.kicker).not.toEqual(BUILT_IN_STYLES.kicker);
    const looks = (["paper", "ink"] as const).map((theme) => ({
      theme,
      colors: styleOf({ theme }, doc.brand).colors,
    }));
    for (const template of templates) {
      expect(checkTemplate(template, styles, looks, new Set(), "f"), template.id).toEqual([]);
    }
  });

  it("have a style for every one a slot names, and for every kind the slot takes", () => {
    for (const template of templates) {
      for (const slot of template.slots) {
        if (!slot.style) continue;
        const style = BUILT_IN_STYLES[slot.style];
        expect(style, `${template.id}/${slot.id}`).toBeDefined();
        for (const kind of slot.accepts ?? ["heading"]) {
          expect(style?.for, `${template.id}/${slot.id}`).toContain(kind);
        }
      }
    }
  });

  it("keep their text and pictures where a brand's chrome is not, whichever corner the brand chose", () => {
    // The logo is up to 14.4% of the height with its margin, the sources and the footer take the foot below 85%, and the
    // slide's edges are 6% in. A template that shows the chrome stays inside that; one that turns it off may not.
    for (const template of templates) {
      for (const slot of template.slots) {
        const { x, y, w, h } = slot.frame;
        const at = `${template.id}/${slot.id}`;
        expect(x + w, at).toBeLessThanOrEqual(100);
        expect(y + h, at).toBeLessThanOrEqual(100);
        if (template.chrome === "none") continue;
        expect(x, at).toBeGreaterThanOrEqual(6);
        expect(x + w, at).toBeLessThanOrEqual(94);
        expect(y, at).toBeGreaterThanOrEqual(15);
        expect(y + h, at).toBeLessThanOrEqual(85);
      }
    }
    // The ones whose point is a picture, or a color that fills the slide, give the chrome up or down.
    expect(Object.fromEntries(templates.map((template) => [template.id, template.chrome]))).toEqual({
      title: "minimal",
      section: "minimal",
      agenda: undefined,
      statement: undefined,
      "big-number": undefined,
      quote: undefined,
      "two-column": undefined,
      comparison: undefined,
      "full-image": "none",
      closing: "minimal",
    });
  });

  it("do not let two slots of one template lie over each other", () => {
    const apart = (a: Template["slots"][number], b: Template["slots"][number]): boolean =>
      a.frame.x + a.frame.w <= b.frame.x ||
      b.frame.x + b.frame.w <= a.frame.x ||
      a.frame.y + a.frame.h <= b.frame.y ||
      b.frame.y + b.frame.h <= a.frame.y;
    for (const template of templates) {
      template.slots.forEach((slot, i) => {
        for (const other of template.slots.slice(i + 1)) {
          expect(apart(slot, other), `${template.id}: ${slot.id} and ${other.id}`).toBe(true);
        }
      });
    }
  });

  it("give a brand's slide strong color no slot style that draws in a tone, which the check reads on the wrong ground", () => {
    // A slide on a strong color swaps its text and muted colors for the background's at draw time, but a template check
    // reads the palette's, so a toned slot style there is judged against colors the audience never sees.
    for (const template of templates.filter((candidate) => candidate.background?.color === "text")) {
      for (const slot of template.slots) {
        const style = slot.style ? BUILT_IN_STYLES[slot.style] : undefined;
        expect(style?.tone, `${template.id}/${slot.id}`).toBeUndefined();
      }
    }
  });
});

describe("Depthcue's own styles", () => {
  it("are the seven a template or a block can name, with the callout and the stat as before", () => {
    expect(Object.keys(BUILT_IN_STYLES)).toEqual([
      "callout",
      "stat",
      "kicker",
      "card",
      "highlight",
      "pull-quote",
      "label",
    ]);
    expect(BUILT_IN_STYLES.callout).toEqual({
      name: "Callout",
      for: ["body", "quote", "caption"],
      fill: "surface",
      edge: "start",
      radius: "s",
      pad: "m",
    });
    expect(BUILT_IN_STYLES.stat).toMatchObject({ for: ["heading", "body"], size: "xl", tone: "action" });
  });

  it("each say what kinds of block they are for and stay inside the limits", () => {
    for (const [id, style] of Object.entries(BUILT_IN_STYLES)) {
      expect(style.for.length, id).toBeGreaterThan(0);
      expect(style.name.length, id).toBeLessThanOrEqual(BRAND_LIMITS.styleName);
    }
  });
});
