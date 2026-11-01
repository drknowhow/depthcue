import type { RawError } from "./diagnostics.ts";

/**
 * A validator that reads a JSON Schema at run time, for every schema in schema.ts. With Ajv's compiled code for them,
 * the editor's script was 8.6 KB brotli larger. Walking the same schema objects that `pnpm schema` publishes also
 * keeps the files and the checks from drifting apart.
 *
 * It knows only the keywords those schemas use, and reports errors as Ajv 8 does with the options the tests name
 * (`allErrors`, `discriminator`, `unicode: false`): the same keyword, params, instance and schema paths, in the same
 * order, so `explain` reads them the same way. test/schemacheck.test.ts runs it beside Ajv on every fixture and on
 * thousands of broken copies of each kind of file. A keyword it does not know throws, so a schema edit that needs one
 * fails loudly in that test instead of passing unchecked.
 */
export interface SchemaValidator {
  (data: unknown): boolean;
  errors?: RawError[] | null;
}

type Schema = Readonly<Record<string, unknown>>;

/** Keywords that check nothing, and the ones handled where their parent keyword is. */
const QUIET = ["$schema", "$id", "title", "description", "$comment", "then", "else"];
/**
 * The keywords Ajv checks for a value of any type, then for each type of value, in the order it checks them, which
 * `check` follows. `discriminator` comes last for objects; it picks the branch of `oneOf` that applies.
 */
const ANY = ["type", "const", "enum", "oneOf", "allOf", "if"];
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
    "discriminator",
  ],
} as const;

/** Made on first use, so a bundle that never checks a file, the player's, keeps none of this. */
let known: Set<string> | undefined;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** As Ajv tells types apart: a number is finite, an integer is a whole one, and an array is not an object. */
function hasType(value: unknown, type: string): boolean {
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return Number.isFinite(value);
  return typeof value === type;
}

const typesOf = (schema: unknown): string[] =>
  isObject(schema) && schema.type !== undefined ? ([] as string[]).concat(schema.type as string) : [];
/** A JSON pointer step. Ajv also URI-encodes the steps of a schema path, such as `%24schema` for `$schema`. */
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

const unsupported = (what: string): never => {
  throw new Error(`schemacheck: unsupported ${what}`);
};
const allSchemas = (list: unknown): boolean => Array.isArray(list) && list.every(isObject);

/**
 * Schemas whose keywords have been looked at, so each is looked at once. A known keyword in a form `check` does not
 * read throws too: a list of `items` (a tuple), a boolean where a schema goes (but `additionalProperties: false`), and
 * `dependencies` that name a schema rather than a list of properties.
 */
const vetted = new WeakSet<Schema>();
function vet(schema: Schema): void {
  if (vetted.has(schema)) return;
  known ??= new Set([...QUIET, ...ANY, ...Object.values(GROUPS).flat()]);
  for (const keyword in schema) if (!known.has(keyword)) unsupported(`keyword ${keyword}`);
  for (const keyword of ["items", "propertyNames", "if", "then", "else", "additionalProperties"]) {
    const sub = schema[keyword];
    if (sub !== undefined && !isObject(sub) && !(keyword === "additionalProperties" && sub === false))
      unsupported(`form of ${keyword}`);
  }
  for (const keyword of ["allOf", "oneOf"])
    if (schema[keyword] !== undefined && !allSchemas(schema[keyword])) unsupported(`form of ${keyword}`);
  const { properties, dependencies } = schema;
  if (properties !== undefined && !(isObject(properties) && allSchemas(Object.values(properties))))
    unsupported("form of properties");
  const names = (list: unknown) => Array.isArray(list) && list.every((name) => typeof name === "string");
  if (dependencies !== undefined && !(isObject(dependencies) && Object.values(dependencies).every(names)))
    unsupported("form of dependencies");
  if (schema.oneOf !== undefined && !isObject(schema.discriminator))
    throw new Error("schemacheck: oneOf works only with a discriminator");
  const items = typesOf(schema.items);
  if (schema.uniqueItems === true && (!items.length || items.some((t) => t === "object" || t === "array")))
    throw new Error("schemacheck: uniqueItems works only on items of a scalar type");
  vetted.add(schema);
}

function check(schema: Schema, data: unknown, at: string, path: string, errors: RawError[]): void {
  vet(schema);
  const fail = (keyword: string, params: Record<string, unknown>): void => {
    errors.push({ instancePath: at, schemaPath: `${path}/${keyword}`, keyword, params });
  };
  const types = typesOf(schema);
  const wrongType = types.length > 0 && !types.some((type) => hasType(data, type));
  // Ajv reports a wrong type first, unless the schema has one type and keywords for it: then after the untyped ones.
  const group = types.length === 1 ? GROUPS[types[0] as keyof typeof GROUPS] : undefined;
  const typed = group?.some((keyword) => keyword in schema) === true;
  if (wrongType && !typed) fail("type", { type: schema.type });
  if ("const" in schema && data !== schema.const) fail("const", { allowedValue: schema.const });
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => value === data))
    fail("enum", { allowedValues: schema.enum });
  if (Array.isArray(schema.allOf))
    for (const [i, part] of (schema.allOf as Schema[]).entries())
      check(part, data, at, `${path}/allOf/${i}`, errors);
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

  if (hasType(data, "number")) {
    const number = data as number;
    if (typeof schema.maximum === "number" && !(number <= schema.maximum))
      fail("maximum", { comparison: "<=", limit: schema.maximum });
    if (typeof schema.minimum === "number" && !(number >= schema.minimum))
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
      // As Ajv does for items of scalar types: from the end, skipping items of another type, keyed on a plain
      // object, stopping at the first repeat and naming both places. A string is marked when numbers could clash.
      const itemTypes = typesOf(schema.items);
      const indices: Record<string, number> = {};
      for (let i = data.length; i--; ) {
        let item = data[i];
        if (!itemTypes.some((type) => hasType(item, type))) continue;
        if (itemTypes.length > 1 && typeof item === "string") item += "_";
        const j = indices[item as string];
        if (typeof j === "number") {
          fail("uniqueItems", { i, j });
          break;
        }
        indices[item as string] = i;
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
        if (Object.hasOwn(properties, key)) continue;
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
      if (data[key] !== undefined)
        check(
          sub,
          data[key],
          at + step(key),
          `${path}/properties/${encodeURIComponent(step(key).slice(1))}`,
          errors,
        );
    if (isObject(schema.discriminator)) {
      // The branch whose tag property is the value's tag; with none, Ajv names the tag and what it held.
      const tag = String(schema.discriminator.propertyName);
      const value = data[tag];
      const branches = schema.oneOf as Schema[];
      const index =
        typeof value === "string"
          ? branches.findIndex(
              (branch) => (branch.properties as Record<string, Schema>)[tag]?.const === value,
            )
          : -1;
      const branch = branches[index];
      if (branch) check(branch, data, at, `${path}/oneOf/${index}`, errors);
      else
        fail("discriminator", { error: typeof value === "string" ? "mapping" : "tag", tag, tagValue: value });
    }
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
