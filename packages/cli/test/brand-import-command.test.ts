import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { type LayoutSpec, LIGHT, temporaryFolders, writeFixture } from "./brand-import-fixtures.ts";

// The real import runs unless a test says otherwise; one test makes it report a brand that fails its checks, which
// no file can be made to do.
vi.mock("../src/brand-import/index.ts", async (original) => {
  const actual = await original<typeof import("../src/brand-import/index.ts")>();
  return { ...actual, importBrand: vi.fn(actual.importBrand) };
});

const { importBrand } = await import("../src/brand-import/index.ts");

const make = temporaryFolders();

async function cli(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, lines, errors, out: lines.join("\n"), err: errors.join("\n") };
}

describe("depthcue brand import: the arguments", () => {
  it("is in the usage text, with its own paragraph", async () => {
    const { code, err } = await cli();
    expect(code).toBe(2);
    expect(err).toContain("depthcue brand import <file.potx|.pptx|.thmx> [--out <dir>] [--json]");
    expect(err).toContain(
      "brand  import turns a PowerPoint template (.potx), presentation (.pptx) or theme (.thmx) into a brand folder",
    );
    expect(err).toContain(
      "Exit codes: 0 done, 1 the file has no theme or no usable layout, 2 the file could not be read.",
    );
  });

  it.each([
    [["brand"], "brand needs a subcommand. The one there is: brand import."],
    [["brand", "export", "x.potx"], "brand needs a subcommand"],
    [["brand", "import"], "brand import needs a PowerPoint file: a .potx, .pptx or .thmx."],
    [["brand", "import", "a.potx", "b.potx"], "Unexpected argument b.potx."],
    [["brand", "import", "a.potx", "--base-rev", "abc"], "brand import takes --out and --json."],
    [["brand", "import", "a.potx", "--port", "3000"], "brand import takes --out and --json."],
    [["brand", "import", "a.potx", "--step", "2"], "brand import takes --out and --json."],
    [["brand", "import", "a.potx", "--width", "800"], "brand import takes --out and --json."],
    [["brand", "import", "a.potx", "--height", "600"], "brand import takes --out and --json."],
    [
      ["brand", "import", "a.potx", "--name", "x"],
      "--name, --quality, --scale and --kine belong to clip build.",
    ],
    [["brand", "import", "a.potx", "--format", "pptx"], "--format belongs to export."],
    [["brand", "import", "a.potx", "--all"], "--all belongs to comments list"],
    [["brand", "import", "a.potx", "--nonsense"], "Unknown option --nonsense."],
  ])("refuses %j with exit 2: %s", async (args, message) => {
    const { code, err, out } = await cli(...args);
    expect(code).toBe(2);
    expect(err).toContain(message);
    expect(err).toContain("depthcue brand import <file.potx|.pptx|.thmx>");
    expect(out).toBe("");
  });
});

