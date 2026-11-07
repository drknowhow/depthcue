import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * The image library in a real Chrome: opened from the quick bar, a picture added and another put in place of the
 * image from the Edit popover, a used file that cannot be deleted, an unused one that can, and Undo. What these assert
 * is structure (which rows, which buttons, what the saved files say) and not how large the text is drawn.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

const NO_LAYOUT: LayoutChecker = {
  async check() {
    return { available: false, message: "Layout checks are off in this test." };
  },
  async close() {},
};

const svg = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#468"/></svg>`;

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let folder: string;
let server: RunningServer;
let context: BrowserContext;
let page: Page;
let problems: string[];

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
  root = mkdtempSync(join(tmpdir(), "depthcue-library-e2e-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  writeFileSync(join(folder, "assets", "other.svg"), svg(40, 30));
  writeFileSync(join(folder, "assets", "spare.svg"), svg(60, 20));
  problems = [];
  server = await startServer({
    folder,
    playerDir: builtPlayerDir(),
    editorDir: builtEditorDir(),
    port: 0,
    layout: NO_LAYOUT,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(server.url);
  await page.locator(".ed-frame [data-id='opening-title']").waitFor();
  await page.locator(".ed-scene").nth(2).click();
  await picture().waitFor();
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

const picture = () => page.locator(".ed-frame [data-id='method-diagram']");
const library = () => page.locator("[data-library]");
const row = (asset: string) => page.locator(`.ed-lib-row[data-asset='${asset}']`);
const assetsOnDisk = () => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return (
    loaded.doc.scenes.method?.blocks.flatMap((block) => (block.type === "image" ? [block.asset] : [])) ?? []
  );
};
const openFromQuickBar = async () => {
  await page.locator(".ed-quick [data-quick='insert']").click();
  await page.locator(".ed-quick label.ed-button", { hasText: "Image" }).click();
  await library().waitFor();
};

describe("the image library in a real browser", () => {
  it("opens from the quick bar with every picture, and inserts an existing one that Undo takes away", async () => {
    expect(assetsOnDisk()).toEqual(["assets/method.svg"]);
    await openFromQuickBar();
    expect(await library().getAttribute("data-library")).toBe("add");
    expect(
      await page
        .locator(".ed-lib-row")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.asset)),
    ).toEqual(["assets/method.svg", "assets/other.svg", "assets/spare.svg"]);
    // Each row has a thumbnail that is told to wait until it is near, and a name for a screen reader.
    expect(await row("assets/other.svg").locator("img").getAttribute("loading")).toBe("lazy");
    expect(await row("assets/other.svg").locator(".ed-lib-pick").getAttribute("aria-label")).toContain(
      "other.svg",
    );
    expect(await row("assets/method.svg").textContent()).toContain("Used on 1 slide");
    expect(await row("assets/other.svg").textContent()).toContain("Not used");

    await row("assets/other.svg").locator(".ed-lib-pick").click();
    await library().waitFor({ state: "hidden" });
    await expect.poll(assetsOnDisk).toEqual(["assets/method.svg", "assets/other.svg"]);

    await page.keyboard.press("Control+z");
    await expect.poll(assetsOnDisk).toEqual(["assets/method.svg"]);
    expect(problems).toEqual([]);
  });

  it("replaces the chosen image from the Edit popover, and Undo puts the old file back", async () => {
    await picture().click();
    await page.locator(".ed-toolbar [data-tb='edit']").click();
    await page.getByRole("button", { name: "Choose from library" }).click();
    await library().waitFor();
    expect(await library().getAttribute("data-library")).toBe("replace");
    await row("assets/spare.svg").locator(".ed-lib-pick").click();
    await library().waitFor({ state: "hidden" });
    await expect.poll(assetsOnDisk).toEqual(["assets/spare.svg"]);
    // The old picture is no longer named by the saved deck.
    await expect.poll(() => picture().locator("img").getAttribute("src")).toContain("spare.svg");

    await page.keyboard.press("Control+z");
    await expect.poll(assetsOnDisk).toEqual(["assets/method.svg"]);
    expect(problems).toEqual([]);
  });

  it("will not delete a file the deck uses, and deletes one nothing uses", async () => {
    await openFromQuickBar();
    // The editor does not offer Delete for a used file, and the server refuses it when asked anyway.
    expect(await row("assets/method.svg").locator(".ed-lib-del").count()).toBe(0);
    const refused = await page.evaluate(async () => {
      const token = document.querySelector<HTMLMetaElement>("meta[name='depthcue-token']")?.content ?? "";
      const response = await fetch("/_depthcue/api/asset/remove?asset=assets%2Fmethod.svg", {
        method: "POST",
        headers: { "X-Depthcue-Token": token },
      });
      return { status: response.status, body: (await response.json()) as { message: string } };
    });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("method.svg");
    expect(existsSync(join(folder, "assets", "method.svg"))).toBe(true);

    // The question is asked inside the popover, and Keep leaves the file alone.
    await row("assets/spare.svg").locator(".ed-lib-del").click();
    expect(await row("assets/spare.svg").textContent()).toContain("Delete spare.svg?");
    await row("assets/spare.svg").getByRole("button", { name: "Keep" }).click();
    expect(existsSync(join(folder, "assets", "spare.svg"))).toBe(true);

    await row("assets/spare.svg").locator(".ed-lib-del").click();
    await row("assets/spare.svg").getByRole("button", { name: "Delete spare.svg for good" }).click();
    await row("assets/spare.svg").waitFor({ state: "detached" });
    expect(existsSync(join(folder, "assets", "spare.svg"))).toBe(false);
    expect(await page.locator(".ed-lib-row").count()).toBe(2);
    expect(await library().isVisible()).toBe(true);
    // The one console error is the browser noting the 409 that this test asked for.
    expect(problems).toEqual([
      "console: Failed to load resource: the server responded with a status of 409 (Conflict)",
    ]);
  });

  it("closes on Escape and gives the keyboard back to the Insert menu the Image button is in", async () => {
    await openFromQuickBar();
    await page.keyboard.press("Escape");
    await library().waitFor({ state: "hidden" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-quick"))).toBe("insert");
  });
});
