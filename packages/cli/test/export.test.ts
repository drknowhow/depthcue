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
import { EXPORT_FORMAT, type ExportData, type FontPair } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPORT_MARKER, ExportError, type ExportRequest, exportDeck } from "../src/export.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

let root: string;
let deck: string;
let runtime: string;
let fonts: string;

/**
 * The font files each pair's stylesheet names, as stand-ins. The pairs share the mono file, as the real ones do, so a
 * test can tell a pair's own files from the ones every pair has.
 */
const FAKE_FONTS: Record<FontPair, string[]> = {
  editorial: ["EditorialSerif.woff2", "EditorialSans.woff2", "Mono.woff2"],
  modern: ["ModernSans.woff2", "ModernSansBold.woff2", "Mono.woff2"],
  classic: ["ClassicSerif.woff2", "ClassicSans.woff2", "Mono.woff2"],
  technical: ["TechnicalSans.woff2", "Mono.woff2"],
};
const sheetOf = (files: readonly string[]) =>
  files
    .map((name) => `@font-face {\n  font-family: "${name}";\n  src: url("${name}") format("woff2");\n}\n`)
    .join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "depthcue-export-"));
  deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
  // The page's script and styles, as stand-ins, so these tests do not need a built player.
  runtime = join(root, "runtime");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "depthcue.js"), "/* the script */");
  writeFileSync(join(runtime, "depthcue.css"), "/* the styles */");
  // The font stylesheets and files the build writes, as stand-ins.
  fonts = join(root, "fonts-src");
  mkdirSync(fonts);
  for (const [pair, files] of Object.entries(FAKE_FONTS)) {
    writeFileSync(join(fonts, `${pair}.css`), sheetOf(files));
    for (const name of files) writeFileSync(join(fonts, name), `font:${name}`);
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
const failure = (extra: Partial<ExportRequest> = {}): ExportError => {
  try {
    run(extra);
  } catch (error) {
    if (error instanceof ExportError) return error;
    throw error;
  }
  throw new Error("the export should have been refused");
};

/** Every file under a folder, as a sorted list of forward-slash paths. */
function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** The deck data a page carries. */
function embedded(html: string): ExportData {
  const match = html.match(/<script type="application\/json" id="depthcue-data">(.*?)<\/script>/s);
  if (!match) throw new Error("the page has no deck data");
  return JSON.parse(match[1] as string) as ExportData;
}

const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const readScene = (id: string) => JSON.parse(readFileSync(join(deck, "scenes", `${id}.json`), "utf8"));
const editScene = (id: string, change: (scene: Record<string, unknown>) => void) => {
  const scene = readScene(id);
  change(scene);
  write(join(deck, "scenes", `${id}.json`), JSON.stringify(scene));
};

/** Stops the demand scene naming report.csv, so no scene uses it. */
const dropReport = () =>
  editScene("demand", (scene) => {
    delete (scene.sources as Array<Record<string, unknown>>)[0]?.asset;
  });

/** Adds a scene with a clip, its poster and (unless told not to) a cue map. */
function addClip(cues: string | null = JSON.stringify({ format: "depthcue-cues/1", cues: [] })) {
  const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
  write(join(deck, "deck.json"), JSON.stringify({ ...manifest, scenes: [...manifest.scenes, "movie"] }));
  write(
    join(deck, "scenes", "movie.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "movie",
      title: "A clip",
      layout: "text-media",
      blocks: [
        { id: "movie-heading", type: "text", role: "heading", text: "In motion" },
        { id: "movie-clip", type: "clip", source: "assets/intro.mp4", poster: "assets/intro.png", alt: "x" },
      ],
    }),
  );
  write(join(deck, "assets", "intro.mp4"), "video");
  write(join(deck, "assets", "intro.png"), "poster");
  if (cues !== null) write(join(deck, "assets", "intro.cues.json"), cues);
}

/** The files an export wrote besides its marker, which its summary counts and weighs. */
const written = () => listing(out()).filter((path) => path !== EXPORT_MARKER);
const weighed = () => written().reduce((sum, path) => sum + statSync(join(out(), path)).size, 0);

/** What a deck on the default pair, editorial, takes along: its stylesheet and the three files it names. */
const EDITORIAL = [
  "fonts/EditorialSans.woff2",
  "fonts/EditorialSerif.woff2",
  "fonts/Mono.woff2",
  "fonts/editorial.css",
];

