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
import { type DeckLook, type ExportData, type FontPair } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPORT_MARKER, type ExportRequest, exportDeck } from "../src/export.ts";

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
  for (const pair of PAIRS) {
    writeFileSync(join(fonts, `${pair}.css`), `@font-face {\n  font-family: "${pair}";\n  src: url("${pair}.woff2") format("woff2");\n}\n`);
    writeFileSync(join(fonts, `${pair}.woff2`), `font:${pair}`);
  }
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
        "brand/logos/harbor.svg",
        "depthcue.css",
        "depthcue.js",
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
    // The files that are not for a page stay behind: the brand file, its templates, the font's licence text.
    for (const left of ["brand/brand.json", "brand/templates/cover.json", "brand/fonts/OFL.txt"]) {
      expect(existsSync(join(out(), left)), left).toBe(false);
    }
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
    const look = data.look as DeckLook;
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
    put(join(deck, "brand", "logos", "harbor-dark.svg"), "<svg/>");
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

  it("does not copy a file that a symlink points out of the brand folder", () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "outside the deck");
    rmSync(join(deck, "brand", "logos", "harbor.svg"));
    try {
      symlinkSync(secret, join(deck, "brand", "logos", "harbor.svg"));
    } catch {
      return; // creating a symlink needs a privilege on some Windows setups; the check itself is the same code
    }
    const summary = done();
    expect(summary.brandFiles).not.toContain("brand/logos/harbor.svg");
    expect(existsSync(join(out(), "brand", "logos", "harbor.svg"))).toBe(false);
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

describe("an export of a deck with no brand", () => {
  it("carries no brand folder and no brand files, and a look with nothing a brand adds", () => {
    deck = join(root, "plain");
    cpSync(plain, deck, { recursive: true });
    const summary = done({ folder: deck });
    expect(summary.brandFiles).toEqual([]);
    expect(listing(out()).some((path) => path.startsWith("brand/"))).toBe(false);
    const look = embedded(readFileSync(join(out(), "index.html"), "utf8")).look as DeckLook;
    expect(look.faces).toBeUndefined();
    expect(look.chrome).toBeUndefined();
    expect(look.templates).toEqual({});
  });
});
