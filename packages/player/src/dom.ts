type Attributes = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/**
 * Builds an element without ever parsing markup, so deck text can only become text. Attributes that are
 * `undefined` or `false` are left off; `true` sets an empty attribute; names starting with `--` set a CSS variable.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith("--")) element.style.setProperty(name, String(value));
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}
