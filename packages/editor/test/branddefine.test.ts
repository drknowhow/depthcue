// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  applyOps,
  BRAND_LIMITS,
  blockStyleSchema,
  type Doc,
  loadDoc,
  type Op,
  PRESETS,
  revisionOf,
  type Scene,
  type Template,
} from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { STYLE_VALUES } from "../src/brandkit.ts";
import { brandColors, brandId, logoStatement } from "../src/brandpanel.ts";
import { slotRemove, slotRename, slotSet, templateSet, toWrite } from "../src/slotops.ts";
import { draftOf, putOnOps } from "../src/templatesave.ts";

const decks = resolve(import.meta.dirname, "../../../fixtures/decks");

/** A fixture deck as core reads it, with its brand's files listed. */
function fixture(name: string): Doc {
  const root = join(decks, name);
  const text: Record<string, string> = {};
  const assets: string[] = [];
  const brandFiles: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      const path = relative(root, full).split(sep).join("/");
      if (statSync(full).isDirectory()) walk(full);
      else if (path.endsWith(".json")) text[path] = readFileSync(full, "utf8");
      else if (path.startsWith("brand/")) brandFiles.push(path);
      else assets.push(path);
    }
  };
  walk(root);
  const { doc, diagnostics } = loadDoc({ text, assets, brandFiles });
  if (!doc) throw new Error(`${name} should load: ${JSON.stringify(diagnostics)}`);
  return doc;
}

const harbor = () => fixture("v0-4-brand");

/** The deck after `ops`, which core must take. */
function applied(doc: Doc, ops: Op[] | string): Doc {
  if (typeof ops === "string") throw new Error(`refused: ${ops}`);
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.doc;
}

const sceneOf = (doc: Doc, id: string) => doc.scenes[id] as Scene;
const templateOf = (doc: Doc, id: string) => doc.templates?.[id] as Template;

describe("the values a style's properties can take", () => {
  it("are the schema's, every one, so a value the schema adds cannot go unnamed", () => {
    for (const [prop, labels] of Object.entries(STYLE_VALUES)) {
      const schema = blockStyleSchema.properties[prop as keyof typeof blockStyleSchema.properties] as {
        enum?: readonly string[];
      };
      expect(Object.keys(labels).sort(), prop).toEqual([...(schema.enum ?? [])].sort());
    }
    const props = Object.keys(blockStyleSchema.properties).filter((key) => key !== "name" && key !== "for");
    expect(Object.keys(STYLE_VALUES).sort()).toEqual(props.sort());
  });
});

describe("starting a brand", () => {
  it("makes its id from the name, starting with a letter", () => {
    expect(brandId("Harbor Analytics")).toBe("harbor-analytics");
    expect(brandId("  Tidewell — Press! ")).toBe("tidewell-press");
    expect(brandId("2027 Plan")).toBe("brand-2027-plan");
    expect(brandId("")).toBe("brand");
    expect(brandId("!!")).toBe("brand");
    expect(brandId("x".repeat(80))).toHaveLength(48);
  });
});

describe("the brand's colors", () => {
  it("are the preset's, with the brand's own over them, and no chart list", () => {
    const brand = harbor().brand as NonNullable<Doc["brand"]>;
    const paper = brandColors(brand, "paper");
    expect(paper.action).toBe(brand.colors?.paper?.action);
    expect(paper.bg).toBe(brand.colors?.paper?.bg ?? PRESETS.paper.bg);
    expect(paper).not.toHaveProperty("chart");
    expect(brandColors({ ...brand, colors: {} }, "ink")).toEqual({ ...PRESETS.ink });
  });
});

describe("where each logo shows", () => {
  it("warns that a light logo alone is what ink slides show, with no plate behind it", () => {
    const said = logoStatement(harbor());
    expect(said[0]).toEqual({ text: "Paper slides show the light logo, harbor.svg." });
    expect(said[1]?.warn).toBe(true);
    expect(said[1]?.text).toMatch(/^Ink slides show harbor\.svg too/);
    expect(said.map((line) => line.text)).toContain("This deck is on Paper, so its slides show harbor.svg.");
    // The cover has no chrome, so it says so.
    expect(said.at(-1)?.text).toMatch(/show(s)? no logo\.$/);
  });

  it("warns of nothing once there is a dark logo too, and says what an ink deck shows", () => {
    const doc = harbor();
    const brand = doc.brand as NonNullable<Doc["brand"]>;
    const both: Doc = {
      ...doc,
      deck: { ...doc.deck, theme: "ink" },
      brand: {
        ...brand,
        logos: { alt: "Harbor Analytics", light: "logos/harbor.svg", dark: "logos/harbor-dark.svg" },
      },
    };
    const said = logoStatement(both);
    expect(said.some((line) => line.warn)).toBe(false);
    expect(said[1]?.text).toBe("Ink slides show the dark logo, harbor-dark.svg.");
    expect(said[2]?.text).toBe("This deck is on Ink, so its slides show harbor-dark.svg.");
  });

  it("says there is no logo, and that none shows until the chrome has a corner for it", () => {
    const doc = harbor();
    const brand = doc.brand as NonNullable<Doc["brand"]>;
    const { logos: _logos, ...bare } = brand;
    expect(logoStatement({ ...doc, brand: bare })).toEqual([
      { text: "The brand has no logo yet. Add one for light slides, dark slides or both." },
    ]);
    const { logo: _logo, ...chrome } = brand.chrome ?? {};
    const unplaced = logoStatement({ ...doc, brand: { ...brand, chrome } });
    expect(unplaced.at(-1)).toEqual({
      text: "No slide shows a logo until it has a corner under Chrome.",
      warn: true,
    });
    expect(logoStatement(fixture("v0-3"))).toEqual([]);
  });
});

