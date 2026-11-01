import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportError, importBrand, ratioLabel, slug } from "../src/brand-import/index.ts";
import { mix } from "../src/brand-import/palette.ts";
import {
  DARK,
  importFixture,
  LAYOUTS,
  LIGHT,
  MASTER,
  type PackageSpec,
  PNG,
  partsOf,
  type ShapeSpec,
  temporaryFolders,
  writeFixture,
  zipParts,
} from "./brand-import-fixtures.ts";

const make = temporaryFolders();

afterEach(() => {
  vi.restoreAllMocks();
});

/** Imports whatever parts are given, as a file of the given name. */
async function importParts(
  parts: Map<string, string | Uint8Array>,
  options: { name?: string; ext?: string } = {},
) {
  const folder = make();
  const file = join(folder, `${options.name ?? "Harbor"}.${options.ext ?? "potx"}`);
  writeFileSync(file, await zipParts(parts));
  const out = join(folder, "brand-out");
  return { folder, file, out, run: () => importBrand({ file, out }) };
}

describe("importBrand of a template", () => {
  it("writes a brand from the theme, the fonts, the logo, the chrome and the layouts", async () => {
    const done = await importFixture(make);
    const brand = done.json("brand.json");
    expect(brand).toMatchObject({
      schemaVersion: "0.4",
      id: "harbor",
      name: "Harbor",
      colors: {
        paper: {
          bg: "#FFFFFF",
          surface: "#F3F1EC",
          text: "#1B1B1B",
          muted: "#44546A",
          action: "#B23A48",
          evidence: "#0B5FA5",
        },
      },
      fonts: { display: { family: "Georgia" }, body: { family: "Calibri" }, fallback: "classic" },
      logos: { light: "logos/logo.png", alt: "The Harbor Co. wordmark" },
      chrome: {
        logo: { corner: "top-end", size: "m" },
        footer: { text: "Harbor Co. confidential", place: "center" },
        number: { place: "end" },
      },
    });
    expect(brand.colors.paper.line).toBe(mix("#FFFFFF", "#1B1B1B", 0.14));
    expect(brand.colors.paper.chart).toEqual(done.report.chart?.colors);
    expect(brand.colors.ink).toBeUndefined();
    expect(brand.fonts.display.files).toBeUndefined();
  });

  it("reports what it took", async () => {
    const done = await importFixture(make);
    const { report } = done;
    expect(report.source).toEqual({
      file: "Harbor.potx",
      kind: "potx",
      theme: "Harbor",
      slide: { width: 12192000, height: 6858000, ratio: "16:9" },
    });
    expect(report.brand).toEqual({ id: "harbor", name: "Harbor" });
    expect(report.preset.name).toBe("paper");
    expect(report.kept).toEqual([]);
    expect(report.colors.map((color) => color.name)).toEqual([
      "bg",
      "surface",
      "line",
      "text",
      "muted",
      "action",
      "evidence",
    ]);
    expect(report.fonts).toMatchObject({
      display: {
        family: "Georgia",
        kind: "serif",
        rule: "its PANOSE number 02040502050405020303 says serif",
      },
      body: { family: "Calibri", kind: "sans" },
      fallback: "classic",
    });
    expect(report.chrome).toEqual({
      logo: "top-end, size m",
      footer: '"Harbor Co. confidential" at the center',
      number: "at the end",
    });
    expect(report.notes).toContain(
      'These colors are for decks with the theme "paper": set "theme": "paper" in deck.json. The other theme keeps Depthcue\'s own colors.',
    );
    expect(report.out).toBe(done.out);
  });

  it("lists what it left out, with the reason", async () => {
    const done = await importFixture(make);
    const whats = done.report.left.map((item) => item.what);
    expect(whats).toContain("The master's text styles (sizes, weights, bullets, spacing)");
    expect(whats).toContain("Claim slots");
    expect(whats).not.toContain("The date placeholder");
    expect(whats.filter((what) => what.startsWith("Decoration"))).toEqual([]);
  });

  it("passes the brand checks, with only the warnings about faces it has no files for", async () => {
    const done = await importFixture(make);
    expect(
      done.diagnostics.map((diagnostic) => [
        diagnostic.severity,
        diagnostic.code,
        diagnostic.file,
        diagnostic.path,
      ]),
    ).toEqual([
      ["warning", "face-without-files", "brand.json", "/fonts/display"],
      ["warning", "face-without-files", "brand.json", "/fonts/body"],
    ]);
  });

  it("writes only the brand, the marker, and what the brand refers to", async () => {
    const done = await importFixture(make);
    expect(readdirSync(done.out).sort()).toEqual([
      ".depthcue-brand-import",
      "brand.json",
      "logos",
      "templates",
    ]);
    expect(JSON.parse(readFileSync(join(done.out, ".depthcue-brand-import"), "utf8"))).toEqual({
      format: "depthcue-brand-import/1",
      files: done.report.files.filter((file) => file !== ".depthcue-brand-import"),
    });
  });

  it("makes a report that is plain data", async () => {
    const done = await importFixture(make);
    expect(JSON.parse(JSON.stringify(done.report))).toEqual(done.report);
  });

  it("is the ink palette, under ink, for a dark master", async () => {
    const done = await importFixture(make, { dark: true, colors: DARK });
    const brand = done.json("brand.json");
    expect(brand.colors.paper).toBeUndefined();
    expect(brand.colors.ink).toMatchObject({
      bg: "#0E1116",
      text: "#F2F4F8",
      muted: "#C9D1DE",
      surface: "#1C2330",
    });
    expect(done.report.preset.name).toBe("ink");
    expect(done.report.notes[0]).toContain('set "theme": "ink" in deck.json');
  });

  it("keeps the preset's color for one the theme gives that would fail, and reports the numbers", async () => {
    const done = await importFixture(make, { colors: { ...LIGHT, dk2: "9A9A9A" } });
    expect(done.json("brand.json").colors.paper.muted).toBe("#4B505B");
    expect(done.report.kept).toHaveLength(1);
    expect(done.report.kept[0]).toMatchObject({
      name: "muted",
      wanted: "#9A9A9A",
      from: "Dark 2 (dk2)",
      need: 4.5,
      against: "bg",
      againstValue: "#FFFFFF",
      used: "#4B505B",
    });
    expect(done.report.kept[0]?.ratio).toMatch(/^2\.\d+:1$/);
    expect(done.report.colors.find((color) => color.name === "muted")).toMatchObject({ source: "preset" });
  });

  it("has no chart colors when no accent reaches 3:1, and says so", async () => {
    const pale = {
      accent1: "F6E58D",
      accent2: "F9E79F",
      accent3: "FCF3CF",
      accent4: "FAD7A0",
      accent5: "FDEBD0",
      accent6: "FEF9E7",
    };
    const done = await importFixture(make, { colors: { ...LIGHT, ...pale } });
    expect(done.report.chart).toBeNull();
    expect(done.json("brand.json").colors.paper.chart).toBeUndefined();
    expect(done.report.notes).toContain(
      "No accent reaches 3:1 on the background, so the brand has no chart colors and charts take the palette's.",
    );
  });

  it("takes the master's background color for the preset, over the theme's", async () => {
    const done = await importFixture(make, { masterBg: { rgb: "0B1E2D" } });
    expect(done.report.preset.name).toBe("ink");
    expect(done.json("brand.json").colors.ink.bg).toBe("#0B1E2D");
  });

  it("falls back to the theme's background color when the master's is a picture, and says so", async () => {
    const done = await importFixture(make, { masterBg: { picture: "logo.png" } });
    expect(done.report.preset.name).toBe("paper");
    expect(done.report.notes).toContain(
      "The master's background is a blip fill, which is not a color, so the theme's background color was used.",
    );
  });

  it("falls back the same way when the master's color is lightened or darkened", async () => {
    const done = await importFixture(make, { masterBg: { scheme: "bg1", adjust: true } });
    expect(done.report.notes.join("\n")).toContain(
      "a theme color made lighter or darker, which is not worked out",
    );
  });
});

