/**
 * JSON Schema source of truth for a deck folder (draft-07 keywords only).
 * `pnpm schema` writes the published .schema.json files and the compiled validators from these objects.
 */
export const SCHEMA_VERSION = "0.1" as const;

export const ID_PATTERN = "^[a-z][a-z0-9-]{1,63}$";
export const ASSET_PATTERN = "^assets/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$";
export const LANGUAGE_PATTERN = "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$";
export const URL_PATTERN = "^https?://[^\\s]+$";

export const LAYOUTS = ["title", "claim-evidence", "text-media"] as const;
export const THEMES = ["paper", "ink"] as const;
export const LEADS = ["human", "agent", "shared"] as const;
export const TEXT_ROLES = ["heading", "body", "caption", "quote"] as const;

/** Character limits per text role; the renderer measures real boxes, these keep the source honest. */
export const TEXT_LIMITS = { heading: 90, body: 600, caption: 160, quote: 300 } as const;

const id = { type: "string", pattern: ID_PATTERN } as const;
const idList = { type: "array", items: id, uniqueItems: true, maxItems: 32 } as const;
const assetPath = { type: "string", pattern: ASSET_PATTERN, maxLength: 200 } as const;
const schemaVersion = { const: SCHEMA_VERSION } as const;
const schemaRef = { type: "string", maxLength: 300 } as const;

const textBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "role", "text"],
  properties: {
    id,
    type: { const: "text" },
    role: { enum: TEXT_ROLES },
    text: { type: "string", minLength: 1, maxLength: TEXT_LIMITS.body },
    sourceIds: idList,
  },
  allOf: [
    {
      if: { properties: { role: { const: "heading" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_LIMITS.heading } } },
    },
    {
      if: { properties: { role: { const: "caption" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_LIMITS.caption } } },
    },
    {
      if: { properties: { role: { const: "quote" } }, required: ["role"] },
      then: { properties: { text: { type: "string", maxLength: TEXT_LIMITS.quote } } },
    },
  ],
} as const;

const imageBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "asset", "alt"],
  properties: {
    id,
    type: { const: "image" },
    asset: assetPath,
    alt: { type: "string", minLength: 1, maxLength: 250 },
    caption: { type: "string", minLength: 1, maxLength: TEXT_LIMITS.caption },
    sourceIds: idList,
  },
} as const;

const barChartBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "data"],
  properties: {
    id,
    type: { const: "bar-chart" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    unit: { type: "string", minLength: 1, maxLength: 16 },
    data: {
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 40 },
          value: { type: "number" },
        },
      },
    },
    sourceIds: idList,
  },
} as const;

const clipBlock = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "source", "alt"],
  properties: {
    id,
    type: { const: "clip" },
    source: assetPath,
    poster: assetPath,
    alt: { type: "string", minLength: 1, maxLength: 250 },
    sourceIds: idList,
  },
} as const;

const source = {
  type: "object",
  additionalProperties: false,
  required: ["id", "title"],
  properties: {
    id,
    title: { type: "string", minLength: 1, maxLength: 160 },
    asset: assetPath,
    url: { type: "string", pattern: URL_PATTERN, maxLength: 500 },
  },
} as const;

export const sceneSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.1:scene",
  title: "Depthcue scene",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "title", "layout", "blocks"],
  properties: {
    $schema: schemaRef,
    schemaVersion,
    id,
    title: { type: "string", minLength: 1, maxLength: 120 },
    layout: { enum: LAYOUTS },
    lead: { enum: LEADS },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["id", "text", "evidenceIds"],
      properties: {
        id,
        text: { type: "string", minLength: 1, maxLength: 280 },
        evidenceIds: idList,
      },
    },
    blocks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        discriminator: { propertyName: "type" },
        oneOf: [textBlock, imageBlock, barChartBlock, clipBlock],
      },
    },
    sources: { type: "array", maxItems: 32, items: source },
    reading: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 2000 } },
    },
    steps: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reveal"],
        properties: { id, reveal: { ...idList, minItems: 1 } },
      },
    },
    notes: { type: "string", maxLength: 4000 },
  },
} as const;

export const deckSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "urn:depthcue:schema:0.1:deck",
  title: "Depthcue deck manifest",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "title", "language", "theme", "scenes"],
  properties: {
    $schema: schemaRef,
    schemaVersion,
    id,
    title: { type: "string", minLength: 1, maxLength: 120 },
    language: { type: "string", pattern: LANGUAGE_PATTERN, maxLength: 35 },
    theme: { enum: THEMES },
    scenes: { type: "array", items: id, uniqueItems: true, minItems: 1, maxItems: 200 },
    modules: {
      type: "object",
      propertyNames: id,
      additionalProperties: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;
