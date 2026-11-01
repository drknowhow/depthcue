/**
 * A PowerPoint theme: its twelve colors and its two Latin fonts, and the color map that says which of the colors the
 * master calls background and text. Also how a color written inside a master or a layout is read back to a theme color.
 */
import { child, descend, type XmlNode } from "./xml.ts";

/** The twelve colors of a theme's color scheme, by their names in the file. */
export const THEME_KEYS = [
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export const ACCENT_KEYS = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"] as const;

/** A font as a theme names it. `panose` is the 20 hex digits PowerPoint records so a viewer can pick a stand-in. */
export interface ThemeFont {
  typeface: string;
  panose?: string;
}

export interface Theme {
  /** The theme's own name, such as "Office Theme". */
  name?: string;
  /** Each color as `#RRGGBB`. */
  colors: Partial<Record<ThemeKey, string>>;
  /** Colors the scheme names that this could not read, such as one written as a preset color name. */
  unreadable: Array<{ key: ThemeKey; kind: string }>;
  fonts: { major?: ThemeFont; minor?: ThemeFont };
  /** The kinds of fill in the theme's background fill list, in order: `solidFill`, `gradFill`, `blipFill`. */
  backgroundFills: string[];
}

/** The two colors Windows reports for a system color, used when a theme leaves out `lastClr`. */
const SYSTEM_COLORS: Readonly<Record<string, string>> = { window: "#FFFFFF", windowText: "#000000" };

const hex = (value: string | undefined): string | undefined =>
  value !== undefined && /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined;

/** The color element inside a container: `a:solidFill`, `a:dk1` and `p:bgRef` each hold one. */
export function colorElement(container: XmlNode | undefined): XmlNode | undefined {
  return container?.children.find((node) =>
    ["srgbClr", "sysClr", "schemeClr", "prstClr", "scrgbClr", "hslClr"].includes(node.name),
  );
}

/** Reads `a:theme`. Returns undefined when the part has no color scheme, which a theme cannot do without. */
export function readTheme(root: XmlNode): Theme | undefined {
  const scheme = descend(root, "themeElements", "clrScheme");
  if (!scheme) return undefined;
  const colors: Theme["colors"] = {};
  const unreadable: Theme["unreadable"] = [];
  for (const key of THEME_KEYS) {
    const element = colorElement(child(scheme, key));
    if (!element) continue;
    const value =
      element.name === "srgbClr"
        ? hex(element.attrs.val)
        : element.name === "sysClr"
          ? (hex(element.attrs.lastClr) ?? SYSTEM_COLORS[element.attrs.val ?? ""])
          : undefined;
    if (value) colors[key] = value;
    else unreadable.push({ key, kind: element.name });
  }
  const fontOf = (name: "majorFont" | "minorFont"): ThemeFont | undefined => {
    const latin = descend(root, "themeElements", "fontScheme", name, "latin");
    const typeface = latin?.attrs.typeface?.trim();
    if (!latin || !typeface) return undefined;
    // "+mj-lt" and the like point back at the theme and are no font name.
    if (typeface.startsWith("+")) return undefined;
    const panose = latin.attrs.panose;
    return { typeface, ...(panose && /^[0-9a-fA-F]{20}$/.test(panose) ? { panose } : {}) };
  };
  const major = fontOf("majorFont");
  const minor = fontOf("minorFont");
  const name = root.attrs.name?.trim();
  return {
    ...(name ? { name } : {}),
    colors,
    unreadable,
    fonts: { ...(major ? { major } : {}), ...(minor ? { minor } : {}) },
    backgroundFills: (descend(root, "themeElements", "fmtScheme", "bgFillStyleLst")?.children ?? []).map(
      (fill) => fill.name,
    ),
  };
}

/** Which theme color each of the master's color names means: `bg1` is usually `lt1`, and `tx1` is `dk1`. */
export type ColorMap = Readonly<Record<string, ThemeKey>>;

export const DEFAULT_COLOR_MAP: ColorMap = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

/** The color map a master (`p:clrMap`) or a layout's override (`a:overrideClrMapping`) writes as attributes. */
export function readColorMap(node: XmlNode | undefined): ColorMap {
  const map: Record<string, ThemeKey> = { ...DEFAULT_COLOR_MAP };
  for (const [name, value] of Object.entries(node?.attrs ?? {})) {
    if ((THEME_KEYS as readonly string[]).includes(value) && Object.hasOwn(DEFAULT_COLOR_MAP, name)) {
      map[name] = value as ThemeKey;
    }
  }
  return map;
}

/** A color written in a master or a layout, read back as far as it can be. */
export interface ResolvedColor {
  /** `#RRGGBB`, when the color is a plain one this could read. */
  hex?: string;
  /** The theme color it names, when it names one. */
  key?: ThemeKey;
  /** False when the color carries an adjustment (lighter, darker, transparent), which is not read. */
  plain: boolean;
  /** How the file wrote it: `srgbClr`, `schemeClr`, and so on. */
  kind: string;
}

/**
 * Reads a color element. `phClr` is the placeholder color of a fill style; the caller substitutes it, so it comes back
 * with no hex. A color with a transform child (`lumMod`, `tint`, `alpha`) is not plain: its base is read but the adjusted
 * color is not worked out.
 */
export function resolveColor(
  element: XmlNode | undefined,
  theme: Theme,
  map: ColorMap,
): ResolvedColor | undefined {
  if (!element) return undefined;
  const plain = element.children.length === 0;
  if (element.name === "srgbClr") {
    const value = hex(element.attrs.val);
    return { ...(value ? { hex: value } : {}), plain, kind: element.name };
  }
  if (element.name === "sysClr") {
    const value = hex(element.attrs.lastClr) ?? SYSTEM_COLORS[element.attrs.val ?? ""];
    return { ...(value ? { hex: value } : {}), plain, kind: element.name };
  }
  if (element.name === "schemeClr") {
    const named = element.attrs.val ?? "";
    const key = Object.hasOwn(map, named)
      ? map[named]
      : (THEME_KEYS as readonly string[]).includes(named)
        ? (named as ThemeKey)
        : undefined;
    const value = key ? theme.colors[key] : undefined;
    return { ...(value ? { hex: value } : {}), ...(key ? { key } : {}), plain, kind: element.name };
  }
  return { plain: false, kind: element.name };
}
