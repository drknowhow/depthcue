import { readdirSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATES } from "../src/builtins.ts";
import { explain, type RawError } from "../src/diagnostics.ts";
import {
  brandSchema,
  COMMENT_OP_NAMES,
  commentOpsSchema,
  commentsSchema,
  deckSchema,
  OP_NAMES,
  opsSchema,
  sceneSchema,
  templateSchema,
} from "../src/schema.ts";
import { schemaValidator } from "../src/schemacheck.ts";

// Core checks every file and every operation with src/schemacheck.ts, which reads the schema objects at run time.
// These tests hold it to Ajv 8, compiled with the options core's generated validators used until schema 0.4: on every
// fixture, on every broken copy that one change to a valid value makes, and on seeded copies with several changes,
// both must accept the same values and report the same errors (keyword, params, instance and schema path, in order),
// so `explain` gives the same diagnostics.

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  discriminator: true,
  allowUnionTypes: true,
  unicode: false,
});

const decks = new URL("../../../fixtures/decks/", import.meta.url);
const json = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const deckDirs = readdirSync(decks, { withFileTypes: true }).filter((entry) => entry.isDirectory());
const fixtureDecks = deckDirs.map((dir) => json(new URL(`${dir.name}/deck.json`, decks)));
const fixtureScenes = deckDirs.flatMap((dir) => {
  const scenes = new URL(`${dir.name}/scenes/`, decks);
  return readdirSync(scenes).map((name) => json(new URL(name, scenes)));
});
const brandFixture = (path: string): unknown => json(new URL(`v0-4-brand/brand/${path}`, decks));

const frame = { x: 10, y: 20, w: 30, h: 40 };
const scene = fixtureScenes[0] as Record<string, unknown>;
const textBlock = { id: "note", type: "text", role: "body", text: "A note.", slot: "left", style: "callout" };
/** One valid operation of each kind, with every property it takes. */
const everyOp = [
  { op: "deck.set", set: { title: "A title", fonts: "modern" } },
  { op: "scene.add", scene, after: null },
  { op: "scene.remove", id: "opening" },
  { op: "scene.move", id: "opening", after: "demand" },
  { op: "scene.set", id: "opening", set: { title: "New", template: "section", layout: null } },
  { op: "scene.upgrade", id: "opening" },
  { op: "block.add", scene: "opening", block: textBlock, after: "opening-title" },
  { op: "block.remove", scene: "opening", id: "note" },
  { op: "block.move", scene: "opening", id: "note", after: null },
  { op: "block.set", scene: "opening", id: "note", set: { slot: "right", style: null } },
  { op: "block.frame", scene: "opening", id: "note", frame },
  { op: "block.unframe", scene: "opening", id: "note" },
  { op: "brand.set", set: { id: "acme", name: "Acme" } },
  { op: "style.set", id: "quiet", style: { name: "Quiet", for: ["body"] } },
  { op: "template.set", id: "plain", set: { name: "Plain", background: null } },
  {
    op: "slot.add",
    template: "plain",
    slot: { id: "aside", role: "content", frame, accepts: ["body"], hint: "A note." },
    after: "body",
  },
  { op: "slot.set", template: "plain", id: "aside", set: { max: 2, style: null } },
  { op: "slot.rename", template: "plain", id: "aside", to: "note" },
  { op: "slot.remove", template: "plain", id: "note", to: null },
  { op: "link.add", link: { id: "report", title: "Report", target: "assets/report.pdf" }, after: null },
  { op: "link.set", id: "report", set: { note: "The full report" } },
  { op: "link.remove", id: "report", to: "summary" },
];
const at = "2026-11-01T10:00:00.000Z";
const everyCommentOp = [
  {
    op: "comment.add",
    id: "c-one",
    scene: "opening",
    block: "opening-title",
    anchor: { x: 0.5, y: 0.25 },
    author: "you",
    text: "Shorter?",
    ask: true,
  },
  { op: "comment.reply", id: "c-one", author: "agent", text: "Done." },
  { op: "comment.resolve", id: "c-one" },
  { op: "comment.reopen", id: "c-one" },
  { op: "comment.delete", id: "c-one" },
];
const comments = {
  $schema: "../schema/comments.schema.json",
  format: "depthcue-comments/1",
  comments: [
    {
      id: "c-one",
      scene: "opening",
      block: "opening-title",
      anchor: { x: 0, y: 1 },
      thread: [
        { author: "you", text: "Shorter?", at },
        { author: "agent", text: "Done.", at: "2026-11-01T10:01:00Z" },
      ],
      resolved: false,
      ask: true,
    },
    {
      id: "c-two",
      scene: "demand",
      block: "demand-chart",
      anchor: { x: 0.3, y: 0.6 },
      thread: [{ author: "agent", text: "Is this the right year?", at }],
      resolved: true,
    },
  ],
};
const fullBrand = {
  schemaVersion: "0.4",
  id: "acme",
  name: "Acme",
  colors: {
    paper: { action: "#0B6E6E", bg: "#FFFFFF", chart: ["#0B6E6E", "#2D4BB8"] },
    ink: { text: "#F0F0F0" },
  },
  fonts: {
    display: {
      family: "Acme Sans",
      license: "OFL-1.1",
      files: [{ file: "fonts/a.woff2", weight: 700, style: "normal" }],
    },
    body: { family: "Acme Text", license: "OFL-1.1" },
    mono: { family: "Acme Mono" },
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
    {
      id: "title",
      role: "title",
      frame: { x: 5, y: 60, w: 90, h: 30 },
      accepts: ["heading"],
      hint: "The title.",
      max: 2,
      valign: "middle",
    },
    { id: "claim", role: "claim", frame: { x: 5, y: 5, w: 90, h: 30 }, hint: "The claim.", style: "big" },
  ],
};

