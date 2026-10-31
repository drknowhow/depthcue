import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let folder: string;
let server: RunningServer;
let context: BrowserContext;
let page: Page;
let problems: string[];
let requested: string[];

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "chart.js")))
      throw new Error("The player is not built. Run pnpm build.");
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
  root = mkdtempSync(join(tmpdir(), "depthcue-chart-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  requested = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
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

const rows = () => page.locator(".dc-chart tbody tr");
const readout = () => page.locator(".dc-chart-readout");
const state = () => page.locator("[data-id='chart-demand']").getAttribute("data-module-state");
const names = () => rows().evaluateAll((all) => all.map((row) => row.querySelector("th")?.textContent));
const chartChunkRequested = () => requested.some((path) => path.endsWith("/chart.js"));

/** Opens the demand scene with every step shown, and waits for the chart's module to finish. */
async function openDemand() {
  await page.goto(`${server.url}#/demand/2`);
  await page.locator(".dc-chart").waitFor();
  await page.evaluate(() =>
    (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled(),
  );
}

describe("the chart module in a real browser", () => {
  it("is not downloaded until a scene with a chart is shown, and then hydrates", async () => {
    await page.goto(server.url);
    await page.locator(".dc-scene[data-scene='opening']").waitFor();
    await page.evaluate(() =>
      (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled(),
    );
    expect(chartChunkRequested()).toBe(false);

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.querySelector(".dc-scene")?.getAttribute("data-scene") === "demand",
    );
    await page.evaluate(() =>
      (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled(),
    );
    expect(chartChunkRequested()).toBe(true);
    expect(await state()).toBe("hydrated");
    expect(await page.locator(".dc-chart-tools [data-chart='sort']").count()).toBe(1);
    expect(problems).toEqual([]);
  });

  it("is settled only once a slow observer has reported, however busy the machine is", async () => {
    // A loaded machine can deliver the first report of what is in view late. Delay it by far more than a frame.
    await page.addInitScript(() => {
      const Real = window.IntersectionObserver;
      window.IntersectionObserver = class extends Real {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          super((entries, observer) => setTimeout(() => callback(entries, observer), 400), options);
        }
      };
    });
    await openDemand();
    expect(await state()).toBe("hydrated");
    expect(await page.locator(".dc-chart-tools").count()).toBe(1);
    expect(problems).toEqual([]);
  });

  it("marks a row under the pointer and reads out its value and rank", async () => {
    await openDemand();
    await rows().nth(1).hover();
    expect(await readout().textContent()).toBe("Channel B: 60%. 1st of 2.");
    expect(await rows().nth(1).getAttribute("data-active")).toBe("");
    await page.mouse.move(5, 5);
    expect(await readout().textContent()).toBe("");
    expect(problems).toEqual([]);
  });

  it("moves between rows with the arrow keys, sorts with s, and leaves Left and Right to the player", async () => {
    await openDemand();
    await rows().first().focus();
    expect(await readout().textContent()).toBe("Channel A: 40%. 2nd of 2.");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.querySelector("th")?.textContent)).toBe(
      "Channel B",
    );
    await page.keyboard.press("s");
    expect(await names()).toEqual(["Channel B", "Channel A"]);
    expect(await page.locator("[data-chart='sort']").getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("s");
    expect(await names()).toEqual(["Channel A", "Channel B"]);
    await page.keyboard.press("Escape");
    expect(await readout().textContent()).toBe("");

    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.querySelector(".dc-scene")?.getAttribute("data-scene") === "method",
    );
    expect(problems).toEqual([]);
  });

  it("runs a command from the page's player, as an agent holding the lease will", async () => {
    await openDemand();
    const ran = await page.evaluate(() =>
      (
        window as unknown as { depthcue: { invoke(id: string, name: string, args: unknown): boolean } }
      ).depthcue.invoke("chart-demand", "highlight", { row: 0 }),
    );
    expect(ran).toBe(true);
    expect(await readout().textContent()).toBe("Channel A: 40%. 2nd of 2.");
    const refused = await page.evaluate(() =>
      (
        window as unknown as { depthcue: { invoke(id: string, name: string, args: unknown): boolean } }
      ).depthcue.invoke("chart-demand", "highlight", { row: 9 }),
    );
    expect(refused).toBe(false);
    expect(await readout().textContent()).toBe("Channel A: 40%. 2nd of 2.");
  });

  it("does not move the page when it hydrates: the toolbar sits in room reserved from the start", async () => {
    await page.route("**/chart.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto(`${server.url}#/demand/2`);
    await page.locator(".dc-chart").waitFor();
    expect(await state()).toBe("pending");
    const measure = () =>
      page.evaluate(() => {
        const figure = document.querySelector("[data-id='chart-demand']") as HTMLElement;
        const box = figure.getBoundingClientRect();
        const tools = figure.querySelector(".dc-chart-tools")?.getBoundingClientRect();
        const table = figure.querySelector("table")?.getBoundingClientRect();
        return { top: box.top, height: box.height, bottom: box.bottom, tools, table };
      });
    const before = await measure();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-id='chart-demand']")?.getAttribute("data-module-state") === "hydrated",
    );
    const after = await measure();
    expect(after.height).toBeCloseTo(before.height, 1);
    expect(after.top).toBeCloseTo(before.top, 1);
    // The toolbar is inside the figure and clear of the table.
    expect(after.tools?.bottom).toBeLessThanOrEqual(after.bottom + 0.5);
    expect(after.tools?.top).toBeGreaterThanOrEqual((after.table?.bottom ?? 0) - 0.5);
  });

  it("leaves a plain, working chart and a working deck when the module cannot load", async () => {
    await page.route("**/chart.js", (route) => route.fulfill({ status: 500, body: "nope" }));
    await openDemand();
    expect(await state()).toBe("failed");
    expect(await names()).toEqual(["Channel A", "Channel B"]);
    expect(await page.locator(".dc-chart-tools").count()).toBe(0);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.querySelector(".dc-scene")?.getAttribute("data-scene") === "method",
    );
    expect(problems.filter((line) => line.startsWith("pageerror"))).toEqual([]);
  });

  it("stays static when the deck turns the module off, and never downloads it", async () => {
    const deckFile = join(folder, "deck.json");
    const deck = JSON.parse(readFileSync(deckFile, "utf8"));
    writeFileSync(deckFile, JSON.stringify({ ...deck, modules: { chart: "off" } }));
    await openDemand();
    expect(await state()).toBe("off");
    expect(chartChunkRequested()).toBe(false);
    expect(await page.locator(".dc-chart-tools").count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("goes back to the plain chart when the scene is left, with nothing left over", async () => {
    await openDemand();
    await rows().nth(1).hover();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.querySelector(".dc-scene")?.getAttribute("data-scene") === "method",
    );
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      () => document.querySelector(".dc-scene")?.getAttribute("data-scene") === "demand",
    );
    await page.evaluate(() =>
      (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled(),
    );
    expect(await state()).toBe("hydrated");
    expect(await page.locator(".dc-chart-tools").count()).toBe(1);
    expect(await readout().textContent()).toBe("");
    expect(problems).toEqual([]);
  });
});