describe("the name and id of the brand", () => {
  it.each([
    ["Harbor", "harbor", "Harbor"],
    ["Acme Corp 2024", "acme-corp-2024", "Acme Corp 2024"],
    ["Über  Brand!", "uber-brand", "Über Brand!"],
    ["2024", "imported-brand-2024", "2024"],
    ["!!!", "imported-brand", "!!!"],
  ])("comes from the file name %j: id %s, name %j", async (stem, id, name) => {
    const done = await importFixture(make, {}, stem);
    expect(done.report.brand).toEqual({ id, name });
    expect(done.json("brand.json")).toMatchObject({ id, name });
  });

  it("keeps a long name within 80 characters", async () => {
    const done = await importFixture(make, {}, "A".repeat(120));
    expect(done.json("brand.json").name).toHaveLength(80);
    expect(done.json("brand.json").id).toHaveLength(64);
  });

  it("reads an upper case extension", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder);
    const upper = join(folder, "Upper.POTX");
    writeFileSync(upper, readFileSync(file));
    const result = await importBrand({ file: upper, out });
    expect(result.ok).toBe(true);
  });
});

describe("slug and ratioLabel", () => {
  it("makes an id of lower case letters, digits and hyphens", () => {
    expect(slug("  --Hello, Wörld!--  ", "x")).toBe("hello-world");
    expect(slug("a".repeat(100), "x")).toHaveLength(64);
    expect(slug("9 lives", "layout")).toBe("layout-9-lives");
    expect(slug("", "layout")).toBe("layout");
    expect(slug("x", "layout")).toBe("layout-x");
  });

  it("names a slide's shape as a ratio people know", () => {
    expect(ratioLabel(12192000, 6858000)).toBe("16:9");
    expect(ratioLabel(9144000, 6858000)).toBe("4:3");
    expect(ratioLabel(12192000, 7620000)).toBe("16:10");
    expect(ratioLabel(10287000, 6858000)).toBe("3:2");
    expect(ratioLabel(5, 4)).toBe("5:4");
    expect(ratioLabel(21, 9)).toBe("21:9");
    expect(ratioLabel(1, 1)).toBe("1:1");
    expect(ratioLabel(3, 1)).toBe("3.00:1");
  });
});

