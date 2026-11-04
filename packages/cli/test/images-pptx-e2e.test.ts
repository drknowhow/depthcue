// What PowerPoint keeps of a picture's crop, fit and focus, of a scene's background and of a decorative mark: the XML of the
// file written for fixtures/decks/images. The page is the measure (a real browser draws it), so each source rectangle is
// the part of the file the page shows, and the tests read it back from <a:srcRect>.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir } from "../src/serve.ts";

const decks = (name: string) => fileURLToPath(new URL(`../../../fixtures/decks/${name}`, import.meta.url));

let skipReason: string | undefined;
let root: string;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "app.js")))
      throw new Error("The player is not built. Run pnpm build.");
    const browser = await launchBrowser();
    await browser.close();
  } catch (error) {
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

beforeEach((test) => {
  if (skipReason) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-images-pptx-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => undefined);

type Json = Record<string, any>;
function changeScene(deck: string, scene: string, change: (json: Json) => void): void {
  const file = join(deck, "scenes", `${scene}.json`);
  const json = JSON.parse(readFileSync(file, "utf8")) as Json;
  change(json);
  writeFileSync(file, JSON.stringify(json));
}

async function exportPptx(folder: string, name: string, ...flags: string[]) {
  const out = join(root, `${name}.pptx`);
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await run(["export", folder, "--format", "pptx", "--out", out, ...flags], {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  });
  if (code !== 0) throw new Error(`The export exited ${code}: ${[...lines, ...errors].join("\n")}`);
  const zip = await JSZip.loadAsync(readFileSync(out));
  const part = async (path: string) => {
    const found = zip.file(path);
    if (!found) throw new Error(`The file has no ${path}.`);
    return found;
  };
  return {
    names: Object.keys(zip.files),
    text: async (path: string) => (await part(path)).async("string"),
    bytes: async (path: string) => Buffer.from(await (await part(path)).async("uint8array")),
  };
}

/** The `<p:pic>` of the shape with this name. */
const pictureOf = (xml: string, name: string): string => {
  const found = [...xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)].find((match) =>
    match[0].includes(`name="${name}"`),
  );
  if (!found) throw new Error(`The slide has no picture named ${name}.`);
  return found[0];
};

/** The source rectangle of a picture in percent of the file (left, top, right, bottom), 0 for an edge it leaves alone. */
function sourceRect(pic: string): { l: number; t: number; r: number; b: number } | undefined {
  const tag = /<a:srcRect([^>]*)\/>/.exec(pic)?.[1];
  if (tag === undefined) return undefined;
  const edge = (name: string) => Number(new RegExp(`${name}="(-?\\d+)"`).exec(tag)?.[1] ?? 0) / 1000;
  return { l: edge("l"), t: edge("t"), r: edge("r"), b: edge("b") };
}
const near = (actual: number | undefined, expected: number, within = 0.6) =>
  expect(
    Math.abs((actual ?? Number.NaN) - expected),
    `${actual} is not within ${within} of ${expected}`,
  ).toBeLessThan(within);

describe("the fixture deck exported to PowerPoint", () => {
  it("writes a crop as the source rectangle the page shows, for contain and for cover with a focus", async () => {
    const pptx = await exportPptx(decks("images"), "images");

    // Slide 2: the top-right quarter of the file in a box wider than it is tall. Contain keeps the quarter whole, so the
    // rectangle is the crop itself: from 50% across, to 50% down.
    const crop = sourceRect(pictureOf(await pptx.text("ppt/slides/slide2.xml"), "crop-image"));
    near(crop?.l, 50);
    near(crop?.t, 0);
    near(crop?.r, 0);
    near(crop?.b, 50);

    // Slides 3 and 4: cover on a wide box takes a band of the square file, 142 of 506 pixels tall, from the focus: the
    // top band cuts the bottom 72% away, the bottom band the top 72%.
    const top = sourceRect(pictureOf(await pptx.text("ppt/slides/slide3.xml"), "cover-image"));
    near(top?.l, 0);
    near(top?.r, 0);
    near(top?.t, 0);
    near(top?.b, 72, 1);
    const bottom = sourceRect(pictureOf(await pptx.text("ppt/slides/slide4.xml"), "cover-bottom-image"));
    near(bottom?.l, 0);
    near(bottom?.r, 0);
    near(bottom?.t, 72, 1);
    near(bottom?.b, 0);
  }, 180_000);

  it("leaves a picture with nothing cut away without a source rectangle, square as the file is", async () => {
    const pptx = await exportPptx(decks("images"), "whole");
    const plain = pictureOf(await pptx.text("ppt/slides/slide1.xml"), "plain-image");
    expect(plain).not.toContain("<a:srcRect");
    const contained = pictureOf(await pptx.text("ppt/slides/slide5.xml"), "contain-image");
    expect(contained).not.toContain("<a:srcRect");
    const [cx, cy] = [
      /<a:ext cx="(\d+)"/.exec(contained)?.[1],
      /<a:ext cx="\d+" cy="(\d+)"/.exec(contained)?.[1],
    ];
    expect(Math.abs(Number(cx) - Number(cy))).toBeLessThan(20_000);
  }, 180_000);

  it("makes a scene's background the slide's background, with the scrim laid over the picture", async () => {
    const deck = join(root, "deck");
    cpSync(decks("images"), deck, { recursive: true });
    const withScrim = (scrim: number) =>
      changeScene(deck, "background", (json) => {
        json.background = { asset: "assets/grid.png", scrim, color: "text", alt: "A grid" };
      });
    withScrim(0);
    const open = await exportPptx(deck, "open");
    const slide = await open.text("ppt/slides/slide8.xml");
    const background = /<p:bg>[\s\S]*?<\/p:bg>/.exec(slide)?.[0] ?? "";
    expect(background).toContain('<a:blip r:embed="rIdSceneBg"/>');
    expect(background).not.toContain("solidFill");
    expect(await open.text("ppt/slides/_rels/slide8.xml.rels")).toContain(
      'Target="../media/depthcue-slide8.jpeg"',
    );
    expect(await open.text("[Content_Types].xml")).toContain('Extension="jpeg"');
    const clear = await open.bytes("ppt/media/depthcue-slide8.jpeg");
    expect([clear[0], clear[1]]).toEqual([0xff, 0xd8]);
    // Every other slide keeps its own color.
    expect(await open.text("ppt/slides/slide1.xml")).toContain("<a:solidFill>");
    expect(await open.text("ppt/slides/slide1.xml")).not.toContain("rIdSceneBg");

    // Fully scrimmed, the picture is the scrim's one color, which a JPEG stores in fewer bytes than nine squares.
    withScrim(100);
    const covered = await exportPptx(deck, "covered");
    const flat = await covered.bytes("ppt/media/depthcue-slide8.jpeg");
    expect(flat.length).toBeLessThan(clear.length * 0.75);
  }, 240_000);

  it("marks a decorative picture as decorative for PowerPoint as well as giving it an empty description", async () => {
    const pptx = await exportPptx(decks("images"), "decorative");
    const decorative = pictureOf(await pptx.text("ppt/slides/slide9.xml"), "decorative-image");
    expect(decorative).toContain('descr=""');
    expect(decorative).toMatch(
      /<p:cNvPr [^>]*>\s*<a:extLst><a:ext uri="\{C183D7F6-B498-43B3-948B-1728B52AA6E4\}"><adec:decorative xmlns:adec="http:\/\/schemas\.microsoft\.com\/office\/drawing\/2017\/decorative" val="1"\/><\/a:ext><\/a:extLst>\s*<\/p:cNvPr>/,
    );
    // A picture that says something has its alt text and no mark.
    const said = pictureOf(await pptx.text("ppt/slides/slide2.xml"), "crop-image");
    expect(said).toContain('descr="A grid of nine colored squares"');
    expect(said).not.toContain("decorative");
  }, 180_000);

  it("keeps the mark and a link together on one picture", async () => {
    const deck = join(root, "linked");
    cpSync(decks("images"), deck, { recursive: true });
    const manifest = join(deck, "deck.json");
    const json = JSON.parse(readFileSync(manifest, "utf8")) as Json;
    json.links = [{ id: "grid", title: "The grid", target: "https://example.com/grid" }];
    writeFileSync(manifest, JSON.stringify(json));
    changeScene(deck, "decorative", (scene) => {
      scene.blocks[1].link = "grid";
    });
    const pptx = await exportPptx(deck, "linked");
    const pic = pictureOf(await pptx.text("ppt/slides/slide9.xml"), "decorative-image");
    expect(pic).toContain("<a:hlinkClick");
    // The extension list comes after the link inside the same element, as the schema orders them.
    expect(pic.indexOf("<a:hlinkClick")).toBeLessThan(pic.indexOf("<a:extLst>"));
    expect(pic.indexOf("<a:extLst>")).toBeLessThan(pic.indexOf("</p:cNvPr>"));
  }, 180_000);

  it("draws a picture the same way in picture mode, as one picture of the page, with no background part", async () => {
    const pptx = await exportPptx(decks("images"), "pictures", "--pictures");
    expect(pptx.names.some((name) => name.startsWith("ppt/media/depthcue-slide"))).toBe(false);
    expect(await pptx.text("ppt/slides/slide8.xml")).not.toContain("rIdSceneBg");
  }, 240_000);
});

describe("a scene background on a template's slide", () => {
  it("belongs to the slide: the layout the template's other scenes share keeps its own look", async () => {
    const deck = join(root, "brand");
    cpSync(decks("v0-4-brand"), deck, { recursive: true });
    cpSync(join(decks("images"), "assets", "grid.png"), join(deck, "assets", "grid.png"));
    changeScene(deck, "welcome", (json) => {
      json.schemaVersion = "0.6";
      json.background = { asset: "assets/grid.png", scrim: 20, decorative: true };
    });
    const pptx = await exportPptx(deck, "brand");
    const slide = await pptx.text("ppt/slides/slide1.xml");
    expect(slide).toContain('<a:blip r:embed="rIdSceneBg"/>');
    const layoutOf = async (n: number) => {
      const rels = await pptx.text(`ppt/slides/_rels/slide${n}.xml.rels`);
      const target = /slideLayouts\/(slideLayout\d+\.xml)/.exec(rels)?.[1];
      return pptx.text(`ppt/slideLayouts/${target}`);
    };
    // The slide's layout does not carry the scene's picture: that would put it behind every scene of the template.
    expect(await layoutOf(1)).not.toContain("rIdBackdrop");
    expect(pptx.names.some((name) => /depthcue-layout\d+\.jpeg/.test(name))).toBe(false);
  }, 240_000);
});