describe("what an export holds", () => {
  it("is a page, its script and styles, the deck's font pair, and the assets the scenes name", () => {
    const summary = done();
    expect(listing(out())).toEqual(
      [
        EXPORT_MARKER,
        "assets/method.svg",
        "assets/report.csv",
        "depthcue.css",
        "depthcue.js",
        ...EDITORIAL,
        "index.html",
      ].sort(),
    );
    expect(summary).toMatchObject({
      out: out(),
      index: join(out(), "index.html"),
      scenes: 3,
      assets: ["assets/method.svg", "assets/report.csv"],
      skipped: [],
      cueMaps: [],
      fonts: "editorial",
      notes: true,
      files: 9,
    });
    expect(summary.bytes).toBe(weighed());
  });

  it("copies the script, the styles and the assets byte for byte", () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);
    write(join(deck, "assets", "method.svg"), bytes);
    done();
    expect(readFileSync(join(out(), "depthcue.js"), "utf8")).toBe("/* the script */");
    expect(readFileSync(join(out(), "depthcue.css"), "utf8")).toBe("/* the styles */");
    expect([...readFileSync(join(out(), "assets", "method.svg"))]).toEqual([...bytes]);
  });

  it("puts the whole deck in the page, so showing it needs no request", () => {
    done();
    const data = embedded(readFileSync(join(out(), "index.html"), "utf8"));
    expect(data.format).toBe(EXPORT_FORMAT);
    expect(data.deck).toEqual(JSON.parse(readFileSync(join(deck, "deck.json"), "utf8")));
    expect(data.scenes.map((scene) => scene.id)).toEqual(["opening", "demand", "method"]);
    expect(data.scenes[1]).toEqual(readScene("demand"));
    expect(data.files).toEqual({});
  });

  it("loads its script and styles from beside the page, as a classic script", () => {
    done();
    const html = readFileSync(join(out(), "index.html"), "utf8");
    expect(html).toContain('<link rel="stylesheet" href="depthcue.css">');
    // The fonts come first, so the page's own styles can name them.
    expect(html.indexOf('<link rel="stylesheet" href="fonts/editorial.css">')).toBeGreaterThan(0);
    expect(html.indexOf('href="fonts/editorial.css"')).toBeLessThan(html.indexOf('href="depthcue.css"'));
    expect(html).toContain('<script src="depthcue.js"></script>');
    expect(html).not.toContain('type="module"');
    expect(html).toContain('<div id="depthcue"></div>');
    expect(html).toContain('<html lang="en">');
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("writes the deck's language on the page", () => {
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    write(join(deck, "deck.json"), JSON.stringify({ ...manifest, language: "fr-CA" }));
    done();
    expect(readFileSync(join(out(), "index.html"), "utf8")).toContain('<html lang="fr-CA">');
  });

  it("leaves out assets no scene names, and says which", () => {
    write(join(deck, "assets", "unused.png"), "x");
    const summary = done();
    expect(existsSync(join(out(), "assets", "unused.png"))).toBe(false);
    expect(summary.skipped).toEqual(["assets/unused.png"]);
    expect(summary.assets).toEqual(["assets/method.svg", "assets/report.csv"]);
  });

  it("counts bytes, not characters, in a page with a title that is not ASCII", () => {
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    write(join(deck, "deck.json"), JSON.stringify({ ...manifest, title: "Café, résumé: 日本語 ✓" }));
    const summary = done();
    expect(summary.bytes).toBe(weighed());
    expect(readFileSync(join(out(), "index.html"), "utf8")).toContain(
      "<title>Café, résumé: 日本語 ✓</title>",
    );
  });

  it("lists the assets it left out in path order, whatever order the folder gave them", () => {
    for (const name of ["c.png", "a.png", "b.png"]) write(join(deck, "assets", name), "x");
    expect(done().skipped).toEqual(["assets/a.png", "assets/b.png", "assets/c.png"]);
  });

  it("keeps the notes by default and removes only the notes when asked", () => {
    const kept = done();
    expect(kept.notes).toBe(true);
    const withNotes = embedded(readFileSync(join(out(), "index.html"), "utf8")).scenes;
    expect(withNotes[0]?.notes).toBe("Open with the answer, then show the evidence.");
    expect(withNotes.filter((scene) => scene.notes !== undefined)).toHaveLength(2);

    rmSync(out(), { recursive: true });
    const bare = done({ notes: false });
    expect(bare.notes).toBe(false);
    const without = embedded(readFileSync(join(out(), "index.html"), "utf8")).scenes;
    expect(without.some((scene) => "notes" in scene)).toBe(false);
    // Nothing else goes with them.
    expect(without).toEqual(withNotes.map(({ notes: _notes, ...rest }) => rest));
    expect(readFileSync(join(out(), "index.html"), "utf8")).not.toContain("Pause on the chart");
  });
});

