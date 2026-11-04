import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Block, loadDoc } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * The editor's controls for pictures, in a real Chrome: Fit or Fill, Crop and Reset on the image toolbar, crop mode with
 * its handles and focus point (by pointer and by keyboard), a pinned picture that keeps its shape when resized, Fit box
 * to picture, the Decorative checkbox, a picture moved to the slide's background and taken off again, and the Background
 * section of the Scene popover. Each ends in the scene file on disk, and the same changes made through `depthcue apply`
 * have to give the same file. What is asserted is structure and the numbers written, not how large anything is drawn.
 * With DEPTHCUE_SHOTS set to a folder, one more test photographs the screens the reviewer looks at.
 */

const fixture = fileURLToPath(new URL("../../../fixtures/decks/images", import.meta.url));
const SCENES = [
  "plain",
  "crop",
  "cover",
  "cover-bottom",
  "contain",
  "slot",
  "slot-contain",
  "background",
  "decorative",
];

const NO_LAYOUT: LayoutChecker = {
  async check() {
    return { available: false, message: "Layout checks are off in this test." };
  },
  async close() {},
};

interface Deck {
  folder: string;
  server: RunningServer;
  page: Page;
}

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let context: BrowserContext;
let problems: string[];
let decks: Deck[];

beforeAll(async () => {
  try {
    if (!existsSync(join(builtEditorDir(), "editor.js")))
      throw new Error("The editor is not built. Run pnpm build.");
    browser = await launchBrowser();
  } catch (error) {
    // CI builds first and has Chrome, so it must not skip. A machine without either can run everything else.
    if (process.env.CI) throw error;
    skipReason = (error as Error).message;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(async (test) => {
  if (!browser) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-images-controls-"));
  problems = [];
  decks = [];
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
});

afterEach(async () => {
  await context?.close();
  for (const deck of decks ?? []) await deck.server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A copy of the fixture deck, served by an editor of its own, in a page of its own, on a scene of it. */
async function openDeck(scene: string, size?: { width: number; height: number }): Promise<Deck> {
  const folder = join(root, `deck-${decks.length}`);
  cpSync(fixture, folder, { recursive: true });
  const server = await startServer({
    folder,
    playerDir: builtPlayerDir(),
    editorDir: builtEditorDir(),
    port: 0,
    layout: NO_LAYOUT,
  });
  const page = await (size
    ? (browser as Browser).newContext({ viewport: size }).then((c) => c.newPage())
    : context.newPage());
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(server.url);
  await page.locator(".ed-frame .dc-scene").waitFor();
  const deck = { folder, server, page };
  decks.push(deck);
  await goTo(page, scene);
  return deck;
}

/** Opens a scene of the strip, and waits for its pictures to be drawn. */
async function goTo(page: Page, scene: string) {
  await page.locator(".ed-scene").nth(SCENES.indexOf(scene)).click();
  await page.locator(`.ed-frame .dc-scene[data-scene="${scene}"]`).waitFor();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>(".ed-frame img")];
    return images.every((image) => image.complete && image.naturalWidth > 0);
  });
}

const diskOf = (folder: string) => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
type Image = Extract<Block, { type: "image" }>;
const imageOn = (folder: string, scene: string, id: string): Image | undefined => {
  const block = diskOf(folder).scenes[scene]?.blocks.find((candidate) => candidate.id === id);
  return block?.type === "image" ? block : undefined;
};
const sceneFile = (folder: string, scene: string) =>
  readFileSync(join(folder, "scenes", `${scene}.json`), "utf8");

const image = (page: Page, id: string) => page.locator(`.ed-frame [data-id='${id}']`);
const tool = (page: Page, name: string) => page.locator(`.ed-toolbar [data-tb='${name}']`);
const layer = (page: Page) => page.locator(".ed-crop");
const part = (page: Page, name: string) => page.locator(`.ed-crop [data-h='${name}']`);
const undo = (page: Page) => page.locator("[data-action='undo']").click();
const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

async function centerOf(locator: ReturnType<Page["locator"]>) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("that is not on the page");
  return { x: found.x + found.width / 2, y: found.y + found.height / 2 };
}

/** Presses on a part of crop mode, moves by `dx` and `dy` pixels in a few steps, and lets go. */
async function dragBy(page: Page, locator: ReturnType<Page["locator"]>, dx: number, dy: number) {
  const from = await centerOf(locator);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const step of [0.25, 0.5, 1]) await page.mouse.move(from.x + dx * step, from.y + dy * step);
  await page.mouse.up();
}

