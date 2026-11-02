import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLOR_MAP,
  readColorMap,
  readTheme,
  resolveColor,
  type Theme,
} from "../src/brand-import/theme.ts";
import { parseXml } from "../src/brand-import/xml.ts";

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

function theme(parts: { colors?: string; fonts?: string; fills?: string; name?: string }): string {
  const colors = parts.colors ?? "";
  return `<a:theme ${NS}${parts.name ? ` name="${parts.name}"` : ""}><a:themeElements>${
    colors ? `<a:clrScheme name="c">${colors}</a:clrScheme>` : ""
  }<a:fontScheme name="f">${parts.fonts ?? ""}</a:fontScheme><a:fmtScheme name="s"><a:bgFillStyleLst>${parts.fills ?? ""}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

describe("readTheme", () => {
  it("reads the colors as #RRGGBB, upper case", () => {
    const read = readTheme(
      parseXml(
        theme({
          name: "Harbor",
          colors:
            '<a:dk1><a:srgbClr val="1b1b1b"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="b23a48"/></a:accent1>',
        }),
      ),
    ) as Theme;
    expect(read.name).toBe("Harbor");
    expect(read.colors).toEqual({ dk1: "#1B1B1B", lt1: "#FFFFFF", accent1: "#B23A48" });
    expect(read.unreadable).toEqual([]);
  });

  it("resolves a system color to its last color, or to Windows' own when it names none", () => {
    const read = readTheme(
      parseXml(
        theme({
          colors:
            '<a:dk1><a:sysClr val="windowText" lastClr="101010"/></a:dk1><a:lt1><a:sysClr val="window"/></a:lt1><a:dk2><a:sysClr val="windowText"/></a:dk2>',
        }),
      ),
    ) as Theme;
    expect(read.colors).toEqual({ dk1: "#101010", lt1: "#FFFFFF", dk2: "#000000" });
  });

  it("lists a color it cannot read instead of guessing it", () => {
    const read = readTheme(
      parseXml(
        theme({ colors: '<a:dk1><a:prstClr val="black"/></a:dk1><a:lt1><a:srgbClr val="nothex"/></a:lt1>' }),
      ),
    ) as Theme;
    expect(read.colors).toEqual({});
    expect(read.unreadable).toEqual([
      { key: "dk1", kind: "prstClr" },
      { key: "lt1", kind: "srgbClr" },
    ]);
  });

  it("returns nothing for a theme with no color scheme", () => {
    expect(readTheme(parseXml(theme({})))).toBeUndefined();
  });

  it("reads the heading and body fonts, with PANOSE only when it is 20 hex digits", () => {
    const read = readTheme(
      parseXml(
        theme({
          colors: '<a:dk1><a:srgbClr val="000000"/></a:dk1>',
          fonts:
            '<a:majorFont><a:latin typeface=" Georgia " panose="02040502050405020303"/></a:majorFont><a:minorFont><a:latin typeface="Calibri" panose="2"/></a:minorFont>',
        }),
      ),
    ) as Theme;
    expect(read.fonts.major).toEqual({ typeface: "Georgia", panose: "02040502050405020303" });
    expect(read.fonts.minor).toEqual({ typeface: "Calibri" });
  });

  it("ignores a font that points back at the theme or names nothing", () => {
    const read = readTheme(
      parseXml(
        theme({
          colors: '<a:dk1><a:srgbClr val="000000"/></a:dk1>',
          fonts:
            '<a:majorFont><a:latin typeface="+mj-lt"/></a:majorFont><a:minorFont><a:latin typeface=""/></a:minorFont>',
        }),
      ),
    ) as Theme;
    expect(read.fonts).toEqual({});
  });

  it("lists the kinds of background fill in order", () => {
    const read = readTheme(
      parseXml(
        theme({
          colors: '<a:dk1><a:srgbClr val="000000"/></a:dk1>',
          fills: '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill/><a:blipFill/>',
        }),
      ),
    ) as Theme;
    expect(read.backgroundFills).toEqual(["solidFill", "gradFill", "blipFill"]);
  });
});

describe("readColorMap", () => {
  const map = (attrs: string) => readColorMap(parseXml(`<m ${attrs}/>`));

  it("is the usual map when nothing is said", () => {
    expect(readColorMap(undefined)).toEqual(DEFAULT_COLOR_MAP);
  });

  it("maps background to dark and text to light on a dark master", () => {
    const dark = map('bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"');
    expect(dark).toMatchObject({ bg1: "dk1", tx1: "lt1", bg2: "dk2", tx2: "lt2", accent1: "accent1" });
  });

  it("ignores a name it does not know, and a value that is no theme color", () => {
    const odd = map('bg1="nonsense" other="dk1"');
    expect(odd).toEqual(DEFAULT_COLOR_MAP);
  });
});

describe("resolveColor", () => {
  const read: Theme = {
    colors: { dk1: "#111111", lt1: "#FFFFFF", dk2: "#222222", lt2: "#EEEEEE", accent1: "#AA0000" },
    unreadable: [],
    fonts: {},
    backgroundFills: [],
  };
  const element = (xml: string) => parseXml(`<x ${NS}>${xml}</x>`).children[0];

  it("reads an RGB color", () => {
    expect(resolveColor(element('<a:srgbClr val="aabbcc"/>'), read, DEFAULT_COLOR_MAP)).toEqual({
      hex: "#AABBCC",
      plain: true,
      kind: "srgbClr",
    });
  });

  it("reads a scheme color through the master's map", () => {
    const dark = readColorMap(parseXml('<m bg1="dk1" tx1="lt1"/>'));
    expect(resolveColor(element('<a:schemeClr val="bg1"/>'), read, DEFAULT_COLOR_MAP)).toMatchObject({
      hex: "#FFFFFF",
      key: "lt1",
    });
    expect(resolveColor(element('<a:schemeClr val="bg1"/>'), read, dark)).toMatchObject({
      hex: "#111111",
      key: "dk1",
    });
    expect(resolveColor(element('<a:schemeClr val="accent1"/>'), read, dark)).toMatchObject({
      hex: "#AA0000",
    });
  });

  it("reads a scheme color named as a theme color directly", () => {
    expect(resolveColor(element('<a:schemeClr val="dk2"/>'), read, DEFAULT_COLOR_MAP)).toMatchObject({
      hex: "#222222",
      key: "dk2",
    });
  });

  it("says a color with an adjustment is not plain", () => {
    expect(
      resolveColor(
        element('<a:schemeClr val="bg1"><a:lumMod val="95000"/></a:schemeClr>'),
        read,
        DEFAULT_COLOR_MAP,
      ),
    ).toMatchObject({
      hex: "#FFFFFF",
      plain: false,
    });
    expect(
      resolveColor(
        element('<a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr>'),
        read,
        DEFAULT_COLOR_MAP,
      )?.plain,
    ).toBe(false);
  });

  it("gives no color for the placeholder color, a preset name or an unknown scheme name", () => {
    expect(resolveColor(element('<a:schemeClr val="phClr"/>'), read, DEFAULT_COLOR_MAP)?.hex).toBeUndefined();
    expect(resolveColor(element('<a:prstClr val="black"/>'), read, DEFAULT_COLOR_MAP)).toEqual({
      plain: false,
      kind: "prstClr",
    });
    expect(resolveColor(undefined, read, DEFAULT_COLOR_MAP)).toBeUndefined();
  });

  it("reads a system color", () => {
    expect(
      resolveColor(element('<a:sysClr val="window" lastClr="FEFEFE"/>'), read, DEFAULT_COLOR_MAP)?.hex,
    ).toBe("#FEFEFE");
    expect(resolveColor(element('<a:sysClr val="windowText"/>'), read, DEFAULT_COLOR_MAP)?.hex).toBe(
      "#000000",
    );
  });
});