describe("clips", () => {
  it("embeds the cue map and does not copy it", () => {
    const cues = JSON.stringify({
      format: "depthcue-cues/1",
      source: "assets/intro.mp4",
      cues: [{ id: "a" }],
    });
    addClip(cues);
    const summary = done();
    expect(summary.cueMaps).toEqual(["assets/intro.cues.json"]);
    expect(summary.assets).toContain("assets/intro.mp4");
    expect(summary.assets).toContain("assets/intro.png");
    expect(summary.assets).not.toContain("assets/intro.cues.json");
    expect(summary.skipped).toEqual([]);
    expect(existsSync(join(out(), "assets", "intro.cues.json"))).toBe(false);
    expect(embedded(readFileSync(join(out(), "index.html"), "utf8")).files).toEqual({
      "assets/intro.cues.json": JSON.parse(cues),
    });
  });

  it("exports a clip that has no cue map", () => {
    addClip(null);
    const summary = done();
    expect(summary.cueMaps).toEqual([]);
    expect(summary.assets).toContain("assets/intro.mp4");
    expect(embedded(readFileSync(join(out(), "index.html"), "utf8")).files).toEqual({});
  });

  it("leaves out a cue map that is not JSON, as the player would find no chips in it either", () => {
    addClip("{not json");
    const summary = done();
    expect(summary.cueMaps).toEqual([]);
    expect(embedded(readFileSync(join(out(), "index.html"), "utf8")).files).toEqual({});
    expect(summary.skipped).toEqual(["assets/intro.cues.json"]);
  });

  it("embeds a cue map once when two clips share a video", () => {
    addClip();
    editScene("movie", (scene) => {
      (scene.blocks as unknown[]).push({
        id: "movie-again",
        type: "clip",
        source: "assets/intro.mp4",
        alt: "again",
      });
    });
    expect(done().cueMaps).toEqual(["assets/intro.cues.json"]);
  });

  it("embeds each clip's own cue map", () => {
    addClip();
    write(join(deck, "assets", "other.mp4"), "v");
    write(join(deck, "assets", "other.cues.json"), JSON.stringify({ format: "depthcue-cues/1", cues: [] }));
    // The clip that comes first in the deck has the name that sorts last.
    editScene("movie", (scene) => {
      (scene.blocks as unknown[]).unshift({
        id: "clip-two",
        type: "clip",
        source: "assets/other.mp4",
        alt: "t",
      });
    });
    expect(done().cueMaps).toEqual(["assets/intro.cues.json", "assets/other.cues.json"]);
  });
});

describe("what goes into the page's text", () => {
  it("escapes the title for the document and keeps the data from closing its script", () => {
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    const title = 'A </script><b> & "quote"';
    write(join(deck, "deck.json"), JSON.stringify({ ...manifest, title }));
    done();
    const html = readFileSync(join(out(), "index.html"), "utf8");
    expect(html).toContain("<title>A &lt;/script&gt;&lt;b&gt; &amp; &quot;quote&quot;</title>");
    // The only closing script tags are the two the template writes.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<b>");
    expect(embedded(html).deck.title).toBe(title);
  });

  it("escapes a less-than sign in scene text, whichever characters follow it", () => {
    editScene("opening", (scene) => {
      (scene.blocks as Array<Record<string, unknown>>)[0] = {
        id: "opening-title",
        type: "text",
        role: "heading",
        text: "<!-- a <script>x</script>",
      };
    });
    done();
    const html = readFileSync(join(out(), "index.html"), "utf8");
    expect(html).not.toContain("<!--");
    expect(embedded(html).scenes[0]?.blocks[0]).toMatchObject({ text: "<!-- a <script>x</script>" });
  });
});