describe("a file that cannot be imported", () => {
  it("is refused by name when it does not end in .potx, .pptx or .thmx", async () => {
    const folder = make();
    writeFileSync(join(folder, "old.ppt"), "x");
    const error = await importBrand({ file: join(folder, "old.ppt") }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({
      code: "bad-file",
      message: expect.stringContaining("does not end in .potx, .pptx or .thmx"),
    });
  });

  it("is refused when it is not there", async () => {
    const folder = make();
    const error = await importBrand({ file: join(folder, "missing.potx"), out: join(folder, "out") }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "unreadable", message: expect.stringContaining("Could not read") });
    expect(existsSync(join(folder, "out"))).toBe(false);
  });

  it("is refused when it is not a zip, with a word about the old formats", async () => {
    const folder = make();
    const file = join(folder, "fake.potx");
    writeFileSync(file, "this is not a zip");
    const error = await importBrand({ file, out: join(folder, "out") }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unreadable", message: expect.stringContaining("is not a zip") });
    expect((error as Error).message).toContain(".ppt");
    expect(existsSync(join(folder, "out"))).toBe(false);
  });

  it("is refused when a part is not XML, and names the part", async () => {
    const parts = partsOf();
    parts.set("ppt/slideMasters/slideMaster1.xml", "<p:sldMaster><oops></p:sldMaster>");
    const { run, out } = await importParts(parts);
    await expect(run()).rejects.toMatchObject({
      code: "unreadable",
      message: expect.stringMatching(/slideMaster1\.xml is not valid XML/),
    });
    expect(existsSync(out)).toBe(false);
  });

  it("is refused when a part declares a DOCTYPE", async () => {
    const parts = partsOf();
    const theme = parts.get("ppt/theme/theme1.xml") as string;
    parts.set("ppt/theme/theme1.xml", theme.replace("?>", '?><!DOCTYPE a [<!ENTITY x "y">]>'));
    const { run } = await importParts(parts);
    await expect(run()).rejects.toMatchObject({
      code: "unreadable",
      message: expect.stringContaining("DOCTYPE"),
    });
  });

  it("has no theme: nothing is written, and the result says why", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { noColors: true });
    const result = await importBrand({ file, out });
    expect(result).toMatchObject({ ok: false, code: "no-theme" });
    expect(existsSync(out)).toBe(false);
  });

  it("has portrait slides: nothing is written, and the message says how to fix it", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { size: { cx: 6858000, cy: 12192000 } });
    const result = await importBrand({ file, out });
    expect(result).toMatchObject({ ok: false, code: "portrait" });
    expect(result.ok ? "" : result.message).toContain("Slide Size");
    expect(existsSync(out)).toBe(false);
  });

  it("has no slide layouts: nothing is written", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder, { layouts: [] });
    const result = await importBrand({ file, out });
    expect(result).toMatchObject({
      ok: false,
      code: "no-layout",
      message: "The file has no slide layouts, so there is nothing to make templates from.",
    });
    expect(existsSync(out)).toBe(false);
  });

  it("is imported without a layout whose part is missing", async () => {
    const parts = partsOf();
    parts.delete("ppt/slideLayouts/slideLayout2.xml");
    const { run } = await importParts(parts);
    const result = await run();
    expect(result.ok && result.report.templates.map((template) => template.id)).toEqual([
      "title-slide",
      "two-content",
    ]);
  });

  it("is refused when the folder for the brand has other files in it, and the folder is left as it was", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder);
    mkdirSync(out);
    writeFileSync(join(out, "mine.txt"), "mine");
    await expect(importBrand({ file, out })).rejects.toMatchObject({ code: "out-not-ours" });
    expect(readdirSync(out)).toEqual(["mine.txt"]);
  });

  it("is refused when the folder for the brand holds the file", async () => {
    const folder = make();
    const { file } = await writeFixture(folder);
    await expect(importBrand({ file, out: folder })).rejects.toMatchObject({ code: "out-in-source" });
  });

  it("is refused when the folder for the brand is a file", async () => {
    const folder = make();
    const { file, out } = await writeFixture(folder);
    writeFileSync(out, "a file");
    await expect(importBrand({ file, out })).rejects.toMatchObject({ code: "out-is-file" });
  });
});

