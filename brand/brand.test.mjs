import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandFiles, palette, parseFont } from "../tools/brand.mjs";
import { contrast } from "../tools/contrast.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url));
const tokens = JSON.parse(read("./tokens.json").toString("utf8"));
const fonts = {
  display: parseFont(read("./fonts/InstrumentSerif-Regular.ttf")),
  ui: parseFont(read("./fonts/SpaceGrotesk-Medium.ttf")),
  mono: parseFont(read("./fonts/IBMPlexMono-Regular.ttf")),
};
const files = brandFiles(tokens, fonts);

describe("the brand files", () => {
  it("are a mark, a logo and a social card, each for light and for dark surfaces", () => {
    expect([...files.keys()].sort()).toEqual([
      "brand/logo-on-dark.svg",
      "brand/logo.svg",
      "brand/mark-on-dark.svg",
      "brand/mark.svg",
      "brand/social-card-on-dark.svg",
      "brand/social-card.svg",
    ]);
  });

  it.each([...files])("%s is one svg document with a size and a label", (_path, text) => {
    expect(text.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ')).toBe(true);
    expect(text.trimEnd().endsWith("</svg>")).toBe(true);
    expect(text).toMatch(/ width="\d+" height="\d+" role="img" aria-label="Depthcue/);
  });

  it.each([...files])("%s draws its letters as outlines, so it needs no font", (_path, text) => {
    expect(text).not.toContain("<text");
    expect(text).not.toContain("font-family");
  });

  it.each([...files])("%s uses each clip path id once", (_path, text) => {
    const ids = [...text.matchAll(/<clipPath id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("come out the same every time", () => {
    expect(brandFiles(tokens, fonts)).toEqual(files);
  });
});

describe("the colors", () => {
  it("come from the tokens and not from the drawing code", () => {
    const changed = structuredClone(tokens);
    changed.color.brand.vermilion.$value = "#123456";
    changed.color.theme.paper.text.$value = "#654321";
    const mark = brandFiles(changed, fonts).get("brand/mark.svg");
    expect(mark).toContain('fill="#123456"');
    expect(mark).toContain('fill="#654321"');
    expect(mark).not.toContain(tokens.color.brand.vermilion.$value);
    expect(mark).not.toContain(tokens.color.theme.paper.text.$value);
  });

  it("put the vermilion cue dot on every mark, in both themes", () => {
    for (const path of ["brand/mark.svg", "brand/mark-on-dark.svg"]) {
      expect(files.get(path)).toContain(
        `<circle cx="19" cy="49" r="5.5" fill="${palette(tokens, "paper").cue}"/>`,
      );
    }
  });

  it("give the on-dark files the dark theme's text color and the others the light theme's", () => {
    expect(files.get("brand/logo.svg")).toContain(`fill="${tokens.color.theme.paper.text.$value}"`);
    expect(files.get("brand/logo.svg")).not.toContain(tokens.color.theme.ink.text.$value);
    expect(files.get("brand/logo-on-dark.svg")).toContain(`fill="${tokens.color.theme.ink.text.$value}"`);
    expect(files.get("brand/logo-on-dark.svg")).not.toContain(tokens.color.theme.paper.text.$value);
  });

  it("keep the cue at least 3:1 against the plane it sits on in the light mark", () => {
    const paper = palette(tokens, "paper");
    expect(contrast(paper.cue, paper.text)).toBeGreaterThanOrEqual(3);
  });

  it("keep the card's lines readable on its background", () => {
    for (const theme of ["paper", "ink"]) {
      const colors = palette(tokens, theme);
      expect(contrast(colors.text, colors.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.muted, colors.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("the mark", () => {
  const mark = files.get("brand/mark.svg");

  it("is a front plane that is filled and two planes behind it that are cut where they are covered", () => {
    expect(mark.match(/<rect /g)).toHaveLength(3);
    expect(mark.match(/<clipPath /g)).toHaveLength(2);
    expect(mark.match(/ clip-path="url\(#m\d\)"/g)).toHaveLength(2);
    expect(mark.match(/stroke-opacity="[\d.]+"/g)).toEqual([
      'stroke-opacity="0.38"',
      'stroke-opacity="0.68"',
    ]);
  });

  it("fits the 64 by 64 grid it is drawn on, strokes included", () => {
    for (const [, x, y, size] of mark.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/g)) {
      expect(Number(x) - 1.5).toBeGreaterThanOrEqual(0);
      expect(Number(y) - 1.5).toBeGreaterThanOrEqual(0);
      expect(Number(x) + Number(size) + 1.5).toBeLessThanOrEqual(64);
      expect(Number(y) + Number(size) + 1.5).toBeLessThanOrEqual(64);
    }
  });
});

describe("the social card", () => {
  const card = files.get("brand/social-card.svg");

  it("is 1280 by 640", () => {
    expect(card).toContain('viewBox="0 0 1280 640" width="1280" height="640"');
  });

  it("keeps the whole mark inside the card, off the edge", () => {
    const [, left, top, scale] = card.match(/translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)/);
    expect(Number(left) + 4.5 * Number(scale)).toBeGreaterThan(0);
    expect(Number(left) + 59.5 * Number(scale)).toBeLessThanOrEqual(1280);
    expect(Number(top)).toBeGreaterThan(0);
    expect(Number(top) + 64 * Number(scale)).toBeLessThanOrEqual(640);
  });

  it("says what Depthcue is in its own tagline", () => {
    expect(card).toContain(
      "Depthcue: explanations an agent can write, a person can repair, and both can present",
    );
  });
});

describe("the font files", () => {
  const names = readdirSync(new URL("./fonts/", import.meta.url));

  it("each travel with their license, which the OFL requires", () => {
    const families = names.filter((name) => name.endsWith(".ttf")).map((name) => name.split("-")[0]);
    expect(families.sort()).toEqual(["IBMPlexMono", "InstrumentSerif", "SpaceGrotesk"]);
    for (const family of families) expect(names).toContain(`${family}-OFL.txt`);
  });
});
