import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND_FILE, type Deck } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import * as core from "../../core/src/brandcheck.ts";
import * as coreBuiltIns from "../../core/src/builtins.ts";
import {
  BRAND_CHECKS_LOADING,
  BUILT_IN_STYLES,
  BUILT_IN_TEMPLATES,
  builtInsLoaded,
  checkBrandFile,
  checkTemplateFile,
  loadBrandChecks,
  loadBuiltIns,
  readBrand,
  unusedBrand,
  waitedForBrandChecks,
  waitedForBuiltIns,
} from "../src/brandchecks.ts";

const fixture = resolve(import.meta.dirname, "../../../fixtures/decks/v0-4-brand");
const json = (path: string): unknown => JSON.parse(readFileSync(join(fixture, path), "utf8"));
const deck = json("deck.json") as Deck;
const data = {
  brand: json("brand/brand.json"),
  templates: Object.fromEntries(
    readdirSync(join(fixture, "brand/templates")).map((name) => [
      name.slice(0, -".json".length),
      json(`brand/templates/${name}`),
    ]),
  ),
};
const brandFiles = new Set([
  "brand/fonts/HarborSans-Bold.woff2",
  "brand/fonts/HarborSans-Regular.woff2",
  "brand/logos/harbor.svg",
]);

describe("the editor's stand-in for core's brand checks", () => {
  it("answers with an error and starts fetching until the checks are in, then answers as core does", async () => {
    const early = readBrand(deck, data, brandFiles);
    expect(early).toEqual({
      diagnostics: [
        expect.objectContaining({ severity: "error", code: BRAND_CHECKS_LOADING, file: BRAND_FILE }),
      ],
    });
    expect(waitedForBrandChecks(early.diagnostics)).toBe(true);
    expect(checkTemplateFile({}, "cover")).toEqual([
      expect.objectContaining({ code: BRAND_CHECKS_LOADING, file: "brand/templates/cover.json" }),
    ]);
    // A deck without a brand needs this one, at the severity it asks for, so it does not wait for the chunk.
    expect(unusedBrand(BRAND_FILE, {}, "warning")).toMatchObject({
      severity: "warning",
      code: "unused-brand",
    });
    expect(unusedBrand(BRAND_FILE, {}, "error")).toMatchObject({ severity: "error", code: "unused-brand" });
    // The first check started the fetch: every later call waits on that one.
    expect(loadBrandChecks()).toBe(loadBrandChecks());

    await loadBrandChecks();
    const read = readBrand(deck, data, brandFiles);
    expect(read).toEqual(core.readBrand(deck, data, brandFiles));
    expect(waitedForBrandChecks(read.diagnostics)).toBe(false);
    expect(checkBrandFile({ id: "x" })).toEqual(core.checkBrandFile({ id: "x" }));
    expect(unusedBrand(BRAND_FILE, {}, "warning")).toEqual(core.unusedBrand(BRAND_FILE, {}, "warning"));
  });
});

describe("the editor's stand-in for core's built-in templates and styles", () => {
  const unknown = (code: string) => [
    { severity: "error", code, file: "scenes/a.json", path: "/template", message: "", fix: "" } as const,
  ];

  it("holds empty records until the chunk is in, and tells a template not there yet from a wrong one", async () => {
    expect(builtInsLoaded()).toBe(false);
    expect(BUILT_IN_TEMPLATES).toEqual({});
    expect(BUILT_IN_STYLES).toEqual({});
    expect(waitedForBuiltIns(unknown("unknown-template"))).toBe(true);
    expect(waitedForBuiltIns(unknown("unknown-style"))).toBe(true);
    // Anything but an unknown id is not for the built-ins to settle.
    expect(waitedForBuiltIns(unknown("missing-slot"))).toBe(false);
    expect(waitedForBuiltIns([])).toBe(false);
    // One fetch for every call, started by the first.
    expect(loadBuiltIns()).toBe(loadBuiltIns());

    await loadBuiltIns();
    expect(builtInsLoaded()).toBe(true);
    expect(BUILT_IN_TEMPLATES).toEqual(coreBuiltIns.BUILT_IN_TEMPLATES);
    expect(BUILT_IN_STYLES).toEqual(coreBuiltIns.BUILT_IN_STYLES);
    // Now the same error is the deck's own, so nothing is left to wait for.
    expect(waitedForBuiltIns(unknown("unknown-template"))).toBe(false);
  });
});