describe("a deck that has problems", () => {
  it("writes nothing and returns every error", () => {
    editScene("demand", (scene) => {
      (scene.blocks as Array<Record<string, unknown>>).push({
        id: "pic",
        type: "image",
        asset: "assets/missing.png",
        alt: "x",
      });
    });
    const result = run();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => d.code)).toContain("missing-asset");
    expect(existsSync(out())).toBe(false);
  });

  it("writes nothing for a folder that is not a deck", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const result = exportDeck({ folder: empty, out: out(), runtimeDir: runtime });
    expect(result.ok).toBe(false);
    expect(existsSync(out())).toBe(false);
  });

  it("exports a deck that only has warnings, and carries them", () => {
    write(
      join(deck, "scenes", "extra.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "extra",
        title: "Extra",
        layout: "title",
        blocks: [{ id: "extra-title", type: "text", role: "heading", text: "Extra" }],
      }),
    );
    const summary = done();
    expect(summary.warnings.map((d) => d.code)).toEqual(["orphan-scene-file"]);
    expect(summary.scenes).toBe(3);
  });

  it("says the player is not built, and writes nothing, when the script is missing", () => {
    rmSync(join(runtime, "depthcue.js"));
    const error = failure();
    expect(error.code).toBe("player-not-built");
    expect(error.message).toContain("pnpm build");
    expect(existsSync(out())).toBe(false);
  });

  it("says the styles are missing when only they are", () => {
    rmSync(join(runtime, "depthcue.css"));
    expect(failure().code).toBe("player-not-built");
  });
});

describe("the fonts of an export", () => {
  const setFonts = (pair: FontPair | null) => {
    const manifest = JSON.parse(readFileSync(join(deck, "deck.json"), "utf8"));
    const { fonts: _drop, ...rest } = manifest;
    // `fonts` came with schema 0.3, so a deck that names a pair says so.
    write(
      join(deck, "deck.json"),
      JSON.stringify(pair === null ? rest : { ...rest, schemaVersion: "0.3", fonts: pair }),
    );
  };

  it("carries the deck's pair and no other: its stylesheet and the files that stylesheet names", () => {
    setFonts("technical");
    const summary = done();
    expect(summary.fonts).toBe("technical");
    expect(written().filter((path) => path.startsWith("fonts/"))).toEqual([
      "fonts/Mono.woff2",
      "fonts/TechnicalSans.woff2",
      "fonts/technical.css",
    ]);
    expect(readFileSync(join(out(), "index.html"), "utf8")).toContain('href="fonts/technical.css"');
    expect(readFileSync(join(out(), "index.html"), "utf8")).not.toContain("editorial");
  });

  it("takes the default pair, editorial, when the deck names none", () => {
    setFonts(null);
    expect(done().fonts).toBe("editorial");
    expect(written().filter((path) => path.startsWith("fonts/"))).toEqual(EDITORIAL);
  });

  it("copies the stylesheet and the font files byte for byte", () => {
    setFonts("modern");
    done();
    expect(readFileSync(join(out(), "fonts", "modern.css"), "utf8")).toBe(sheetOf(FAKE_FONTS.modern));
    expect(readFileSync(join(out(), "fonts", "ModernSansBold.woff2"), "utf8")).toBe(
      "font:ModernSansBold.woff2",
    );
  });

  it("swaps the old pair's files for the new one's when the deck changes pair, and keeps the shared one", () => {
    setFonts("classic");
    done();
    expect(existsSync(join(out(), "fonts", "ClassicSerif.woff2"))).toBe(true);
    setFonts("technical");
    done();
    expect(written().filter((path) => path.startsWith("fonts/"))).toEqual([
      "fonts/Mono.woff2",
      "fonts/TechnicalSans.woff2",
      "fonts/technical.css",
    ]);
  });

  it("says the player is not built, and writes nothing, when the deck's stylesheet is missing", () => {
    setFonts("modern");
    rmSync(join(fonts, "modern.css"));
    const error = failure();
    expect(error.code).toBe("player-not-built");
    expect(error.message).toContain("modern");
    expect(error.message).toContain("pnpm build");
    expect(existsSync(out())).toBe(false);
  });

  it("says so, and writes nothing, when a file the stylesheet names is missing", () => {
    setFonts("modern");
    rmSync(join(fonts, "ModernSansBold.woff2"));
    const error = failure();
    expect(error.code).toBe("player-not-built");
    expect(error.message).toContain("ModernSansBold.woff2");
    expect(existsSync(out())).toBe(false);
  });

  it("refuses a stylesheet that names a file in a way the export does not read, instead of leaving it out", () => {
    setFonts("modern");
    writeFileSync(
      join(fonts, "modern.css"),
      `${sheetOf(["ModernSans.woff2"])}\n@font-face { src: url(Other.woff2); }`,
    );
    const error = failure();
    expect(error.code).toBe("player-not-built");
    expect(error.message).toContain("does not read");
    expect(existsSync(out())).toBe(false);
  });

  it("does not follow a stylesheet out of the fonts folder", () => {
    setFonts("modern");
    writeFileSync(join(fonts, "modern.css"), sheetOf(["../runtime/depthcue.js"]));
    expect(failure().message).toContain("does not read");
  });
});

