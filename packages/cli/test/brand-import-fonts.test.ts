import { describe, expect, it } from "vitest";
import { classify, fallbackPair, readFonts } from "../src/brand-import/fonts.ts";

describe("classify", () => {
  it.each([
    ["Georgia", "02040502050405020303", "serif"],
    ["Calibri", "020F0502020204030204", "sans"],
    ["Century Gothic", "020B0502020202020204", "sans"],
    ["Palatino", "02020502050305020303", "serif"],
    ["Garamond", "02020404030301010803", "serif"],
  ])("takes %s from its PANOSE number: %s is a %s", (typeface, panose, kind) => {
    const face = classify({ typeface, panose });
    expect(face.kind).toBe(kind);
    expect(face.rule).toBe(`its PANOSE number ${panose} says ${kind}`);
  });

  it("reads PANOSE's second digit: 2 to 10 are serifs, 11 to 15 are sans", () => {
    expect(classify({ typeface: "X", panose: "02020000000000000000" }).kind).toBe("serif");
    expect(classify({ typeface: "X", panose: "020A0000000000000000" }).kind).toBe("serif");
    expect(classify({ typeface: "X", panose: "020B0000000000000000" }).kind).toBe("sans");
    expect(classify({ typeface: "X", panose: "020F0000000000000000" }).kind).toBe("sans");
  });

  it("goes by the name when PANOSE says nothing", () => {
    // A PANOSE number whose family is not Latin text, or whose style is 0 or 1, says nothing.
    expect(classify({ typeface: "Georgia", panose: "00000000000000000000" })).toMatchObject({
      kind: "serif",
      rule: 'its name matches the serif family "Georgia"',
    });
    expect(classify({ typeface: "Arial", panose: "02010000000000000000" })).toMatchObject({ kind: "sans" });
    expect(classify({ typeface: "Arial", panose: "03020000000000000000" }).rule).toMatch(
      /^its PANOSE number does not say, and its name is not a known serif/,
    );
  });

  it("goes by the name when there is no PANOSE number", () => {
    expect(classify({ typeface: "Times New Roman" })).toMatchObject({
      kind: "serif",
      rule: 'its name matches the serif family "Times"',
    });
    expect(classify({ typeface: "Source Serif Pro" }).kind).toBe("serif");
    expect(classify({ typeface: "Segoe UI" })).toEqual({
      kind: "sans",
      rule: "it has no PANOSE number, and its name is not a known serif, so a sans is assumed",
    });
  });

  it('puts "sans" and "gothic" ahead of the serif names: Century Gothic and Noto Sans are sans', () => {
    expect(classify({ typeface: "Century Gothic" })).toEqual({
      kind: "sans",
      rule: 'its name has "sans" or "gothic" in it',
    });
    expect(classify({ typeface: "Noto Sans Serif" }).kind).toBe("sans");
    expect(classify({ typeface: "Century Schoolbook" }).kind).toBe("serif");
  });
});

describe("fallbackPair", () => {
  it("is classic for a serif display face and modern for a sans one", () => {
    expect(fallbackPair("serif", "sans")).toEqual({
      pair: "classic",
      rule: "the display face is a serif, so the serif pair classic",
    });
    expect(fallbackPair("sans", "sans")).toEqual({
      pair: "modern",
      rule: "the display face is a sans, so the sans pair modern",
    });
    expect(fallbackPair("sans", "serif").pair).toBe("modern");
  });

  it("says when a serif body has no pair of its own", () => {
    expect(fallbackPair("serif", "serif").rule).toBe(
      "the display face is a serif, so the serif pair classic; no built-in pair has a serif body, so the body stands in as a sans",
    );
  });
});

describe("readFonts", () => {
  it("takes the heading font as display and the body font as body", () => {
    const { fonts, notes } = readFonts({
      major: { typeface: "Georgia", panose: "02040502050405020303" },
      minor: { typeface: "Calibri", panose: "020F0502020204030204" },
    });
    expect(fonts).toMatchObject({
      display: { family: "Georgia", kind: { kind: "serif" } },
      body: { family: "Calibri", kind: { kind: "sans" } },
      fallback: "classic",
    });
    expect(notes).toEqual([]);
  });

  it("uses the one font it has for both, and says so", () => {
    const onlyMinor = readFonts({ minor: { typeface: "Calibri" } });
    expect(onlyMinor.fonts?.display.family).toBe("Calibri");
    expect(onlyMinor.notes).toEqual([
      "The theme has no heading font, so the body font is used for headings too.",
    ]);
    const onlyMajor = readFonts({ major: { typeface: "Georgia" } });
    expect(onlyMajor.fonts?.body.family).toBe("Georgia");
    expect(onlyMajor.notes).toEqual([
      "The theme has no body font, so the heading font is used for text too.",
    ]);
  });

  it("gives no fonts for a theme with none", () => {
    const { fonts, notes } = readFonts({});
    expect(fonts).toBeUndefined();
    expect(notes).toEqual(["The theme names no font that can be used, so the deck keeps its own font pair."]);
  });

  it.each([
    ["a quote", 'Bad"Font'],
    ["an apostrophe", "Bob's Font"],
    ["a semicolon", "A;B"],
    ["a brace", "A{B}"],
    ["an angle bracket", "A<B"],
    ["a backslash", "A\\B"],
    ["a line break", "A\nB"],
    ["a tab", "A\tB"],
    ["a delete character", "A\u007fB"],
    ["more than 64 characters", "F".repeat(65)],
  ])("refuses a family name with %s, which a brand cannot carry", (_, typeface) => {
    const { fonts, notes } = readFonts({ major: { typeface }, minor: { typeface: "Calibri" } });
    expect(fonts?.display.family).toBe("Calibri");
    expect(notes[0]).toMatch(/^The theme's heading font ".*" has a name a brand cannot carry/);
    // The name is shown quoted as JSON, so a control character in it is written as an escape.
    expect(notes[0]).toContain(JSON.stringify(typeface).replaceAll("\u007f", "\\u007f"));
    const controls = [...(notes[0] ?? "")].filter(
      (char) => (char.codePointAt(0) ?? 0) < 0x20 || char === "\u007f",
    );
    expect(controls).toEqual([]);
  });

  it("accepts a 64-character family name", () => {
    expect(readFonts({ major: { typeface: "F".repeat(64) } }).fonts?.display.family).toBe("F".repeat(64));
  });
});
