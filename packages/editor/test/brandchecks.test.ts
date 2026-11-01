import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND_FILE, type Deck } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import * as core from "../../core/src/brandcheck.ts";
import {
  BRAND_CHECKS_LOADING,
  checkBrandFile,
  checkTemplateFile,
  loadBrandChecks,
  readBrand,
  unusedBrand,
  waitedForBrandChecks,
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
    expect(unusedBrand(BRAND_FILE, {}, "warning")).toMatchObject({
      severity: "error",
      code: BRAND_CHECKS_LOADING,
    });
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
