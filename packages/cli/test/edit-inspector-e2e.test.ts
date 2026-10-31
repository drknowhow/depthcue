import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDoc } from "@depthcue/core";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

/** A real 1x1 PNG, so the server's content sniffing accepts it. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
  root = mkdtempSync(join(tmpdir(), "depthcue-inspector-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({ folder, playerDir: builtPlayerDir(), editorDir: builtEditorDir(), port: 0 });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const read = (locator: Locator) => locator.evaluate((node) => node.textContent ?? "");
const disk = () => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
const field = (key: string) => page.locator(`[data-field="${key}"]`);
const scene = (id: string) => page.locator(`.ed-scene[data-scene="${id}"]`);
/** Waits for the bar to say the deck is saved. A text match would also match "Unsaved changes". */
const saved = () => page.locator(".ed-status[data-state='saved']").waitFor();

async function open() {
  await page.goto(server.url);
  await page.locator(".ed-frame").waitFor();
  // The details panel starts closed; these tests work in it.
  await page.locator("[data-action='details']").click();
}

async function save() {
  await page.keyboard.press("Control+s");
  await saved();
}

const sceneOrder = () => disk().deck.scenes;
const blocksOnDisk = (id: string) => disk().scenes[id]?.blocks ?? [];

describe("the inspector in a real browser", () => {
  it("adds a scene, renames it in the inspector, and saves a deck that validates", async () => {
    await open();
    await page.locator("[data-field='rail:layout']").selectOption("text-media");
    await page.getByRole("button", { name: "Add scene" }).click();
    await scene("new-scene").waitFor();
    expect(await page.locator(".ed-scene").count()).toBe(4);
    expect(await scene("new-scene").getAttribute("aria-current")).toBe("true");

    await field("scene:title").fill("The follow-up");
    await save();
    expect(sceneOrder()).toEqual(["opening", "new-scene", "demand", "method"]);
    expect(disk().scenes["new-scene"]).toMatchObject({ title: "The follow-up", layout: "text-media" });
    expect(problems).toEqual([]);
  });

  it("reorders scenes with the buttons and by dragging, and undoes", async () => {
    await open();
    await field("scene:down").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".ed-scene")[1]?.getAttribute("data-scene") === "opening",
    );
    await page.keyboard.press("Control+z");
    await page.waitForFunction(
      () => document.querySelectorAll(".ed-scene")[0]?.getAttribute("data-scene") === "opening",
    );

    await page
      .locator(".ed-scene-list > li")
      .nth(0)
      .dragTo(page.locator(".ed-scene-list > li").nth(2), {
        targetPosition: { x: 20, y: 40 },
      });
    await page.waitForFunction(
      () => document.querySelectorAll(".ed-scene")[2]?.getAttribute("data-scene") === "opening",
    );
    await save();
    expect(sceneOrder()).toEqual(["demand", "method", "opening"]);
    expect(problems).toEqual([]);
  });

  it("edits a chart value from the inspector and shows it on the slide and on disk", async () => {
    await open();
    await scene("demand").click();
    await page.locator(".ed-frame [data-id='chart-demand']").click();
    await field("block:chart-demand:row1:value").waitFor();
    await field("block:chart-demand:row1:value").fill("75");
    expect(await read(page.locator(".ed-frame .dc-chart"))).toContain("75%");
    await field("block:chart-demand:addrow").click();
    await field("block:chart-demand:row2:label").fill("Channel C");
    await field("block:chart-demand:row2:value").fill("12.5");
    await save();
    const chart = blocksOnDisk("demand").find((block) => block.id === "chart-demand");
    expect(chart?.type === "bar-chart" && chart.data).toEqual([
      { label: "Channel A", value: 40 },
      { label: "Channel B", value: 75 },
      { label: "Channel C", value: 12.5 },
    ]);
    expect(problems).toEqual([]);
  });

  it("adds, edits, moves and removes a block, keeping the claim and steps valid", async () => {
    await open();
    await scene("demand").click();
    await page.getByRole("button", { name: "Add text" }).click();
    await field("block:demand-text:text").fill("A note about the chart.");
    expect(await read(page.locator(".ed-frame [data-id='demand-text']"))).toBe("A note about the chart.");
    await field("up:demand-text").click();
    await page.getByRole("button", { name: "Remove Chart: Share of orders, latest quarter" }).click();
    await save();
    const demand = disk().scenes.demand;
    expect(demand?.blocks.map((block) => block.id)).toEqual(["demand-text"]);
    expect(demand?.summary?.evidenceIds).toEqual([]);
    expect(demand?.steps).toEqual([{ id: "show-claim", reveal: ["claim-shift"] }]);
    expect(problems).toEqual([]);
  });

  it("uploads an image, uses it as a new block, and the picture really loads", async () => {
    await open();
    await scene("method").click();
    await field("add:image").setInputFiles({ name: "Pixel.png", mimeType: "image/png", buffer: PIXEL });
    const added = page.locator(".ed-frame figure img[src*='pixel-']");
    await added.waitFor();
    expect(
      await added.evaluate(
        (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth,
      ),
    ).toBe(1);
    await save();
    const image = blocksOnDisk("method").at(-1);
    expect(image?.type).toBe("image");
    const asset = image?.type === "image" ? image.asset : "";
    expect(asset).toMatch(/^assets\/pixel-[0-9a-f]{8}\.png$/);
    expect(readdirSync(join(folder, "assets"))).toContain(asset.replace("assets/", ""));
    expect(problems).toEqual([]);
  });

  it("refuses a file that is not an image, and says why", async () => {
    await open();
    await scene("method").click();
    await field("add:image").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    const message = page.locator(".ed-inspector-problem:not([hidden])");
    await message.waitFor();
    expect(await read(message)).toMatch(/\S/);
    expect(blocksOnDisk("method")).toHaveLength(3);
    expect(await page.locator(".ed-frame figure img[src*='notes']").count()).toBe(0);
    // The refused upload is a handled answer from the server, not a script error.
    expect(problems.filter((line) => line.startsWith("pageerror"))).toEqual([]);
  });

  it("shows the core's message under a field it refuses, and keeps the deck as it was", async () => {
    await open();
    await field("scene:title").fill("");
    const input = field("scene:title");
    expect(await input.getAttribute("aria-invalid")).toBe("true");
    const message = page.locator(".ed-field:has([data-field='scene:title']) .ed-problem");
    expect(await read(message)).toMatch(/\S/);
    expect(await page.locator(".ed-status[data-state='saved']").count()).toBe(1);
    await input.blur();
    expect(await input.inputValue()).toBe("Why channel B now leads");
    expect(problems).toEqual([]);
  });

  it("adds a step and a source, and the saved deck passes its own checks", async () => {
    await open();
    await scene("demand").click();
    await page.locator("[data-section='steps'] summary").click();
    await field("step:add").click();
    await page.locator("[data-section='sources'] summary").click();
    await field("source:add").click();
    await field("source:demand-source:title").fill("Raw export");
    await field("source:demand-source:url").fill("https://example.com/raw");
    await page
      .locator(".ed-field:has([data-field='source:demand-source:url']) .ed-problem")
      .waitFor({ state: "hidden" });
    await save();
    const demand = disk().scenes.demand;
    expect(demand?.steps).toHaveLength(3);
    expect(demand?.sources?.map((source) => source.title)).toEqual([
      "Quarterly order snapshot",
      "Raw export",
    ]);
    expect(demand?.sources?.[1]?.url).toBe("https://example.com/raw");
    expect(problems).toEqual([]);
  });

  it("changes the deck theme and language from the inspector", async () => {
    await open();
    await page.locator("[data-section='deck'] summary").click();
    await field("deck:theme").selectOption("ink");
    expect(await page.locator(".ed-frame").getAttribute("data-theme")).toBe("ink");
    await field("deck:language").fill("pt-BR");
    await save();
    expect(disk().deck).toMatchObject({ theme: "ink", language: "pt-BR" });
    expect(problems).toEqual([]);
  });

  it("keeps working on a phone: the forms sit under the slide and nothing overflows sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    const sizes = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      slide: document.querySelector(".ed-main")?.getBoundingClientRect().bottom ?? 0,
      form: document.querySelector(".ed-inspector")?.getBoundingClientRect().top ?? 0,
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
    expect(sizes.form).toBeGreaterThanOrEqual(sizes.slide - 1);
    await field("scene:title").scrollIntoViewIfNeeded();
    await field("scene:title").fill("Phone edit");
    expect(await read(page.locator(".ed-scene").first())).toContain("Phone edit");
    expect(problems).toEqual([]);
  });
});
