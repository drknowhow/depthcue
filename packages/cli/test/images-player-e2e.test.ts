// Pictures with a crop, a fit and a focus, and a scene's own background, in a real browser: the page is photographed and
// the color at the middle of a picture's box says which part of the file is there. fixtures/decks/images holds a 300 by
// 300 picture in a 3 by 3 grid of colors (tools/make-images-fixture.mjs), so every case below is a cell of it. These
// are colors and positions, never text sizes, so they do not depend on the machine's fonts.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchBrowser, openRenderer } from "../src/render.ts";
import { builtPlayerDir, startServer } from "../src/serve.ts";

const fixture = fileURLToPath(new URL("../../../fixtures/decks/images", import.meta.url));

/** The grid's cells, row by row: the same colors tools/make-images-fixture.mjs paints. */
const CELLS = [
  [255, 0, 0],
  [255, 128, 0],
  [255, 255, 0],
  [0, 200, 0],
  [128, 128, 128],
  [0, 255, 255],
  [0, 0, 255],
  [160, 0, 255],
  [255, 0, 255],
];
const cell = (col: number, row: number) => row * 3 + col;

let browser: Browser | undefined;
let root: string;
const closers: Array<() => Promise<unknown>> = [];
let skipReason: string | undefined;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "player.js")))
      throw new Error("The player is not built. Run pnpm build.");
    browser = await launchBrowser();
  } catch (error) {
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach((test) => {
  if (!browser) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-images-"));
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
}, 60_000);

/** A copy of the fixture deck that a test may change. */
function copyDeck(): string {
  const deck = join(root, "deck");
  cpSync(fixture, deck, { recursive: true });
  return deck;
}

type Json = Record<string, any>;
function changeScene(deck: string, scene: string, change: (json: Json) => void): void {
  const file = join(deck, "scenes", `${scene}.json`);
  const json = JSON.parse(readFileSync(file, "utf8")) as Json;
  change(json);
  writeFileSync(file, JSON.stringify(json));
}

async function open(folder: string, scene: string): Promise<Page> {
  const server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  closers.push(() => server.close());
  const context = await (browser as Browser).newContext({
    viewport: { width: 1280, height: 781 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  closers.push(() => context.close());
  const page = await context.newPage();
  await page.goto(`${server.url}#/${scene}`);
  await page.waitForSelector(`.dc-scene[data-scene="${scene}"]`);
  await page.waitForFunction(
    () =>
      [...document.images].every((image) => image.complete && image.naturalWidth > 0) &&
      [...document.querySelectorAll<HTMLElement>(".dc-crop")].every((box) =>
        box.style.getPropertyValue("--a"),
      ),
  );
  return page;
}

/** The color of one pixel of the page, read back from a photograph of it. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const shot = await page.screenshot({
    clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 },
    animations: "disabled",
  });
  const blank = await page.context().newPage();
  try {
    return await blank.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    }, shot.toString("base64"));
  } finally {
    await blank.close();
  }
}

/** Which cell of the grid a color is, or -1 when it is none of them (the box's own background, say). */
const cellOf = (rgb: number[]): number =>
  CELLS.findIndex((color) => color.every((channel, at) => Math.abs(channel - (rgb[at] as number)) <= 6));

async function box(page: Page, selector: string, nth = 0) {
  const found = await page.locator(selector).nth(nth).boundingBox();
  if (!found) throw new Error(`${selector} is not on the page.`);
  return found;
}
const middle = (b: { x: number; y: number; width: number; height: number }) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

describe("a picture with a crop, fit or focus", () => {
  it("shows the cropped part: a crop of the top-right quarter has that quarter at the middle of its box", async () => {
    const page = await open(fixture, "crop");
    const frame = await box(page, ".dc-block .dc-crop");
    const at = middle(frame);
    // The quarter is 150 by 150 pixels of the file, and the middle of it is in column 2 (yellow) of row 0.
    expect(cellOf(await pixel(page, at.x, at.y))).toBe(cell(2, 0));
    // Its edges are the crop's: just inside the stage, the corner pixels are the crop's corner cells.
    const stage = await box(page, ".dc-block .dc-crop-in");
    expect(cellOf(await pixel(page, stage.x + 3, stage.y + 3))).toBe(cell(1, 0));
    expect(cellOf(await pixel(page, stage.x + stage.width - 4, stage.y + stage.height - 4))).toBe(cell(2, 1));
    // Contain: the stage is as big as the box allows and is square like the crop.
    expect(Math.abs(stage.width - stage.height)).toBeLessThan(2);
    expect(stage.width).toBeLessThanOrEqual(frame.width + 1);
    expect(stage.height).toBeLessThanOrEqual(frame.height + 1);
  }, 60_000);

  it("keeps the focus in view when cover cuts the picture", async () => {
    const top = await open(fixture, "cover");
    const bottom = await open(fixture, "cover-bottom");
    const topBox = await box(top, ".dc-block .dc-crop");
    const bottomBox = await box(bottom, ".dc-block .dc-crop");
    const topAt = middle(topBox);
    const bottomAt = middle(bottomBox);
    // A wide box on a square file shows a band of it: focus at the top shows the top band, at the bottom the bottom one.
    expect(cellOf(await pixel(top, topAt.x, topAt.y))).toBe(cell(1, 0));
    expect(cellOf(await pixel(bottom, bottomAt.x, bottomAt.y))).toBe(cell(1, 2));
    // And the band fills the box edge to edge: its corners are the file's corners, with none left empty. (A few pixels
    // in, because the box has rounded corners.)
    expect(cellOf(await pixel(top, topBox.x + 14, topBox.y + 14))).toBe(cell(0, 0));
    expect(cellOf(await pixel(top, topBox.x + topBox.width - 15, topBox.y + 14))).toBe(cell(2, 0));
    expect(cellOf(await pixel(bottom, bottomBox.x + 14, bottomBox.y + bottomBox.height - 15))).toBe(
      cell(0, 2),
    );
    expect(
      cellOf(await pixel(bottom, bottomBox.x + bottomBox.width - 15, bottomBox.y + bottomBox.height - 15)),
    ).toBe(cell(2, 2));
  }, 60_000);

  it("shows all of a picture under contain, with the box's own color around it", async () => {
    const page = await open(fixture, "contain");
    const frame = await box(page, ".dc-block .dc-crop");
    const stage = await box(page, ".dc-block .dc-crop-in");
    expect(stage.height).toBeLessThanOrEqual(frame.height + 1);
    expect(Math.abs(stage.width - stage.height)).toBeLessThan(2);
    expect(cellOf(await pixel(page, stage.x + 3, stage.y + 3))).toBe(cell(0, 0));
    expect(cellOf(await pixel(page, stage.x + stage.width - 4, stage.y + stage.height - 4))).toBe(cell(2, 2));
    const at = middle(frame);
    expect(cellOf(await pixel(page, at.x, at.y))).toBe(cell(1, 1));
    expect(cellOf(await pixel(page, frame.x + 6, at.y))).toBe(-1);
  }, 60_000);

  it("draws a plain picture as before: an img in the figure and nothing around it", async () => {
    const page = await open(fixture, "plain");
    expect(await page.locator(".dc-crop").count()).toBe(0);
    expect(await page.locator(".dc-figure > img").count()).toBe(1);
  }, 60_000);

  it("keeps cover in a picture slot, and fit contain takes it away", async () => {
    const covered = await open(fixture, "slot");
    expect(await covered.locator(".dc-crop").count()).toBe(0);
    expect(await covered.locator(".dc-figure > img").evaluate((img) => getComputedStyle(img).objectFit)).toBe(
      "cover",
    );

    const contained = await open(fixture, "slot-contain");
    const stage = await box(contained, ".dc-block .dc-crop-in");
    const slot = await box(contained, ".dc-slot[data-role='picture']");
    // A 300 by 300 file in a slot 1280 wide: contain leaves it square and whole, where cover would fill the width.
    expect(stage.width).toBeLessThan(slot.width / 2);
    expect(cellOf(await pixel(contained, stage.x + 3, stage.y + 3))).toBe(cell(0, 0));
    expect(cellOf(await pixel(contained, stage.x + stage.width - 4, stage.y + stage.height - 4))).toBe(
      cell(2, 2),
    );
  }, 90_000);
});

describe("a scene's own background", () => {
  it("draws the picture behind the slide from its focus, and gives a reader its alt", async () => {
    const deck = copyDeck();
    const page = await open(deck, "background");
    const backdrop = page.locator(".dc-backdrop");
    expect(await backdrop.getAttribute("role")).toBe("img");
    expect(await backdrop.getAttribute("aria-label")).toBe("A grid of nine colored squares");
    expect(await backdrop.getAttribute("aria-hidden")).toBeNull();
    // Cover on a 16 by 9 slide shows a band of the square file; focus 50 puts row 1 at the middle of the slide.
    const scene = await box(page, ".dc-scene");
    expect(cellOf(await pixel(page, scene.x + scene.width - 6, scene.y + scene.height / 2))).toBe(cell(2, 1));

    // Focus at the top shows the top band instead.
    changeScene(deck, "background", (json) => {
      json.background.focus = { x: 50, y: 0 };
    });
    const top = await open(deck, "background");
    const slide = await box(top, ".dc-scene");
    expect(cellOf(await pixel(top, slide.x + slide.width - 6, slide.y + slide.height / 2))).toBe(cell(2, 0));
  }, 90_000);

  it("is hidden from a reader when it is decorative", async () => {
    const deck = copyDeck();
    changeScene(deck, "background", (json) => {
      json.background = { asset: "assets/grid.png", scrim: 0, decorative: true };
    });
    const page = await open(deck, "background");
    expect(await page.locator(".dc-backdrop").getAttribute("aria-hidden")).toBe("true");
    expect(await page.locator(".dc-backdrop").getAttribute("role")).toBeNull();
  }, 60_000);

  it("is measured for contrast: low with a bright picture and no scrim, fine under a strong one", async () => {
    const deck = copyDeck();
    writeFileSync(
      join(deck, "assets", "bright.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><rect width="1600" height="900" fill="#ffffff"/></svg>',
    );
    const withScrim = (scrim: number) =>
      changeScene(deck, "background", (json) => {
        json.background = { asset: "assets/bright.svg", scrim, color: "text", alt: "A white field" };
      });
    withScrim(0);
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const bright = await renderer.render("background", { screenshot: false });
    const found = bright.diagnostics.find((d) => d.code === "background-low-contrast");
    expect(found?.severity).toBe("error");
    expect(found?.message).toContain("scene's background");
    expect(found?.fix).toContain("scrim");
    withScrim(90);
    const calm = await renderer.render("background", { screenshot: false });
    expect(calm.diagnostics.map((d) => d.code)).not.toContain("background-low-contrast");
  }, 120_000);
});

describe("the low-resolution check on a real page", () => {
  it("warns for a 300 pixel picture drawn large, from the pixels of the part that shows, and not for a small one", async () => {
    const deck = copyDeck();
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const big = await renderer.render("crop", { screenshot: false });
    const found = big.diagnostics.find((d) => d.code === "image-low-resolution");
    expect(found?.severity).toBe("warning");
    expect(found?.path).toBe("/blocks/1");
    // The crop is 150 by 150 pixels of the file, drawn about 540 by 540 on a 1920 pixel slide.
    expect(found?.message).toContain("150x150px");
    expect(found?.fix).toBeTruthy();

    changeScene(deck, "crop", (json) => {
      json.blocks[1].frame = { x: 10, y: 30, w: 8, h: 14 };
    });
    const small = await renderer.render("crop", { screenshot: false });
    expect(small.diagnostics.map((d) => d.code)).not.toContain("image-low-resolution");
  }, 120_000);
});

describe("the cut-off check on a real page", () => {
  it("does not call a covered or cropped picture cut off, since its box clips the file on purpose", async () => {
    const renderer = await openRenderer(copyDeck());
    closers.push(() => renderer.close());
    for (const scene of ["cover", "cover-bottom", "crop", "slot"]) {
      const result = await renderer.render(scene, { screenshot: false });
      expect(
        result.diagnostics.filter((d) => d.code === "clipped"),
        scene,
      ).toEqual([]);
    }
  }, 120_000);
});