/** Starts crop mode the way a person does with a mouse. */
async function cropByDoubleClick(page: Page, id: string) {
  await image(page, id).dblclick();
  await layer(page).waitFor();
}

function applyTo(folder: string, list: unknown[]) {
  const ops = join(root, "ops.json");
  writeFileSync(ops, JSON.stringify(list));
  const errors: string[] = [];
  const rev: string[] = [];
  expect(run(["rev", folder], { out: (line) => rev.push(line), err: (line) => errors.push(line) })).toBe(0);
  const code = run(["apply", folder, ops, "--base-rev", rev[0] as string], {
    out: () => {},
    err: (line) => errors.push(line),
  });
  expect({ code, errors }).toEqual({ code: 0, errors: [] });
}

/** A second copy of the deck for an agent, which makes the same change through `depthcue apply`. */
function agentDeck(): string {
  const folder = join(root, "agent");
  cpSync(fixture, folder, { recursive: true });
  return folder;
}

describe("the image toolbar", () => {
  it("has Crop, Fill and Reset picture on an image, with Fill pressed for a picture that fills its box", async () => {
    const { page, folder } = await openDeck("plain");
    await image(page, "plain-image").click();
    expect(await tool(page, "crop").textContent()).toBe("Crop");
    expect(await tool(page, "fill").textContent()).toBe("Fill");
    expect(await tool(page, "reset").textContent()).toBe("Reset picture");
    expect(await tool(page, "reset").isDisabled()).toBe(true);
    // A picture outside a slot is shown whole until it is told to fill its box.
    expect(await tool(page, "fill").getAttribute("aria-pressed")).toBe("false");
    await tool(page, "fill").click();
    await expect.poll(() => imageOn(folder, "plain", "plain-image")?.fit).toBe("cover");
    expect(await tool(page, "fill").getAttribute("aria-pressed")).toBe("true");
    expect(await tool(page, "reset").isDisabled()).toBe(false);
    // Pressed again it goes back to what it did before, which is not written down.
    await tool(page, "fill").click();
    await expect.poll(() => imageOn(folder, "plain", "plain-image")?.fit).toBeUndefined();
    expect(await tool(page, "fill").getAttribute("aria-pressed")).toBe("false");
    expect(problems).toEqual([]);
  });

  it("shows a picture in a picture slot as filling it, and writes a fit only when it differs", async () => {
    const { page, folder } = await openDeck("slot");
    await image(page, "slot-image").click();
    expect(await tool(page, "fill").getAttribute("aria-pressed")).toBe("true");
    await tool(page, "fill").click();
    await expect.poll(() => imageOn(folder, "slot", "slot-image")?.fit).toBe("contain");
    expect(await tool(page, "fill").getAttribute("aria-pressed")).toBe("false");
    await tool(page, "fill").click();
    await expect.poll(() => imageOn(folder, "slot", "slot-image")?.fit).toBeUndefined();
    expect(await tool(page, "fill").getAttribute("aria-pressed")).toBe("true");
    expect(problems).toEqual([]);
  });

  it("resets the fit, the crop and the focus in one step that Undo takes back whole", async () => {
    const { page, folder } = await openDeck("cover");
    await image(page, "cover-image").click();
    await tool(page, "reset").click();
    await expect.poll(() => imageOn(folder, "cover", "cover-image")?.fit).toBeUndefined();
    const reset = imageOn(folder, "cover", "cover-image");
    expect([reset?.fit, reset?.crop, reset?.focus]).toEqual([undefined, undefined, undefined]);
    await undo(page);
    await expect.poll(() => imageOn(folder, "cover", "cover-image")?.fit).toBe("cover");
    expect(imageOn(folder, "cover", "cover-image")?.focus).toEqual({ x: 50, y: 0 });
    expect(problems).toEqual([]);
  });
});

