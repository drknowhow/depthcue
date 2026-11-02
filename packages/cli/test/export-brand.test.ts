import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeckLook, type ExportData, type FontPair, lookOf, type PageLook } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { brandFilesOf, EXPORT_MARKER, type ExportRequest, exportDeck } from "../src/export.ts";

const branded = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const plain = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

const PAIRS: FontPair[] = ["editorial", "modern", "classic", "technical"];

let root: string;
let deck: string;
let runtime: string;
let fonts: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-export-brand-"));
  deck = join(root, "deck");
  cpSync(branded, deck, { recursive: true });
  runtime = join(root, "runtime");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "depthcue.js"), "/* the script */");
  writeFileSync(join(runtime, "depthcue.css"), "/* the styles */");
  // The built-in pairs, as stand-ins: a stylesheet per pair naming one file of its own.
  fonts = join(root, "fonts-src");
  mkdirSync(fonts);
  const licenses: Record<string, string> = {};
  for (const pair of PAIRS) {
    writeFileSync(
      join(fonts, `${pair}.css`),
      `@font-face {\n  font-family: "${pair}";\n  src: url("${pair}.woff2") format("woff2");\n}\n`,
    );
    writeFileSync(join(fonts, `${pair}.woff2`), `font:${pair}`);
    writeFileSync(join(fonts, `${pair}-OFL.txt`), `license of ${pair}`);
    licenses[pair] = `${pair}-OFL.txt`;
  }
  writeFileSync(join(fonts, "licenses.json"), JSON.stringify(licenses));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const out = () => join(root, "out");
const run = (extra: Partial<ExportRequest> = {}) =>
  exportDeck({ folder: deck, out: out(), runtimeDir: runtime, fontsDir: fonts, ...extra });
const done = (extra: Partial<ExportRequest> = {}) => {
  const result = run(extra);
  if (!result.ok) throw new Error(`the export failed: ${JSON.stringify(result.diagnostics)}`);
  return result.summary;
};

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function embedded(html: string): ExportData {
  const match = html.match(/<script type="application\/json" id="depthcue-data">(.*?)<\/script>/s);
  if (!match) throw new Error("the page has no deck data");
  return JSON.parse(match[1] as string) as ExportData;
}

const put = (path: string, text: string | Uint8Array) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const editJson = (path: string, change: (json: Record<string, any>) => void) => {
  const json = JSON.parse(readFileSync(path, "utf8"));
  change(json);
  writeFileSync(path, JSON.stringify(json));
};

