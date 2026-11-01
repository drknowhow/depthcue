/**
 * The brand's colors from a PowerPoint theme. A theme has twelve colors and Depthcue's palette has seven names with
 * contrast rules, so each name gets the theme color that does the same job, and a color that would fail a rule keeps the
 * preset's color instead and is reported. The result never fails the palette checks.
 */
import {
  BRAND_LIMITS,
  CONTRAST,
  contrastRatio,
  luminance,
  PALETTE_COLORS,
  type PaletteColor,
  PRESETS,
  type ThemeName,
} from "@depthcue/core";
import { ACCENT_KEYS, type ColorMap, type ResolvedColor, type Theme, type ThemeKey } from "./theme.ts";

export type PaletteName = PaletteColor;
export type Palette = Record<PaletteName, string>;

/** A theme color's name as a person knows it in PowerPoint's color picker. */
const LABELS: Readonly<Record<ThemeKey, string>> = {
  dk1: "Dark 1",
  lt1: "Light 1",
  dk2: "Dark 2",
  lt2: "Light 2",
  accent1: "Accent 1",
  accent2: "Accent 2",
  accent3: "Accent 3",
  accent4: "Accent 4",
  accent5: "Accent 5",
  accent6: "Accent 6",
  hlink: "Hyperlink",
  folHlink: "Followed hyperlink",
};
export const labelOf = (key: ThemeKey): string => `${LABELS[key]} (${key})`;

/** How far from the background toward the text a line is drawn: the presets' own lines sit about this far. */
const LINE_SHARE = 0.14;

export interface ColorLine {
  name: PaletteName;
  value: string;
  /** `theme` took a theme color, `derived` worked it out from other colors, `preset` kept Depthcue's own. */
  source: "theme" | "derived" | "preset";
  from: string;
}

/** A theme color that would have failed a contrast rule, so the preset's color stayed. */
export interface ColorKept {
  name: PaletteName;
  /** The theme's color, and where it came from. */
  wanted: string;
  from: string;
  /** The contrast the pair had, the minimum it needed, and the other color of the pair. */
  ratio: number;
  need: number;
  against: PaletteName;
  againstValue: string;
  /** The preset's color that was used. */
  used: string;
}

export interface PaletteResult {
  preset: ThemeName;
  /** Why this preset: what the master's background is. */
  presetWhy: string;
  colors: Palette;
  taken: ColorLine[];
  kept: ColorKept[];
  /** The accents that reach 3:1 on the background, in order, and the theme colors they came from. */
  chart: { colors: string[]; from: ThemeKey[] };
  /** Theme colors that could not be read, and anything else worth a line in the report. */
  notes: string[];
}

export interface PaletteInput {
  theme: Theme;
  map: ColorMap;
  /** The master's own background, when it is a solid color. */
  background?: ResolvedColor | undefined;
  /** What the master's background is, when it is not a solid color this could use. */
  backgroundNote?: string | undefined;
}

interface Candidate {
  hex: string;
  from: string;
  key?: ThemeKey;
}

/**
 * The pairs the palette checks hold to a minimum: each of these colors against the slide and against a panel. This is
 * the list in core's `checkBrandColors`, which stays the authority: a test compares the two, and the import checks its
 * result with `checkBrand` before it writes anything.
 */
const CHECKED: ReadonlyArray<readonly [PaletteName, number]> = [
  ["text", CONTRAST.text],
  ["muted", CONTRAST.text],
  ["evidence", CONTRAST.text],
  ["action", CONTRAST.large],
];

export interface Failure {
  name: PaletteName;
  against: "bg" | "surface";
  ratio: number;
  need: number;
}

/** The pairs of a palette that fall under their minimum, in the order the checks list them. */
export function contrastFailures(colors: Palette): Failure[] {
  const failures: Failure[] = [];
  for (const [name, need] of CHECKED) {
    for (const against of ["bg", "surface"] as const) {
      const ratio = contrastRatio(colors[name], colors[against]);
      if (ratio < need) failures.push({ name, against, ratio, need });
    }
  }
  return failures;
}