describe("where the brand goes", () => {
  it("is a folder named for the file in the current directory, when no --out is given", async () => {
    const folder = make();
    const { file } = await writeFixture(folder, {}, "Acme Deck");
    vi.spyOn(process, "cwd").mockReturnValue(folder);
    const result = await importBrand({ file });
    expect(result.ok && result.report.out).toBe(join(folder, "Acme Deck-brand"));
    expect(existsSync(join(folder, "Acme Deck-brand", "brand.json"))).toBe(true);
  });

  it("replaces an earlier import in the same folder, and nothing of the earlier one stays", async () => {
    const folder = make();
    const out = join(folder, "brand-out");
    const first = await writeFixture(folder, { colors: LIGHT }, "First");
    const second = await writeFixture(
      folder,
      {
        dark: true,
        colors: DARK,
        layouts: [LAYOUTS[0] as (typeof LAYOUTS)[number]],
        master: MASTER.filter((shape) => shape.kind !== "pic"),
      },
      "Second",
    );
    const one = await importBrand({ file: first.file, out });
    expect(one.ok && readdirSync(join(out, "templates")).sort()).toEqual([
      "title-and-content.json",
      "title-slide.json",
      "two-content.json",
    ]);
    expect(existsSync(join(out, "logos", "logo.png"))).toBe(true);
    const two = await importBrand({ file: second.file, out });
    expect(two.ok).toBe(true);
    expect(readdirSync(join(out, "templates"))).toEqual(["title-slide.json"]);
    expect(existsSync(join(out, "logos"))).toBe(false);
    const brand = JSON.parse(readFileSync(join(out, "brand.json"), "utf8"));
    expect(brand).toMatchObject({ id: "second", name: "Second" });
    expect(brand.colors.paper).toBeUndefined();
    expect(brand.colors.ink).toBeDefined();
    expect(brand.logos).toBeUndefined();
    const marker = JSON.parse(readFileSync(join(out, ".depthcue-brand-import"), "utf8"));
    expect(marker.files).toEqual(["brand.json", "templates/title-slide.json"]);
  });

  it("leaves the earlier import alone when the new file cannot be imported", async () => {
    const folder = make();
    const out = join(folder, "brand-out");
    const good = await writeFixture(folder, {}, "Good");
    const bad = await writeFixture(folder, { size: { cx: 100, cy: 200 } }, "Bad");
    await importBrand({ file: good.file, out });
    const before = readFileSync(join(out, "brand.json"), "utf8");
    const result = await importBrand({ file: bad.file, out });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(out, "brand.json"), "utf8")).toBe(before);
  });
});

