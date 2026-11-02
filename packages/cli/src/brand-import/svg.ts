/**
 * Whether an SVG from an Office file is safe to keep in a brand. The SVG is read as XML, not searched for words: a
 * search finds `<script` and misses `<s:script>`, and an `href` written with character references reads as
 * `javascript:` only once they are decoded. Anything this does not know to be harmless is refused:
 *
 * - no script, foreignObject, animation or embedding element, under any prefix;
 * - no event handler (`onload`, `onclick`, ...);
 * - a link (`href` under any prefix) only to a place in the file (`#id`) or to a picture inside it (`data:image/...`);
 * - a style (a `style` element or attribute, or a presentation attribute) only with `url()` pointing the same way, and
 *   no `@import`, escapes or old script hooks.
 */
import { parseXml, XmlError, type XmlNode } from "./xml.ts";

/** A logo or a background has a few hundred elements; this is for a drawing made of a great many paths. */
const MAX_ELEMENTS = 200_000;

/** Elements that run something, load something or move something that is in the file. Compared by local name, lower case. */
const REFUSED_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "link",
  "base",
  "meta",
  "audio",
  "video",
  "canvas",
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "animatecolor",
  "handler",
  "listener",
  "mpath",
  "tref",
  "cursor",
  "font-face-uri",
]);

/** A link may point at a place in the file, or at a picture held in the link itself. Not at an SVG held there. */
const LOCAL_LINK = /^(?:#|data:image\/(?:png|jpe?g|gif|webp)[;,])/i;
const CSS_HOOKS = /@import|expression\s*\(|-moz-binding|behavior\s*:|\\/i;
/**
 * Longer than the style sheet or style attribute of any drawing. One past it is refused before anything searches it, so
 * no search's cost can grow with a style made to be long.
 */
export const MAX_STYLE_LENGTH = 64 * 1024;

/** A value as it is shown in a message: one line, not long. */
const shown = (value: string): string => {
  const plain = value.replace(/[^\x20-\x7e -￿]+/g, " ").trim();
  return plain.length > 60 ? `${plain.slice(0, 57)}...` : plain;
};

/** The text with A-Z in lower case and nothing else changed, so an index in one is the same place in the other. */
export const asciiLower = (text: string): string => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

const CSS_SPACE: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r", "\f"]);

/**
 * The target of each `url(...)` in a piece of CSS (`url` in any case, white space allowed before the parenthesis), with
 * the white space and the quotes around it taken off. Undefined when one cannot be read: a `url(` with no `)` after it,
 * or a quote that does not close or is inside the target. Found by indexOf in one pass, not by a pattern, so CSS that is
 * one long run of `url(` costs what its length does and no more.
 */
export function cssUrls(css: string): string[] | undefined {
  const lower = asciiLower(css);
  const targets: string[] = [];
  for (let at = lower.indexOf("url"); at !== -1; ) {
    let open = at + 3;
    while (CSS_SPACE.has(lower[open] as string)) open++;
    if (lower[open] !== "(") {
      at = lower.indexOf("url", at + 3);
      continue;
    }
    const close = lower.indexOf(")", open + 1);
    if (close === -1) return undefined;
    let target = css.slice(open + 1, close).trim();
    const quote = target[0];
    if ((quote === '"' || quote === "'") && target.length >= 2 && target.endsWith(quote)) {
      target = target.slice(1, -1);
    }
    if (target.includes('"') || target.includes("'")) return undefined;
    targets.push(target.trim());
    at = lower.indexOf("url", close + 1);
  }
  return targets;
}

/** The first thing wrong with a piece of CSS, or with a presentation attribute that may hold a `url()`, as a phrase. */
function styleProblem(css: string): string | undefined {
  const hook = CSS_HOOKS.exec(css);
  if (hook) return `a style with "${shown(hook[0])}", which can load or run something`;
  const targets = cssUrls(css);
  // A url( that does not read as one, such as an unclosed one.
  if (targets === undefined) return "a style with a url() this cannot read";
  for (const target of targets) {
    if (!LOCAL_LINK.test(target)) return `a style that loads "${shown(target)}", which is outside the file`;
  }
  return undefined;
}

const TOO_LONG_STYLE = `a style longer than ${MAX_STYLE_LENGTH / 1024} KB, which no drawing needs`;

function nodeProblem(node: XmlNode): string | undefined {
  if (REFUSED_ELEMENTS.has(node.name.toLowerCase())) return `a "${shown(node.name)}" element`;
  if (node.name.toLowerCase() === "style") {
    if (node.text.length > MAX_STYLE_LENGTH) return TOO_LONG_STYLE;
    const problem = styleProblem(node.text);
    if (problem) return problem;
  }
  for (const [attribute, value] of Object.entries(node.attrs)) {
    const local = attribute.slice(attribute.lastIndexOf(":") + 1).toLowerCase();
    if (local.startsWith("on")) return `an event handler ("${shown(attribute)}")`;
    if (local === "href" && !LOCAL_LINK.test(value.trim())) {
      return `a link to "${shown(value)}", which is outside the file`;
    }
    // Only a style attribute has a length limit: a path's data can be long in a real drawing, and every search below
    // costs what the value's length does, however it is written.
    if (local === "style" && value.length > MAX_STYLE_LENGTH) return TOO_LONG_STYLE;
    const problem = styleProblem(value);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * The text without its DOCTYPE when that only names the DTD, as Illustrator writes one: from `<!DOCTYPE` to the first
 * `>`, with no `[` between. Found by indexOf, since a pattern for it backtracks over every unclosed `<!DOCTYPE`.
 */
function withoutBareDoctype(text: string): string {
  const lower = asciiLower(text);
  const at = lower.indexOf("<!doctype");
  if (at === -1) return text;
  const end = lower.indexOf(">", at);
  if (end === -1 || lower.slice(at, end).includes("[")) return text;
  return text.slice(0, at) + text.slice(end + 1);
}

/**
 * What is wrong with an SVG for a brand, as a phrase that follows "its SVG has" ("a script element"), or undefined when
 * nothing is.
 */
export function svgProblem(text: string): string | undefined {
  // A DOCTYPE that only names the DTD, as Illustrator writes, is nothing; one with a body can define entities.
  const bare = withoutBareDoctype(text);
  if (/<!DOCTYPE|<!ENTITY/i.test(bare)) return "a DOCTYPE with declarations in it, which can define entities";
  if (/<\?xml-stylesheet/i.test(bare)) return "a linked style sheet";
  let root: XmlNode;
  try {
    root = parseXml(bare, { keepAttributes: true, maxNodes: MAX_ELEMENTS });
  } catch (error) {
    if (error instanceof XmlError) return "markup that is not valid XML, so it cannot be checked";
    throw error;
  }
  if (root.name.toLowerCase() !== "svg") return `"${shown(root.name)}" as its root element, not "svg"`;
  const pending: XmlNode[] = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const problem = nodeProblem(node);
    if (problem) return problem;
    for (const next of node.children) pending.push(next);
  }
  return undefined;
}
