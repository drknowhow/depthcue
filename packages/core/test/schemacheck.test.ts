import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATES } from "../src/builtins.ts";
import { explain } from "../src/diagnostics.ts";
import { brandSchema, templateSchema } from "../src/schema.ts";
import { schemaValidator } from "../src/schemacheck.ts";

// The brand and template files are checked by src/schemacheck.ts instead of Ajv's compiled code. These tests hold it to
// Ajv, compiled with the options scripts/build-schema.mjs uses for the other schemas: on valid files and on every
// broken copy that one change to a valid file makes, both must give the same diagnostics in the same order.

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  discriminator: true,
  allowUnionTypes: true,
  unicode: false,
});
const fixture = (path: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/decks/v0-4-brand/brand/${path}`, import.meta.url), "utf8"),
  );

const fullBrand = {
  schemaVersion: "0.4",
  id: "acme",
  name: "Acme",
  colors: { paper: { action: "#0B6E6E", bg: "#FFFFFF" }, ink: { text: "#F0F0F0" } },
  chart: ["#0B6E6E", "#2D4BB8"],
  fonts: {
    display: {
      family: "Acme Sans",
      license: "OFL-1.1",
      files: [{ file: "fonts/a.woff2", weight: 700, style: "normal" }],
    },
    body: { family: "Acme Text", license: "OFL-1.1" },
    mono: { family: "Acme Mono", license: "OFL-1.1" },
    fallback: "modern",
  },
  logos: { light: "logos/a.svg", dark: "logos/b.png", alt: "Acme" },
  chrome: {
    logo: { corner: "top-end", size: "s" },
    footer: { text: "Acme", place: "start" },
    number: { place: "end" },
    accent: "top",
  },
  styles: { quiet: { name: "Quiet", for: ["body", "caption"], tone: "muted", fill: "surface", pad: "m" } },
  lock: true,
  hideBuiltIn: ["templates"],
};
const imageTemplate = {
  schemaVersion: "0.4",
  id: "photo",
  name: "Photo",
  description: "A photo with a title over it.",
  background: { color: "text", image: "images/cover.jpg", scrim: 40 },
  chrome: "none",
  slots: [
    { id: "title", frame: { x: 5, y: 60, w: 90, h: 30 }, accepts: ["heading"], hint: "The title.", max: 2 },
  ],
};

/** Every copy of `value` that one change makes: a key removed or added, a value of another type, a bad string. */
function* mutations(value: unknown): Generator<unknown> {
  const others = [null, 7, 1.5, -1, 1000, true, "x", "", "Bad Value!", "a".repeat(400), [], {}, ["x", "x"]];
  for (const other of others) yield other;
  if (Array.isArray(value)) {
    if (value.length) yield [...value, value[0]];
    yield Array.from({ length: 20 }, () => value[0] ?? "x");
    for (const [index, item] of value.entries())
      for (const changed of mutations(item)) yield value.map((entry, i) => (i === index ? changed : entry));
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    yield { ...record, zzz: 1 };
    yield { ...record, Bad_Name: record[Object.keys(record)[0] ?? ""] ?? 1 };
    for (const key of Object.keys(record)) {
      const { [key]: _, ...rest } = record;
      yield rest;
      for (const changed of mutations(record[key])) yield { ...record, [key]: changed };
    }
  }
}

function agree(schema: object, values: Iterable<unknown>): number {
  const ours = schemaValidator(schema);
  const theirs = ajv.getSchema((schema as { $id: string }).$id) ?? ajv.compile(schema);
  let count = 0;
  for (const value of values) {
    const valid = theirs(value);
    expect(ours(value)).toBe(valid);
    expect(explain(ours.errors, value, schema, "f.json")).toEqual(
      explain(theirs.errors, value, schema, "f.json"),
    );
    const raw = (errors: typeof ours.errors) =>
      (errors ?? []).map(({ instancePath, schemaPath, keyword, params }) => ({
        instancePath,
        schemaPath,
        keyword,
        params,
      }));
    expect(raw(ours.errors)).toEqual(raw(theirs.errors));
    count++;
  }
  return count;
}

describe("schemaValidator", () => {
  it("accepts what Ajv accepts and explains what it refuses the same way, for brands", () => {
    for (const brand of [fixture("brand.json"), fullBrand]) {
      expect(schemaValidator(brandSchema)(brand)).toBe(true);
      expect(agree(brandSchema, mutations(brand))).toBeGreaterThan(500);
    }
  });

  it("does the same for templates, the fixture's, the built-ins and one with a background image", () => {
    const templates = [
      fixture("templates/cover.json"),
      fixture("templates/chart-and-note.json"),
      ...Object.values(BUILT_IN_TEMPLATES),
      imageTemplate,
    ];
    for (const template of templates) {
      expect(schemaValidator(templateSchema)(template)).toBe(true);
      expect(agree(templateSchema, mutations(template))).toBeGreaterThan(300);
    }
  });

  it("names both places of a repeat and the missing partner of a dependency", () => {
    const validate = schemaValidator(templateSchema);
    validate({ ...imageTemplate, background: { color: "bg", image: "images/a.jpg" } });
    expect(validate.errors).toEqual([
      {
        instancePath: "/background",
        schemaPath: "#/properties/background/dependencies",
        keyword: "dependencies",
        params: { property: "image", missingProperty: "scrim", depsCount: 1, deps: "scrim" },
      },
    ]);
    const slot = { ...imageTemplate.slots[0], accepts: ["heading", "body", "heading"] };
    validate({ ...imageTemplate, slots: [slot] });
    expect(validate.errors?.map((error) => [error.keyword, error.params])).toEqual([
      ["uniqueItems", { i: 0, j: 2 }],
    ]);
  });

  it("sets errors to null on a valid value, as Ajv does", () => {
    const validate = schemaValidator(templateSchema);
    validate({});
    expect(validate.errors?.length).toBeGreaterThan(0);
    validate(imageTemplate);
    expect(validate.errors).toBeNull();
  });

  it("throws on a keyword it does not know, so a schema edit cannot pass unchecked", () => {
    expect(() => schemaValidator({ type: "object", oneOf: [] })({})).toThrow(/unsupported keyword oneOf/);
  });
});