describe("the kinds of file", () => {
  it("imports a .pptx with slides from its master, and says the slides are not imported", async () => {
    const done = await importFixture(make, { kind: "pptx", slides: 2 });
    expect(done.report.source.kind).toBe("pptx");
    expect(done.report.left).toContainEqual({
      what: "2 slides",
      why: "their content is not imported; only the master, layouts and theme they use are",
    });
    expect(done.report.templates).toHaveLength(3);
  });

  it("takes the master the first slide uses, and counts the others", async () => {
    const parts = partsOf({ kind: "pptx", slides: 1, extraMasters: 1 });
    const xmlns =
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    parts.set(
      "ppt/slideLayouts/slideLayout9.xml",
      `<p:sldLayout ${xmlns}><p:cSld name="Second master layout"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1000000" y="500000"/><a:ext cx="9000000" cy="1000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sldLayout>`,
    );
    const rels = (type: string, target: string) =>
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
    parts.set(
      "ppt/slideLayouts/_rels/slideLayout9.xml.rels",
      rels("slideMaster", "../slideMasters/slideMaster2.xml"),
    );
    parts.set(
      "ppt/slideMasters/_rels/slideMaster2.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout9.xml"/></Relationships>`,
    );
    parts.set("ppt/slides/_rels/slide1.xml.rels", rels("slideLayout", "../slideLayouts/slideLayout9.xml"));
    const { run } = await importParts(parts, { ext: "pptx" });
    const result = await run();
    expect(result.ok && result.report.templates.map((template) => template.id)).toEqual([
      "second-master-layout",
    ]);
    expect(result.ok && result.report.left.map((item) => item.what)).toContain("1 other slide master");
  });

  it("counts the masters a file has beyond the first", async () => {
    const done = await importFixture(make, { extraMasters: 2 });
    expect(done.report.left).toContainEqual({
      what: "2 other slide masters",
      why: "a brand is taken from one master, the one the first slide uses or else the first listed",
    });
    expect(done.report.templates).toHaveLength(3);
  });

  it("imports a .thmx the way PowerPoint saves it, with its layouts, and counts the theme variants", async () => {
    const done = await importFixture(make, { kind: "thmx", variants: 3 });
    expect(done.report.source.kind).toBe("thmx");
    expect(done.report.templates).toHaveLength(3);
    expect(done.report.left).toContainEqual({
      what: "3 theme variants",
      why: "they are other color sets of the same theme; the theme's own is imported",
    });
    expect(done.json("brand.json").colors.paper.bg).toBe("#FFFFFF");
  });

  it("imports a .thmx that is only a theme: the colors and fonts, and no templates", async () => {
    const done = await importFixture(make, { kind: "thmx", themeOnly: true });
    expect(done.report.templates).toEqual([]);
    expect(done.report.files).toEqual([".depthcue-brand-import", "brand.json"]);
    expect(readdirSync(done.out).sort()).toEqual([".depthcue-brand-import", "brand.json"]);
    const brand = done.json("brand.json");
    expect(brand.colors.paper.text).toBe("#1B1B1B");
    expect(brand.fonts.display.family).toBe("Georgia");
    expect(brand.chrome).toBeUndefined();
    expect(done.report.chrome).toEqual({});
    expect(done.report.left.map((item) => item.what)).not.toContain("Claim slots");
  });
});

describe("embedded fonts", () => {
  it("are named in the report and not copied", async () => {
    const done = await importFixture(make, { embeddedFonts: ["Harbor Sans", "Harbor Serif"] });
    const item = done.report.left.find((entry) => entry.what.startsWith("Embedded font files"));
    expect(item?.what).toBe("Embedded font files (Harbor Sans, Harbor Serif)");
    expect(item?.why).toContain("Embedded OpenType");
    expect(done.report.files.filter((file) => /\.fntdata$|^fonts\//.test(file))).toEqual([]);
    const brand = done.json("brand.json");
    expect(brand.fonts.display.files).toBeUndefined();
    expect(brand.fonts.body.files).toBeUndefined();
    expect(readdirSync(done.out)).not.toContain("fonts");
  });

  it("are found by their parts when the presentation does not list them", async () => {
    const parts = partsOf({ embeddedFonts: ["Harbor Sans"] });
    const presentation = parts.get("ppt/presentation.xml") as string;
    parts.set("ppt/presentation.xml", presentation.replace(/<p:embeddedFontLst>.*<\/p:embeddedFontLst>/, ""));
    const { run } = await importParts(parts);
    const result = await run();
    expect(result.ok && result.report.left.map((item) => item.what)).toContain(
      "Embedded font files (font1.fntdata)",
    );
  });
});

describe("the footer, the slide number and the date", () => {
  const without = MASTER.filter(
    (shape) => !(shape.kind === "ph" && (shape.type === "ftr" || shape.type === "sldNum")),
  );
  const master = (...extra: ShapeSpec[]): PackageSpec => ({ master: [...without, ...extra] });
  const footer = (frame: { x: number; y: number; w: number; h: number }, text?: string): ShapeSpec => ({
    kind: "ph",
    type: "ftr",
    idx: 3,
    name: "Footer",
    frame,
    ...(text === undefined ? {} : { text }),
  });
  /** A slide number placeholder: a number field, or plain text when it is given some. */
  const number = (x: number, plainText?: string): ShapeSpec => ({
    kind: "ph",
    type: "sldNum",
    idx: 4,
    name: "Number",
    frame: { x, y: 92, w: 6, h: 5 },
    ...(plainText === undefined ? { field: "slidenum" } : { text: plainText }),
  });

  it.each([
    [2, "start"],
    [34, "center"],
    [70, "end"],
  ])("puts the footer at the %i%% mark in the %s", async (x, place) => {
    const done = await importFixture(make, master(footer({ x, y: 92, w: 28, h: 5 }, "Quarterly review")));
    expect(done.json("brand.json").chrome.footer).toEqual({ text: "Quarterly review", place });
  });

  it("puts the slide number where the master has it", async () => {
    const done = await importFixture(make, master(number(4)));
    expect(done.json("brand.json").chrome.number).toEqual({ place: "start" });
  });

  it("takes the footer's words from a layout when the master's footer is empty", async () => {
    const withFooter = LAYOUTS.map((layout, at) =>
      at === 1
        ? {
            ...layout,
            shapes: [
              ...layout.shapes,
              { kind: "ph", type: "ftr", text: "Words from the layout", idx: 3 } as ShapeSpec,
            ],
          }
        : layout,
    );
    const done = await importFixture(make, {
      ...master(footer({ x: 34, y: 92, w: 32, h: 5 })),
      layouts: withFooter,
    });
    expect(done.json("brand.json").chrome.footer).toEqual({ text: "Words from the layout", place: "center" });
  });

  it("has no footer line when no placeholder has words, and says so", async () => {
    const done = await importFixture(make, master(footer({ x: 34, y: 92, w: 32, h: 5 })));
    expect(done.json("brand.json").chrome?.footer).toBeUndefined();
    expect(done.report.notes).toContain(
      "The master has a footer placeholder with no text in it, so the brand has no footer line; the words are typed on each slide in PowerPoint.",
    );
  });

  it("cuts a footer's words at 120 characters", async () => {
    const done = await importFixture(make, master(footer({ x: 34, y: 92, w: 32, h: 5 }, "W".repeat(300))));
    expect(done.json("brand.json").chrome.footer.text).toHaveLength(120);
  });

  it("has no slide number when the placeholder holds plain text, and says so", async () => {
    const done = await importFixture(make, master(number(88, "7")));
    expect(done.json("brand.json").chrome?.number).toBeUndefined();
    expect(done.report.notes).toContain(
      "The master's slide number placeholder holds plain text, not a number field, so the brand has no slide number.",
    );
  });

  it("has neither when the master has neither", async () => {
    const done = await importFixture(make, master());
    expect(done.json("brand.json").chrome).toEqual({ logo: { corner: "top-end", size: "m" } });
  });

  it("lists the date placeholder as left out", async () => {
    const date: ShapeSpec = {
      kind: "ph",
      type: "dt",
      idx: 2,
      name: "Date",
      frame: { x: 4, y: 92, w: 20, h: 5 },
      text: "1/1/2026",
    };
    const done = await importFixture(make, master(date));
    expect(done.report.left).toContainEqual({
      what: "The date placeholder",
      why: "Depthcue slides have no date; only the footer and the slide number are chrome",
    });
  });
});

describe("pictures for a background", () => {
  it("get names that are safe, and unique when two come to the same", async () => {
    const other = Uint8Array.from([...PNG, 0]);
    const layout = (name: string, picture: string) => ({
      name,
      shapes: [
        { kind: "ph", type: "title", frame: { x: 8, y: 6, w: 78, h: 16 } } as ShapeSpec,
        { kind: "ph", idx: 1, frame: { x: 8, y: 26, w: 84, h: 60 } } as ShapeSpec,
      ],
      bg: { picture },
    });
    const done = await importFixture(make, {
      layouts: [
        layout("One", "my pic (1).png"),
        layout("Two", "my-pic-1.png"),
        layout("Three", "my pic (1).png"),
      ],
      media: { "logo.png": PNG, "my pic (1).png": PNG, "my-pic-1.png": other },
    });
    expect(done.report.files.filter((file) => file.startsWith("images/"))).toEqual([
      "images/my-pic-1-2.png",
      "images/my-pic-1.png",
    ]);
    expect(done.json("templates/one.json").background.image).toBe("images/my-pic-1.png");
    expect(done.json("templates/two.json").background.image).toBe("images/my-pic-1-2.png");
    expect(done.json("templates/three.json").background.image).toBe("images/my-pic-1.png");
    expect(done.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });
});