describe("crop mode", () => {
  it("opens on a double click with the whole file dimmed around the crop and a named handle on each edge and corner", async () => {
    const { page } = await openDeck("crop");
    await cropByDoubleClick(page, "crop-image");
    expect(
      await layer(page)
        .locator("[data-h]")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label"))),
    ).toEqual([
      "The picture inside the crop. Arrow keys move it.",
      "Top edge of the crop",
      "Top-right corner of the crop",
      "Right edge of the crop",
      "Bottom-right corner of the crop",
      "Bottom edge of the crop",
      "Bottom-left corner of the crop",
      "Left edge of the crop",
      "Top-left corner of the crop",
    ]);
    // The file is drawn whole, so it is larger than the window that is the crop (half of it each way).
    const file = await layer(page).locator(".ed-crop-file").boundingBox();
    const window = await layer(page).locator(".ed-crop-win").boundingBox();
    expect((file?.width ?? 0) / (window?.width ?? 1)).toBeCloseTo(2, 0);
    expect((file?.height ?? 0) / (window?.height ?? 1)).toBeCloseTo(2, 0);
    // The window stays where the picture was drawn.
    const drawn = await image(page, "crop-image").boundingBox();
    expect(Math.abs((window?.x ?? 0) - (drawn?.x ?? 0))).toBeLessThan(drawn ? drawn.width : 1);
    // A picture that does not fill its box has no focus point.
    expect(await part(page, "focus").count()).toBe(0);
    expect(await page.locator(".ed-crop-say").textContent()).toContain("Crop mode");
    expect(problems).toEqual([]);
  });

  it("opens from the Crop button too", async () => {
    const { page } = await openDeck("crop");
    await image(page, "crop-image").click();
    await tool(page, "crop").click();
    await layer(page).waitFor();
    // A second press is the same as Enter: it applies, and with nothing moved writes nothing.
    await tool(page, "crop").click();
    await layer(page).waitFor({ state: "detached" });
    expect(problems).toEqual([]);
  });

  it("drags a handle and applies it on Enter as one change that one Undo takes back", async () => {
    const { page, folder } = await openDeck("crop");
    expect(imageOn(folder, "crop", "crop-image")?.crop).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    await cropByDoubleClick(page, "crop-image");
    // The left edge moves right, so less of the picture shows; nothing is written until it is applied.
    await dragBy(page, part(page, "w"), 40, 0);
    expect(imageOn(folder, "crop", "crop-image")?.crop).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    await page.keyboard.press("Enter");
    await layer(page).waitFor({ state: "detached" });
    await expect.poll(() => imageOn(folder, "crop", "crop-image")?.crop?.w).toBeLessThan(50);
    const crop = imageOn(folder, "crop", "crop-image")?.crop;
    expect(crop?.x).toBeGreaterThan(50);
    expect(crop?.y).toBe(0);
    expect(crop?.h).toBe(50);
    expect((crop?.x ?? 0) + (crop?.w ?? 0)).toBeCloseTo(100, 5);
    await undo(page);
    await expect
      .poll(() => imageOn(folder, "crop", "crop-image")?.crop)
      .toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(problems).toEqual([]);
  });

  it("moves the picture under the crop when the inside is dragged", async () => {
    const { page, folder } = await openDeck("crop");
    await cropByDoubleClick(page, "crop-image");
    // Dragging the picture up shows more of its lower part, so the crop's y grows.
    await dragBy(page, layer(page).locator(".ed-crop-win"), 0, -30);
    await page.keyboard.press("Enter");
    await expect.poll(() => imageOn(folder, "crop", "crop-image")?.crop?.y).toBeGreaterThan(0);
    const crop = imageOn(folder, "crop", "crop-image")?.crop;
    expect([crop?.w, crop?.h]).toEqual([50, 50]);
    expect(problems).toEqual([]);
  });

  it("is cancelled by Escape with nothing written", async () => {
    const { page, folder } = await openDeck("crop");
    const before = sceneFile(folder, "crop");
    await cropByDoubleClick(page, "crop-image");
    await dragBy(page, part(page, "e"), -40, 0);
    await page.keyboard.press("Escape");
    await layer(page).waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    expect(sceneFile(folder, "crop")).toBe(before);
    expect(await page.locator(".ed-crop-say").textContent()).toBe("Crop canceled.");
    expect(problems).toEqual([]);
  });

  it("is applied by a click outside the crop", async () => {
    const { page, folder } = await openDeck("crop");
    await cropByDoubleClick(page, "crop-image");
    await part(page, "w").focus();
    await page.keyboard.press("Shift+ArrowRight");
    const slide = await page.locator(".ed-canvas-host").boundingBox();
    // The top left corner of the slide, far from the crop.
    await page.mouse.click((slide?.x ?? 0) + 4, (slide?.y ?? 0) + 4);
    await layer(page).waitFor({ state: "detached" });
    await expect
      .poll(() => imageOn(folder, "crop", "crop-image")?.crop)
      .toEqual({ x: 60, y: 0, w: 40, h: 50 });
    expect(problems).toEqual([]);
  });

  it("is driven from the keyboard: Tab between named handles, Shift with an arrow for a larger step, Enter to apply", async () => {
    const { page, folder } = await openDeck("crop");
    await image(page, "crop-image").click();
    await tool(page, "crop").focus();
    await page.keyboard.press("Enter");
    await layer(page).waitFor();
    // The keyboard starts on the window that holds the picture, and Tab goes round the handles.
    expect(await focusedName(page)).toBe("The picture inside the crop. Arrow keys move it.");
    const names: Array<string | null | undefined> = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      names.push(await focusedName(page));
    }
    expect(names).toEqual([
      "Top edge of the crop",
      "Top-right corner of the crop",
      "Right edge of the crop",
      "Bottom-right corner of the crop",
      "Bottom edge of the crop",
      "Bottom-left corner of the crop",
      "Left edge of the crop",
      "Top-left corner of the crop",
    ]);
    // On the top left corner: Shift and an arrow moves 10 percent, an arrow alone 1.
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowDown");
    expect(await page.locator(".ed-crop-say").textContent()).toBe(
      "Crop 40 by 49 percent, from 60 across and 1 down.",
    );
    await page.keyboard.press("Enter");
    await layer(page).waitFor({ state: "detached" });
    await expect
      .poll(() => imageOn(folder, "crop", "crop-image")?.crop)
      .toEqual({ x: 60, y: 1, w: 40, h: 49 });
    // The keyboard goes back to the picture.
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-id]")?.getAttribute("data-id")),
    ).toBe("crop-image");
    expect(problems).toEqual([]);
  });

  it("keeps a crop of at least 5 percent a side inside the file whatever is pressed", async () => {
    const { page, folder } = await openDeck("crop");
    await cropByDoubleClick(page, "crop-image");
    await part(page, "w").focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
    await part(page, "s").focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Enter");
    await expect.poll(() => imageOn(folder, "crop", "crop-image")?.crop).toEqual({ x: 95, y: 0, w: 5, h: 5 });
    expect(diskOf(folder).scenes.crop).toBeDefined();
    expect(problems).toEqual([]);
  });

  it("has a focus point on a picture that fills its box, applied with the crop in one step", async () => {
    const { page, folder } = await openDeck("cover");
    await cropByDoubleClick(page, "cover-image");
    const mark = part(page, "focus");
    expect(await mark.getAttribute("aria-label")).toBe("Focus point");
    await part(page, "e").focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await mark.focus();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await layer(page).waitFor({ state: "detached" });
    await expect.poll(() => imageOn(folder, "cover", "cover-image")?.focus).toEqual({ x: 51, y: 10 });
    expect(imageOn(folder, "cover", "cover-image")?.crop).toEqual({ x: 0, y: 0, w: 90, h: 100 });
    await undo(page);
    await expect.poll(() => imageOn(folder, "cover", "cover-image")?.focus).toEqual({ x: 50, y: 0 });
    expect(imageOn(folder, "cover", "cover-image")?.crop).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("drags the focus point, and shows none on a picture that is shown whole", async () => {
    const { page, folder } = await openDeck("cover");
    await cropByDoubleClick(page, "cover-image");
    await dragBy(page, part(page, "focus"), 0, 40);
    await page.keyboard.press("Enter");
    await expect.poll(() => imageOn(folder, "cover", "cover-image")?.focus?.y).toBeGreaterThan(0);
    await goTo(page, "contain");
    await cropByDoubleClick(page, "contain-image");
    expect(await part(page, "focus").count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(problems).toEqual([]);
  });

  it("is put away when another block is chosen, writing nothing", async () => {
    const { page, folder } = await openDeck("crop");
    const before = sceneFile(folder, "crop");
    await cropByDoubleClick(page, "crop-image");
    await part(page, "e").focus();
    await page.keyboard.press("ArrowLeft");
    // The scene strip is outside the crop, so choosing a scene applies it first: the crop is the person's.
    await goTo(page, "plain");
    await layer(page).waitFor({ state: "detached" });
    await expect.poll(() => sceneFile(folder, "crop")).not.toBe(before);
    expect(problems).toEqual([]);
  });
});

describe("resizing a pinned picture", () => {
  const frame = (folder: string) => imageOn(folder, "cover", "cover-image")?.frame;

  async function drag(page: Page, shift: boolean) {
    await image(page, "cover-image").click();
    const handle = page.locator(".ed-handle[data-handle='se']");
    const from = await centerOf(handle);
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Far more across than down: a free drag would stretch the box.
    for (const step of [0.5, 1]) await page.mouse.move(from.x + 120 * step, from.y + 4 * step);
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  }

  it("keeps the shape of its box, from a corner", async () => {
    const { page, folder } = await openDeck("cover");
    expect(frame(folder)).toEqual({ x: 5, y: 35, w: 40, h: 20 });
    await drag(page, false);
    await expect.poll(() => frame(folder)?.w).toBeGreaterThan(40);
    const now = frame(folder);
    expect((now?.w ?? 0) / (now?.h ?? 1)).toBeCloseTo(2, 1);
    expect([now?.x, now?.y]).toEqual([5, 35]);
    expect(problems).toEqual([]);
  });

  it("is freed by Shift", async () => {
    const { page, folder } = await openDeck("cover");
    await drag(page, true);
    await expect.poll(() => frame(folder)?.w).toBeGreaterThan(40);
    const now = frame(folder);
    expect((now?.w ?? 0) / (now?.h ?? 1)).toBeGreaterThan(2.1);
    expect(problems).toEqual([]);
  });

  it("leaves other blocks as free as before", async () => {
    const { page, folder } = await openDeck("cover");
    // Pin the heading where it is, then resize it from the corner with no Shift: only the picture keeps its shape.
    await page.locator(".ed-frame [data-id='cover-heading']").click();
    await page.locator(".ed-toolbar [data-tb='free']").click();
    await expect
      .poll(() => diskOf(folder).scenes.cover?.blocks.find((b) => b.id === "cover-heading")?.frame)
      .toBeDefined();
    const before = diskOf(folder).scenes.cover?.blocks.find((b) => b.id === "cover-heading")?.frame;
    const handle = page.locator(".ed-handle[data-handle='se']");
    const from = await centerOf(handle);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const step of [0.5, 1]) await page.mouse.move(from.x + 120 * step, from.y + 4 * step);
    await page.mouse.up();
    await expect
      .poll(() => diskOf(folder).scenes.cover?.blocks.find((b) => b.id === "cover-heading")?.frame?.w)
      .toBeGreaterThan(before?.w ?? 0);
    const after = diskOf(folder).scenes.cover?.blocks.find((b) => b.id === "cover-heading")?.frame;
    expect((after?.w ?? 0) / (after?.h ?? 1)).not.toBeCloseTo((before?.w ?? 1) / (before?.h ?? 1), 0);
    expect(problems).toEqual([]);
  });
});

