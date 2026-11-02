import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { type Scene, styleOf } from "@depthcue/core";
import { numberText } from "@depthcue/player";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { run } from "../src/index.ts";
import { buildPresentation } from "../src/pptx/build.ts";
import { readEot } from "../src/pptx/eot.ts";
import { measureSlide } from "../src/pptx/measure.ts";
import { readSfnt } from "../src/pptx/sfnt.ts";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, PPTX_ROUTE, pptxOutOf, startServer } from "../src/serve.ts";

/**
 * The PowerPoint extras against the real player in a real browser: a branded deck's master, layouts and placeholders,
 * the embedded fonts, picture mode, an embedded video and its poster form, one slide per step, the live server's
 * export call, and the report's honest parts (content past an edge, a picture cropped there, decorations a shape cannot
 * draw, the deck warnings that change the file, and a player that is not built). Where LibreOffice is installed, the
 * files are also opened there and must give one page per slide.
 */

const decks = (name: string) => fileURLToPath(new URL(`../../../fixtures/decks/${name}`, import.meta.url));
const tinyMp4 = fileURLToPath(new URL("./fixtures/tiny.mp4", import.meta.url));

/** The built player the export draws with, which one test replaces with a folder that has none. */
const hooks = vi.hoisted(() => ({ playerDir: undefined as string | undefined }));

vi.mock("../src/serve.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/serve.ts")>();
  return { ...original, builtPlayerDir: () => hooks.playerDir ?? original.builtPlayerDir() };
});

