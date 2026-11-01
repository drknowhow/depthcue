const NS = "http://www.w3.org/2000/svg";

type Attributes = Record<string, string | number | undefined>;
type Child = Node | string | null | undefined | false;

/** An SVG element, built like `h` builds an HTML one: strings become text, and markup is never parsed. */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) element.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) element.append(child);
  }
  return element;
}

/** A path's data from commands and numbers, the numbers rounded to a tenth of a unit to keep the drawing small. */
export const d = (...parts: Array<string | number>): string =>
  parts.map((part) => (typeof part === "number" ? Math.round(part * 10) / 10 : part)).join(" ");