describe("Fit box to picture", () => {
  it("is offered in the menu and the palette, and sets the box to the shape of the cropped picture", async () => {
    const { page, folder } = await openDeck("crop");
    expect(imageOn(folder, "crop", "crop-image")?.frame).toEqual({ x: 10, y: 30, w: 40, h: 50 });
    await image(page, "crop-image").click({ button: "right" });
    await page.locator(".ed-menu:not([hidden]) .ed-menu-item", { hasText: "Fit box to picture" }).click();
    // The file is a square and the crop takes half of each side, so the box is square: 40 percent across is 71.1 high,
    // which does not fit under y = 30, so both shrink to the 70 percent that is left.
    await expect
      .poll(() => imageOn(folder, "crop", "crop-image")?.frame)
      .toEqual({ x: 10, y: 30, w: 39.4, h: 70 });
    await undo(page);
    await expect
      .poll(() => imageOn(folder, "crop", "crop-image")?.frame)
      .toEqual({ x: 10, y: 30, w: 40, h: 50 });
    // The same from the palette.
    await image(page, "crop-image").click();
    await page.keyboard.press("Control+k");
    await page.locator(".ed-palette input").fill("fit box");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => imageOn(folder, "crop", "crop-image")?.frame)
      .toEqual({ x: 10, y: 30, w: 39.4, h: 70 });
    expect(problems).toEqual([]);
  });

  it("is not offered for a picture that is not pinned", async () => {
    const { page } = await openDeck("plain");
    await image(page, "plain-image").click({ button: "right" });
    await page.locator(".ed-menu:not([hidden])").waitFor();
    expect(await page.locator(".ed-menu-item", { hasText: "Fit box to picture" }).count()).toBe(0);
    expect(await page.locator(".ed-menu-item", { hasText: "Use as slide background" }).count()).toBe(1);
    expect(problems).toEqual([]);
  });
});