describe("depthcue brand import: a file that imports", () => {
  it("prints what it took, what it left out and the checks, and exits 0", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { colors: { ...LIGHT, dk2: "9A9A9A" } });
    const result = await cli("brand", "import", file, "--out", out);
    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
    const text = result.out;
    expect(result.lines[0]).toBe(`Imported Harbor.potx into ${out}`);
    expect(result.lines[1]).toBe('  brand "Harbor" (harbor), theme "Harbor", slide 16:9');
    expect(text).toContain(
      "Colors: The background (#FFFFFF, the master's background, Light 1 (lt1)) is light, so the colors are the paper palette.",
    );
    expect(text).toContain("  bg        #FFFFFF  the master's background, Light 1 (lt1)");
    expect(text).toContain(
      "  muted     #4B505B  (preset) Depthcue's paper preset, because Dark 2 (dk2) fails a contrast rule",
    );
    expect(text).toMatch(
      /\n {2}kept the preset's muted #4B505B: Dark 2 \(dk2\) is #9A9A9A, 2\.81:1 against bg #FFFFFF, and it needs 4\.5:1\n/,
    );
    expect(text).toMatch(/\n {2}chart {5}#B23A48 /);
    expect(text).toContain(
      "  headings  Georgia: a serif, because its PANOSE number 02040502050405020303 says serif",
    );
    expect(text).toContain(
      "  text      Calibri: a sans, because its PANOSE number 020F0502020204030204 says sans",
    );
    expect(text).toContain(
      "  fallback  classic: the display face is a serif, so the serif pair classic. No font files are taken.",
    );
    expect(text).toContain("  logos/logo.png, top-end, size m: Harbor logo on the slide master");
    expect(text).toContain(
      'Chrome  logo top-end, size m; footer "Harbor Co. confidential" at the center; number at the end',
    );
    expect(text).toContain("Templates (3)");
    expect(text).toContain('  title-slide  "Title Slide"');
    expect(text).toMatch(/ {6}title {8}title {5}10% 28%, 80% by 24%, bottom {2}takes heading\n/);
    expect(text).toContain("Left out");
    expect(text).toContain("  Claim slots: PowerPoint has no placeholder for a claim");
    expect(text).toContain("Notes");
    expect(text).toContain("Checks: 0 errors, 2 warnings");
    expect(text).toContain('  brand.json/fonts/display  warning  The deck carries no file for "Georgia"');
    expect(text).toContain("    fix: Add its files under the brand's fonts/");
    expect(result.lines.at(-1)).toMatch(
      /^Wrote 6 files to .+\. Use it with a deck: copy the folder to <deck>\/brand and name "harbor" as "brand" in deck.json\.$/,
    );
    expect(existsSync(join(out, "brand.json"))).toBe(true);
  });

  it("counts warnings in the singular and the plural", async () => {
    // The body starts half a percent above where the title ends: touching, which core warns about.
    const touching: LayoutSpec = {
      name: "Touch",
      shapes: [
        { kind: "ph", type: "title", frame: { x: 8, y: 6, w: 78, h: 16 } },
        { kind: "ph", type: "body", frame: { x: 8, y: 21.5, w: 84, h: 40 } },
      ],
    };
    const none = await writeFixture(make(), { fonts: {} });
    expect((await cli("brand", "import", none.file, "--out", none.out)).out).toContain(
      "Checks: 0 errors, 0 warnings\n",
    );
    const one = await writeFixture(make(), { fonts: {}, layouts: [touching] });
    const result = await cli("brand", "import", one.file, "--out", one.out);
    expect(result.out).toContain("Checks: 0 errors, 1 warning\n");
    expect(result.out).toContain(
      '  templates/touch.json/slots/1/frame  warning  The slot "body" overlaps "title" (slot 1)',
    );
  });

  it("gives the same report as data with --json", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder);
    const result = await cli("brand", "import", file, "--out", out, "--json");
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      ok: true,
      errors: 0,
      warnings: 2,
      source: { file: "Harbor.potx", kind: "potx" },
      brand: { id: "harbor", name: "Harbor" },
      preset: { name: "paper" },
      logo: { file: "logos/logo.png", corner: "top-end", size: "m" },
      chrome: { logo: "top-end, size m" },
    });
    expect(report.templates.map((template: { id: string }) => template.id)).toEqual([
      "title-slide",
      "title-and-content",
      "two-content",
    ]);
    expect(report.files).toContain("brand.json");
    expect(report.diagnostics.map((diagnostic: { code: string }) => diagnostic.code)).toEqual([
      "face-without-files",
      "face-without-files",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("names the folder after the file in the current directory when --out is left out", async () => {
    const folder = make();
    const { file } = await writeFixture(folder);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(folder);
    const result = await cli("brand", "import", file);
    cwd.mockRestore();
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(`Imported Harbor.potx into ${join(folder, "Harbor-brand")}`);
    expect(existsSync(join(folder, "Harbor-brand", "brand.json"))).toBe(true);
  });

  it("replaces its own earlier output and exits 0 again", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder);
    expect((await cli("brand", "import", file, "--out", out)).code).toBe(0);
    expect((await cli("brand", "import", file, "--out", out)).code).toBe(0);
    expect(readdirSync(join(out, "templates"))).toHaveLength(3);
  });
});