/** Every `const` and `enum` string of a schema: the values that pick a branch, a role or a kind. */
function wordsOf(schema: unknown, out = new Set<string>()): string[] {
  if (Array.isArray(schema)) for (const item of schema) wordsOf(item, out);
  else if (schema !== null && typeof schema === "object") {
    const node = schema as Record<string, unknown>;
    if (typeof node.const === "string") out.add(node.const);
    if (Array.isArray(node.enum)) for (const word of node.enum) if (typeof word === "string") out.add(word);
    for (const value of Object.values(node)) wordsOf(value, out);
  }
  return [...out];
}

/** Values that break most keywords: other types, empty and overlong strings, edges of the number ranges, repeats. */
const OTHERS: readonly unknown[] = [
  null,
  7,
  1.5,
  -1,
  0,
  4.9,
  100,
  101,
  1000,
  true,
  "x",
  "",
  "Bad Value!",
  "a".repeat(241),
  "a".repeat(401),
  "a".repeat(1601),
  [],
  {},
  ["x", "x"],
  ["ab", 1, "ab"],
  [1, 1],
];

/** A small seeded generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every copy of `value` that one change makes: a key removed or added, a value of another type or another word. */
function* mutations(value: unknown, words: readonly string[], pick: () => number): Generator<unknown> {
  for (const other of OTHERS) yield other;
  if (typeof value === "string" && words.length > 0)
    for (let n = 0; n < 3; n++) yield words[Math.floor(pick() * words.length)];
  if (Array.isArray(value)) {
    if (value.length) yield [...value, value[0]];
    yield Array.from({ length: 30 }, () => value[0] ?? "x");
    for (const [index, item] of value.entries())
      for (const changed of mutations(item, words, pick))
        yield value.map((entry, i) => (i === index ? changed : entry));
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    yield { ...record, zzz: 1 };
    const first = record[Object.keys(record)[0] ?? ""] ?? 1;
    yield { ...record, Bad_Name: first };
    yield { ...record, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`extra-${i}`, first])) };
    // A key that every object inherits, which an own-property test must still call unknown.
    yield { constructor: 1, ...record };
    for (const key of Object.keys(record)) {
      const { [key]: _, ...rest } = record;
      yield rest;
      for (const changed of mutations(record[key], words, pick)) yield { ...record, [key]: changed };
    }
  }
}

/** A copy of `value` with `count` changes at random places, each one of the changes `mutations` makes. */
function scrambled(value: unknown, count: number, words: readonly string[], pick: () => number): unknown {
  let result = structuredClone(value);
  for (let n = 0; n < count; n++) {
    const places: Array<{ parent: Record<string, unknown> | unknown[] | null; key: string | number }> = [
      { parent: null, key: "" },
    ];
    const walk = (node: unknown) => {
      if (Array.isArray(node))
        node.forEach((item, i) => {
          places.push({ parent: node, key: i });
          walk(item);
        });
      else if (node !== null && typeof node === "object")
        for (const [key, item] of Object.entries(node)) {
          places.push({ parent: node as Record<string, unknown>, key });
          walk(item);
        }
    };
    walk(result);
    const place = places[Math.floor(pick() * places.length)] as (typeof places)[number];
    const current = place.parent === null ? result : (place.parent as Record<string, unknown>)[place.key];
    const options = [...mutations(current, words, pick)].slice(0, 60);
    const changed = structuredClone(options[Math.floor(pick() * options.length)]);
    if (place.parent === null) result = changed;
    else if (!Array.isArray(place.parent) && pick() < 0.15) delete place.parent[place.key as string];
    else (place.parent as Record<string, unknown>)[place.key] = changed;
  }
  return result;
}