const channels = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** The color `share` of the way from `from` to `to`. */
export function mix(from: string, to: string, share: number): string {
  const [a, b] = [channels(from), channels(to)];
  const part = (index: number) =>
    Math.round((a[index] as number) + ((b[index] as number) - (a[index] as number)) * share);
  return `#${[0, 1, 2].map((index) => part(index).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** The ratio rounded down, as a person reads it, so 4.49 never shows as 4.5. */
export const shownRatio = (ratio: number): string => `${Math.floor(ratio * 100) / 100}:1`;

/** True for a color that reads as dark: white has more contrast against it than black does. */
export const isDark = (hex: string): boolean => luminance(hex) < 0.1791;

/** A theme color moved toward the text color, because it did not read as it was. */
interface AdjustedColor {
  hex: string;
  from: string;
}

interface Settled {
  colors: Palette;
  kept: ColorKept[];
  reverted: Set<PaletteName>;
  adjusted: Map<PaletteName, AdjustedColor>;
}

/** True when the color reads at `need`:1 on the slide and on a panel. */
const readsOn = (hex: string, need: number, colors: Palette): boolean =>
  contrastRatio(hex, colors.bg) >= need && contrastRatio(hex, colors.surface) >= need;

/**
 * A color is moved no further than this share of the way toward the text color. Past it the color is more the text's than
 * the theme's (a link that is as dark as the text is no link), and the background is given up instead.
 */
const MAX_MOVE = 0.5;

/**
 * The theme's color moved toward the text color, by the least 5% steps that make it read at `need`:1 on the slide and on
 * a panel, or nothing when that takes more than `MAX_MOVE` of the way. The text color is the one in `colors`, which the
 * checks list first, so it reads on both whenever another color is being looked at.
 */
function adjustedTowards(wanted: Candidate, need: number, colors: Palette): AdjustedColor | undefined {
  for (let step = 1; step <= MAX_MOVE * 20; step++) {
    const hex = mix(wanted.hex, colors.text, step / 20);
    if (readsOn(hex, need, colors)) {
      return {
        hex,
        from: `${wanted.from} (${wanted.hex}), moved ${step * 5}% of the way toward the text color (${colors.text}) until it reads at ${need}:1 on the background and the panel`,
      };
    }
  }
  return undefined;
}

export function buildPalette(input: PaletteInput): PaletteResult {
  const { theme, map } = input;
  const notes: string[] = [];
  for (const { key, kind } of theme.unreadable) {
    notes.push(`${labelOf(key)} is written as ${kind}, which this does not read, so it was not used.`);
  }
  const themeColor = (name: string): Candidate | undefined => {
    const key = map[name];
    const hex = key ? theme.colors[key] : undefined;
    return key && hex ? { hex, from: labelOf(key), key } : undefined;
  };

  const background = input.background;
  const bg: Candidate | undefined =
    background?.hex && background.plain
      ? {
          hex: background.hex,
          from: background.key
            ? `the master's background, ${labelOf(background.key)}`
            : "the master's background",
          ...(background.key ? { key: background.key } : {}),
        }
      : themeColor("bg1");
  if (input.backgroundNote) notes.push(input.backgroundNote);
  const preset: ThemeName = bg && isDark(bg.hex) ? "ink" : "paper";
  const base = PRESETS[preset];

  const candidates: Partial<Record<PaletteName, Candidate>> = {};
  if (bg) candidates.bg = bg;
  // A panel is the theme's second background; when the master already uses that one, the first is the panel.
  const panel = [themeColor("bg2"), themeColor("bg1")].find(
    (candidate) => candidate && candidate.hex !== bg?.hex,
  );
  if (panel) candidates.surface = panel;
  const text = themeColor("tx1");
  if (text) candidates.text = text;
  const muted = themeColor("tx2");
  if (muted) candidates.muted = muted;
  const link = themeColor("hlink");
  if (link) candidates.evidence = link;

  // The action color is the first accent that reads as an accent on both backgrounds: 3:1, as large text needs.
  const ground = [candidates.bg?.hex ?? base.bg, candidates.surface?.hex ?? base.surface];
  const accents = ACCENT_KEYS.flatMap((key) => {
    const hex = theme.colors[key];
    return hex ? [{ hex, from: labelOf(key), key } satisfies Candidate] : [];
  });
  const action =
    accents.find((accent) =>
      ground.every((against) => contrastRatio(accent.hex, against) >= CONTRAST.large),
    ) ?? accents[0];
  if (action) candidates.action = action;

  /**
   * Settles the palette: a color that fails a rule goes back to the preset's. Each pass handles one color, so this ends:
   * the preset's own colors pass. The text side of a failing pair goes first, so a background the theme chose stays
   * when the preset's text reads on it. With `adjust`, a text-side color whose preset color would fail too is moved
   * toward the text color until it reads, before the background that it failed on is given up.
   */
  const settle = (adjust: boolean): Settled => {
    const colors = Object.fromEntries(
      PALETTE_COLORS.map((name) => [name, candidates[name]?.hex ?? base[name]]),
    ) as Palette;
    const kept: ColorKept[] = [];
    const reverted = new Set<PaletteName>();
    const adjusted = new Map<PaletteName, AdjustedColor>();
    const handled = new Set<PaletteName>();
    for (let pass = 0; pass < PALETTE_COLORS.length; pass++) {
      const failure = contrastFailures(colors)[0];
      if (!failure) break;
      const side = [failure.name, failure.against].find((name) => candidates[name] && !handled.has(name));
      if (!side) break;
      const wanted = candidates[side] as Candidate;
      handled.add(side);
      if (adjust && side === failure.name && side !== "text" && !readsOn(base[side], failure.need, colors)) {
        const moved = adjustedTowards(wanted, failure.need, colors);
        if (moved) {
          colors[side] = moved.hex;
          adjusted.set(side, moved);
          continue;
        }
      }
      const other = side === failure.name ? failure.against : failure.name;
      reverted.add(side);
      kept.push({
        name: side,
        wanted: wanted.hex,
        from: wanted.from,
        ratio: failure.ratio,
        need: failure.need,
        against: other,
        againstValue: colors[other],
        used: base[side],
      });
      colors[side] = base[side];
    }
    // A color sent back for a pair that no longer exists (its partner was sent back too) is the theme's again, if the
    // whole palette still passes with it. One that comes back can free another, so this goes on until nothing changes.
    for (let changed = true; changed; ) {
      changed = false;
      for (const entry of [...kept]) {
        colors[entry.name] = entry.wanted;
        if (contrastFailures(colors).length === 0) {
          reverted.delete(entry.name);
          kept.splice(kept.indexOf(entry), 1);
          changed = true;
        } else {
          colors[entry.name] = entry.used;
        }
      }
    }
    // What a line says is against the palette as it ended: the partner of a pair may have been sent back since.
    for (const entry of kept) {
      colors[entry.name] = entry.wanted;
      const failure = contrastFailures(colors).find(
        (found) => found.name === entry.name || found.against === entry.name,
      );
      colors[entry.name] = entry.used;
      if (!failure) continue;
      const other = failure.name === entry.name ? failure.against : failure.name;
      Object.assign(entry, {
        ratio: failure.ratio,
        need: failure.need,
        against: other,
        againstValue: colors[other],
      });
    }
    return { colors, kept, reverted, adjusted };
  };

  // The theme's own colors go first. If that gives up the background or the panel the theme chose, the colors on them
  // are tried again with their theme colors moved toward the text color, and kept if that saves one.
  const given = (result: Settled): number =>
    (["bg", "surface"] as const).filter((name) => result.reverted.has(name)).length;
  let settled = settle(false);
  if (given(settled) > 0) {
    const again = settle(true);
    if (given(again) < given(settled)) settled = again;
  }
  const { colors, kept, reverted, adjusted } = settled;

  colors.line = mix(colors.bg, colors.text, LINE_SHARE);

  const taken: ColorLine[] = PALETTE_COLORS.map((name) => {
    if (name === "line") {
      return {
        name,
        value: colors.line,
        source: "derived",
        from: `the background blended ${Math.round(LINE_SHARE * 100)}% of the way toward the text; a theme has no color for lines`,
      };
    }
    const moved = adjusted.get(name);
    if (moved) return { name, value: colors[name], source: "derived", from: moved.from };
    const candidate = candidates[name];
    if (candidate && !reverted.has(name))
      return { name, value: colors[name], source: "theme", from: candidate.from };
    return {
      name,
      value: colors[name],
      source: "preset",
      from: candidate
        ? `Depthcue's ${preset} preset, because ${candidate.from} fails a contrast rule`
        : `Depthcue's ${preset} preset; the theme has no color for it`,
    };
  });

  const chart = accents
    .filter((accent, at) => accents.findIndex((other) => other.hex === accent.hex) === at)
    .filter((accent) => contrastRatio(accent.hex, colors.bg) >= CONTRAST.large)
    .slice(0, BRAND_LIMITS.chart);

  const darkness = isDark(candidates.bg?.hex ?? base.bg) ? "dark" : "light";
  return {
    preset,
    presetWhy: bg
      ? `The background (${bg.hex}, ${bg.from}) is ${darkness}, so the colors are the ${preset} palette.`
      : `The theme has no background color, so the colors are the ${preset} palette.`,
    colors,
    taken,
    kept,
    chart: {
      colors: chart.map((accent) => accent.hex),
      from: chart.flatMap((accent) => (accent.key ? [accent.key] : [])),
    },
    notes,
  };
}
