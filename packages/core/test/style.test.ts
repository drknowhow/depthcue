import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTRAST,
  checkDeckFiles,
  checkManifest,
  checkPalette,
  checkTones,
  contrastRatio,
  DEFAULT_FONTS,
  type Deck,
  isLargeText,
  luminance,
  PALETTE_COLORS,
  PRESETS,
  type Scene,
  styleOf,
  THEME_COLORS,
  THEMES,
  TONES,
} from "../src/index.ts";
import { loadDir } from "./helpers.ts";

const tokens = JSON.parse(readFileSync(new URL("../../../brand/tokens.json", import.meta.url), "utf8")) as {
  color: { theme: Record<string, Record<string, { $value: string }>> };
};
const v03Dir = fileURLToPath(new URL("../../../fixtures/decks/v0-3", import.meta.url));

const deck = (extra: Partial<Deck> = {}): Deck =>
  ({
    schemaVersion: "0.3",
    id: "a-deck",
    title: "A deck",
    language: "en",
    theme: "paper",
    scenes: ["a-scene"],
    ...extra,
  }) as Deck;

const textScene = (block: Record<string, unknown>, schemaVersion = "0.3"): Scene =>
  ({
    schemaVersion,
    id: "a-scene",
    title: "A scene",
    layout: "title",
    blocks: [{ id: "a-text", type: "text", role: "body", text: "Words", ...block }],
  }) as Scene;

/** An action color between 3:1 and 4.5:1 on the paper backgrounds: fine for large text, too faint for small. */
const faintAction = "#D9542E";

describe("the theme presets", () => {
  it("are brand/tokens.json's colors, every one of them", () => {
    for (const theme of THEMES) {
      const fromTokens = Object.fromEntries(
        Object.entries(tokens.color.theme[theme] ?? {}).map(([name, token]) => [name, token.$value]),
      );
      expect(PRESETS[theme], theme).toEqual(fromTokens);
      expect(Object.keys(PRESETS[theme]).sort()).toEqual([...THEME_COLORS].sort());
    }
  });

  it("pass their own contrast check", () => {
    for (const theme of THEMES) expect(checkPalette(deck({ theme })), theme).toEqual([]);
  });

  it("leave the state colors out of the palette, and the backgrounds and line out of the tones", () => {
    expect(PALETTE_COLORS).not.toContain("state");
    expect(PALETTE_COLORS).not.toContain("on-state");
    for (const tone of TONES) expect(PALETTE_COLORS).toContain(tone);
    for (const name of ["bg", "surface", "line"]) expect(TONES).not.toContain(name);
  });
});

describe("a deck's style", () => {
  it("is its theme's preset with the palette on top, and the default fonts", () => {
    const style = styleOf(deck({ theme: "ink", palette: { action: "#FF8800" } }));
    expect(style.colors).toEqual({ ...PRESETS.ink, action: "#FF8800" });
    expect(style.fonts).toBe(DEFAULT_FONTS);
    expect(styleOf(deck({ fonts: "technical" })).fonts).toBe("technical");
  });

  it("checks a palette's colors and font pair in deck.json's schema", () => {
    expect(checkManifest(deck({ palette: { text: "#111111" }, fonts: "classic" }))).toEqual([]);
    const [hex] = checkManifest(deck({ palette: { text: "red" } as never }));
    expect(hex).toMatchObject({ code: "bad-format", path: "/palette/text" });
    const [state] = checkManifest(deck({ palette: { state: "#000000" } as never }));
    expect(state).toMatchObject({ code: "unknown-property", path: "/palette/state" });
    const [empty] = checkManifest(deck({ palette: {} }));
    expect(empty).toMatchObject({ code: "too-few", path: "/palette" });
    const [font] = checkManifest(deck({ fonts: "comic" as never }));
    expect(font).toMatchObject({ code: "bad-value", path: "/fonts" });
  });
});

describe("contrast", () => {
  it("is measured the way WCAG 2 measures it", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#FFFFFF")).toBe(1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });

  it("holds text colors to 4.5:1 on bg and surface, naming the color the palette changed", () => {
    const found = checkPalette(deck({ palette: { muted: "#B0B0B0" } }));
    expect(found.map((d) => [d.code, d.path, d.severity])).toEqual([
      ["palette-low-contrast", "/palette/muted", "error"],
      ["palette-low-contrast", "/palette/muted", "error"],
    ]);
    expect(found[0]?.message).toContain('"muted" (#B0B0B0) on "bg" (#F5F2EA)');
    expect(found[0]?.message).toContain(`under the ${CONTRAST.text}:1`);
    expect(found[0]?.fix).toBe('Make "muted" darker until the two reach 4.5:1.');
  });

  it("names the background when the palette changed that instead", () => {
    const found = checkPalette(deck({ palette: { surface: "#C9C2B0" } }));
    expect(found.length).toBeGreaterThan(0);
    for (const each of found) expect(each.path).toBe("/palette/surface");
    expect(found[0]?.fix).toMatch(/^Make "surface" lighter/);
  });

  it("holds action to 3:1 only, since small text in it is checked where it is used", () => {
    expect(checkPalette(deck({ palette: { action: faintAction } }))).toEqual([]);
    const [found] = checkPalette(deck({ palette: { action: "#E07050" } }));
    expect(found).toMatchObject({ code: "palette-low-contrast", path: "/palette/action" });
    expect(found?.message).toContain(`under the ${CONTRAST.large}:1 that even large text needs`);
  });

  it("runs on deck.json with the rest of the deck's checks", () => {
    expect(checkDeckFiles(loadDir(v03Dir))).toEqual([]);
  });
});

describe("tones on text", () => {
  const faint = styleOf(deck({ palette: { action: faintAction } }));

  it("may be faint on large text: a heading, or size l or xl", () => {
    expect(isLargeText({ id: "a", type: "text", role: "heading", text: "x" })).toBe(true);
    expect(isLargeText({ id: "a", type: "text", role: "body", text: "x", size: "l" })).toBe(true);
    expect(isLargeText({ id: "a", type: "text", role: "body", text: "x", size: "m" })).toBe(false);
    expect(checkTones(textScene({ tone: "action", size: "xl" }), faint, "scenes/a-scene.json")).toEqual([]);
    expect(checkTones(textScene({ role: "heading", tone: "action" }), faint, "scenes/a-scene.json")).toEqual(
      [],
    );
  });

  it("must reach 4.5:1 on smaller text, by the block's tone or a span's", () => {
    const [block] = checkTones(textScene({ tone: "action" }), faint, "scenes/a-scene.json");
    expect(block).toMatchObject({ code: "tone-low-contrast", path: "/blocks/0/tone", severity: "error" });
    const [span] = checkTones(textScene({ text: "Up [12%]{action}" }), faint, "scenes/a-scene.json");
    expect(span).toMatchObject({ code: "tone-low-contrast", path: "/blocks/0/text" });
    expect(checkTones(textScene({ tone: "action" }), styleOf(deck()), "scenes/a-scene.json")).toEqual([]);
  });

  it("are not read from the text of a scene below 0.3, where a span is only characters", () => {
    expect(checkTones(textScene({ text: "Up [12%]{action}" }, "0.2"), faint, "scenes/a-scene.json")).toEqual(
      [],
    );
  });
});