const raw = (errors: readonly RawError[] | null | undefined) =>
  (errors ?? []).map(({ instancePath, schemaPath, keyword, params }) => ({
    instancePath,
    schemaPath,
    keyword,
    params,
  }));

/** What Ajv reported across all the cases, as keyword and the kind of place, to show the cases reach every keyword. */
const reached = new Set<string>();

/** Runs both validators on each value; returns how many it ran and the first few values they disagree on. */
function compare(schema: object, values: Iterable<unknown>) {
  const ours = schemaValidator(schema);
  const theirs = ajv.getSchema((schema as { $id: string }).$id) ?? ajv.compile(schema);
  let count = 0;
  let invalid = 0;
  const differ: unknown[] = [];
  for (const value of values) {
    count++;
    const valid = theirs(value);
    if (!valid) invalid++;
    for (const error of theirs.errors ?? []) {
      reached.add(error.keyword === "discriminator" ? `discriminator:${error.params.error}` : error.keyword);
      if (error.schemaPath.includes("/allOf/")) reached.add(`allOf:${error.keyword}`);
    }
    const same =
      ours(value) === valid &&
      JSON.stringify(raw(ours.errors)) === JSON.stringify(raw(theirs.errors)) &&
      JSON.stringify(explain(ours.errors, value, schema, "f.json")) ===
        JSON.stringify(explain(theirs.errors, value, schema, "f.json"));
    if (!same && differ.length < 3) differ.push({ value, ours: raw(ours.errors), ajv: raw(theirs.errors) });
  }
  return { count, invalid, differ };
}

/** The one-change copies of each sample, and `seeded` copies with two to four changes. */
function* variants(schema: object, samples: readonly unknown[], seeded: number, seed: number) {
  const words = wordsOf(schema);
  const pick = random(seed);
  for (const sample of samples) {
    yield sample;
    yield* mutations(sample, words, pick);
  }
  for (let n = 0; n < seeded; n++) {
    const sample = samples[n % samples.length];
    yield scrambled(sample, 2 + Math.floor(pick() * 3), words, pick);
  }
}

const CASES: ReadonlyArray<[name: string, schema: object, samples: () => unknown[], seeded: number]> = [
  ["deck.json", deckSchema, () => fixtureDecks, 3000],
  ["a scene", sceneSchema, () => fixtureScenes, 4000],
  ["operations", opsSchema, () => [everyOp, ...everyOp.map((op) => [op])], 4000],
  ["comments.json", commentsSchema, () => [comments, { format: "depthcue-comments/1", comments: [] }], 3000],
  ["comment operations", commentOpsSchema, () => [everyCommentOp, ...everyCommentOp.map((op) => [op])], 3000],
  ["brand.json", brandSchema, () => [brandFixture("brand.json"), fullBrand], 3000],
  [
    "a template",
    templateSchema,
    () => [
      brandFixture("templates/cover.json"),
      brandFixture("templates/chart-and-note.json"),
      ...Object.values(BUILT_IN_TEMPLATES),
      imageTemplate,
    ],
    3000,
  ],
];

