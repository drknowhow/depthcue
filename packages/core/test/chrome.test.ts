import { describe, expect, it } from "vitest";
import {
  applyOps,
  type Bands,
  bandsOf,
  type ChromeDeck,
  checkChromeDeck,
  checkChromeFields,
  checkDeckFiles,
  type Doc,
  fieldsIn,
  fillChrome,
  resolveChrome,
  revisionOf,
  sectionOf,
} from "../src/index.ts";
import { brandDir, demoDoc, loadDir } from "./helpers.ts";

/* A header and footer say the same thing wherever they are drawn: one resolver, tested here on its own. */

const deck = (over: Partial<ChromeDeck> = {}): ChromeDeck => ({
  title: "Annual review",
  slides: [
    { id: "cover", title: "Annual review", template: "title" },
    { id: "part-one", title: "Results", template: "section" },
    { id: "revenue", title: "Revenue" },
    { id: "costs", title: "Costs" },
    { id: "part-two", title: "Outlook", template: "section" },
    { id: "plan", title: "The plan" },
  ],
  ...over,
});

const bands = (over: Partial<Bands> = {}): Bands => ({
  header: { start: "{deck}", end: "{section}" },
  footer: { center: "{number} / {count}", end: "{date}" },
  ...over,
});

describe("bandsOf", () => {
  it("reads an old footer line and slide number as zones", () => {
    expect(
      bandsOf({ footer: { text: "Acme", place: "start" }, number: { place: "end" }, accent: "none" }),
    ).toEqual({ header: {}, footer: { start: "Acme", end: "{number}" } });
  });

  it("puts a footer line and a number at the same place side by side, as they were drawn", () => {
    expect(bandsOf({ footer: { text: "Acme", place: "end" }, number: { place: "end" } }).footer).toEqual({
      end: "Acme  {number}",
    });
  });

  it("lets a zone of the bands win over an old part at its place", () => {
    const both = bandsOf({
      footer: { text: "Old", place: "start" },
      number: { place: "end" },
      bands: { footer: { start: "New" } },
    });
    expect(both.footer).toEqual({ start: "New", end: "{number}" });
  });

  it("is empty for a brand with no chrome", () => {
    expect(bandsOf(undefined)).toEqual({ header: {}, footer: {} });
  });
});

describe("fields", () => {
  it("finds the names between braces", () => {
    expect(fieldsIn("{number} of {count} {nope}")).toEqual(["number", "count", "nope"]);
  });

  it("fills known fields and leaves an unknown name as written", () => {
    expect(fillChrome("{deck}, {nope}", { deck: "Annual" })).toBe("Annual, {nope}");
  });

  it("fills a field with no value with nothing, and trims", () => {
    expect(fillChrome("{section} ", {})).toBe("");
  });
});

describe("resolveChrome", () => {
  it("fills every field for a slide", () => {
    const shown = resolveChrome(bands(), deck({ date: "March 2027" }), 2);
    expect(shown).toEqual({
      mode: "full",
      number: 3,
      section: "Results",
      header: { start: "Annual review", end: "Results" },
      footer: { center: "3 / 6", end: "March 2027" },
    });
  });

  it("starts the numbers where the deck says", () => {
    expect(resolveChrome(bands(), deck({ numbering: { start: 0 } }), 0).number).toBe(0);
    expect(resolveChrome(bands(), deck({ numbering: { start: 10 } }), 2).number).toBe(12);
  });

  it("shows no number on a template the deck skips, and still counts that slide", () => {
    const skipping = deck({ numbering: { skip: ["title", "section"] } });
    const cover = resolveChrome(bands(), skipping, 0);
    expect(cover.number).toBeUndefined();
    expect(cover.footer.center).toBe("/ 6");
    expect(resolveChrome(bands(), skipping, 2).number).toBe(3);
  });

  it("names the section from the nearest section slide at or before the slide", () => {
    const slides = deck();
    expect(sectionOf(slides, 0)).toBeUndefined();
    expect(sectionOf(slides, 1)).toBe("Results");
    expect(sectionOf(slides, 3)).toBe("Results");
    expect(sectionOf(slides, 4)).toBe("Outlook");
    expect(sectionOf(slides, 5)).toBe("Outlook");
  });

  it("leaves a zone out when everything in it is empty", () => {
    const shown = resolveChrome(bands(), deck(), 0);
    expect(shown.header).toEqual({ start: "Annual review" });
    expect(shown.footer).toEqual({ center: "1 / 6" });
  });

  it("takes the slide's own setting over its template's, and shows no text unless it shows all", () => {
    const slides = deck({ templateChrome: { section: "minimal" } });
    expect(resolveChrome(bands(), slides, 1).mode).toBe("minimal");
    expect(resolveChrome(bands(), slides, 1).header).toEqual({});
    const own = deck({
      templateChrome: { section: "minimal" },
      slides: [
        { id: "a", title: "A", template: "section", chrome: "full" },
        { id: "b", title: "B", chrome: "none" },
      ],
    });
    expect(resolveChrome(bands(), own, 0).mode).toBe("full");
    expect(resolveChrome(bands(), own, 1)).toMatchObject({ mode: "none", header: {}, footer: {} });
  });

  it("gives a slide that is not there nothing", () => {
    expect(resolveChrome(bands(), deck(), 99)).toMatchObject({ mode: "full", header: {}, footer: {} });
  });
});