describe("depthcue brand import: a file with nothing to import", () => {
  it("exits 1 for a portrait file, says so on stderr, and writes nothing", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { size: { cx: 6858000, cy: 12192000 } });
    const result = await cli("brand", "import", file, "--out", out);
    expect(result.code).toBe(1);
    expect(result.err).toContain("The slides are portrait");
    expect(result.lines).toEqual(["Nothing was written."]);
    expect(existsSync(out)).toBe(false);
  });

  it("lists why each layout was skipped when none can be a template", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { layouts: [{ name: "Blank", shapes: [] }] });
    const result = await cli("brand", "import", file, "--out", out);
    expect(result.code).toBe(1);
    expect(result.err).toContain("None of the file's slide layouts can be a template");
    expect(result.lines).toEqual([
      '  The layout "Blank": it is not a template: it has no placeholder a slot can be made from (a blank layout).',
      "Nothing was written.",
    ]);
  });

  it("gives the failure as data with --json, and still exits 1", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { noColors: true });
    const result = await cli("brand", "import", file, "--out", out, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({
      ok: false,
      code: "no-theme",
      message: "The file has no theme with a color scheme, so there is nothing to build a brand from.",
      left: [],
      diagnostics: [],
    });
    expect(result.errors).toEqual([]);
  });

  it("prints the checks a brand failed, when the import made a brand that does not pass them", async () => {
    const failed = {
      ok: false as const,
      code: "brand-invalid" as const,
      message: "The brand made from this file does not pass Depthcue's brand checks, so nothing was written.",
      left: [{ what: "A layout", why: "a reason" }],
      diagnostics: [
        {
          severity: "error" as const,
          code: "palette-low-contrast",
          file: "brand.json",
          path: "/colors/paper/muted",
          message: "Low.",
        },
      ],
    };
    vi.mocked(importBrand).mockResolvedValueOnce(failed);
    const human = await cli("brand", "import", "x.potx");
    expect(human.code).toBe(1);
    expect(human.err).toBe(failed.message);
    expect(human.lines).toEqual([
      "  A layout: a reason.",
      "  brand.json/colors/paper/muted  error  Low.",
      "Nothing was written.",
    ]);
    vi.mocked(importBrand).mockResolvedValueOnce(failed);
    const json = await cli("brand", "import", "x.potx", "--json");
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      ok: false,
      code: "brand-invalid",
      diagnostics: [{ code: "palette-low-contrast" }],
    });
  });
});

describe("depthcue brand import: a file that cannot be read", () => {
  it("exits 2 for a name that is no PowerPoint file's", async () => {
    const folder = make();
    const file = join(folder, "notes.txt");
    writeFileSync(file, "x");
    const result = await cli("brand", "import", file);
    expect(result.code).toBe(2);
    expect(result.err).toContain("does not end in .potx, .pptx or .thmx");
    expect(result.out).toBe("");
  });

  it("exits 2 for a file that is not a zip, as data with --json", async () => {
    const folder = make();
    const file = join(folder, "fake.pptx");
    writeFileSync(file, "not a zip");
    const result = await cli("brand", "import", file, "--out", join(folder, "out"), "--json");
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      code: "unreadable",
      message: expect.stringContaining("is not a zip"),
    });
    expect(existsSync(join(folder, "out"))).toBe(false);
  });

  it("exits 2 for a folder with somebody else's files in it, and leaves it alone", async () => {
    const folder = make();
    const { file } = await writeFixture(folder);
    const other = join(folder, "other");
    mkdirSync(other);
    writeFileSync(join(other, "keep.txt"), "mine");
    const result = await cli("brand", "import", file, "--out", other);
    expect(result.code).toBe(2);
    expect(result.err).toContain("was not made by depthcue brand import, so nothing was written");
    expect(readdirSync(other)).toEqual(["keep.txt"]);
  });

  it("exits 2 for a folder that holds the file being imported", async () => {
    const folder = make();
    const { file } = await writeFixture(folder);
    const result = await cli("brand", "import", file, "--out", folder);
    expect(result.code).toBe(2);
    expect(result.err).toContain("is inside");
    expect(readdirSync(folder)).toEqual(["Harbor.potx"]);
  });
});