let skipReason: string | undefined;
let root: string;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "app.js")))
      throw new Error("The player is not built. Run pnpm build.");
    const browser = await launchBrowser();
    await browser.close();
  } catch (error) {
    // CI builds first and has Chrome, so it must not skip. A machine without either can run everything else.
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

beforeEach(async (test) => {
  if (skipReason !== undefined) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-pptx-extras-"));
});

afterEach(() => {
  hooks.playerDir = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Running the command and reading the file.
// ---------------------------------------------------------------------------------------------------------------------

interface Summary {
  ok: boolean;
  out: string;
  pictures: boolean;
  steps: boolean;
  posters: boolean;
  layouts: string[];
  embedded: Array<{ family: string; as?: string; embedded: string[]; notes: string[] }>;
  slides: Array<{ scene: string; title: string; step?: number; left: string[] }>;
  deck: string[];
}

async function command(...args: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(args, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
  return { code, lines, errors };
}

/** Exports with --json and returns what the command reported. */
async function exported(folder: string, out: string, ...flags: string[]): Promise<Summary> {
  const { code, lines, errors } = await command(
    "export",
    folder,
    "--format",
    "pptx",
    "--out",
    out,
    "--json",
    ...flags,
  );
  if (code !== 0) throw new Error(`The export exited ${code}: ${[...lines, ...errors].join("\n")}`);
  return JSON.parse(lines.join("\n")) as Summary;
}

async function unzip(file: string | Uint8Array) {
  const zip = await JSZip.loadAsync(typeof file === "string" ? readFileSync(file) : file);
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name]?.dir)
    .sort();
  const entry = (name: string) => {
    const found = zip.file(name);
    if (!found) throw new Error(`The file has no ${name}.`);
    return found;
  };
  return {
    names,
    text: (name: string) => entry(name).async("string"),
    bytes: async (name: string) => Buffer.from(await entry(name).async("uint8array")),
  };
}
type Unzipped = Awaited<ReturnType<typeof unzip>>;

const encodeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const SHAPE = /<p:(sp|pic|graphicFrame)>(?:(?!<p:(?:sp|pic|graphicFrame)>)[\s\S])*?<\/p:\1>/g;
/** The slide's or layout's shape of that name. */
const shapeOf = (xml: string, name: string) =>
  [...xml.matchAll(SHAPE)]
    .map((match) => match[0])
    .find((shape) => shape.includes(`name="${encodeXml(name)}"`));

/** The layouts by the name PowerPoint shows, with the part each is in. */
async function layoutsOf(pptx: Unzipped): Promise<Map<string, { part: string; xml: string }>> {
  const out = new Map<string, { part: string; xml: string }>();
  const parts = pptx.names
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
  for (const part of parts) {
    const xml = await pptx.text(part);
    out.set(/<p:cSld name="([^"]*)"/.exec(xml)?.[1] ?? "", { part, xml });
  }
  return out;
}

/** The layout part a slide is on. */
async function layoutOf(pptx: Unzipped, slide: number): Promise<string> {
  const rels = await pptx.text(`ppt/slides/_rels/slide${slide}.xml.rels`);
  return `ppt/slideLayouts/${/Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(rels)?.[1]}`;
}

/** A copy of a fixture deck, which the test may change. */
function copyDeck(name: string, as = name): string {
  const folder = join(root, as);
  cpSync(decks(name), folder, { recursive: true });
  return folder;
}

const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

/** A deck with only the scenes named, the rest of its scene files removed. */
function keepScenes(folder: string, scenes: string[]) {
  const deckFile = join(folder, "deck.json");
  writeJson(deckFile, { ...readJson(deckFile), scenes });
  for (const file of readdirSync(join(folder, "scenes"))) {
    if (!scenes.includes(file.replace(/\.json$/, ""))) rmSync(join(folder, "scenes", file));
  }
}

/** A PNG of one color, made here so the test carries no picture file. */
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([red, green, blue], y * stride + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Every file under a folder, relative to it, for checking that nothing was written there. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------------
// A branded deck: its master, layouts, placeholders and fonts. Exported once for the tests that read it.
// ---------------------------------------------------------------------------------------------------------------------

let brandRoot: string | undefined;
let brandExport: Promise<{ deck: string; out: string; summary: Summary; pptx: Unzipped }> | undefined;

function brandFile() {
  brandExport ??= (async () => {
    brandRoot = mkdtempSync(join(tmpdir(), "depthcue-pptx-brand-"));
    const deck = join(brandRoot, "v0-4-brand");
    cpSync(decks("v0-4-brand"), deck, { recursive: true });
    const out = join(brandRoot, "brand.pptx");
    const summary = await exported(deck, out);
    return { deck, out, summary, pptx: await unzip(out) };
  })();
  return brandExport;
}

afterAll(() => {
  if (brandRoot) rmSync(brandRoot, { recursive: true, force: true });
});

/** Each slot's placeholder in the brand's two template layouts, as `<p:ph>` attributes. */
const SLOT_PLACEHOLDERS: Record<string, Record<string, string>> = {
  Cover: { kicker: 'type="body" idx="13"', title: 'type="title"', byline: 'type="subTitle" idx="15"' },
  "Chart and note": { title: 'type="title"', chart: 'idx="14"', note: 'type="body" idx="15"' },
};
const TEMPLATE_FILES: Record<string, string> = { Cover: "cover", "Chart and note": "chart-and-note" };

describe("a branded deck", () => {
  it("has the brand's chrome as its slide master: background, accent bar, logo, footer and number", async () => {
    const { summary, pptx } = await brandFile();
    expect(summary.layouts).toEqual(["Blank", "Cover", "Chart and note"]);
    const masters = pptx.names.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name));
    expect(masters).toEqual(["ppt/slideMasters/slideMaster1.xml"]);
    const master = await pptx.text("ppt/slideMasters/slideMaster1.xml");
    expect(master).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5F2EA"/>');
    for (const ph of [
      '<p:ph type="title"/>',
      '<p:ph type="body" idx="1"/>',
      '<p:ph type="ftr" sz="quarter" idx="3"/>',
      '<p:ph type="sldNum" sz="quarter" idx="4"/>',
    ]) {
      expect(master).toContain(ph);
    }
    expect(master).toMatch(/<a:fld id="\{[0-9A-F-]+\}" type="slidenum">/);
    expect(master).toContain("<a:t>Harbor Analytics, for internal use</a:t>");
    expect(master).toContain('name="Accent bar"');
    expect(master).toContain('<a:srgbClr val="0B6E6E"/>');
    expect(master).toMatch(/<p:cNvPr id="\d+" name="Logo" descr="Harbor Analytics"\/>/);
    expect(master).toContain('<p:hf hdr="0" dt="0"/>');
    expect(await pptx.text("ppt/slideMasters/_rels/slideMaster1.xml.rels")).toContain(
      'Target="../media/depthcue-logo.png"',
    );
    const logo = await pptx.bytes("ppt/media/depthcue-logo.png");
    expect([...logo.subarray(1, 4)].map((code) => String.fromCharCode(code)).join("")).toBe("PNG");
    expect(await pptx.text("ppt/theme/theme1.xml")).toContain("0B6E6E");
  }, 180_000);

  it("has a layout per template it uses, named after it, with a placeholder per slot prompting with its hint", async () => {
    const { deck, pptx } = await brandFile();
    const layouts = await layoutsOf(pptx);
    expect([...layouts.keys()]).toEqual(["Blank", "Cover", "Chart and note"]);
    const types = await pptx.text("[Content_Types].xml");
    for (const [name, slots] of Object.entries(SLOT_PLACEHOLDERS)) {
      const { part, xml } = layouts.get(name) as { part: string; xml: string };
      expect(types).toContain(`PartName="/${part}"`);
      const template = readJson(join(deck, "brand", "templates", `${TEMPLATE_FILES[name]}.json`)) as {
        slots: Array<{ id: string; hint: string }>;
      };
      expect(template.slots.map((slot) => slot.id)).toEqual(Object.keys(slots));
      for (const slot of template.slots) {
        const shape = shapeOf(xml, slot.id);
        expect(shape, `${name}: ${slot.id}`).toBeDefined();
        expect(shape).toContain(`<p:ph ${slots[slot.id]} hasCustomPrompt="1"/>`);
        expect(shape).toContain(`<a:t>${encodeXml(slot.hint)}</a:t>`);
      }
    }
    // The cover shows none of the chrome ("chrome": "none"); the chart template shows all of it, footer and number.
    const cover = layouts.get("Cover")?.xml as string;
    expect(cover).toContain('showMasterSp="0"');
    expect(cover).not.toContain('type="ftr"');
    expect(cover).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B6E6E"/>');
    const chart = layouts.get("Chart and note")?.xml as string;
    expect(chart).not.toContain('showMasterSp="0"');
    expect(chart).toContain('<p:ph type="ftr" sz="quarter" idx="11"/>');
    expect(chart).toContain('<p:ph type="sldNum" sz="quarter" idx="12"/>');
    // The anchor is the slot's: the cover's title sits at the bottom of its frame.
    expect(shapeOf(cover, "title")).toContain('anchor="b"');
  }, 180_000);

  it("puts each template scene on its layout, with the first block in each slot as that slot's placeholder", async () => {
    const { pptx } = await brandFile();
    const layouts = await layoutsOf(pptx);
    expect(await layoutOf(pptx, 1)).toBe(layouts.get("Cover")?.part);
    expect(await layoutOf(pptx, 2)).toBe(layouts.get("Blank")?.part);
    expect(await layoutOf(pptx, 3)).toBe(layouts.get("Chart and note")?.part);

    const welcome = await pptx.text("ppt/slides/slide1.xml");
    expect(shapeOf(welcome, "welcome-kicker")).toContain('<p:ph type="body" idx="13"/>');
    expect(shapeOf(welcome, "welcome-title")).toContain('<p:ph type="title"/>');
    expect(shapeOf(welcome, "welcome-byline")).toContain('<p:ph type="subTitle" idx="15"/>');

    const growth = await pptx.text("ppt/slides/slide3.xml");
    expect(shapeOf(growth, "growth-title")).toContain('<p:ph type="title"/>');
    expect(shapeOf(growth, "growth-title")).toContain('<a:spLocks noGrp="1"/>');
    expect(shapeOf(growth, "growth-chart")).toContain('<p:ph idx="14"/>');
    expect(shapeOf(growth, "growth-chart")).toContain('<a:graphicFrameLocks noGrp="1"/>');
    expect(shapeOf(growth, "growth-note")).toContain('<p:ph type="body" idx="15"/>');
    // The chart's source line is not the slot's first block, so it is no placeholder.
    expect(shapeOf(growth, "growth-chart source")).not.toContain("<p:ph");
    // The footer and the number are the layout's, filled: the number is PowerPoint's own field.
    expect(shapeOf(growth, "Footer")).toContain('<p:ph type="ftr" sz="quarter" idx="11"/>');
    expect(shapeOf(growth, "Slide number")).toMatch(
      /<a:fld id="\{[0-9A-F-]+\}" type="slidenum">.*<a:t>3<\/a:t><\/a:fld>/,
    );
    // A template scene's sources are one line at the foot with no numbers, as the page draws them.
    for (const name of ["Sources label", "Sources"]) {
      const shape = shapeOf(growth, name) as string;
      expect(shape, name).toContain('wrap="none"');
      expect(shape, name).not.toContain("<a:t>1. </a:t>");
    }
    // The chrome is the master's, not content: the page's footer and logo are not drawn again on the slide.
    expect(growth.split("Harbor Analytics, for internal use")).toHaveLength(2);
    expect(shapeOf(growth, "Logo")).toBeUndefined();
    // A built-in layout's scene has no placeholders but the footer and number.
    const context = await pptx.text("ppt/slides/slide2.xml");
    expect([...context.matchAll(/<p:ph type="(\w+)"/g)].map((match) => match[1])).toEqual(["ftr", "sldNum"]);
  }, 180_000);

  it("embeds the faces it draws as EOT parts, listed in the presentation, under their own names", async () => {
    const { pptx, summary } = await brandFile();
    const presentation = await pptx.text("ppt/presentation.xml");
    expect(presentation).toContain('embedTrueTypeFonts="1"');
    const list = /<p:embeddedFontLst>([\s\S]*?)<\/p:embeddedFontLst>/.exec(presentation)?.[1] ?? "";
    const entries = [
      ...list.matchAll(/<p:embeddedFont><p:font typeface="([^"]+)"[^>]*\/>(.*?)<\/p:embeddedFont>/g),
    ];
    expect(entries.map((entry) => entry[1])).toEqual(["IBM Plex Mono", "Space Grotesk"]);
    expect(entries[1]?.[2]).toMatch(/^<p:regular r:id="rIdFont\d+"\/><p:bold r:id="rIdFont\d+"\/>$/);

    const rels = await pptx.text("ppt/_rels/presentation.xml.rels");
    const types = await pptx.text("[Content_Types].xml");
    expect(types).toContain('<Default Extension="fntdata" ContentType="application/x-fontdata"/>');
    const parts = pptx.names.filter((name) => name.startsWith("ppt/fonts/"));
    expect(parts).toEqual(["ppt/fonts/font1.fntdata", "ppt/fonts/font2.fntdata", "ppt/fonts/font3.fntdata"]);
    for (const [, typeface, faces] of entries) {
      for (const [, id] of (faces as string).matchAll(/r:id="([^"]+)"/g)) {
        const target = new RegExp(
          `<Relationship Id="${id}" Type="[^"]*/font" Target="(fonts/font\\d+\\.fntdata)"/>`,
        ).exec(rels)?.[1];
        expect(target, `${typeface} ${id}`).toBeDefined();
        const eot = await pptx.bytes(`ppt/${target}`);
        const header = readEot(eot);
        expect(header.magic).toBe(0x504c);
        expect(header.version).toBe(0x00020002);
        expect(header.size).toBe(eot.length);
        expect(header.family).toBe(typeface);
        expect(header.fsType & 0x0202).toBe(0);
        expect(readSfnt(header.font).tables.has("glyf")).toBe(true);
      }
    }
    // The slides name the faces the way PowerPoint knows them, so it finds the embedded ones.
    for (const name of pptx.names.filter((part) => part.endsWith(".xml"))) {
      expect(await pptx.text(name), name).not.toMatch(/typeface="Harbor (Sans|Display)"/);
    }
    expect(summary.embedded.find((font) => font.family === "Harbor Sans")).toMatchObject({
      as: "Space Grotesk",
      embedded: ["regular", "bold"],
    });
    expect(summary.embedded.find((font) => font.family === "Harbor Display")).toMatchObject({
      as: "Space Grotesk",
      embedded: ["bold"],
    });
  }, 180_000);

  it("says which faces it embedded in the human summary", async () => {
    const { deck } = await brandFile();
    const { code, lines } = await command(
      "export",
      deck,
      "--format",
      "pptx",
      "--out",
      join(root, "brand.pptx"),
    );
    expect(code).toBe(0);
    expect(lines).toContain("  slide layouts: Blank, Cover, Chart and note");
    expect(
      lines.some((line) =>
        /^ {6}Harbor Sans \(text\): embedded \(regular, bold\), which PowerPoint uses$/.test(line),
      ),
    ).toBe(true);
    expect(lines).toContain(
      '          its file names itself "Space Grotesk", which is the name PowerPoint knows it by, so the slides use that name.',
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// What the report raises.
// ---------------------------------------------------------------------------------------------------------------------

describe("the report", () => {
  it("raises an empty slot, a face with no files and a background picture nobody has measured", async () => {
    const deck = copyDeck("v0-4-brand", "raised");
    const brandJson = join(deck, "brand", "brand.json");
    const brand = readJson(brandJson);
    delete brand.fonts.display.files;
    writeJson(brandJson, brand);
    const templateFile = join(deck, "brand", "templates", "chart-and-note.json");
    writeJson(templateFile, {
      ...readJson(templateFile),
      background: { color: "bg", image: "images/sea.png", scrim: 70 },
    });
    mkdirSync(join(deck, "brand", "images"));
    writeFileSync(join(deck, "brand", "images", "sea.png"), solidPng(64, 36, [30, 90, 140]));
    const growthFile = join(deck, "scenes", "growth.json");
    const growth = readJson(growthFile);
    writeJson(growthFile, {
      ...growth,
      blocks: growth.blocks.filter((b: { id: string }) => b.id !== "growth-chart"),
    });

    const out = join(root, "raised.pptx");
    const summary = await exported(deck, out);
    expect(summary.slides[2]?.left).toContain(
      'The slot "chart" of the template "chart-and-note" is empty. The slide has nothing there; its layout keeps the slot\'s placeholder (slot-empty).',
    );
    expect(summary.slides[0]?.left.join(" ")).not.toContain("slot-empty");
    expect(
      summary.deck.some(
        (line) => line.includes('"Harbor Display"') && line.endsWith("(face-without-files)."),
      ),
    ).toBe(true);
    expect(
      summary.deck.some(
        (line) =>
          line.startsWith("brand/templates/chart-and-note.json: ") &&
          line.endsWith("(background-unmeasured)."),
      ),
    ).toBe(true);
    expect(summary.embedded.find((font) => font.family === "Harbor Display")?.notes).toEqual([
      "no font file, so a viewer needs it installed to see it as drawn.",
    ]);
    // The layout carries the picture with its scrim, as the page drew it.
    const pptx = await unzip(out);
    const layouts = await layoutsOf(pptx);
    const chart = layouts.get("Chart and note") as { part: string; xml: string };
    expect(chart.xml).toContain(
      '<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rIdBackdrop"/>',
    );
    const rels = await pptx.text(
      chart.part.replace("slideLayouts/", "slideLayouts/_rels/").replace(/$/, ".rels"),
    );
    const backdrop =
      /Id="rIdBackdrop" Type="[^"]*\/image" Target="\.\.\/(media\/depthcue-layout\d+\.jpeg)"/.exec(rels)?.[1];
    expect(backdrop).toBeDefined();
    expect([...(await pptx.bytes(`ppt/${backdrop}`)).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    // The empty slot's placeholder is still on the layout, prompting.
    expect(shapeOf(chart.xml, "chart")).toContain('<p:ph idx="14" hasCustomPrompt="1"/>');
  }, 180_000);

  it("says how far content runs past the slide on every edge it crosses", async () => {
    const deck = copyDeck("v0-3");
    const summary = await exported(deck, join(root, "v0-3.pptx"));
    const past = (scene: string) =>
      summary.slides
        .find((slide) => slide.scene === scene)
        ?.left.find((line) => line.startsWith("the content runs ")) ?? "";
    // The numbers depend on this machine's fonts; the edge and the words do not.
    expect(past("overview")).toMatch(
      /^the content runs \d+px past the slide in the player too, at the bottom, where it scrolls or is cut off; boxes are cut at the slide's edge here, pictures are cropped there, and a table keeps every row\.$/,
    );
    expect(past("data")).toMatch(/^the content runs \d+px past the slide in the player too, at the bottom/);
    expect(past("legacy")).toBe("");
  }, 180_000);

  it("crops a picture at the slide's edge, keeping the rest of it for PowerPoint's Crop", async () => {
    const deck = copyDeck("demo", "cropped");
    keepScenes(deck, ["crop"]);
    const lines = [1, 2, 3, 4]
      .map((n) => `- Line ${n} of the method, which is long enough to wrap once.`)
      .join("\n");
    writeJson(join(deck, "scenes", "crop.json"), {
      schemaVersion: "0.3",
      id: "crop",
      title: "A picture past the edge",
      layout: "claim-evidence",
      blocks: [
        { id: "crop-heading", type: "text", role: "heading", text: "The picture runs off the bottom" },
        { id: "crop-body", type: "text", role: "body", text: lines },
        { id: "crop-picture", type: "image", asset: "assets/method.svg", alt: "The method diagram." },
      ],
    });
    const out = join(root, "cropped.pptx");
    const summary = await exported(deck, out);
    expect(summary.slides[0]?.left).toContain(
      "\"crop-picture\": the picture runs past the slide's edge; it is cropped there, as the slide shows it, and PowerPoint's Crop gives the rest back.",
    );
    const slide = await (await unzip(out)).text("ppt/slides/slide1.xml");
    const picture = shapeOf(slide, "crop-picture") as string;
    const crop = /<a:srcRect l="(\d+)" r="(\d+)" t="(\d+)" b="(\d+)"\/>/.exec(picture);
    expect(crop, picture).not.toBeNull();
    expect(Number(crop?.[4])).toBeGreaterThan(0);
    expect([crop?.[1], crop?.[2], crop?.[3]]).toEqual(["0", "0", "0"]);
    const y = Number(/<a:off x="\d+" y="(\d+)"\/>/.exec(picture)?.[1]);
    const cy = Number(/<a:ext cx="\d+" cy="(\d+)"\/>/.exec(picture)?.[1]);
    expect(Math.abs(y + cy - 6858000)).toBeLessThanOrEqual(2);
  }, 180_000);

  it("names what a panel has that a PowerPoint shape here does not draw", async () => {
    const deck = copyDeck("v0-4-brand", "panels");
    const server = await startServer({ folder: deck, playerDir: builtPlayerDir(), port: 0 });
    const browser = await launchBrowser();
    try {
      // As the export draws it: the page's own policy would refuse the style this test adds.
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, bypassCSP: true });
      await page.goto(`${server.url}#/context`, { waitUntil: "load" });
      await page.waitForSelector('.dc-scene[data-scene="context"]');
      await page.addStyleTag({
        content:
          '.dc-block[data-id="context-body"] { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3) !important; border-style: dashed !important; }',
      });
      await page.evaluate(() => (window as { depthcue?: { settled(): Promise<void> } }).depthcue?.settled());
      const measure = await page.evaluate(measureSlide);
      expect(measure.lost).toContain("context-body panel: a shadow, a dashed border, drawn solid");
      const opened = openDeck(deck);
      if (!opened.ok) throw new Error("The deck does not open.");
      const { doc } = opened;
      const built = await buildPresentation({
        deck: doc.deck,
        style: styleOf(doc.deck, doc.brand),
        scenes: [doc.scenes.context as Scene],
        measures: [measure],
        folder: deck,
        out: join(root, "panels.pptx"),
        notes: true,
        numberText,
        master: true,
      });
      expect(built.slides[0]?.left).toContain(
        '"context-body panel" has what a PowerPoint shape here does not draw: a shadow, a dashed border, drawn solid.',
      );
    } finally {
      await browser.close();
      await server.close();
    }
  }, 180_000);

  it("refuses with player-not-built, as JSON under --json, exit 2, when the player is not built", async () => {
    const deck = copyDeck("v0-1");
    hooks.playerDir = join(root, "no-player");
    mkdirSync(hooks.playerDir);
    const out = join(root, "deck.pptx");
    const { code, lines, errors } = await command("export", deck, "--format", "pptx", "--out", out, "--json");
    expect(code).toBe(2);
    expect(errors).toEqual([]);
    const reply = JSON.parse(lines.join("\n"));
    expect(reply).toMatchObject({ ok: false, code: "player-not-built" });
    expect(reply.message).toContain("Build it first: pnpm build.");
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// Picture mode, steps and videos.
// ---------------------------------------------------------------------------------------------------------------------

describe("--pictures", () => {
  it("makes each slide one 1920x1080 picture of the scene, with its notes and a hidden title for the outline", async () => {
    const deck = copyDeck("demo");
    const out = join(root, "pictures.pptx");
    const summary = await exported(deck, out, "--pictures");
    expect(summary.pictures).toBe(true);
    expect(summary.layouts).toEqual(["Picture"]);
    const scenes = readJson(join(deck, "deck.json")).scenes as string[];
    expect(summary.slides.map((slide) => slide.scene)).toEqual(scenes);
    const pptx = await unzip(out);
    for (const [at, id] of scenes.entries()) {
      const scene = readJson(join(deck, "scenes", `${id}.json`)) as { title: string; notes?: string };
      const xml = await pptx.text(`ppt/slides/slide${at + 1}.xml`);
      const shapes = [...xml.matchAll(SHAPE)].map((match) => match[0]);
      expect(shapes, id).toHaveLength(2);
      // The title is under the picture, hidden, and PowerPoint's title placeholder.
      expect(shapes[0]).toContain('name="Depthcue scene title" hidden="1"');
      expect(shapes[0]).toContain('<p:ph type="title"/>');
      expect(shapes[0]).toContain(`<a:t>${encodeXml(scene.title)}</a:t>`);
      expect(shapes[1]).toMatch(/^<p:pic>/);
      expect(shapes[1]).toContain(`descr="${encodeXml(scene.title)}"`);
      expect(shapes[1]).toContain('<a:ext cx="12192000" cy="6858000"/>');
      const rels = await pptx.text(`ppt/slides/_rels/slide${at + 1}.xml.rels`);
      const media = /Type="[^"]*\/image" Target="\.\.\/(media\/[^"]+\.png)"/.exec(rels)?.[1];
      const png = await pptx.bytes(`ppt/${media}`);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], id).toEqual([1920, 1080]);
      if (scene.notes) {
        const notes = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1];
        expect(await pptx.text(`ppt/notesSlides/${notes}`)).toContain(
          encodeXml(scene.notes).replaceAll("'", "&apos;"),
        );
      }
    }
  }, 180_000);
});

describe("--steps", () => {
  it("makes one slide per build step, from the scene as it opens to every step taken", async () => {
    const deck = copyDeck("demo");
    const out = join(root, "steps.pptx");
    const summary = await exported(deck, out, "--steps");
    expect(summary.steps).toBe(true);
    expect(summary.slides.map((slide) => [slide.scene, slide.step ?? null])).toEqual([
      ["opening", null],
      ["demand", 0],
      ["demand", 1],
      ["demand", 2],
      ["trend", null],
      ["method", null],
    ]);
    for (const slide of summary.slides) expect(slide.left.join(" ")).not.toContain("flattened");
    const pptx = await unzip(out);
    // The bar chart is held back until a step shows it, as the player holds it back.
    const charts = async (n: number) =>
      ((await pptx.text(`ppt/slides/slide${n}.xml`)).match(/<c:chart /g) ?? []).length;
    expect(await charts(2)).toBe(0);
    expect(await charts(4)).toBe(1);
    // Without --steps the same deck flattens them, and says so.
    const flat = await exported(deck, join(root, "flat.pptx"));
    expect(flat.slides.find((slide) => slide.scene === "demand")?.left).toContain(
      "build steps: 2 steps flattened, so every block shows at once.",
    );
  }, 180_000);
});

describe("a clip", () => {
  /** The demo deck with one scene: an MP4 clip and its poster. */
  function clipDeck(): string {
    const deck = copyDeck("demo", "clip-deck");
    keepScenes(deck, ["clip-scene"]);
    copyFileSync(tinyMp4, join(deck, "assets", "tiny.mp4"));
    writeFileSync(join(deck, "assets", "tiny.png"), solidPng(320, 180, [40, 90, 200]));
    writeJson(join(deck, "scenes", "clip-scene.json"), {
      schemaVersion: "0.1",
      id: "clip-scene",
      title: "A clip",
      layout: "text-media",
      blocks: [
        { id: "clip-heading", type: "text", role: "heading", text: "The opening, in motion" },
        {
          id: "tiny-clip",
          type: "clip",
          source: "assets/tiny.mp4",
          poster: "assets/tiny.png",
          alt: "A tiny clip.",
        },
      ],
    });
    return deck;
  }

  it("is embedded when it is an H.264 MP4 in the deck, with its description and its poster", async () => {
    const deck = clipDeck();
    const out = join(root, "clip.pptx");
    const summary = await exported(deck, out);
    expect(summary.slides[0]?.left.join(" ")).not.toContain("tiny-clip");
    const pptx = await unzip(out);
    const videos = pptx.names.filter((name) => name.endsWith(".mp4"));
    expect(videos).toHaveLength(1);
    expect((await pptx.bytes(videos[0] as string)).equals(readFileSync(tinyMp4))).toBe(true);
    expect(await pptx.text("[Content_Types].xml")).toContain('Extension="mp4"');
    const slide = await pptx.text("ppt/slides/slide1.xml");
    const clip = shapeOf(slide, "tiny-clip") as string;
    expect(clip).toMatch(/^<p:pic>/);
    expect(clip).toContain('descr="A tiny clip."');
    expect(clip).toMatch(/<a:videoFile r:link="rId\d+"\/>/);
    const rels = await pptx.text("ppt/slides/_rels/slide1.xml.rels");
    expect(rels).toMatch(
      /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/video"/,
    );
    expect(rels).toMatch(/Type="http:\/\/schemas\.microsoft\.com\/office\/2007\/relationships\/media"/);
    // The poster is the picture PowerPoint shows until it plays.
    expect(rels).toMatch(/relationships\/image" Target="\.\.\/media\/[^"]+\.png"/);
    // Nothing of this machine is in the file.
    for (const name of pptx.names.filter((part) => part.endsWith(".rels") || part.endsWith(".xml"))) {
      expect(await pptx.text(name)).not.toContain(root);
    }
  }, 180_000);

  it("is its poster with a link instead under --posters, and the report says why", async () => {
    const deck = clipDeck();
    const out = join(root, "posters.pptx");
    const summary = await exported(deck, out, "--posters");
    expect(summary.posters).toBe(true);
    expect(summary.slides[0]?.left).toContain(
      '"tiny-clip": the video is shown as its poster and linked to assets/tiny.mp4; it is not embedded, because --posters asks for posters and links.',
    );
    const pptx = await unzip(out);
    expect(pptx.names.some((name) => name.endsWith(".mp4"))).toBe(false);
    expect(await pptx.text("ppt/slides/_rels/slide1.xml.rels")).toContain(
      'Target="clip-deck/assets/tiny.mp4"',
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The live server's export call.
// ---------------------------------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  type: string;
  disposition: string;
  body: Buffer;
}

function call(
  port: number,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: PPTX_ROUTE,
        method: init.method ?? "POST",
        headers: init.headers ?? {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            type: String(response.headers["content-type"] ?? ""),
            disposition: String(response.headers["content-disposition"] ?? ""),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", fail);
    req.end(init.body ?? "");
  });
}

describe("the export call on the live server", () => {
  it("sends the same bytes the CLI writes, and writes nothing into the deck folder", async () => {
    const deck = copyDeck("demo", "live-deck");
    const editor = join(root, "editor");
    mkdirSync(editor);
    const before = filesUnder(deck);
    const server = await startServer({
      folder: deck,
      playerDir: builtPlayerDir(),
      editorDir: editor,
      port: 0,
    });
    let sent: Reply;
    try {
      const token = server.token as string;
      sent = await call(server.port, {
        headers: { "X-Depthcue-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ notes: true }),
      });
    } finally {
      await server.close();
    }
    expect(sent.status, sent.body.toString("utf8").slice(0, 400)).toBe(200);
    expect(sent.type).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(sent.disposition).toContain('attachment; filename="live-deck.pptx"');
    expect(filesUnder(deck)).toEqual(before);
    const beside = pptxOutOf(realpathSync(deck));
    expect(existsSync(beside)).toBe(false);

    const { code, lines, errors } = await command(
      "export",
      deck,
      "--format",
      "pptx",
      "--out",
      beside,
      "--json",
    );
    expect(code, [...lines, ...errors].join("\n")).toBe(0);
    expect(readFileSync(beside).equals(sent.body)).toBe(true);

    // A deck with no brand keeps the file it had: one layout, no placeholders. Its faces are embedded.
    const summary = JSON.parse(lines.join("\n")) as Summary;
    expect(summary.layouts).toEqual([]);
    const pptx = await unzip(sent.body);
    expect(pptx.names.filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))).toHaveLength(
      1,
    );
    for (const name of pptx.names.filter((part) => part.startsWith("ppt/slides/slide"))) {
      expect(await pptx.text(name)).not.toContain("<p:ph ");
    }
    expect(pptx.names.some((name) => name.startsWith("ppt/fonts/"))).toBe(true);
    expect(basename(beside)).toBe("live-deck.pptx");
  }, 180_000);

  it("is guarded as the other write calls are: the token, the origin, POST and the options", async () => {
    const deck = copyDeck("v0-1", "guarded");
    const editor = join(root, "editor");
    mkdirSync(editor);
    const server = await startServer({
      folder: deck,
      playerDir: builtPlayerDir(),
      editorDir: editor,
      port: 0,
    });
    try {
      const token = server.token as string;
      // One character off. Swapping in a fixed letter would hand back the real token whenever it ends in that letter.
      const almost = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      const refused = [
        await call(server.port, {}),
        await call(server.port, { headers: { "X-Depthcue-Token": almost } }),
        await call(server.port, { headers: { "X-Depthcue-Token": token, Origin: "http://example.com" } }),
        await call(server.port, { headers: { "X-Depthcue-Token": token, "Sec-Fetch-Site": "cross-site" } }),
      ];
      for (const reply of refused) {
        expect(reply.status).toBe(403);
        expect(JSON.parse(reply.body.toString("utf8")).error).toBe("forbidden");
      }
      expect(
        (await call(server.port, { method: "GET", headers: { "X-Depthcue-Token": token } })).status,
      ).toBe(405);
      const unknown = await call(server.port, {
        headers: { "X-Depthcue-Token": token },
        body: JSON.stringify({ format: "pdf" }),
      });
      expect(unknown.status).toBe(400);
      expect(JSON.parse(unknown.body.toString("utf8")).message).toContain('There is no option "format"');
      const notBoolean = await call(server.port, {
        headers: { "X-Depthcue-Token": token },
        body: JSON.stringify({ notes: "no" }),
      });
      expect(notBoolean.status).toBe(400);
      expect((await call(server.port, { headers: { "X-Depthcue-Token": token }, body: "{" })).status).toBe(
        400,
      );
      expect(
        (
          await call(server.port, {
            headers: { "X-Depthcue-Token": token },
            body: JSON.stringify({ pad: "x".repeat(5000) }),
          })
        ).status,
      ).toBe(413);
    } finally {
      await server.close();
    }
    // A server that is not editing has no write calls, this one included.
    const plain = await startServer({ folder: deck, playerDir: builtPlayerDir(), port: 0 });
    try {
      expect((await call(plain.port, {})).status).toBe(405);
    } finally {
      await plain.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// LibreOffice, where it is installed: another reader of the file must find one page per slide.
// ---------------------------------------------------------------------------------------------------------------------

const SOFFICE = [
  "C:/Program Files/LibreOffice/program/soffice.exe",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
].find((path) => existsSync(path));

/** The PDF LibreOffice makes of a PowerPoint file, and its page count. */
function pdfPages(file: string): number {
  const dir = join(root, "pdf");
  mkdirSync(dir, { recursive: true });
  const profile = pathToFileURL(join(root, "lo-profile")).href;
  const done = spawnSync(
    SOFFICE as string,
    [`-env:UserInstallation=${profile}`, "--headless", "--convert-to", "pdf", "--outdir", dir, file],
    { timeout: 120_000, encoding: "utf8" },
  );
  const pdf = join(dir, `${basename(file, ".pptx")}.pdf`);
  if (!existsSync(pdf)) throw new Error(`LibreOffice made no PDF: ${done.stderr || done.stdout}`);
  return (readFileSync(pdf, "latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

describe("in LibreOffice", () => {
  it("opens the branded file and the stepped file with one page per slide", async ({ skip }) => {
    if (!SOFFICE) return skip();
    const { out } = await brandFile();
    expect(pdfPages(out)).toBe(3);
    const deck = copyDeck("demo");
    const steps = join(root, "steps.pptx");
    const summary = await exported(deck, steps, "--steps");
    expect(pdfPages(steps)).toBe(summary.slides.length);
  }, 300_000);
});