describe("an export of a deck with a brand", () => {
  it("carries the brand's faces, the logo for the deck's theme and nothing else from the brand folder", () => {
    const summary = done();
    expect(listing(out())).toEqual(
      [
        EXPORT_MARKER,
        "brand/fonts/HarborSans-Bold.woff2",
        "brand/fonts/HarborSans-Regular.woff2",
        "brand/fonts/OFL.txt",
        "brand/logos/harbor.svg",
        "depthcue.css",
        "depthcue.js",
        "fonts/modern-OFL.txt",
        "fonts/modern.css",
        "fonts/modern.woff2",
        "index.html",
      ].sort(),
    );
    expect(summary.brandFiles).toEqual([
      "brand/fonts/HarborSans-Bold.woff2",
      "brand/fonts/HarborSans-Regular.woff2",
      "brand/logos/harbor.svg",
    ]);
    // The files that are not for a page stay behind: the brand file and its templates.
    for (const left of ["brand/brand.json", "brand/templates/cover.json"]) {
      expect(existsSync(join(out(), left)), left).toBe(false);
    }
  });

  it("copies the font's license text beside its faces, and the license of each built-in family it uses, byte for byte", () => {
    const summary = done();
    expect(summary.licenses).toEqual(["brand/fonts/OFL.txt", "fonts/modern-OFL.txt"]);
    expect(
      readFileSync(join(out(), "brand", "fonts", "OFL.txt")).equals(
        readFileSync(join(deck, "brand", "fonts", "OFL.txt")),
      ),
    ).toBe(true);
    expect(readFileSync(join(out(), "fonts", "modern-OFL.txt"), "utf8")).toBe("license of modern");
    // The license is not a brand file: the page does not read it, and the summary's list of those does not count it.
    expect(summary.brandFiles).not.toContain("brand/fonts/OFL.txt");
    // It is in the page's data nowhere, and the marker lists it so the next export can replace it.
    expect(readFileSync(join(out(), "index.html"), "utf8")).not.toContain("OFL.txt");
    const marker = JSON.parse(readFileSync(join(out(), EXPORT_MARKER), "utf8")) as { files: string[] };
    expect(marker.files).toContain("brand/fonts/OFL.txt");
    expect(marker.files).toContain("fonts/modern-OFL.txt");
  });

  it("copies every .txt beside a face it copies, and none beside a logo or a picture, or in a folder with no face", () => {
    put(join(deck, "brand", "fonts", "NOTICE.txt"), "notice");
    put(join(deck, "brand", "fonts", "not a license.txt"), "a name the marker cannot carry");
    put(join(deck, "brand", "logos", "usage.txt"), "how to use the logo");
    put(join(deck, "brand", "images", "credits.txt"), "credits");
    expect(done().licenses).toEqual([
      "brand/fonts/NOTICE.txt",
      "brand/fonts/OFL.txt",
      "fonts/modern-OFL.txt",
    ]);
    expect(existsSync(join(out(), "brand", "logos", "usage.txt"))).toBe(false);
    expect(existsSync(join(out(), "brand", "images", "credits.txt"))).toBe(false);
    expect(existsSync(join(out(), "brand", "fonts", "not a license.txt"))).toBe(false);
  });

  it("copies no brand license text when the brand's faces are not copied", () => {
    editJson(join(deck, "brand", "brand.json"), (brand) => {
      brand.fonts = "modern";
    });
    const summary = done();
    expect(summary.licenses).toEqual(["fonts/modern-OFL.txt"]);
    expect(existsSync(join(out(), "brand", "fonts"))).toBe(false);
  });

  it("copies those files byte for byte, and counts them in the summary", () => {
    const summary = done();
    for (const path of summary.brandFiles) {
      expect(readFileSync(join(out(), path)).equals(readFileSync(join(deck, path))), path).toBe(true);
    }
    const written = listing(out()).filter((path) => path !== EXPORT_MARKER);
    expect(summary.files).toBe(written.length);
    expect(summary.bytes).toBe(written.reduce((sum, path) => sum + statSync(join(out(), path)).size, 0));
  });

  it("puts the deck's look in the page, so the page needs no brand file to read it", () => {
    done();
    const data = embedded(readFileSync(join(out(), "index.html"), "utf8"));
    const look = data.look as PageLook;
    expect(look.colors.action).toBe("#0B6E6E");
    expect(look.chart).toEqual(["#0B6E6E", "#2D4BB8", "#B4531F"]);
    expect(look.faces?.display.family).toBe("Harbor Display");
    expect(look.chrome?.footer?.text).toBe("Harbor Analytics, for internal use");
    expect(Object.keys(look.templates).sort()).toEqual(["chart-and-note", "cover"]);
    // The templates themselves are in the look, so the page does not read brand/templates.
    expect(look.templates.cover?.slots.map((slot) => slot.id)).toEqual(["kicker", "title", "byline"]);
    expect(JSON.stringify(data)).not.toContain("fonts/OFL.txt");
  });

  it("takes the pair the brand falls back to, not the deck's own, for the built-in fonts", () => {
    expect(done().fonts).toBe("modern");
    const html = readFileSync(join(out(), "index.html"), "utf8");
    expect(html).toContain('href="fonts/modern.css"');
  });

  it("leaves the other theme's logo behind, and takes it when the deck is on that theme", () => {
    put(join(deck, "brand", "logos", "harbor-dark.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    editJson(join(deck, "brand", "brand.json"), (brand) => {
      brand.logos.dark = "logos/harbor-dark.svg";
    });
    expect(done().brandFiles).not.toContain("brand/logos/harbor-dark.svg");
    editJson(join(deck, "deck.json"), (manifest) => {
      manifest.theme = "ink";
    });
    const ink = done().brandFiles;
    expect(ink).toContain("brand/logos/harbor-dark.svg");
    expect(ink).not.toContain("brand/logos/harbor.svg");
  });

  it("takes the images the deck's templates draw behind a slide, and not the ones it does not use", () => {
    put(join(deck, "brand", "images", "hero.jpg"), "jpg");
    put(join(deck, "brand", "images", "unused.jpg"), "jpg");
    editJson(join(deck, "brand", "templates", "cover.json"), (template) => {
      template.background = { color: "text", image: "images/hero.jpg", scrim: 60 };
    });
    const summary = done();
    expect(summary.brandFiles).toContain("brand/images/hero.jpg");
    expect(existsSync(join(out(), "brand", "images", "hero.jpg"))).toBe(true);
    expect(existsSync(join(out(), "brand", "images", "unused.jpg"))).toBe(false);
  });

  it("leaves out the images of a template no scene uses", () => {
    put(join(deck, "brand", "images", "hero.jpg"), "jpg");
    editJson(join(deck, "brand", "templates", "cover.json"), (template) => {
      template.background = { color: "text", image: "images/hero.jpg", scrim: 60 };
    });
    editJson(join(deck, "deck.json"), (manifest) => {
      manifest.scenes = ["context", "growth"];
    });
    expect(done().brandFiles).not.toContain("brand/images/hero.jpg");
  });

  it("writes nothing for a deck whose brand names a file that is not there: the deck has an error", () => {
    rmSync(join(deck, "brand", "fonts", "HarborSans-Bold.woff2"));
    const result = run();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain("missing-brand-file");
    expect(existsSync(out())).toBe(false);
  });

  it("does not copy a file that a symlink points out of the brand folder, and says which file it left out", (ctx) => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "outside the deck");
    rmSync(join(deck, "brand", "logos", "harbor.svg"));
    try {
      symlinkSync(secret, join(deck, "brand", "logos", "harbor.svg"));
    } catch {
      // Creating a symlink needs a privilege on some Windows setups, and the check cannot be run without one: skipped,
      // not passed.
      return ctx.skip();
    }
    const summary = done();
    expect(summary.brandFiles).not.toContain("brand/logos/harbor.svg");
    expect(existsSync(join(out(), "brand", "logos", "harbor.svg"))).toBe(false);
    // The page's data still names the logo, so the export says it was left out instead of leaving a broken picture.
    expect(readFileSync(join(out(), "index.html"), "utf8")).toContain("brand/logos/harbor.svg");
    const warning = summary.warnings.find((diagnostic) => diagnostic.code === "brand-file-not-copied");
    expect(warning).toMatchObject({ severity: "warning", file: "brand/logos/harbor.svg" });
    expect(warning?.message).toContain("brand/logos/harbor.svg");
    expect(warning?.message).toContain("outside the brand folder");
    expect(warning?.fix).toBeTruthy();
    expect(summary.warnings.filter((diagnostic) => diagnostic.code === "brand-file-not-copied")).toHaveLength(
      1,
    );
  });

  it("does not copy a license text that a symlink points out of the brand folder either, and says so", (ctx) => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "outside the deck");
    rmSync(join(deck, "brand", "fonts", "OFL.txt"));
    try {
      symlinkSync(secret, join(deck, "brand", "fonts", "OFL.txt"));
    } catch {
      return ctx.skip();
    }
    const summary = done();
    expect(summary.licenses).toEqual(["fonts/modern-OFL.txt"]);
    expect(existsSync(join(out(), "brand", "fonts", "OFL.txt"))).toBe(false);
    expect(summary.warnings.map((diagnostic) => diagnostic.file)).toContain("brand/fonts/OFL.txt");
  });

  it.each([
    [
      "an XHTML img",
      '<svg xmlns="http://www.w3.org/2000/svg"><img xmlns="http://www.w3.org/1999/xhtml" src="http://evil.example/p.png"/></svg>',
      'an element outside the SVG namespace ("img")',
    ],
    [
      "a script",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>',
      'a "script" element',
    ],
    [
      "an encoding other than UTF-8",
      '<?xml version="1.0" encoding="ISO-2022-JP"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      'an encoding of "ISO-2022-JP"',
    ],
  ])("leaves out a brand SVG with %s, which the upload would refuse, and says so", (_, svg, problem) => {
    // Written into the brand folder by hand, as brand use or a copy can: not through the upload's check.
    writeFileSync(join(deck, "brand", "logos", "harbor.svg"), svg);
    const summary = done();
    expect(summary.brandFiles).not.toContain("brand/logos/harbor.svg");
    expect(existsSync(join(out(), "brand", "logos", "harbor.svg"))).toBe(false);
    const warnings = summary.warnings.filter((diagnostic) => diagnostic.code === "brand-file-not-copied");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ severity: "warning", file: "brand/logos/harbor.svg" });
    expect(warnings[0]?.message).toContain(`brand/logos/harbor.svg is an SVG with ${problem}`);
    expect(warnings[0]?.fix).toContain("plain SVG");
    // The fonts still go: only the SVG is left out.
    expect(summary.brandFiles).toContain("brand/fonts/HarborSans-Bold.woff2");
  });

  it("has no warning to give when every brand file the page names was copied", () => {
    expect(done().warnings.filter((diagnostic) => diagnostic.code === "brand-file-not-copied")).toEqual([]);
  });

  it("is replaced cleanly by the next export: a face the brand dropped does not stay behind", () => {
    done();
    editJson(join(deck, "brand", "brand.json"), (brand) => {
      brand.fonts = "modern";
    });
    const summary = done();
    expect(summary.brandFiles).toEqual(["brand/logos/harbor.svg"]);
    expect(existsSync(join(out(), "brand", "fonts"))).toBe(false);
    expect(existsSync(join(out(), "brand", "logos", "harbor.svg"))).toBe(true);
  });
});

