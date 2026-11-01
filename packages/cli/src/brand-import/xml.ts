/**
 * A small XML reader for the parts of an Office file that brand import reads: themes, slide masters, layouts and
 * relationships. It builds a tree of elements and keeps what they need (names, attributes, text) and nothing else. It
 * reads no DOCTYPE, so no entity can expand into more than the five the language defines and the character
 * references, and it refuses nesting past a fixed depth, so a hostile file cannot exhaust memory or the stack.
 */

/** The namespace of `r:id` and `r:embed`, the attributes that point from one part to another. */
const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Office files nest a few dozen elements deep at most, in a group of groups of shapes. */
const MAX_DEPTH = 100;

export class XmlError extends Error {}

/** The document has more elements than the reader was told to take. */
export class XmlTooLarge extends XmlError {}

export interface XmlOptions {
  /** Refuse a document with more elements than this. There is no limit when it is left out. */
  maxNodes?: number;
  /**
   * Keep every attribute under its name as written (`xlink:href`), not only the ones in the relationships namespace.
   * Used to read an SVG, where a link or an event handler may have any prefix.
   */
  keepAttributes?: boolean;
}

export interface XmlNode {
  /** The element's name without its prefix: `a:srgbClr` is `srgbClr`. */
  name: string;
  /**
   * Attributes by name. One in the relationships namespace is written `r:` and its name, whatever prefix the file
   * gave it. Attributes of any other prefix are left out, unless the document was read with `keepAttributes`, which
   * keeps all of them under the name as written.
   */
  attrs: Readonly<Record<string, string>>;
  children: XmlNode[];
  /** The text directly inside the element, character references replaced. */
  text: string;
}

const CHARACTER_REFERENCE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g;
const NAMED = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as const;

function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARACTER_REFERENCE, (whole, decimal?: string, hex?: string, named?: string) => {
    if (named !== undefined) return NAMED[named as keyof typeof NAMED];
    const code = Number.parseInt((decimal ?? hex) as string, decimal === undefined ? 16 : 10);
    // A reference to a code point that is not a character is left as written.
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : whole;
  });
}

// In order: a comment, CDATA, a processing instruction, a closing tag, an opening tag with its attributes, text.
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?][^\s/>]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

type Scope = Readonly<Record<string, string>>;

/** The element's attributes, with the namespaces it declares, which its children inherit. */
function readAttributes(
  source: string,
  inherited: Scope,
  keepAll: boolean,
): { attrs: Record<string, string>; scope: Scope } {
  const raw: Array<[string, string]> = [];
  let scope = inherited;
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1] as string;
    const value = decode((match[2] ?? match[3]) as string);
    if (name === "xmlns") scope = { ...scope, "": value };
    else if (name.startsWith("xmlns:")) scope = { ...scope, [name.slice(6)]: value };
    else raw.push([name, value]);
  }
  const attrs: Record<string, string> = {};
  for (const [name, value] of raw) {
    const colon = name.indexOf(":");
    if (colon < 0 || keepAll) attrs[name] = value;
    else if (scope[name.slice(0, colon)] === RELATIONSHIPS_NS) attrs[`r:${name.slice(colon + 1)}`] = value;
  }
  return { attrs, scope };
}

/** Reads a document into its root element, and says how many elements it has. Throws `XmlError` for text that is not well-formed XML. */
export function parseXmlCounted(source: string, options: XmlOptions = {}): { root: XmlNode; nodes: number } {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (/<!DOCTYPE/i.test(text)) throw new XmlError("The document declares a DOCTYPE, which is not read.");
  const stack: Array<{ node: XmlNode; scope: Scope }> = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const match = TOKEN.exec(text);
    if (!match) throw new XmlError(`Unreadable markup near character ${TOKEN.lastIndex}.`);
    const [, cdata, closing, opening, attributes, selfClosing, chunk] = match;
    const top = stack[stack.length - 1];
    if (cdata !== undefined || chunk !== undefined) {
      if (top) top.node.text += cdata ?? decode(chunk as string);
      else if (chunk !== undefined && chunk.trim() !== "")
        throw new XmlError("Text outside the root element.");
    } else if (closing !== undefined) {
      const closed = stack.pop();
      if (!closed || closed.node.name !== closing.slice(closing.indexOf(":") + 1)) {
        throw new XmlError(`The closing tag </${closing}> matches no open element.`);
      }
    } else if (opening !== undefined) {
      if (!top && root) throw new XmlError("More than one root element.");
      nodes++;
      if (options.maxNodes !== undefined && nodes > options.maxNodes) {
        throw new XmlTooLarge(`The document has more than ${options.maxNodes} elements.`);
      }
      const { attrs, scope } = readAttributes(
        attributes ?? "",
        top?.scope ?? {},
        options.keepAttributes === true,
      );
      const node: XmlNode = { name: opening.slice(opening.indexOf(":") + 1), attrs, children: [], text: "" };
      if (top) top.node.children.push(node);
      else root = node;
      if (selfClosing !== "/") {
        if (stack.length >= MAX_DEPTH) throw new XmlError("The elements nest too deep.");
        stack.push({ node, scope });
      }
    }
  }
  if (stack.length > 0)
    throw new XmlError(`The element <${stack[stack.length - 1]?.node.name}> is never closed.`);
  if (!root) throw new XmlError("The document has no root element.");
  return { root, nodes };
}

/** Reads a document into its root element. Throws `XmlError` for text that is not well-formed XML. */
export const parseXml = (source: string, options: XmlOptions = {}): XmlNode =>
  parseXmlCounted(source, options).root;

/** The first child element with this name. */
export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  node?.children.find((candidate) => candidate.name === name);

/** The child elements with this name, in order. */
export const childrenNamed = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node?.children.filter((candidate) => candidate.name === name) ?? [];

/** Follows a path of child names: `descend(sp, "spPr", "xfrm", "off")`. */
export function descend(node: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let at = node;
  for (const name of path) at = child(at, name);
  return at;
}

/** The first element with this name anywhere below `node`, in document order. */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const candidate of node.children) {
    if (candidate.name === name) return candidate;
    const deeper = find(candidate, name);
    if (deeper) return deeper;
  }
  return undefined;
}

/** A whole number attribute, or undefined when it is missing or is not one. */
export function integer(node: XmlNode | undefined, name: string): number | undefined {
  const value = node?.attrs[name];
  return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined;
}