describe("the Decorative checkbox", () => {
  it("marks a picture decorative, keeps its alt text, and unmarks it", async () => {
    const { page, folder } = await openDeck("plain");
    await image(page, "plain-image").click();
    await tool(page, "edit").click();
    const box = page.locator("[data-field='image:decorative']");
    const alt = page.locator("[data-field='image:alt']");
    expect(await alt.isDisabled()).toBe(false);
    await box.check();
    await expect.poll(() => imageOn(folder, "plain", "plain-image")?.decorative).toBe(true);
    // The alt text waits, unchanged.
    expect(imageOn(folder, "plain", "plain-image")?.alt).toBe("A grid of nine colored squares");
    await expect.poll(() => alt.isDisabled()).toBe(true);
    await box.uncheck();
    await expect.poll(() => imageOn(folder, "plain", "plain-image")?.decorative).toBeUndefined();
    expect(await alt.isDisabled()).toBe(false);
    expect(await alt.inputValue()).toBe("A grid of nine colored squares");
    expect(problems).toEqual([]);
  });

  it("unmarks a picture with no alt text by starting its alt text as a name to write over", async () => {
    const { page, folder } = await openDeck("decorative");
    await image(page, "decorative-image").click();
    await tool(page, "edit").click();
    const box = page.locator("[data-field='image:decorative']");
    expect(await box.isChecked()).toBe(true);
    await box.click();
    // The schema asks for alt text on a picture that is not decorative, so the mark comes off with a placeholder that
    // the alt text field, no longer held, is there to replace. Nothing is refused, so the person is never stuck.
    await expect.poll(() => imageOn(folder, "decorative", "decorative-image")?.decorative).toBeUndefined();
    expect(imageOn(folder, "decorative", "decorative-image")?.alt).toBeTruthy();
    expect(await box.isChecked()).toBe(false);
    expect(await page.locator("[data-field='image:alt']").isDisabled()).toBe(false);
    expect(problems).toEqual([]);
  });
});

