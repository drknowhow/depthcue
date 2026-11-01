import {
  BRAND_LIMITS,
  CONTRAST,
  checkBrandColors,
  contrastRatio,
  PALETTE_COLORS,
  PRESETS,
} from "@depthcue/core";
import { describe, expect, it } from "vitest";
import {
  buildPalette,
  contrastFailures,
  isDark,
  labelOf,
  mix,
  type Palette,
  shownRatio,
} from "../src/brand-import/palette.ts";
import { DEFAULT_COLOR_MAP, readColorMap, type Theme, type ThemeKey } from "../src/brand-import/theme.ts";
import { parseXml } from "../src/brand-import/xml.ts";
import { DARK, LIGHT } from "./brand-import-fixtures.ts";

function themeOf(colors: Partial<Record<ThemeKey, string>>): Theme {
  return {
    colors: Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, `#${value}`])),
    unreadable: [],
    fonts: {},
    backgroundFills: [],
  };
}

/** A small random number generator, so the same "random" themes are tried on every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const hexOf = (next: () => number): string =>
  `#${Math.floor(next() * 0xffffff)
    .toString(16)
    .padStart(6, "0")
    .toUpperCase()}`;

const KEYS: ThemeKey[] = [
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
];
const light = () => buildPalette({ theme: themeOf(LIGHT), map: DEFAULT_COLOR_MAP });
const darkMap = readColorMap(parseXml('<m bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"/>'));

describe("buildPalette on a light theme", () => {
  it("takes every color it can, and says where each came from", () => {
    const result = light();
    expect(result.preset).toBe("paper");
    expect(result.colors).toMatchObject({
      bg: "#FFFFFF",
      surface: "#F3F1EC",
      text: "#1B1B1B",
      muted: "#44546A",
      action: "#B23A48",
      evidence: "#0B5FA5",
    });
    expect(result.kept).toEqual([]);
    expect(result.taken.map(({ name, source }) => [name, source])).toEqual([
      ["bg", "theme"],
      ["surface", "theme"],
      ["line", "derived"],
      ["text", "theme"],
      ["muted", "theme"],
      ["action", "theme"],
      ["evidence", "theme"],
    ]);
    expect(result.taken.find(({ name }) => name === "text")?.from).toBe("Dark 1 (dk1)");
    expect(result.taken.find(({ name }) => name === "bg")?.from).toBe("Light 1 (lt1)");
    expect(result.presetWhy).toMatch(/is light, so the colors are the paper palette/);
  });

  it("derives the line between the background and the text", () => {
    const { colors } = light();
    expect(colors.line).toBe(mix("#FFFFFF", "#1B1B1B", 0.14));
  });

  it("never produces a palette that fails the contrast rules", () => {
    expect(contrastFailures(light().colors)).toEqual([]);
  });

  it("makes the chart colors the accents, in order, that reach 3:1 on the background", () => {
    const { chart } = light();
    const accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map(
      (key) => `#${LIGHT[key as keyof typeof LIGHT]}`,
    );
    expect(chart.colors).toEqual(accents.filter((hex) => contrastRatio(hex, "#FFFFFF") >= CONTRAST.large));
    expect(chart.colors.length).toBeGreaterThanOrEqual(3);
    expect(chart.from).toEqual(
      ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].slice(0, chart.colors.length),
    );
  });
});

describe("buildPalette on a dark theme", () => {
  const result = buildPalette({ theme: themeOf(DARK), map: darkMap });

  it("is the ink preset when the background is dark", () => {
    expect(result.preset).toBe("ink");
    expect(result.colors).toMatchObject({
      bg: "#0E1116",
      surface: "#1C2330",
      text: "#F2F4F8",
      muted: "#C9D1DE",
      evidence: "#8CC4FF",
      action: "#4FB3FF",
    });
    expect(result.kept).toEqual([]);
    expect(result.presetWhy).toMatch(/is dark, so the colors are the ink palette/);
  });

  it("reads the line toward the light text", () => {
    expect(result.colors.line).toBe(mix("#0E1116", "#F2F4F8", 0.14));
  });
});

describe("the master's own background", () => {
  it("is the background when it is a plain color, and decides the preset", () => {
    const result = buildPalette({
      theme: themeOf(LIGHT),
      map: DEFAULT_COLOR_MAP,
      background: { hex: "#10202E", plain: true, kind: "srgbClr" },
    });
    expect(result.preset).toBe("ink");
    expect(result.colors.bg).toBe("#10202E");
    expect(result.taken[0]?.from).toBe("the master's background");
    // Dark text on a dark background fails; the preset's light text takes over and the report says so.
    expect(result.kept.map((kept) => kept.name)).toContain("text");
    expect(contrastFailures(result.colors)).toEqual([]);
  });

  it("names the theme color the background is when it is one", () => {
    const result = buildPalette({
      theme: themeOf(LIGHT),
      map: DEFAULT_COLOR_MAP,
      background: { hex: "#F3F1EC", key: "lt2", plain: true, kind: "schemeClr" },
    });
    expect(result.taken[0]?.from).toBe("the master's background, Light 2 (lt2)");
    // The panel is the theme's second background, and the master already uses it: the first becomes the panel.
    expect(result.colors).toMatchObject({ bg: "#F3F1EC", surface: "#FFFFFF" });
  });

  it("is left to the theme's background color, with the note passed along, when the master has no color", () => {
    const result = buildPalette({
      theme: themeOf(LIGHT),
      map: DEFAULT_COLOR_MAP,
      background: undefined,
      backgroundNote: "The master's background is a picture fill.",
    });
    expect(result.colors.bg).toBe("#FFFFFF");
    expect(result.notes).toContain("The master's background is a picture fill.");
  });
});

describe("a color that fails a contrast rule", () => {
  it("sends the text side back to the preset's color and records both values and the ratio", () => {
    const result = buildPalette({ theme: themeOf({ ...LIGHT, dk2: "9A9A9A" }), map: DEFAULT_COLOR_MAP });
    expect(result.colors.muted).toBe(PRESETS.paper.muted);
    expect(result.colors.bg).toBe("#FFFFFF");
    const [kept] = result.kept;
    expect(result.kept).toHaveLength(1);
    expect(kept).toMatchObject({
      name: "muted",
      wanted: "#9A9A9A",
      from: "Dark 2 (dk2)",
      need: CONTRAST.text,
      used: PRESETS.paper.muted,
    });
    expect(kept?.ratio).toBeLessThan(CONTRAST.text);
    expect(kept?.ratio).toBeCloseTo(contrastRatio("#9A9A9A", kept?.againstValue as string), 5);
    expect(result.taken.find(({ name }) => name === "muted")).toMatchObject({
      source: "preset",
      from: expect.stringContaining("Dark 2 (dk2) fails a contrast rule"),
    });
    expect(contrastFailures(result.colors)).toEqual([]);
  });

  it("sends the background back when no text reads on it, and keeps the theme's text colors that read on the preset's", () => {
    const result = buildPalette({ theme: themeOf({ ...LIGHT, lt1: "808080" }), map: DEFAULT_COLOR_MAP });
    expect(result.kept.map((kept) => kept.name)).toEqual(["bg"]);
    expect(result.colors).toMatchObject({ bg: PRESETS.paper.bg, text: "#1B1B1B", muted: "#44546A" });
    expect(contrastFailures(result.colors)).toEqual([]);
  });

  it("takes a color back from the preset when the partner that failed it went back too", () => {
    // Retrospect-like: the panel color fails with the preset's evidence, which fails because the theme's did not (and a
    // link that pale cannot be moved to read without ceasing to be the theme's), and the muted color had only failed
    // against that panel.
    const result = buildPalette({
      theme: themeOf({ ...LIGHT, dk2: "637052", lt2: "CCDDEA", hlink: "9FD3FF", accent1: "BD582C" }),
      map: DEFAULT_COLOR_MAP,
    });
    expect(result.colors.muted).toBe("#637052");
    expect(result.colors.surface).toBe(PRESETS.paper.surface);
    expect(result.colors.evidence).toBe(PRESETS.paper.evidence);
    expect(result.kept.map((kept) => kept.name).sort()).toEqual(["evidence", "surface"]);
    expect(contrastFailures(result.colors)).toEqual([]);
  });

  it("says in each kept line what the theme's color fails against in the palette as it ended, not as it was when it failed", () => {
    // The text fails on this background, so it goes back to the preset's. That fails on it too, so the background goes back,
    // and the line about the text must name the background that is in the palette, not the one it was tried on.
    const result = buildPalette({
      theme: themeOf({ ...LIGHT, lt1: "C16165", dk1: "8985B0" }),
      map: DEFAULT_COLOR_MAP,
    });
    expect(result.colors.bg).toBe(PRESETS.paper.bg);
    const text = result.kept.find((kept) => kept.name === "text");
    expect(text).toMatchObject({ wanted: "#8985B0", against: "bg", againstValue: PRESETS.paper.bg });
    expect(text?.ratio).toBeCloseTo(contrastRatio("#8985B0", PRESETS.paper.bg), 6);
    expect(text?.ratio).toBeLessThan(CONTRAST.text);
  });

  it("tells the truth in every kept line, for 600 random themes", () => {
    const next = random(20261102);
    let lines = 0;
    for (let n = 0; n < 600; n++) {
      const colors: Partial<Record<ThemeKey, string>> = {};
      for (const key of KEYS) colors[key] = hexOf(next).slice(1);
      const result = buildPalette({ theme: themeOf(colors), map: DEFAULT_COLOR_MAP });
      for (const kept of result.kept) {
        lines++;
        // The partner is the one in the palette, the ratio is the theme's color against it, and that fails.
        expect(kept.againstValue, JSON.stringify(colors)).toBe(result.colors[kept.against]);
        expect(kept.ratio, JSON.stringify(colors)).toBeCloseTo(
          contrastRatio(kept.wanted, kept.againstValue),
          6,
        );
        expect(kept.ratio, JSON.stringify(colors)).toBeLessThan(kept.need);
      }
    }
    expect(lines).toBeGreaterThan(500);
  });

  it("holds the action color to 3:1, not 4.5:1", () => {
    const result = buildPalette({ theme: themeOf({ ...LIGHT, accent1: "E45730" }), map: DEFAULT_COLOR_MAP });
    expect(result.colors.action).toBe("#E45730");
    expect(result.kept).toEqual([]);
  });

  it("takes the first accent that reads on both the slide and the panel as the action color", () => {
    const result = buildPalette({
      theme: themeOf({ ...LIGHT, accent1: "F5D76E", accent2: "EAB308", accent3: "3A7D44" }),
      map: DEFAULT_COLOR_MAP,
    });
    expect(result.colors.action).toBe("#3A7D44");
  });

  it("keeps the preset's action color when no accent reads, and offers no chart colors", () => {
    const pale = {
      accent1: "F6E58D",
      accent2: "F9E79F",
      accent3: "FCF3CF",
      accent4: "FAD7A0",
      accent5: "FDEBD0",
      accent6: "FEF9E7",
    };
    const result = buildPalette({ theme: themeOf({ ...LIGHT, ...pale }), map: DEFAULT_COLOR_MAP });
    expect(result.colors.action).toBe(PRESETS.paper.action);
    expect(result.kept.map((kept) => kept.name)).toEqual(["action"]);
    expect(result.chart.colors).toEqual([]);
  });
});

describe("a background the theme chose", () => {
  // Teal, as the Ion theme's: its link color and the preset's link color both read under 4.5:1 on it.
  const TEAL = { ...DARK, dk1: "000000", lt1: "FFFFFF", dk2: "1E5155", lt2: "C9D1DE", hlink: "58C1BA" };
  const teal = { hex: "#1E5155", key: "dk2", plain: true, kind: "schemeClr" } as const;

  it("premise: neither the theme's link nor the preset's reads on it", () => {
    expect(contrastRatio("#58C1BA", "#1E5155")).toBeLessThan(CONTRAST.text);
    expect(contrastRatio(PRESETS.ink.evidence, "#1E5155")).toBeLessThan(CONTRAST.text);
    expect(contrastRatio("#FFFFFF", "#1E5155")).toBeGreaterThan(8);
  });

  it("stays, and the link moves toward the text color until it reads, instead of the background going back", () => {
    const result = buildPalette({ theme: themeOf(TEAL), map: darkMap, background: teal });
    expect(result.preset).toBe("ink");
    expect(result.colors.bg).toBe("#1E5155");
    expect(result.kept).toEqual([]);
    expect(contrastFailures(result.colors)).toEqual([]);
    const { evidence, bg, surface, text } = result.colors;
    expect(evidence).not.toBe("#58C1BA");
    expect(evidence).not.toBe(PRESETS.ink.evidence);
    expect(contrastRatio(evidence, bg)).toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrastRatio(evidence, surface)).toBeGreaterThanOrEqual(CONTRAST.text);
    // It moved toward the text, by the least that reads: one step less would not have.
    const line = result.taken.find(({ name }) => name === "evidence");
    expect(line).toMatchObject({
      value: evidence,
      source: "derived",
      from: expect.stringMatching(
        /^Hyperlink \(hlink\) \(#58C1BA\), moved \d+% of the way toward the text color/,
      ),
    });
    const share = Number(/moved (\d+)%/.exec(line?.from ?? "")?.[1]);
    expect(mix("#58C1BA", text, share / 100)).toBe(evidence);
    expect(contrastRatio(mix("#58C1BA", text, (share - 5) / 100), bg)).toBeLessThan(CONTRAST.text);
    expect(share).toBeLessThanOrEqual(50);
  });

  it("leaves the theme's colors alone that read, and does not move the preset's", () => {
    const result = buildPalette({ theme: themeOf(TEAL), map: darkMap, background: teal });
    expect(result.colors.text).toBe("#FFFFFF");
    expect(result.taken.filter(({ source }) => source === "derived").map(({ name }) => name)).toEqual([
      "line",
      "evidence",
    ]);
  });

  it("moves a color far enough to read on the panel too, not only on the slide", () => {
    // The panel is a lighter blue-green than the slide, so the link has to go further to read on it.
    const colors = { ...TEAL, dk1: "24585E" };
    const result = buildPalette({ theme: themeOf(colors), map: darkMap, background: teal });
    expect(result.colors.bg).toBe("#1E5155");
    expect(result.colors.surface).toBe("#24585E");
    const { evidence, bg, surface } = result.colors;
    expect(contrastRatio("#58C1BA", surface)).toBeLessThan(CONTRAST.text);
    expect(contrastRatio(evidence, bg)).toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrastRatio(evidence, surface)).toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrastFailures(result.colors)).toEqual([]);
  });
  it("moves a color only when the preset's would fail too; one the preset fixes goes back to it", () => {
    // On this blue-green the preset's muted color reads and the preset's link color does not, and the theme's fail both.
    const sea = "#0E4250";
    const colors = { ...TEAL, dk2: "0E4250", lt2: "4A8A94", hlink: "2F6F7A" };
    expect(contrastRatio(PRESETS.ink.muted, sea)).toBeGreaterThanOrEqual(CONTRAST.text);
    expect(contrastRatio(PRESETS.ink.evidence, sea)).toBeLessThan(CONTRAST.text);
    expect(contrastRatio("#4A8A94", sea)).toBeLessThan(CONTRAST.text);
    expect(contrastRatio("#2F6F7A", sea)).toBeLessThan(CONTRAST.text);
    const result = buildPalette({
      theme: themeOf(colors),
      map: darkMap,
      background: { hex: sea, key: "dk2", plain: true, kind: "schemeClr" },
    });
    expect(result.colors.bg).toBe(sea);
    expect(contrastFailures(result.colors)).toEqual([]);
    expect(result.colors.muted).toBe(PRESETS.ink.muted);
    const sourceOf = (name: string) => result.taken.find((line) => line.name === name)?.source;
    expect(sourceOf("muted")).toBe("preset");
    expect(sourceOf("evidence")).toBe("derived");
    expect(result.kept.map((kept) => kept.name)).toEqual(["muted"]);
  });
  it("goes back to the preset, as it did, when a color would have to move more than half way", () => {
    // A mid gray: the link and the muted color would have to become the text color, and be no color of their own.
    const result = buildPalette({ theme: themeOf({ ...LIGHT, lt1: "808080" }), map: DEFAULT_COLOR_MAP });
    expect(result.kept.map((kept) => kept.name)).toEqual(["bg"]);
    expect(result.colors.bg).toBe(PRESETS.paper.bg);
    expect(result.taken.filter(({ source }) => source === "derived").map(({ name }) => name)).toEqual([
      "line",
    ]);
  });
});
describe("every palette passes its own rules", () => {
  it("whatever the theme, and whatever the master's background", () => {
    const next = random(20261103);
    let moved = 0;
    for (let n = 0; n < 4000; n++) {
      const colors: Partial<Record<ThemeKey, string>> = {};
      for (const key of KEYS) colors[key] = hexOf(next).slice(1);
      const background =
        n % 3 === 0 ? undefined : ({ hex: hexOf(next), plain: true, kind: "srgbClr" } as const);
      const result = buildPalette({
        theme: themeOf(colors),
        map: n % 2 ? DEFAULT_COLOR_MAP : darkMap,
        ...(background ? { background } : {}),
      });
      expect(contrastFailures(result.colors), JSON.stringify({ colors, background })).toEqual([]);
      if (result.taken.some(({ name, source }) => name !== "line" && source === "derived")) moved++;
    }
    // The themes that needed a color moved are in the run, so the moved ones are held to the rules too.
    expect(moved).toBeGreaterThan(100);
  });
});
describe("colors the theme leaves out", () => {
  it("keep the preset's, and the report says the theme had none", () => {
    const result = buildPalette({ theme: themeOf({ dk1: "000000", lt1: "FFFFFF" }), map: DEFAULT_COLOR_MAP });
    expect(result.colors.muted).toBe(PRESETS.paper.muted);
    expect(result.colors.action).toBe(PRESETS.paper.action);
    expect(result.taken.find(({ name }) => name === "muted")).toMatchObject({
      source: "preset",
      from: "Depthcue's paper preset; the theme has no color for it",
    });
    expect(result.kept).toEqual([]);
  });

  it("note a color the theme writes in a form this does not read", () => {
    const theme = themeOf(LIGHT);
    theme.unreadable.push({ key: "accent2", kind: "prstClr" });
    expect(buildPalette({ theme, map: DEFAULT_COLOR_MAP }).notes).toContain(
      "Accent 2 (accent2) is written as prstClr, which this does not read, so it was not used.",
    );
  });

  it("have no background to go on in a theme with neither a background nor a dark side", () => {
    const result = buildPalette({ theme: themeOf({}), map: DEFAULT_COLOR_MAP });
    expect(result.preset).toBe("paper");
    expect(result.presetWhy).toBe("The theme has no background color, so the colors are the paper palette.");
    expect(result.colors).toMatchObject({ bg: PRESETS.paper.bg, text: PRESETS.paper.text });
  });
});

describe("the chart colors", () => {
  it("skip a repeated accent, keep the order, and stop at the limit", () => {
    const many = {
      accent1: "B23A48",
      accent2: "B23A48",
      accent3: "2F6690",
      accent4: "3A7D44",
      accent5: "6C4A9E",
      accent6: "007C89",
    };
    const result = buildPalette({ theme: themeOf({ ...LIGHT, ...many }), map: DEFAULT_COLOR_MAP });
    expect(result.chart.colors).toEqual(["#B23A48", "#2F6690", "#3A7D44", "#6C4A9E", "#007C89"]);
    expect(result.chart.colors.length).toBeLessThanOrEqual(BRAND_LIMITS.chart);
  });

  it("leave out an accent that does not reach 3:1 on the background", () => {
    const result = buildPalette({ theme: themeOf({ ...LIGHT, accent2: "F6E58D" }), map: DEFAULT_COLOR_MAP });
    expect(result.chart.colors).not.toContain("#F6E58D");
  });
});

describe("contrastFailures against core's own check", () => {
  // The import repeats core's list of pairs so it can repair a palette before the check runs. This keeps the two the same.

  it("finds exactly the pairs core reports, for 400 random palettes", () => {
    const next = random(20261101);
    let failing = 0;
    for (let n = 0; n < 400; n++) {
      const colors = Object.fromEntries(PALETTE_COLORS.map((name) => [name, hexOf(next)])) as Palette;
      const mine = contrastFailures(colors)
        .map((failure) => `${failure.name}|${failure.against}|${failure.need}`)
        .sort();
      const core = checkBrandColors({ colors: { paper: colors } }, "brand.json")
        .map((diagnostic) => {
          const match = /"(\w+)" \(#\w+\) on "(\w+)" \(#\w+\).*the (\d+(?:\.\d+)?):1/.exec(
            diagnostic.message,
          );
          return `${match?.[1]}|${match?.[2]}|${match?.[3]}`;
        })
        .sort();
      expect(mine).toEqual(core);
      if (core.length > 0) failing++;
    }
    // Most random palettes fail somewhere, and some pass: both sides of the comparison were exercised.
    expect(failing).toBeGreaterThan(300);
  });

  it("finds nothing in the presets", () => {
    expect(contrastFailures(PRESETS.paper as unknown as Palette)).toEqual([]);
    expect(contrastFailures(PRESETS.ink as unknown as Palette)).toEqual([]);
  });
});

describe("the small helpers", () => {
  it("mix goes part of the way between two colors", () => {
    expect(mix("#000000", "#FFFFFF", 0)).toBe("#000000");
    expect(mix("#000000", "#FFFFFF", 1)).toBe("#FFFFFF");
    expect(mix("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(mix("#FF0000", "#0000FF", 0.5)).toBe("#800080");
  });

  it("shownRatio rounds down, so a ratio just under the minimum never prints as the minimum", () => {
    expect(shownRatio(4.4999)).toBe("4.49:1");
    expect(shownRatio(4.5)).toBe("4.5:1");
    expect(shownRatio(21)).toBe("21:1");
  });

  it("isDark is true where white reads better than black", () => {
    expect(isDark("#000000")).toBe(true);
    expect(isDark("#0E1116")).toBe(true);
    expect(isDark("#FFFFFF")).toBe(false);
    expect(isDark("#808080")).toBe(false);
  });

  it("labelOf names a theme color as the color picker does", () => {
    expect(labelOf("dk1")).toBe("Dark 1 (dk1)");
    expect(labelOf("hlink")).toBe("Hyperlink (hlink)");
    expect(labelOf("folHlink")).toBe("Followed hyperlink (folHlink)");
  });
});
