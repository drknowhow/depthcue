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
const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
const CSS_HOOKS = /@import|expression\s*\(|-moz-binding|behavior\s*:|\\/i;

/** A value as it is shown in a message: one line, not long. */
const shown = (value: string): string => {
  const plain = value.replace(/[^\x20-\x7e -￿]+/g, " ").trim();
  return plain.length > 60 ? `${plain.slice(0, 57)}...` : plain;
};

/** The first thing wrong with a piece of CSS, or with a presentation attribute that may hold a `url()`, as a phrase. */
function styleProblem(css: string): string | undefined {
  const hook = CSS_HOOKS.exec(css);
  if (hook) return `a style with "${shown(hook[0])}", which can load or run something`;
  for (const match of css.matchAll(CSS_URL)) {
    const target = (match[2] ?? "").trim();
    if (!LOCAL_LINK.test(target)) return `a style that loads "${shown(target)}", which is outside the file`;
  }
  // A url( that did not read as one, such as an unclosed one.
  if (/url\s*\(/i.test(css.replace(CSS_URL, ""))) return "a style with a url() this cannot read";
  return undefined;
}

function nodeProblem(node: XmlNode): string | undefined {
  if (REFUSED_ELEMENTS.has(node.name.toLowerCase())) return `a "${shown(node.name)}" element`;
  if (node.name.toLowerCase() === "style") {
    const problem = styleProblem(node.text);
    if (problem) return problem;
  }
  for (const [attribute, value] of Object.entries(node.attrs)) {
    const local = attribute.slice(attribute.lastIndexOf(":") + 1).toLowerCase();
    if (local.startsWith("on")) return `an event handler ("${shown(attribute)}")`;
    if (local === "href" && !LOCAL_LINK.test(value.trim())) {
      return `a link to "${shown(value)}", which is outside the file`;
    }
    const problem = styleProblem(value);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * What is wrong with an SVG for a brand, as a phrase that follows "its SVG has" ("a script element"), or undefined when
 * nothing is.
 */
export function svgProblem(text: string): string | undefined {
  // A DOCTYPE that only names the DTD, as Illustrator writes, is nothing; one with a body can define entities.
  const bare = text.replace(/<!DOCTYPE[^[>]*>/i, "");
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
