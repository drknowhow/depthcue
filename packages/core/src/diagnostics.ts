import {
  ASSET_PATTERN,
  COLOR_PATTERN,
  FAMILY_PATTERN,
  FONT_FILE_PATTERN,
  FRAME_MIN,
  ID_PATTERN,
  IMAGE_FILE_PATTERN,
  LANGUAGE_PATTERN,
  LOGO_FILE_PATTERN,
  MODULE_SETTING_PATTERN,
  URL_PATTERN,
} from "./schema.ts";
import type { Diagnostic } from "./types.ts";

/** The subset of an Ajv error that the explainer reads. */
export interface RawError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string | undefined;
}

type Json = unknown;

function at(data: Json, pointer: string): Json {
  let node = data;
  for (const part of pointer.split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, Json>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

function schemaAt(root: Json, schemaPath: string): Json {
  let node = root;
  for (const part of schemaPath.replace(/^#/, "").split("/").slice(1)) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, Json>)[part];
  }
  return node;
}

/** The option within two edits of `value`, if any. */
export function closest(value: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const option of options) {
    const distance = editDistance(value, option);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] as number;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] as number;
}

export const PATTERN_HINTS: Record<string, string> = {
  [ID_PATTERN]:
    "Ids use lowercase letters, digits and hyphens, start with a letter, and are 2 to 64 characters long.",
  [ASSET_PATTERN]:
    'Asset paths start with "assets/", use letters, digits, ".", "-", "_" and "/", and never contain "..".',
  [LANGUAGE_PATTERN]: 'Use a language tag such as "en" or "pt-BR".',
  [URL_PATTERN]: "Use a full http or https URL.",
  [MODULE_SETTING_PATTERN]: 'Write "off", or the version the deck needs, such as "1" or "1.2".',
  [COLOR_PATTERN]: 'Write a color as "#" and six hex digits, such as "#2b55e6".',
  [FONT_FILE_PATTERN]:
    'A font file is in the brand folder\'s fonts/, such as "fonts/Acme-Regular.woff2" (woff2, woff, ttf or otf).',
  [LOGO_FILE_PATTERN]: 'A logo is in the brand folder\'s logos/, such as "logos/acme.svg" (svg or png).',
  [IMAGE_FILE_PATTERN]:
    'An image is in the brand folder\'s images/, such as "images/cover.jpg" (jpg, png, webp or svg).',
  [FAMILY_PATTERN]: "Write the family name alone, without quotes, semicolons or braces.",
  "^[a-z]{2}_[a-z0-9]{2,32}$":
    'A Kokoro voice name is a language letter, a gender letter, "_" and a name, such as "af_heart".',
  "^[0-9a-f]{64}$": "Leave this to `depthcue voice build`: it is a 64-digit hex hash of the text and voice.",
};

/** What a number outside its range in a frame should be, since the schema's own limits do not say percent of what. */
const FRAME_HINT = `A frame is in percent of the slide: x and y from 0 to 100, w and h from ${FRAME_MIN} to 100.`;
const inFrame = (path: string): boolean => /\/frame\/[xywh]$/.test(path);

function kind(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function display(value: Json): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/** Turns Ajv errors into messages that say what is wrong and what to change. */
export function explain(
  errors: readonly RawError[] | null | undefined,
  data: Json,
  root: Json,
  file: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const error of errors ?? []) {
    if (error.keyword === "if") continue;
    const entry = explainOne(error, data, root);
    const key = `${error.instancePath}|${entry.code}|${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ severity: "error", file, ...entry, path: entry.path ?? error.instancePath });
  }
  return out;
}

interface Explained {
  code: string;
  message: string;
  fix?: string;
  path?: string;
}

function explainOne(error: RawError, data: Json, root: Json): Explained {
  const { keyword, params, instancePath: path } = error;
  const value = at(data, path);
  switch (keyword) {
    case "required": {
      const name = String(params.missingProperty);
      // Alt text is required in an `else`: a picture needs it unless it is marked decorative.
      if (error.schemaPath.endsWith("/else/required") && name === "alt")
        return {
          code: "missing-property",
          message: 'Missing "alt": a picture needs alt text unless it is decorative.',
          fix: 'Add "alt" that says what the picture shows, for someone who cannot see it, or set "decorative": true if it carries no information.',
        };
      return { code: "missing-property", message: `Missing "${name}".`, fix: `Add "${name}".` };
    }
    case "additionalProperties": {
      const name = String(params.additionalProperty);
      const parent = schemaAt(root, error.schemaPath.replace(/\/additionalProperties$/, "")) as {
        properties?: Record<string, unknown>;
      };
      const allowed = Object.keys(parent?.properties ?? {});
      const guess = closest(name, allowed);
      return {
        code: "unknown-property",
        path: `${path}/${name}`,
        message: `Unknown property "${name}".`,
        fix: guess ? `Did you mean "${guess}"?` : `Allowed here: ${allowed.join(", ")}.`,
      };
    }
    case "enum": {
      const allowed = (params.allowedValues as unknown[]).map(String);
      const guess = typeof value === "string" ? closest(value, allowed) : undefined;
      return {
        code: "bad-value",
        message: `${display(value)} is not allowed here.`,
        fix: `${guess ? `Did you mean "${guess}"? ` : ""}Use one of: ${allowed.join(", ")}.`,
      };
    }
    case "const":
      return {
        code: "bad-value",
        message: `Expected ${display(params.allowedValue)}, got ${display(value)}.`,
        fix: `Set it to ${display(params.allowedValue)}.`,
      };
    case "maxLength": {
      const limit = Number(params.limit);
      const length = typeof value === "string" ? value.length : limit + 1;
      return {
        code: "too-long",
        message: `${length} characters; the limit is ${limit}.`,
        fix: `Shorten it by ${length - limit}, or move the detail into a body block or the reading text.`,
      };
    }
    case "minLength":
      return {
        code: "too-short",
        message:
          Number(params.limit) <= 1 ? "Must not be empty." : `Needs at least ${params.limit} characters.`,
        fix: "Write the text, or remove the property.",
      };
    case "maxItems":
      return {
        code: "too-many",
        message: `${Array.isArray(value) ? value.length : "Too many"} items; the limit is ${params.limit}.`,
        fix: "Split the content across more scenes.",
      };
    case "minItems":
      return {
        code: "too-few",
        message: `Needs at least ${params.limit} item${params.limit === 1 ? "" : "s"}.`,
        fix: "Add one.",
      };
    case "maxProperties":
      return {
        code: "too-many",
        message: `More than ${params.limit} entries.`,
        fix: `Keep ${params.limit} or fewer.`,
      };
    case "dependencies":
      return {
        code: "missing-property",
        message: `"${params.property}" needs "${params.missingProperty}" beside it.`,
        fix: `Add "${params.missingProperty}", or remove "${params.property}".`,
      };
    case "minProperties":
      return {
        code: "too-few",
        message: `Needs at least ${params.limit} propert${params.limit === 1 ? "y" : "ies"}.`,
        fix: "Add one, or leave the whole object out.",
      };
    case "uniqueItems":
      return {
        code: "duplicate",
        message: `Items ${params.j} and ${params.i} are the same.`,
        fix: "Remove the repeat.",
      };
    case "pattern": {
      const hint = PATTERN_HINTS[String(params.pattern)];
      return {
        code: "bad-format",
        message: `${display(value)} does not match the expected format.`,
        ...(hint ? { fix: hint } : {}),
      };
    }
    case "type":
      return {
        code: "wrong-type",
        message: `Expected ${String(params.type).replace(",", " or ")}, got ${kind(value)}.`,
        fix: `Use a ${String(params.type).replace(",", " or ")}.`,
      };
    case "minimum":
      return {
        code: "too-small",
        message: `${display(value)} is below the minimum of ${params.limit}.`,
        fix: inFrame(path) ? FRAME_HINT : `Use ${params.limit} or more.`,
      };
    case "maximum":
      return {
        code: "too-large",
        message: `${display(value)} is above the maximum of ${params.limit}.`,
        fix: inFrame(path) ? FRAME_HINT : `Use ${params.limit} or less.`,
      };
    case "propertyNames":
      return {
        code: "bad-format",
        message: `Invalid property name ${display(params.propertyName)}.`,
        fix: PATTERN_HINTS[ID_PATTERN] as string,
      };
    case "discriminator": {
      const tag = String(params.tag);
      const branches = (
        schemaAt(root, error.schemaPath.replace(/\/discriminator$/, "")) as {
          oneOf?: Array<{ properties?: Record<string, { const?: unknown }> }>;
        }
      )?.oneOf;
      const allowed = (branches ?? []).map((branch) => String(branch.properties?.[tag]?.const));
      if (params.error === "tag") {
        return {
          code: "missing-property",
          message: `Missing "${tag}".`,
          fix: `Set "${tag}" to one of: ${allowed.join(", ")}.`,
        };
      }
      const given = String(params.tagValue);
      const guess = closest(given, allowed);
      return {
        code: "bad-value",
        path: `${path}/${tag}`,
        message: `Unknown ${tag} ${display(params.tagValue)}.`,
        fix: `${guess ? `Did you mean "${guess}"? ` : ""}Use one of: ${allowed.join(", ")}.`,
      };
    }
    default:
      return { code: keyword, message: error.message ?? "Invalid." };
  }
}