describe("schemaValidator against Ajv", () => {
  it("has a sample of every operation and every comment operation", () => {
    expect(everyOp.map((op) => op.op)).toEqual([...OP_NAMES]);
    expect(everyCommentOp.map((op) => op.op)).toEqual([...COMMENT_OP_NAMES]);
    expect(fixtureDecks.length).toBeGreaterThanOrEqual(6);
    expect(fixtureScenes.length).toBeGreaterThanOrEqual(20);
  });

  for (const [name, schema, samples, seeded] of CASES) {
    it(`accepts and refuses the same ${name} files, with the same errors`, () => {
      const all = samples();
      const ours = schemaValidator(schema);
      for (const sample of all) expect(ours(sample), JSON.stringify(ours.errors)).toBe(true);
      const result = compare(schema, variants(schema, all, seeded, name.length));
      expect(result.differ).toEqual([]);
      expect(result.count).toBeGreaterThan(seeded + 500);
      expect(result.invalid).toBeGreaterThan(result.count / 2);
    }, 120_000);
  }

  it("reached every keyword the schemas use, both ways a tag can fail, and the limits text roles add", () => {
    expect([...reached].sort()).toEqual(
      [
        "additionalProperties",
        "allOf:if",
        "allOf:maxLength",
        "allOf:type",
        "const",
        "dependencies",
        "discriminator:mapping",
        "discriminator:tag",
        "enum",
        "if",
        "maxItems",
        "maxLength",
        "maxProperties",
        "maximum",
        "minItems",
        "minLength",
        "minProperties",
        "minimum",
        "pattern",
        "propertyNames",
        "required",
        "type",
        "uniqueItems",
      ].sort(),
    );
  });
});

describe("schemaValidator", () => {
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

  it("picks the branch an operation names, and says when it names none", () => {
    const validate = schemaValidator(opsSchema);
    validate([{ op: "scene.remove" }, { op: "scene.delete", id: "x" }, { id: "x" }]);
    expect(validate.errors).toEqual([
      {
        instancePath: "/0",
        schemaPath: "#/items/oneOf/2/required",
        keyword: "required",
        params: { missingProperty: "id" },
      },
      {
        instancePath: "/1",
        schemaPath: "#/items/discriminator",
        keyword: "discriminator",
        params: { error: "mapping", tag: "op", tagValue: "scene.delete" },
      },
      {
        instancePath: "/2",
        schemaPath: "#/items/discriminator",
        keyword: "discriminator",
        params: { error: "tag", tag: "op", tagValue: undefined },
      },
    ]);
  });

  it("sets errors to null on a valid value, as Ajv does", () => {
    const validate = schemaValidator(templateSchema);
    validate({});
    expect(validate.errors?.length).toBeGreaterThan(0);
    validate(imageTemplate);
    expect(validate.errors).toBeNull();
  });

  it("throws on a keyword or a use of one it does not know, so a schema edit cannot pass unchecked", () => {
    expect(() => schemaValidator({ type: "object", anyOf: [] })({})).toThrow(/unsupported keyword anyOf/);
    expect(() => schemaValidator({ type: "object", oneOf: [] })({})).toThrow(/oneOf works only with/);
    expect(() =>
      schemaValidator({ type: "array", uniqueItems: true, items: { type: "object" } })([]),
    ).toThrow(/uniqueItems works only/);
  });

  it("throws on a form of a known keyword it does not read, before looking at any value", () => {
    const branch = { type: "object", properties: { kind: { const: "a" } } };
    const forms: Array<[string, object]> = [
      ["items", { type: "array", items: [{ type: "string" }] }],
      ["items", { type: "array", items: true }],
      ["additionalProperties", { type: "object", additionalProperties: true }],
      ["additionalProperties", { type: "object", additionalProperties: [] }],
      ["propertyNames", { type: "object", propertyNames: false }],
      ["properties", { type: "object", properties: { a: true } }],
      ["properties", { type: "object", properties: [{ type: "string" }] }],
      ["allOf", { allOf: [true] }],
      ["allOf", { allOf: { type: "string" } }],
      ["oneOf", { type: "object", discriminator: { propertyName: "kind" }, oneOf: [branch, false] }],
      // biome-ignore lint/suspicious/noThenProperty: then and else are JSON Schema keywords here, not a thenable
      ["if", { if: true, then: { type: "string" } }],
      // biome-ignore lint/suspicious/noThenProperty: as above
      ["then", { if: { type: "string" }, then: false }],
      ["else", { if: { type: "string" }, else: true }],
      ["dependencies", { type: "object", dependencies: { a: { required: ["b"] } } }],
      ["dependencies", { type: "object", dependencies: { a: true } }],
      ["dependencies", { type: "object", dependencies: { a: [1] } }],
      ["dependencies", { type: "object", dependencies: ["a"] }],
    ];
    for (const [keyword, schema] of forms) {
      // null reaches no keyword of these schemas but type, so only the look at the schema itself can throw.
      expect(() => schemaValidator(schema)(null), keyword).toThrow(
        `schemacheck: unsupported form of ${keyword}`,
      );
    }
    // The one boolean the schemas use is still read.
    const closed = schemaValidator({ type: "object", additionalProperties: false });
    expect(closed({ a: 1 })).toBe(false);
  });
});