describe("a slide's background", () => {
  it("is made of a picture by Use as slide background: one step, and the picture comes back with Undo", async () => {
    const { page, folder } = await openDeck("plain");
    await image(page, "plain-image").click({ button: "right" });
    await page
      .locator(".ed-menu:not([hidden]) .ed-menu-item", { hasText: "Use as slide background" })
      .click();
    await expect
      .poll(() => diskOf(folder).scenes.plain?.background)
      .toEqual({
        asset: "assets/grid.png",
        scrim: 40,
        alt: "A grid of nine colored squares",
      });
    expect(diskOf(folder).scenes.plain?.blocks.map((block) => block.id)).toEqual(["plain-heading"]);
    await page.locator(".ed-frame .dc-backdrop").waitFor();
    await undo(page);
    await expect.poll(() => diskOf(folder).scenes.plain?.background).toBeUndefined();
    expect(diskOf(folder).scenes.plain?.blocks.map((block) => block.id)).toEqual([
      "plain-heading",
      "plain-image",
    ]);
    expect(problems).toEqual([]);
  });

  it("carries the decorative mark and the focus of the picture", async () => {
    const { page, folder } = await openDeck("decorative");
    await image(page, "decorative-image").click();
    await page.keyboard.press("Control+k");
    await page.locator(".ed-palette input").fill("slide background");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => diskOf(folder).scenes.decorative?.background)
      .toEqual({
        asset: "assets/grid.png",
        scrim: 40,
        decorative: true,
      });
    expect(problems).toEqual([]);
  });

  it("is taken off by Remove background, which only a slide with one lists", async () => {
    const { page, folder } = await openDeck("plain");
    await page.locator(".ed-frame [data-id='plain-heading']").click({ button: "right" });
    await page.locator(".ed-menu:not([hidden])").waitFor();
    expect(await page.locator(".ed-menu-item", { hasText: "Remove background" }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await goTo(page, "background");
    await page.locator(".ed-frame [data-id='background-heading']").click({ button: "right" });
    await page.locator(".ed-menu:not([hidden]) .ed-menu-item", { hasText: "Remove background" }).click();
    await expect.poll(() => diskOf(folder).scenes.background?.background).toBeUndefined();
    await undo(page);
    await expect.poll(() => diskOf(folder).scenes.background?.background?.asset).toBe("assets/grid.png");
    expect(problems).toEqual([]);
  });

  it("is set from the Background section of the Scene popover: file, scrim, color, alt text, and Remove", async () => {
    const { page, folder } = await openDeck("plain");
    const background = () => diskOf(folder).scenes.plain?.background;
    await page.locator(".ed-scene-tools [data-tb='scene']").click();
    await page.locator("details[data-section='background'] summary").click();
    const field = (name: string) => page.locator(`[data-field='bg:${name}']`);
    await field("asset").waitFor();
    expect(await field("scrim").count()).toBe(0);
    await field("asset").selectOption("assets/grid.png");
    // A new background is decorative until it is told otherwise, and sits under a 40 percent scrim.
    await expect.poll(background).toEqual({ asset: "assets/grid.png", scrim: 40, decorative: true });
    await field("scrim").fill("65");
    await expect.poll(() => background()?.scrim).toBe(65);
    await field("color").selectOption("surface");
    await expect.poll(() => background()?.color).toBe("surface");
    await field("color").selectOption("bg");
    await expect.poll(() => background()?.color).toBeUndefined();
    // Not decorative: the schema wants alt text, so it starts as a name to be written over.
    await field("decorative").uncheck();
    await expect.poll(() => background()?.decorative).toBeUndefined();
    expect(background()?.alt).toBeTruthy();
    await field("alt").fill("A grid of colored squares");
    await expect.poll(() => background()?.alt).toBe("A grid of colored squares");
    expect(await field("alt").isEnabled()).toBe(true);
    await field("remove").click();
    await expect.poll(background).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

describe("the same changes through depthcue apply", () => {
  it("write the same scene files: crop and focus, fit, decorative", async () => {
    const editor = await openDeck("cover");
    const { page } = editor;
    await cropByDoubleClick(page, "cover-image");
    await part(page, "e").focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await part(page, "focus").focus();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Enter");
    await layer(page).waitFor({ state: "detached" });
    await expect.poll(() => imageOn(editor.folder, "cover", "cover-image")?.crop).toBeDefined();
    await image(page, "cover-image").click();
    await tool(page, "fill").click();
    // It already filled its box, so pressing it again clears the fit instead of writing "contain".
    await expect.poll(() => imageOn(editor.folder, "cover", "cover-image")?.fit).toBeUndefined();
    await tool(page, "edit").click();
    await page.locator("[data-field='image:decorative']").check();
    await expect.poll(() => imageOn(editor.folder, "cover", "cover-image")?.decorative).toBe(true);

    const agent = agentDeck();
    applyTo(agent, [
      {
        op: "block.set",
        scene: "cover",
        id: "cover-image",
        set: { crop: { x: 0, y: 0, w: 90, h: 100 }, focus: { x: 50, y: 10 } },
      },
    ]);
    applyTo(agent, [{ op: "block.set", scene: "cover", id: "cover-image", set: { fit: null } }]);
    applyTo(agent, [{ op: "block.set", scene: "cover", id: "cover-image", set: { decorative: true } }]);
    expect(sceneFile(editor.folder, "cover")).toBe(sceneFile(agent, "cover"));
    expect(problems).toEqual([]);
  });

  it("write the same scene file when a picture becomes the background", async () => {
    const editor = await openDeck("plain");
    const { page } = editor;
    await image(page, "plain-image").click({ button: "right" });
    await page
      .locator(".ed-menu:not([hidden]) .ed-menu-item", { hasText: "Use as slide background" })
      .click();
    await expect.poll(() => diskOf(editor.folder).scenes.plain?.background).toBeDefined();
    const agent = agentDeck();
    applyTo(agent, [
      {
        op: "scene.set",
        id: "plain",
        set: { background: { asset: "assets/grid.png", scrim: 40, alt: "A grid of nine colored squares" } },
      },
      { op: "block.remove", scene: "plain", id: "plain-image" },
    ]);
    expect(sceneFile(editor.folder, "plain")).toBe(sceneFile(agent, "plain"));
    expect(readFileSync(join(editor.folder, "deck.json"), "utf8")).toBe(
      readFileSync(join(agent, "deck.json"), "utf8"),
    );
    expect(problems).toEqual([]);
  });

  it("write the same scene file for a background set in the Scene popover", async () => {
    const editor = await openDeck("plain");
    const { page } = editor;
    await page.locator(".ed-scene-tools [data-tb='scene']").click();
    await page.locator("details[data-section='background'] summary").click();
    await page.locator("[data-field='bg:asset']").selectOption("assets/grid.png");
    await expect.poll(() => diskOf(editor.folder).scenes.plain?.background).toBeDefined();
    await page.locator("[data-field='bg:scrim']").fill("55");
    await expect.poll(() => diskOf(editor.folder).scenes.plain?.background?.scrim).toBe(55);
    await page.locator("[data-field='bg:color']").selectOption("text");
    await expect.poll(() => diskOf(editor.folder).scenes.plain?.background?.color).toBe("text");
    const agent = agentDeck();
    applyTo(agent, [
      {
        op: "scene.set",
        id: "plain",
        set: { background: { asset: "assets/grid.png", scrim: 55, decorative: true, color: "text" } },
      },
    ]);
    expect(sceneFile(editor.folder, "plain")).toBe(sceneFile(agent, "plain"));
    expect(problems).toEqual([]);
  });
});

/** The screens the reviewer looks at, written outside the repository when DEPTHCUE_SHOTS names a folder. */
describe.skipIf(!process.env.DEPTHCUE_SHOTS)("screenshots", () => {
  const out = process.env.DEPTHCUE_SHOTS as string;
  const shot = async (page: Page, name: string) => {
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, `${name}.png`) });
  };

  it("photographs the toolbar, crop mode, the committed crop, the Background section and the menus", async () => {
    const big = { width: 1440, height: 900 };
    const { page, folder } = await openDeck("crop", big);
    await image(page, "crop-image").click();
    await shot(page, "1-toolbar");
    await cropByDoubleClick(page, "crop-image");
    await shot(page, "2-crop-mode");
    await page.keyboard.press("Enter");
    await layer(page).waitFor({ state: "detached" });
    await shot(page, "3-after-commit");
    await goTo(page, "cover");
    await cropByDoubleClick(page, "cover-image");
    await shot(page, "2b-crop-mode-focus");
    await page.keyboard.press("Escape");
    await goTo(page, "plain");
    await image(page, "plain-image").click({ button: "right" });
    await page.locator(".ed-menu:not([hidden])").waitFor();
    await shot(page, "6-menu");
    await page.keyboard.press("Escape");
    await image(page, "plain-image").click();
    await tool(page, "edit").click();
    await shot(page, "7-edit-popover");
    await page.mouse.click(5, 5);
    await page.locator(".ed-scene-tools [data-tb='scene']").click();
    await page.locator("details[data-section='background'] summary").click();
    await page.locator("[data-field='bg:asset']").selectOption("assets/grid.png");
    await page.locator("[data-field='bg:scrim']").fill("55");
    await page.locator("[data-field='bg:decorative']").uncheck();
    await page.locator("[data-field='bg:alt']").fill("A grid of nine colored squares");
    await expect.poll(() => diskOf(folder).scenes.plain?.background?.scrim).toBe(55);
    await shot(page, "4-background-section");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await shot(page, "5-slide-with-background");

    const small = { width: 1024, height: 768 };
    const narrow = await openDeck("crop", small);
    await cropByDoubleClick(narrow.page, "crop-image");
    await shot(narrow.page, "2-crop-mode-1024");
    await narrow.page.keyboard.press("Escape");
    await goTo(narrow.page, "plain");
    await narrow.page.locator(".ed-scene-tools [data-tb='scene']").click();
    await narrow.page.locator("details[data-section='background'] summary").click();
    await narrow.page.locator("[data-field='bg:asset']").selectOption("assets/grid.png");
    await expect.poll(() => diskOf(narrow.folder).scenes.plain?.background).toBeDefined();
    await shot(narrow.page, "4-background-section-1024");
    expect(problems).toEqual([]);
  });
});