describe("the brand files an export will copy", () => {
  const lookOfDeck = (): DeckLook => {
    const opened = openDeck(deck);
    if (!opened.ok) throw new Error("the fixture has errors");
    return lookOf(opened.doc);
  };

  // The same rule as the server's: a path that climbs, doubles a separator, holds a backslash or a NUL is not one a page
  // may read, so it is not one the export copies. Core's schema refuses most of these in a brand.json already; this is
  // the second wall, the one a look from anywhere else would meet.
  it.each([
    "brand/images/../notes.png",
    "brand/images/./hero.png",
    "brand/images//hero.png",
    "brand/images/..\\notes.png",
    "brand/logos/../templates/draft.svg",
    "brand/logos/..\\templates\\draft.svg",
    "brand/images/hero.png\0",
    "brand/images/hero.png\0.png",
    "images/hero.png",
    "brand/notes.png",
    "brand/templates/draft.svg",
  ])("does not copy %j, and says it left it out", (path) => {
    put(join(deck, "brand", "images", "hero.png"), "png");
    put(join(deck, "brand", "notes.png"), "a picture the page has no business with");
    put(join(deck, "brand", "templates", "draft.svg"), "<svg/>");
    const look = lookOfDeck();
    look.chrome = { accent: "none", logo: { path, alt: "x", corner: "top-end", size: "s" } };
    const { files, left } = brandFilesOf(look, deck);
    expect(files).not.toContain(path);
    expect(left.map((diagnostic) => diagnostic.file)).toEqual([path]);
    // The faces the look names are still copied.
    expect(files).toContain("brand/fonts/HarborSans-Regular.woff2");
  });

  it("copies a picture in its own folder", () => {
    put(join(deck, "brand", "images", "hero.png"), "png");
    const look = lookOfDeck();
    look.chrome = {
      accent: "none",
      logo: { path: "brand/images/hero.png", alt: "x", corner: "top-end", size: "s" },
    };
    const { files, left } = brandFilesOf(look, deck);
    expect(files).toContain("brand/images/hero.png");
    expect(left).toEqual([]);
  });
});

describe("an export of a deck with no brand", () => {
  it("carries no brand folder and no brand files, and a look with nothing a brand adds", () => {
    deck = join(root, "plain");
    cpSync(plain, deck, { recursive: true });
    const summary = done({ folder: deck });
    expect(summary.brandFiles).toEqual([]);
    expect(listing(out()).some((path) => path.startsWith("brand/"))).toBe(false);
    const look = embedded(readFileSync(join(out(), "index.html"), "utf8")).look as PageLook;
    expect(look.faces).toBeUndefined();
    expect(look.chrome).toBeUndefined();
    expect(look.templates).toEqual({});
  });
});
