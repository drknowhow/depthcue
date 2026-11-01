import type { RawError } from "./diagnostics.ts";

/**
 * A validator that reads a JSON Schema at run time, for the brand and template schemas. Compiled by Ajv, as the deck,
 * scene and operation schemas are, those two weighed about 10 KB gzip in core and 5 KB in the editor's script; this
 * walks the same schema objects that `pnpm schema` publishes, so the files and the checks cannot drift apart.
 *
 * It knows only the keywords those schemas use, and reports errors as Ajv does (keyword, params, instance and schema
 * paths, `allErrors` order), so `explain` reads them the same way. A test runs it beside Ajv on valid and broken
 * files and requires the same explained diagnostics. A keyword it does not know throws, so a schema edit that needs
 * one fails loudly in that test instead of passing unchecked.
 */
export interface SchemaValidator {
  (data: unknown): boolean;
  errors?: RawError[] | null;
}

type Schema = Readonly<Record<string, unknown>>;

/** Keywords that check nothing, and the ones handled where their parent keyword is. */
const QUIET = new Set(["$schema", "$id", "title", "description", "$comment", "then", "else"]);
const KNOWN = new Set([
  "type",
  "enum",
  "const",
  "if",
  "maximum",
  "minimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "items",
  "maxProperties",
  "minProperties",
  "required",
  "dependencies",
  "propertyNames",
  "additionalProperties",
  "properties",
]);
/** The keywords Ajv checks for each type of value, in the order it checks them, which `check` follows. */
const GROUPS = {
  number: ["maximum", "minimum"],
  string: ["maxLength", "minLength", "pattern"],
  array: ["maxItems", "minItems", "items", "uniqueItems"],
  object: [
    "maxProperties",
    "minProperties",
    "required",
    "propertyNames",
    "additionalProperties",
    "dependencies",
    "properties",
  ],
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasType(value: unknown, type: string): boolean {
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

const step = (key: string | number): string => `/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
const patterns = new Map<string, RegExp>();
const regex = (source: string): RegExp => {
  let found = patterns.get(source);
  if (!found) {
    found = new RegExp(source, "u");
    patterns.set(source, found);
  }
  return found;
};

function check(schema: Schema, data: unknown, at: string, path: string, errors: RawError[]): void {
  for (const keyword in schema)
    if (!KNOWN.has(keyword) && !QUIET.has(keyword))
      throw new Error(`schemacheck: unsupported keyword ${keyword}`);
  const fail = (keyword: string, params: Record<string, unknown>): void => {
    errors.push({ instancePath: at, schemaPath: `${path}/${keyword}`, keyword, params });
  };
  const types: readonly string[] =
    schema.type === undefined ? [] : ([] as string[]).concat(schema.type as string);
  const wrongType = types.length > 0 && !types.some((type) => hasType(data, type));
  // Ajv reports a wrong type first, unless the schema has one type and keywords for it: then after the untyped ones.
  const group = types.length === 1 ? GROUPS[types[0] as keyof typeof GROUPS] : undefined;
  const typed = group?.some((keyword) => keyword in schema) === true;
  if (wrongType && !typed) fail("type", { type: schema.type });
  if ("const" in schema && data !== schema.const) fail("const", { allowedValue: schema.const });
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) fail("enum", { allowedValues: schema.enum });
  if (isObject(schema.if)) {
    const branch = passes(schema.if, data) ? "then" : "else";
    const next = schema[branch];
    if (isObject(next)) {
      const before = errors.length;
      check(next, data, at, `${path}/${branch}`, errors);
      if (errors.length > before) fail("if", { failingKeyword: branch });
    }
  }
  if (wrongType && typed) fail("type", { type: schema.type });

  if (typeof data === "number") {
    if (typeof schema.maximum === "number" && !(data <= schema.maximum))
      fail("maximum", { comparison: "<=", limit: schema.maximum });
    if (typeof schema.minimum === "number" && !(data >= schema.minimum))
      fail("minimum", { comparison: ">=", limit: schema.minimum });
  } else if (typeof data === "string") {
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength)
      fail("maxLength", { limit: schema.maxLength });
    if (typeof schema.minLength === "number" && data.length < schema.minLength)
      fail("minLength", { limit: schema.minLength });
    if (typeof schema.pattern === "string" && !regex(schema.pattern).test(data))
      fail("pattern", { pattern: schema.pattern });
  } else if (Array.isArray(data)) {
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems)
      fail("maxItems", { limit: schema.maxItems });
    if (typeof schema.minItems === "number" && data.length < schema.minItems)
      fail("minItems", { limit: schema.minItems });
    if (isObject(schema.items))
      for (const [index, item] of data.entries())
        check(schema.items, item, at + step(index), `${path}/items`, errors);
    if (schema.uniqueItems === true) {
      // As Ajv does: from the end, stop at the first repeat, and name both places.
      const seen = new Map<string, number>();
      for (let i = data.length; i--; ) {
        const item = data[i];
        const key = typeof item === "object" ? JSON.stringify(item) : `${typeof item}:${String(item)}`;
        const j = seen.get(key);
        if (j !== undefined) {
          fail("uniqueItems", { i, j });
          break;
        }
        seen.set(key, i);
      }
    }
  } else if (isObject(data)) {
    const keys = Object.keys(data);
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties)
      fail("maxProperties", { limit: schema.maxProperties });
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties)
      fail("minProperties", { limit: schema.minProperties });
    for (const missing of (schema.required as readonly string[] | undefined) ?? [])
      if (data[missing] === undefined) fail("required", { missingProperty: missing });
    if (isObject(schema.propertyNames))
      for (const key of keys) {
        const before = errors.length;
        check(schema.propertyNames, key, at, `${path}/propertyNames`, errors);
        if (errors.length > before) fail("propertyNames", { propertyName: key });
      }
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    const extra = schema.additionalProperties;
    if (extra !== undefined)
      for (const key of keys) {
        if (key in properties) continue;
        if (extra === false) fail("additionalProperties", { additionalProperty: key });
        else if (isObject(extra))
          check(extra, data[key], at + step(key), `${path}/additionalProperties`, errors);
      }
    for (const [property, deps] of Object.entries(
      (schema.dependencies as Record<string, string[]> | undefined) ?? {},
    ))
      if (data[property] !== undefined)
        for (const missing of deps)
          if (data[missing] === undefined)
            fail("dependencies", {
              property,
              missingProperty: missing,
              depsCount: deps.length,
              deps: deps.join(", "),
            });
    for (const [key, sub] of Object.entries(properties))
      if (data[key] !== undefined) check(sub, data[key], at + step(key), `${path}/properties/${key}`, errors);
  }
}

function passes(schema: Schema, data: unknown): boolean {
  const errors: RawError[] = [];
  check(schema, data, "", "#", errors);
  return errors.length === 0;
}

/** A validator for `schema` with Ajv's call shape: true or false, and the errors on `.errors`. */
export function schemaValidator(schema: object): SchemaValidator {
  const validate: SchemaValidator = (data) => {
    const errors: RawError[] = [];
    check(schema as Schema, data, "", "#", errors);
    validate.errors = errors.length ? errors : null;
    return !errors.length;
  };
  return validate;
}