describe("checks", () => {
  it("reports a field that is not one, at the zone that has it", () => {
    const found = checkChromeFields({ bands: { header: { end: "{chapter}" } } }, "brand/brand.json");
    expect(found).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "chrome-unknown-field",
        path: "/chrome/bands/header/end",
      }),
    ]);
    expect(found[0]?.fix).toContain("{number}");
  });

  it("reports nothing for the fields it has", () => {
    expect(
      checkChromeFields({ bands: { footer: { start: "{number} {count} {title}" } } }, "brand.json"),
    ).toEqual([]);
  });

  it("warns about a date asked for and not given", () => {
    const chrome = { bands: { footer: { end: "{date}" } } };
    expect(checkChromeDeck(chrome, deck(), "deck.json").map((d) => d.code)).toEqual(["chrome-no-date"]);
    expect(checkChromeDeck(chrome, deck({ date: "Today" }), "deck.json")).toEqual([]);
  });

  it("warns about a section asked for in a deck with no section slide", () => {
    const chrome = { bands: { header: { end: "{section}" } } };
    const plain = deck({ slides: [{ id: "a", title: "A" }] });
    expect(checkChromeDeck(chrome, plain, "deck.json").map((d) => d.code)).toEqual(["chrome-no-section"]);
    expect(checkChromeDeck(chrome, deck(), "deck.json")).toEqual([]);
  });

  it("warns when the numbering skips every slide's template and the brand shows a number", () => {
    const chrome = { number: { place: "end" as const } };
    const everyone = deck({
      slides: [{ id: "a", title: "A", template: "title" }],
      numbering: { skip: ["title"] },
    });
    expect(checkChromeDeck(chrome, everyone, "deck.json").map((d) => d.code)).toEqual(["chrome-no-number"]);
    expect(checkChromeDeck(chrome, deck({ numbering: { skip: ["title"] } }), "deck.json")).toEqual([]);
  });
});

const run = (doc: Doc, ops: unknown) => applyOps(doc, ops, revisionOf(doc));

describe("the operations", () => {
  it("write a date and numbering on the deck and a chrome setting on a scene, and raise them to 0.7", () => {
    const result = run(demoDoc(), [
      { op: "deck.set", set: { date: "March 2027", numbering: { start: 0, skip: ["title"] } } },
      { op: "scene.set", id: "opening", set: { chrome: "none" } },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.doc.deck).toMatchObject({
      schemaVersion: "0.7",
      date: "March 2027",
      numbering: { start: 0, skip: ["title"] },
    });
    expect(result.doc.scenes.opening).toMatchObject({ schemaVersion: "0.7", chrome: "none" });
    expect(result.deckChanged).toBe(true);
    expect(result.changed).toEqual(["opening"]);
  });

  it("refuse a chrome setting that is not one, and a skip list with a repeat", () => {
    const bad = run(demoDoc(), [{ op: "scene.set", id: "opening", set: { chrome: "half" } }]);
    expect(bad.ok).toBe(false);
    const repeated = run(demoDoc(), [{ op: "deck.set", set: { numbering: { skip: ["title", "title"] } } }]);
    expect(repeated.ok).toBe(false);
  });

  it("delete them with null", () => {
    const first = run(demoDoc(), [{ op: "deck.set", set: { date: "March 2027" } }]);
    if (!first.ok) throw new Error("expected success");
    const second = run(first.doc, [{ op: "deck.set", set: { date: null } }]);
    if (!second.ok) throw new Error("expected success");
    expect(second.doc.deck.date).toBeUndefined();
  });
});

/** The brand fixture with its chrome bands replaced. */
function withBands(bands: unknown) {
  const files = loadDir(brandDir);
  const brand = JSON.parse(files.text["brand/brand.json"] as string);
  brand.chrome.bands = bands;
  return { ...files, text: { ...files.text, "brand/brand.json": JSON.stringify(brand) } };
}

describe("a deck folder", () => {
  it("passes with bands whose fields are known", () => {
    const files = withBands({ header: { start: "{deck}" }, footer: { center: "{number} / {count}" } });
    expect(checkDeckFiles(files).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("reports a field that is not one in the brand file", () => {
    const files = withBands({ header: { start: "{chapter}" } });
    expect(checkDeckFiles(files).map((d) => d.code)).toContain("chrome-unknown-field");
  });

  it("warns that {date} shows nothing in a deck with no date", () => {
    const files = withBands({ footer: { end: "{date}" } });
    expect(checkDeckFiles(files).map((d) => d.code)).toContain("chrome-no-date");
  });
});
