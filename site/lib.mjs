// The parts of the content step that are plain functions, so a test can run them without a build.
import { posix } from "node:path";

const ID_PATTERN = "^[a-z][a-z0-9-]{1,63}$";

/** The first level-one heading becomes the page title, because Starlight draws the title itself. */
export function splitTitle(markdown, path = "a page") {
  const match = markdown.match(/^# (.+)\r?\n+/m);
  if (!match) throw new Error(`${path} has no level-one heading to use as its title.`);
  return { title: match[1].trim(), body: markdown.replace(match[0], "") };
}

/** A page's front matter. The title goes through JSON so a colon or a quote in it cannot break the YAML. */
export function frontMatter(fields) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

/**
 * Points every relative link at where its target ends up. `pages` maps a repository path to its page address
 * ("docs/lease.md" to "/guides/lease/"). A link to anything else in the repository goes to GitHub, and a link that
 * starts with a slash is a site address that only needs the base put in front.
 */
export function rewriteLinks(markdown, { from, pages, base, repo }) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole;
    const [path, hash = ""] = target.split(/(?=#)/);
    if (path.startsWith("/")) return `](${base}${path}${hash})`;
    const resolved = posix.normalize(posix.join(posix.dirname(from), path));
    if (resolved.startsWith(".."))
      throw new Error(`${from} links to ${target}, which is outside the repository.`);
    const page = pages[resolved];
    if (page) return `](${base}${page}${hash})`;
    return `](${repo}/${path.endsWith("/") ? "tree" : "blob"}/main/${resolved}${hash})`;
  });
}

/** Puts the base in front of `link: /path` lines in a page's front matter, which Starlight leaves as written. */
export function rewriteFrontMatterLinks(markdown, base) {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!match) return markdown;
  const head = match[0].replace(/^(\s*link: )(\/(?!\/)\S*)$/gm, `$1${base}$2`);
  return head + markdown.slice(match[0].length);
}

/** The text under a `##` heading, up to the next one, without the heading itself. */
export function section(markdown, heading, path = "a file") {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`${path} has no "## ${heading}" section.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

const FENCE = { json: "json", md: "md", css: "css", mjs: "js", ts: "ts", txt: "text" };

/** A file as a fenced block, long enough to hold any fence inside it. */
export function fenced(text, language) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text.trimEnd()}\n${fence}`;
}

export const languageOf = (path) => FENCE[path.split(".").pop()] ?? "text";

/**
 * Replaces each directive comment with what it names. `read(path)` returns a repository file's text, and
 * `generated[name]()` returns a generated section. A directive that names nothing is an error, because a page that
 * quietly lost its content is worse than a build that stops.
 */
export function expand(markdown, { read, generated, path }) {
  return markdown.replace(
    /<!-- (include-section|include|generated): (.+?) -->/g,
    (_whole, kind, argument) => {
      if (kind === "generated") {
        const make = generated[argument];
        if (!make)
          throw new Error(`${path} asks for "${argument}", which is not one of: ${Object.keys(generated)}.`);
        return make();
      }
      if (kind === "include") return fenced(read(argument), languageOf(argument));
      const [file, heading] = argument.split("#");
      return section(read(file), heading, file);
    },
  );
}

const quantity = (low, high, unit) => {
  if (low !== undefined && high !== undefined) return `, ${low} to ${high} ${unit}`;
  if (high !== undefined) return `, up to ${high} ${unit}`;
  if (low !== undefined) return `, at least ${low} ${unit}`;
  return "";
};

/** One schema node as a short phrase. Anything it does not know how to say, it says so, and never guesses. */
export function describe(node) {
  if (node.const !== undefined) return `always \`${JSON.stringify(node.const)}\``;
  if (node.enum) return `one of ${node.enum.map((value) => `\`${value}\``).join(", ")}`;
  if (node.type === "string") {
    if (node.pattern === ID_PATTERN) return "an id";
    if (node.pattern?.startsWith("^assets/")) return "a path under `assets/`";
    return `text${quantity(node.minLength, node.maxLength, "characters")}`;
  }
  if (node.type === "number" || node.type === "integer") {
    const kind = node.type === "integer" ? "a whole number" : "a number";
    return `${kind}${quantity(node.minimum, node.maximum, "")}`.trimEnd();
  }
  if (node.type === "boolean") return "true or false";
  if (node.type === "array") {
    const items = node.items ?? {};
    const of = items.type === "object" ? `objects with ${fieldNames(items)}` : describe(items);
    return `a list${quantity(node.minItems, node.maxItems, "items")} of ${of}`;
  }
  if (node.type === "object") return `an object with ${fieldNames(node)}`;
  return "see the schema file";
}

const fieldNames = (node) =>
  Object.keys(node.properties ?? {})
    .map((name) => `\`${name}\``)
    .join(", ");

const cell = (text) => text.replaceAll("|", "\\|");

/** A table of an object schema's fields: name, whether it is required, and what it holds. */
export function fieldTable(node) {
  const required = new Set(node.required ?? []);
  const rows = Object.entries(node.properties ?? {})
    .filter(([name]) => name !== "$schema")
    .map(
      ([name, child]) => `| \`${name}\` | ${required.has(name) ? "yes" : "no"} | ${cell(describe(child))} |`,
    );
  return ["| Field | Required | Holds |", "| --- | --- | --- |", ...rows].join("\n");
}

/** The deck, scene and block field tables, written from the schema files so they cannot disagree with them. */
export function schemaReference({ deck, scene }) {
  const parts = ["## Deck fields", "", fieldTable(deck), "", "## Scene fields", "", fieldTable(scene)];
  const variants = scene.properties.blocks.items.oneOf;
  for (const variant of variants) {
    parts.push("", `## Block: ${variant.properties.type.const}`, "", fieldTable(variant));
  }
  return parts.join("\n");
}

/** The MCP tools, each with the description an agent is given. */
export function toolReference(descriptions) {
  return Object.entries(descriptions)
    .map(([name, description]) => `## ${name}\n\n${description}`)
    .join("\n\n");
}

/** The two palettes as the variables the site's theme reads, keyed to Starlight's own light and dark switch. */
export function paletteCss(tokens) {
  const block = (selector, theme) => {
    const lines = Object.entries(tokens.color.theme[theme]).map(
      ([name, token]) => `  --dc-site-${name}: ${token.$value};`,
    );
    return `${selector} {\n${lines.join("\n")}\n}`;
  };
  return [
    "/* Generated by site/prepare.mjs from brand/tokens.json. Do not edit. */",
    block(':root,\n:root[data-theme="dark"]', "ink"),
    block(':root[data-theme="light"]', "paper"),
    "",
  ].join("\n");
}