describe("where it may write", () => {
  it("refuses a folder inside the deck, and the deck folder itself", () => {
    for (const inside of [join(deck, "export"), deck, join(deck, "assets")]) {
      const error = failure({ out: inside });
      expect(error.code).toBe("out-in-deck");
    }
    expect(listing(deck)).toEqual([
      "assets/method.svg",
      "assets/report.csv",
      "deck.json",
      "scenes/demand.json",
      "scenes/method.json",
      "scenes/opening.json",
    ]);
  });

  it("refuses a folder that holds the deck", () => {
    const error = failure({ out: root });
    expect(error.code).toBe("deck-in-out");
    expect(existsSync(join(root, "index.html"))).toBe(false);
  });

  it("refuses a folder inside the deck whose name starts with two dots", () => {
    expect(failure({ out: join(deck, "..hidden") }).code).toBe("out-in-deck");
  });

  it("refuses a folder that reaches the deck through a longer path", () => {
    expect(failure({ out: join(deck, "..", "deck", "x") }).code).toBe("out-in-deck");
  });

  it("sees through a link to the deck folder", () => {
    // A junction needs no privilege on Windows, and is a plain symlink elsewhere.
    const link = join(root, "link");
    symlinkSync(deck, link, "junction");
    const error = failure({ out: join(link, "site") });
    expect(error.code).toBe("out-in-deck");
    expect(existsSync(join(deck, "site"))).toBe(false);
    expect(failure({ out: link }).code).toBe("out-in-deck");
  });

  it("allows a sibling whose name starts like the deck's", () => {
    const sibling = join(root, "deck-export");
    exportDeck({ folder: deck, out: sibling, runtimeDir: runtime, fontsDir: fonts });
    expect(existsSync(join(sibling, "index.html"))).toBe(true);
  });

  it("uses a new folder, creating the parents it needs", () => {
    done({ out: join(root, "a", "b", "c") });
    expect(existsSync(join(root, "a", "b", "c", "index.html"))).toBe(true);
  });

  it("uses an empty folder", () => {
    mkdirSync(out());
    done();
    expect(existsSync(join(out(), "index.html"))).toBe(true);
  });

  it("refuses a folder with files in it that no export wrote, and leaves them alone", () => {
    write(join(out(), "mine.txt"), "keep me");
    const error = failure();
    expect(error.code).toBe("out-not-empty");
    expect(error.message).toContain("was not made by depthcue export");
    expect(listing(out())).toEqual(["mine.txt"]);
  });

  it("refuses a file where the folder should be", () => {
    write(out(), "I am a file");
    const error = failure();
    expect(error.code).toBe("out-not-empty");
    expect(error.message).toContain("is a file");
    expect(readFileSync(out(), "utf8")).toBe("I am a file");
  });

  it("does not trust a marker it cannot read, or one that lists a way out of the folder", () => {
    const markers = [
      "{not json",
      JSON.stringify({ format: "something-else/1", files: ["index.html"] }),
      JSON.stringify({ format: EXPORT_FORMAT }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["../deck/deck.json"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["/etc/passwd"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["a\\b"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["c:x"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["a//b"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["./x"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: [""] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: [3] }),
      // One good entry does not make a list with a bad one in it safe.
      JSON.stringify({ format: EXPORT_FORMAT, files: ["index.html", "../deck/deck.json"] }),
      JSON.stringify({ format: EXPORT_FORMAT, files: ["../deck/deck.json", "index.html"] }),
    ];
    for (const marker of markers) {
      rmSync(out(), { recursive: true, force: true });
      write(join(out(), EXPORT_MARKER), marker);
      write(join(out(), "mine.txt"), "keep me");
      expect(failure().code).toBe("out-not-empty");
      expect(readFileSync(join(out(), "mine.txt"), "utf8")).toBe("keep me");
    }
    // The deck the marker pointed at is untouched.
    expect(existsSync(join(deck, "deck.json"))).toBe(true);
  });
});

describe("exporting again", () => {
  it("replaces an earlier export and removes what it no longer needs", () => {
    done();
    editScene("method", (scene) => {
      scene.blocks = (scene.blocks as Array<{ type: string }>).filter((block) => block.type !== "image");
    });
    dropReport();
    const again = done();
    expect(again.assets).toEqual([]);
    expect(listing(out())).toEqual(
      [EXPORT_MARKER, "depthcue.css", "depthcue.js", ...EDITORIAL, "index.html"].sort(),
    );
    expect(existsSync(join(out(), "assets"))).toBe(false);
  });

  it("keeps the folders it still uses, and any file that is not its own", () => {
    done();
    write(join(out(), "readme.txt"), "mine");
    write(join(out(), "assets", "mine.png"), "mine too");
    dropReport();
    done();
    expect(readFileSync(join(out(), "readme.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(out(), "assets", "mine.png"), "utf8")).toBe("mine too");
    expect(existsSync(join(out(), "assets", "report.csv"))).toBe(false);
    expect(existsSync(join(out(), "assets", "method.svg"))).toBe(true);
  });

  it("refuses to overwrite a file the earlier export did not write", () => {
    done();
    editScene("method", (scene) => {
      (scene.blocks as unknown[]).push({ id: "pic2", type: "image", asset: "assets/new.svg", alt: "n" });
    });
    write(join(deck, "assets", "new.svg"), "<svg/>");
    write(join(out(), "assets", "new.svg"), "not from the export");
    const error = failure();
    expect(error.code).toBe("out-not-empty");
    expect(error.message).toContain("did not write");
    expect(readFileSync(join(out(), "assets", "new.svg"), "utf8")).toBe("not from the export");
    // Nothing was removed on the way to refusing.
    expect(existsSync(join(out(), "assets", "report.csv"))).toBe(true);
  });

  it("can switch the notes on and off by exporting again", () => {
    done();
    done({ notes: false });
    expect(readFileSync(join(out(), "index.html"), "utf8")).not.toContain("Pause on the chart");
    done({ notes: true });
    expect(readFileSync(join(out(), "index.html"), "utf8")).toContain("Pause on the chart");
  });

  it("can be replaced after an export that stopped part-way, because the marker is written first", () => {
    done();
    rmSync(join(out(), "index.html"));
    rmSync(join(out(), "assets", "method.svg"));
    expect(done().files).toBe(9);
  });

  it("can be replaced after an export that failed part-way, because the marker is written first", () => {
    // A directory where the script should be passes the check for it and then fails to copy.
    rmSync(join(runtime, "depthcue.js"));
    mkdirSync(join(runtime, "depthcue.js"));
    expect(() => run()).toThrow();
    expect(existsSync(join(out(), EXPORT_MARKER))).toBe(true);
    expect(existsSync(join(out(), "index.html"))).toBe(false);
    rmSync(join(runtime, "depthcue.js"), { recursive: true });
    writeFileSync(join(runtime, "depthcue.js"), "/* the script */");
    expect(done().files).toBe(9);
    expect(existsSync(join(out(), "index.html"))).toBe(true);
  });

  it("removes a stale file in a nested folder and the folders it leaves empty", () => {
    write(join(deck, "assets", "deep", "er", "pic.svg"), "<svg/>");
    editScene("method", (scene) => {
      (scene.blocks as unknown[]).push({
        id: "deep",
        type: "image",
        asset: "assets/deep/er/pic.svg",
        alt: "d",
      });
    });
    done();
    expect(existsSync(join(out(), "assets", "deep", "er", "pic.svg"))).toBe(true);
    editScene("method", (scene) => {
      scene.blocks = (scene.blocks as Array<{ id: string }>).filter((block) => block.id !== "deep");
    });
    done();
    expect(existsSync(join(out(), "assets", "deep"))).toBe(false);
    expect(existsSync(join(out(), "assets", "method.svg"))).toBe(true);
  });
});

describe("repeatability", () => {
  it("writes the same bytes every time, wherever it writes", () => {
    addClip();
    done({ out: join(root, "one") });
    done({ out: join(root, "two") });
    const files = listing(join(root, "one"));
    expect(listing(join(root, "two"))).toEqual(files);
    for (const path of files) {
      expect(readFileSync(join(root, "two", path)).equals(readFileSync(join(root, "one", path)))).toBe(true);
    }
  });

  it("lists the files in the marker in path order", () => {
    done();
    const marker = JSON.parse(readFileSync(join(out(), EXPORT_MARKER), "utf8"));
    expect(marker.format).toBe(EXPORT_FORMAT);
    expect(marker.files).toEqual([...marker.files].sort());
  });
});