describe("the template editor's operations", () => {
  it("move one slot's frame, and take a property out with null, as one template.set core takes", () => {
    const doc = harbor();
    const ops = slotSet(doc, "chart-and-note", "note", {
      frame: { x: 64, y: 24, w: 26, h: 68 },
      style: null,
    });
    expect(ops).toHaveLength(1);
    const note = templateOf(applied(doc, ops), "chart-and-note").slots.find((slot) => slot.id === "note");
    expect(note?.frame).toEqual({ x: 64, y: 24, w: 26, h: 68 });
    expect(note).not.toHaveProperty("style");
  });

  it("rename a slot and every block in it, in one step", () => {
    const doc = harbor();
    const ops = slotRename(doc, "chart-and-note", "note", "aside");
    const after = applied(doc, ops);
    expect(templateOf(after, "chart-and-note").slots.map((slot) => slot.id)).toEqual([
      "title",
      "chart",
      "aside",
    ]);
    expect(sceneOf(after, "growth").blocks.find((block) => block.id === "growth-note")?.slot).toBe("aside");
    expect(slotRename(doc, "chart-and-note", "note", "chart")).toBe(
      'The template already has a slot "chart".',
    );
    expect(slotRename(doc, "chart-and-note", "note", "note")).toEqual([]);
  });

  it("refuse to remove a slot a block is in, naming the block and its scene, until told where it goes", () => {
    const doc = harbor();
    const refused = slotRemove(doc, "chart-and-note", "note");
    expect(typeof refused).toBe("string");
    expect(refused).toMatch(/^The note slot holds .*\(Growth\)\. Pin it where the slot was/);

    const pinned = applied(doc, slotRemove(doc, "chart-and-note", "note", null));
    const block = sceneOf(pinned, "growth").blocks.find((candidate) => candidate.id === "growth-note");
    expect(block?.slot).toBeUndefined();
    expect(block?.frame).toEqual({ x: 68, y: 24, w: 26, h: 68 });
    expect(templateOf(pinned, "chart-and-note").slots.map((slot) => slot.id)).toEqual(["title", "chart"]);
  });

  it("keep a template's last slot, and change only the brand's own templates", () => {
    const doc = harbor();
    const one = applied(doc, [
      { op: "template.set", id: "one", template: { ...toWrite(templateOf(doc, "cover")), name: "One" } },
    ]);
    const single = templateOf(one, "one");
    const trimmed: Doc = {
      ...one,
      templates: { ...one.templates, one: { ...single, slots: single.slots.slice(0, 1) } },
    };
    expect(slotRemove(trimmed, "one", single.slots[0]?.id as string)).toBe(
      "A template keeps at least one slot.",
    );
    expect(templateSet(doc, "title", { name: "Mine" })).toBe('The brand has no template "title".');
    expect(slotSet(doc, "chart-and-note", "nowhere", {})).toBe('The template has no slot "nowhere".');
  });
});

describe("Save as template", () => {
  it("makes a slot of each block of the scene, in order, with a role from its kind", () => {
    const doc = harbor();
    const draft = draftOf(doc, "context", () => undefined, "Context");
    if (typeof draft === "string") throw new Error(draft);
    const { template, from } = draft;
    expect(template.id).toBe("context");
    expect(template.name).toBe("Context");
    expect(from).toEqual(sceneOf(doc, "context").blocks.map((block) => block.id));
    expect(template.slots.map((slot) => [slot.id, slot.role])).toEqual([
      ["body", "body"],
      ["title", "title"],
      ["body-2", "body"],
      ["body-3", "body"],
    ]);
    // With nothing measured, the slots stack down the slide, inside it.
    for (const slot of template.slots) expect(slot.frame.y + slot.frame.h).toBeLessThanOrEqual(100);
  });

  it("takes a name no template of the brand or of Depthcue has, and refuses a scene with too many blocks", () => {
    const doc = harbor();
    const taken = draftOf(doc, "growth", () => undefined, "Chart and note");
    if (typeof taken === "string") throw new Error(taken);
    expect(taken.template.id).not.toBe("chart-and-note");
    const builtIn = draftOf(doc, "growth", () => undefined, "Title");
    if (typeof builtIn === "string") throw new Error(builtIn);
    expect(builtIn.template.id).not.toBe("title");

    const scene = sceneOf(doc, "context");
    const many = Array.from({ length: BRAND_LIMITS.slots + 1 }, (_, at) => ({
      ...(scene.blocks[1] as Scene["blocks"][number]),
      id: `many-${at}`,
    }));
    const crowded: Doc = { ...doc, scenes: { ...doc.scenes, context: { ...scene, blocks: many } } };
    expect(draftOf(crowded, "context", () => undefined)).toMatch(/a template holds \d+ slots at most/);
  });

  it("puts the scene on the template it made, each block in the slot it made, as core takes it", () => {
    const doc = harbor();
    const draft = draftOf(doc, "context", () => undefined, "Context");
    if (typeof draft === "string") throw new Error(draft);
    const { id, schemaVersion: _version, ...template } = draft.template;
    const saved = applied(doc, [{ op: "template.set", id, template }]);
    const after = applied(
      saved,
      putOnOps(saved, "context", draft, () => undefined),
    );
    const scene = sceneOf(after, "context");
    expect(scene.template).toBe(id);
    expect(scene.blocks.map((block) => [block.id, block.slot, block.frame])).toEqual(
      draft.from.map((block, at) => [block, draft.template.slots[at]?.id, undefined]),
    );
  });
});
