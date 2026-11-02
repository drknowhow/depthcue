// What `deck_get` tells an agent about the templates and styles it may choose: the short answer names them, the
// detailed one carries the slots and hints. With Depthcue's own templates and styles in every deck the slots and hints
// alone are several thousand characters, which an agent should not pay for on every read.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getOutline, openDeck } from "../src/deck-api.ts";

const decks = fileURLToPath(new URL("../../../fixtures/decks", import.meta.url));

function open(name: string) {
  const opened = openDeck(`${decks}/${name}`);
  if (!opened.ok) throw new Error(`${name} should open`);
  return opened.doc;
}

describe("the outline an agent reads", () => {
  it("names the templates by id and name, and the styles by id", () => {
    const outline = getOutline(open("demo"));
    expect(outline.templates.length).toBeGreaterThan(5);
    for (const template of outline.templates) {
      expect(Object.keys(template).sort(), template.id).toEqual(["id", "name"]);
    }
    expect(outline.styles.length).toBeGreaterThan(0);
    for (const style of outline.styles) expect(typeof style).toBe("string");
    expect(JSON.stringify(outline)).not.toMatch(/"(slots|hint|accepts)"/);
  });

  it("marks a template the deck's brand wrote, in the short answer too", () => {
    const outline = getOutline(open("v0-4-brand"));
    expect(outline.templates.find((template) => template.id === "cover")).toEqual({
      id: "cover",
      name: expect.any(String),
      brand: true,
    });
    expect(outline.templates.some((template) => !("brand" in template))).toBe(true);
  });

  it("gives the slots, hints and style kinds when detailed", () => {
    const outline = getOutline(open("demo"), "detailed");
    expect(outline.templates.length).toBeGreaterThan(5);
    for (const template of outline.templates) {
      const slots = (template as { slots: Array<{ id: string; role: string; hint: string }> }).slots;
      expect(slots.length, template.id).toBeGreaterThan(0);
      for (const slot of slots) expect(slot.hint, `${template.id}.${slot.id}`).toMatch(/\w/);
    }
    for (const style of outline.styles)
      expect(style).toMatchObject({ id: expect.any(String), for: expect.any(Array) });
  });

  it("is far smaller than the detailed answer", () => {
    const concise = JSON.stringify(getOutline(open("demo"))).length;
    const detailed = JSON.stringify(getOutline(open("demo"), "detailed")).length;
    expect(concise * 3).toBeLessThan(detailed);
  });
});
