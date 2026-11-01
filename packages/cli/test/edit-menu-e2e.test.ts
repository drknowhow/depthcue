import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDoc } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * The right-click menu and the keys that go with it, in a real Chrome. The unit tests of the editor cover the menu in
 * a fake DOM; these check what only a browser does: the contextmenu event of a real right-click, the keys that open the
 * menu, and a block copied in one deck's editor and pasted into another's through the system clipboard.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

/** A server with no browser to render in. None of these tests is about layout, and none needs a second Chrome. */
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
  root = mkdtempSync(join(tmpdir(), "depthcue-menu-e2e-"));
  decks = [];
  problems = [];
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
});

afterEach(async () => {
  await context?.close();
  for (const deck of decks ?? []) await deck.server.close();
  rmSync(root, { recursive: true, force: true });
});

/** Gives the picture of the method scene a file that only this deck has, so another deck cannot take the picture. */
function withOwnPicture(folder: string) {
  cpSync(join(folder, "assets", "method.svg"), join(folder, "assets", "only-here.svg"));
  const file = join(folder, "scenes", "method.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("assets/method.svg", "assets/only-here.svg"));
}

/** Another copy of the demo deck, served by an editor of its own, in a page of its own. */
async function openDeck(prepare?: (folder: string) => void): Promise<Deck> {
  const folder = join(root, `deck-${decks.length}`);
  cpSync(demo, folder, { recursive: true });
  prepare?.(folder);
  const server = await startServer({
    folder,
    playerDir: builtPlayerDir(),
    editorDir: builtEditorDir(),
    port: 0,
    layout: NO_LAYOUT,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(server.url);
  await page.locator(".ed-frame [data-id='opening-title']").waitFor();
  const deck = { folder, server, page };
  decks.push(deck);
  return deck;
}

const diskOf = (deck: Deck) => {
  const loaded = loadDoc(loadDeckDir(deck.folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
const blocksOf = (deck: Deck, scene: string) => diskOf(deck).scenes[scene]?.blocks ?? [];
const kindsOf = (deck: Deck, scene: string) => blocksOf(deck, scene).map((block) => block.type);

/** Opens a scene of the strip by its number, from 1. */
async function goTo(page: Page, number: number) {
  await page
    .locator(".ed-scene")
    .nth(number - 1)
    .click();
}

const menu = (page: Page) => page.locator(".ed-menu:not(.ed-menu-sub)");
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const picture = (page: Page) => page.locator(".ed-frame [data-id='method-diagram']");

/**
 * Records, for the next right-click, whether the page asked the browser to keep its own menu away. It listens on
 * the document, after the editor has had its turn, so what it sees is what the browser would act on.
 */
async function watchContextMenu(page: Page) {
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { __prevented: boolean[] }).__prevented = seen;
    document.addEventListener("contextmenu", (event) => seen.push(event.defaultPrevented));
  });
}
const prevented = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented);

describe("the right-click menu in a real browser", () => {
  it("opens on a right-click over a block, and Duplicate puts a second block in the scene file", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await goTo(page, 3);
    await picture(page).waitFor();
    expect(kindsOf(deck, "method")).toEqual(["text", "text", "image"]);

    await watchContextMenu(page);
    await picture(page).click({ button: "right" });
    await menu(page).waitFor();
    expect(await menu(page).getAttribute("aria-label")).toBe("Block menu");
    expect(await prevented(page)).toEqual([true]);
    // The block that was pointed at is the chosen one, and the menu lists what the palette would for it.
    expect(await page.locator(".ed-frame [data-selected]").getAttribute("data-id")).toBe("method-diagram");
    expect(await menuItem(page, "Cut").count()).toBe(1);

    await menuItem(page, "Duplicate").click();
    await menu(page).waitFor({ state: "hidden" });
    await expect.poll(() => kindsOf(deck, "method")).toEqual(["text", "text", "image", "image"]);
    const ids = blocksOf(deck, "method").map((block) => block.id);
    expect(new Set(ids).size).toBe(4);
    expect(problems).toEqual([]);

    // One Undo takes the copy away again.
    await page.keyboard.press("Control+z");
    await expect.poll(() => kindsOf(deck, "method")).toEqual(["text", "text", "image"]);
  });

  it("opens on Shift+F10 over the focused block, and Enter runs the item the arrows chose", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await goTo(page, 3);
    await picture(page).focus();

    await page.keyboard.press("Shift+F10");
    await menu(page).waitFor();
    expect(await menu(page).getAttribute("aria-label")).toBe("Block menu");
    // The keyboard is in the menu, on its first item.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("menuitem");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Cut");

    // Cut, Copy, Paste, then Duplicate.
    for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Duplicate");
    await page.keyboard.press("Enter");
    await menu(page).waitFor({ state: "hidden" });
    await expect.poll(() => kindsOf(deck, "method")).toEqual(["text", "text", "image", "image"]);

    // The same menu opens from the Menu key, and Esc puts the keyboard back on the block.
    await picture(page).focus();
    await page.keyboard.press("ContextMenu");
    await menu(page).waitFor();
    await page.keyboard.press("Escape");
    await menu(page).waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-id"))).toBe("method-diagram");
    expect(problems).toEqual([]);
  });

  it("copies a block in one deck's editor and pastes it into another's, which saves it to its own folder", async () => {
    const first = await openDeck();
    const second = await openDeck();
    const before = JSON.stringify(blocksOf(second, "method"));

    // The chart of the first deck, chosen and copied with the keys.
    await first.page.bringToFront();
    await goTo(first.page, 2);
    await first.page.locator(".ed-frame [data-id='chart-demand']").click();
    await first.page.keyboard.press("Control+c");

    // The second deck gets it after a block that is chosen there, with the keys too.
    await second.page.bringToFront();
    await goTo(second.page, 3);
    await second.page.locator(".ed-frame [data-id='method-diagram']").click();
    await second.page.keyboard.press("Control+v");

    await expect.poll(() => kindsOf(second, "method")).toEqual(["text", "text", "image", "bar-chart"]);
    const pasted = blocksOf(second, "method").find((block) => block.type === "bar-chart");
    expect(pasted?.type === "bar-chart" && pasted.data.map((row) => row.label)).toEqual([
      "Channel A",
      "Channel B",
    ]);
    // It has an id of its own in the scene it is in, and keeps no source that scene does not have.
    expect(pasted?.id).toBe("chart-demand-copy");
    expect(pasted?.sourceIds).toBeUndefined();
    // The deck it came from is as it was, and so is the rest of the one it went to.
    expect(kindsOf(first, "demand")).toEqual(["bar-chart"]);
    expect(JSON.stringify(blocksOf(second, "method").slice(0, 3))).toBe(before);
    expect(problems).toEqual([]);
  });

  it("copies and pastes through the menu as well, and Paste here pins the block where the pointer was", async () => {
    const first = await openDeck();
    const second = await openDeck();

    await first.page.bringToFront();
    await goTo(first.page, 3);
    await picture(first.page).click({ button: "right" });
    await menuItem(first.page, "Copy").click();
    await menu(first.page).waitFor({ state: "hidden" });
    await expect.poll(() => first.page.evaluate(() => navigator.clipboard.readText())).toContain("Diagram");

    await second.page.bringToFront();
    // The title slide has an area for its text only, so four fifths of the way down is the slide, and no area.
    const slide = second.page.locator(".ed-canvas-host .dc-view");
    const box = await slide.boundingBox();
    if (!box) throw new Error("the slide should have a box");
    await second.page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8, { button: "right" });
    await menu(second.page).waitFor();
    expect(await menu(second.page).getAttribute("aria-label")).toBe("Slide menu");
    await menuItem(second.page, "Paste here").click();
    await expect.poll(() => kindsOf(second, "opening")).toEqual(["text", "text", "image"]);
    const pasted = blocksOf(second, "opening").find((block) => block.type === "image");
    expect(pasted?.id).toBe("method-diagram-copy");
    // Centered on the pointer across the slide, and as far up from the foot as the margin a projector cuts allows.
    const frame = pasted?.frame;
    expect(frame).toMatchObject({ w: 40, h: 40, y: 56 });
    expect(Math.abs((frame?.x ?? 0) + 20 - 50)).toBeLessThan(0.6);
    expect(problems).toEqual([]);
  });

  it("refuses an image whose file the other deck does not have, and says why", async () => {
    const first = await openDeck(withOwnPicture);
    const second = await openDeck();

    await first.page.bringToFront();
    await goTo(first.page, 3);
    await picture(first.page).click();
    await first.page.keyboard.press("Control+c");

    await second.page.bringToFront();
    await goTo(second.page, 3);
    await picture(second.page).click();
    await second.page.keyboard.press("Control+v");
    await expect
      .poll(() => second.page.locator(".ed-hint").textContent())
      .toContain("assets/only-here.svg, which is not in this deck");
    // Nothing was pasted, in the editor or in the folder.
    expect(await second.page.locator(".ed-frame [data-id='method-diagram']").count()).toBe(1);
    expect(kindsOf(second, "method")).toEqual(["text", "text", "image"]);
  });

  it("keeps the browser's own menu over text that is being typed in, and takes the right-click otherwise", async () => {
    const deck = await openDeck();
    const { page } = deck;
    const headline = page.locator(".ed-frame [data-id='opening-title']");
    await watchContextMenu(page);

    // Typing in the headline: its right-click is the browser's, which has the spelling suggestions.
    await headline.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" now");
    await headline.click({ button: "right" });
    expect(await menu(page).isHidden()).toBe(true);
    expect(await prevented(page)).toEqual([false]);

    // Shift+F10 in the same text is the browser's too.
    await page.keyboard.press("Shift+F10");
    expect(await menu(page).isHidden()).toBe(true);

    // The caret is somewhere else, so a right-click on the headline is a right-click on a block.
    await page.locator(".ed-scene").nth(1).click();
    await page.locator(".ed-scene").nth(0).click();
    await headline.click({ button: "right" });
    await menu(page).waitFor();
    expect((await prevented(page)).at(-1)).toBe(true);
    expect(await page.locator(".ed-frame [data-selected]").getAttribute("data-id")).toBe("opening-title");
    expect(problems).toEqual([]);
  });

  it("opens on a scene of the strip, moves that scene, and puts the keyboard back on it with Esc", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await page.locator(".ed-scene-list > li[data-id='opening']").click({ button: "right" });
    await menu(page).waitFor();
    expect(await menu(page).getAttribute("aria-label")).toBe("Scene menu");
    expect(await menuItem(page, "Move later").count()).toBe(1);
    // The first scene has nowhere earlier to go.
    expect(await menuItem(page, "Move earlier").count()).toBe(0);
    await menuItem(page, "Move later").click();
    await expect.poll(() => diskOf(deck).deck.scenes).toEqual(["demand", "opening", "method"]);

    await page.locator(".ed-scene-list > li[data-id='method']").click({ button: "right" });
    await menu(page).waitFor();
    await page.keyboard.press("Escape");
    await menu(page).waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-scene"))).toBe("method");
    expect(problems).toEqual([]);
  });

  it("adds to the empty slide from its menu, and lists the same things as the palette", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await goTo(page, 3);
    const view = page.locator(".ed-canvas-host .dc-view");
    const box = await view.boundingBox();
    if (!box) throw new Error("the slide should have a box");
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8, { button: "right" });
    await menu(page).waitFor();
    expect(await menu(page).getAttribute("aria-label")).toBe("Slide menu");
    const inMenu = await menu(page)
      .locator("[data-command]")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.command));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.locator(".ed-palette-option").first().waitFor();
    const inPalette = await page
      .locator(".ed-palette-option")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.command));
    for (const id of inMenu) expect(inPalette).toContain(id);
    await page.keyboard.press("Escape");

    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8, { button: "right" });
    await menuItem(page, "Add a chart here").click();
    await expect.poll(() => kindsOf(deck, "method")).toContain("chart");
    expect(problems).toEqual([]);
  });
});
