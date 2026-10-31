import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildClip } from "../src/clip.ts";
import { exportDeck } from "../src/export.ts";
import { launchBrowser } from "../src/render.ts";
import { builtStandaloneDir } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));
const stub = fileURLToPath(new URL("./fixtures/kine-stub.mjs", import.meta.url));

const probe = {
  canvas: { w: 1920, h: 1080, fps: 30, duration: 4.2, frames: 126 },
  layers: [
    { id: "dot", type: "circle", in: 0, out: 1.1, parent: null },
    { id: "title", type: "text", in: 1, out: 4.2, parent: null },
    { id: "sub", type: "text", in: 1.8, out: 4.2, parent: null },
  ],
  audio: [],
};

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let folder: string;
let context: BrowserContext;
let page: Page;
let problems: string[];
let requested: string[];
/** Every request the page made that was not for a file, and so would have needed a network. */
let blocked: string[];

beforeAll(async () => {
  try {
    if (!existsSync(join(builtStandaloneDir(), "depthcue.js")))
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

/** A copy of the demo deck with a clip scene added and built the way an author would build it. */
async function deckWithClip(): Promise<string> {
  const deck = join(root, "deck");
  cpSync(demo, deck, { recursive: true });
  const deckFile = join(deck, "deck.json");
  const manifest = JSON.parse(readFileSync(deckFile, "utf8"));
  writeFileSync(deckFile, JSON.stringify({ ...manifest, scenes: [...manifest.scenes, "clip-scene"] }));
  writeFileSync(
    join(deck, "scenes", "clip-scene.json"),
    JSON.stringify({
      schemaVersion: "0.1",
      id: "clip-scene",
      title: "A clip",
      layout: "text-media",
      blocks: [
        { id: "clip-heading", type: "text", role: "heading", text: "The opening, in motion" },
        {
          id: "intro-clip",
          type: "clip",
          source: "assets/intro.mp4",
          poster: "assets/intro.png",
          alt: "The opening animation.",
        },
      ],
    }),
  );
  const sceneFile = join(root, "intro.json");
  writeFileSync(sceneFile, JSON.stringify({ probe }));
  await buildClip({ folder: deck, scene: sceneFile, kine: [process.execPath, stub] });
  return deck;
}

/** Exports the deck to `<root>/<name>` and returns the address of its page. */
function exportTo(deck: string, name: string, notes = true): string {
  const result = exportDeck({ folder: deck, out: join(root, name), notes });
  if (!result.ok) throw new Error(`the export failed: ${JSON.stringify(result.diagnostics)}`);
  return pathToFileURL(join(result.summary.out, "index.html")).href;
}

const frames = {
  "pin-body": { x: 56, y: 58, w: 38, h: 26 },
  "pin-image": { x: 6, y: 56, w: 38, h: 38 },
  "pin-quote": { x: 58, y: 12, w: 36, h: 16 },
};

/** Adds a scene to the deck whose body, picture and quote are pinned, and whose quote comes with the first step. */
function addPinnedScene(deck: string): void {
  const deckFile = join(deck, "deck.json");
  const manifest = JSON.parse(readFileSync(deckFile, "utf8"));
  writeFileSync(deckFile, JSON.stringify({ ...manifest, scenes: [...manifest.scenes, "pinned"] }));
  writeFileSync(
    join(deck, "scenes", "pinned.json"),
    JSON.stringify({
      schemaVersion: "0.2",
      id: "pinned",
      title: "Pinned",
      layout: "text-media",
      blocks: [
        { id: "pin-heading", type: "text", role: "heading", text: "A heading that stays in the template" },
        {
          id: "pin-body",
          type: "text",
          role: "body",
          text: "A paragraph pinned to the lower right.",
          frame: frames["pin-body"],
        },
        {
          id: "pin-image",
          type: "image",
          asset: "assets/method.svg",
          alt: "A diagram of the method",
          frame: frames["pin-image"],
        },
        {
          id: "pin-quote",
          type: "text",
          role: "quote",
          text: "Pinned over the top right.",
          frame: frames["pin-quote"],
        },
      ],
      steps: [{ id: "pin-s1", reveal: ["pin-quote"] }],
    }),
  );
}

beforeEach(async (test) => {
  if (!browser) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-export-e2e-"));
  folder = await deckWithClip();
  // The network is off for this page: nothing but files may load, and anything else that asks is counted.
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, offline: true });
  blocked = [];
  await context.route(
    (url) => url.protocol !== "file:",
    (route) => {
      blocked.push(route.request().url());
      return route.abort();
    },
  );
  page = await context.newPage();
  problems = [];
  requested = [];
  page.on("request", (request) => requested.push(request.url()));
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  // A script or style the page refuses to load shows up as a console error, not a page error.
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
});

afterEach(async () => {
  await context?.close();
  rmSync(root, { recursive: true, force: true });
});

const scene = (id: string) => page.locator(`.dc-scene[data-scene='${id}']`);
const settled = () =>
  page.evaluate(() => (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled());
const position = () => new URL(page.url()).hash;

describe("an exported deck opened from a folder with the network off", () => {
  it("shows the first scene, and every request it made was for a file", async () => {
    await page.goto(exportTo(folder, "out"));
    await scene("opening").waitFor();
    await settled();
    expect(await page.title()).toBe("Why channel B now leads");
    expect(await scene("opening").textContent()).toContain("Channel B now leads demand");
    expect(page.url().startsWith("file:")).toBe(true);
    expect(requested.every((url) => url.startsWith("file:"))).toBe(true);
    expect(blocked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("loads the page, its styles and its script from beside it, and nothing else but assets", async () => {
    await page.goto(exportTo(folder, "out"));
    await scene("opening").waitFor();
    await settled();
    const names = requested.map((url) => url.slice(url.lastIndexOf("/") + 1));
    expect(names).toEqual(expect.arrayContaining(["index.html", "depthcue.css", "depthcue.js"]));
    // No deck.json, no scene files and no chunks: the deck is in the page and the modules are in the script.
    expect(names.filter((name) => /^(deck|opening|demand|method)\.json$/.test(name))).toEqual([]);
    expect(names.filter((name) => /^(chart|clip|lease|presenter|app|player)\.js$/.test(name))).toEqual([]);
    expect(names).not.toContain("intro.cues.json");
  });

  it("moves through the deck with the keyboard and keeps its place in the address", async () => {
    await page.goto(exportTo(folder, "out"));
    await scene("opening").waitFor();
    await page.keyboard.press("ArrowRight");
    await scene("demand").waitFor();
    // page.url() can trail the page's own history write, so wait for it rather than read it once.
    await page.waitForURL((url) => url.hash === "#/demand");
    expect(position()).toBe("#/demand");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.waitForURL((url) => url.hash === "#/demand/2");
    expect(position()).toBe("#/demand/2");
    await page.keyboard.press("ArrowRight");
    await scene("method").waitFor();
    await page.keyboard.press("ArrowLeft");
    await scene("demand").waitFor();
    expect(blocked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("opens at the scene in the address, so a place can be bookmarked", async () => {
    await page.goto(`${exportTo(folder, "out")}#/method`);
    await scene("method").waitFor();
    expect(await page.locator("[data-scene='method'] img").getAttribute("src")).toBe("./assets/method.svg");
  });

  it("loads an image from the folder", async () => {
    await page.goto(`${exportTo(folder, "out")}#/method`);
    const image = page.locator("[data-scene='method'] img");
    await image.waitFor();
    await page.waitForFunction(() => {
      const picture = document.querySelector<HTMLImageElement>("[data-scene='method'] img");
      return picture?.complete === true;
    });
    expect(await image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("hydrates the chart from the same script, with no chunk to fetch", async () => {
    await page.goto(`${exportTo(folder, "out")}#/demand/2`);
    const chart = page.locator("[data-id='chart-demand']");
    await chart.waitFor();
    await settled();
    expect(await chart.getAttribute("data-module-state")).toBe("hydrated");
    expect(await page.locator(".dc-chart-tools").count()).toBeGreaterThan(0);
    expect(blocked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("gives a clip its cue chips from the cue map in the page, not from a request", async () => {
    await page.goto(`${exportTo(folder, "out")}#/clip-scene/0`);
    const figure = page.locator("[data-id='intro-clip']");
    await figure.waitFor();
    await settled();
    await page.waitForFunction(
      () => document.querySelector("[data-id='intro-clip']")?.getAttribute("data-module-state") !== "pending",
    );
    expect(await figure.getAttribute("data-module-state")).toBe("hydrated");
    const cues = page.locator(".dc-clip-cues [data-cue]");
    expect(await cues.evaluateAll((all) => all.map((chip) => chip.getAttribute("data-cue")))).toEqual([
      "dot",
      "title",
      "sub",
    ]);
    expect(requested.some((url) => url.endsWith("intro.cues.json"))).toBe(false);
    expect(blocked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("shows the speaker notes, which went with the deck", async () => {
    await page.goto(exportTo(folder, "out"));
    await scene("opening").waitFor();
    await page.locator("[data-action='notes']").click();
    expect(await page.locator("#dc-notes").textContent()).toContain(
      "Open with the answer, then show the evidence.",
    );
  });

  it("has no notes to show when it was exported with --no-notes", async () => {
    await page.goto(exportTo(folder, "bare", false));
    await scene("opening").waitFor();
    await page.locator("[data-action='notes']").click();
    const text = (await page.locator("#dc-notes").textContent()) ?? "";
    expect(text).toContain("No notes for this scene.");
    expect(text).not.toContain("Open with the answer");
    expect(await page.content()).not.toContain("Open with the answer");
  });

  it("opens the reading view, which holds the whole deck as one page", async () => {
    await page.goto(exportTo(folder, "out"));
    await scene("opening").waitFor();
    await page.locator("[data-action='read']").click();
    await page.locator(".dc-reading").waitFor();
    expect(await page.locator(".dc-reading-scene").count()).toBe(4);
    expect(problems).toEqual([]);
  });

  it("still works after the folder is copied somewhere else", async () => {
    exportTo(folder, "out");
    const moved = join(root, "usb", "talk");
    cpSync(join(root, "out"), moved, { recursive: true });
    rmSync(join(root, "out"), { recursive: true });
    await page.goto(`${pathToFileURL(join(moved, "index.html")).href}#/method`);
    await scene("method").waitFor();
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>("[data-scene='method'] img")?.complete === true,
    );
    expect(
      await page.locator("[data-scene='method'] img").evaluate((i) => (i as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    expect(requested.every((url) => url.startsWith("file:"))).toBe(true);
    expect(problems).toEqual([]);
  });

  it("shows the deck's title and nothing from a page that carries script in its data", async () => {
    const manifestFile = join(folder, "deck.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, title: "</script><img src=x onerror=window.owned=1>" }),
    );
    await page.goto(exportTo(folder, "out"));
    await scene("opening").waitFor();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as unknown as { owned?: number }).owned)).toBeUndefined();
    expect(await page.title()).toBe("</script><img src=x onerror=window.owned=1>");
  });
});

describe("an exported scene with pinned blocks", () => {
  const box = async (selector: string) => {
    const found = await page.locator(selector).boundingBox();
    if (!found) throw new Error(`${selector} has no box on the page`);
    return found;
  };

  /** Where `id` should be, from the slide's own box and the block's frame. */
  async function expectAtFrame(id: keyof typeof frames) {
    const slide = await box(".dc-scene[data-scene='pinned']");
    const frame = frames[id];
    const found = await box(`[data-id='${id}']`);
    expect(found.x).toBeCloseTo(slide.x + (frame.x / 100) * slide.width, 0);
    expect(found.y).toBeCloseTo(slide.y + (frame.y / 100) * slide.height, 0);
    expect(found.width).toBeCloseTo((frame.w / 100) * slide.width, 0);
    expect(found.height).toBeCloseTo((frame.h / 100) * slide.height, 0);
  }

  async function openPinned(position = "#/pinned") {
    addPinnedScene(folder);
    await page.goto(`${exportTo(folder, "out")}${position}`);
    await scene("pinned").waitFor();
    await settled();
  }

  it("is a 16 by 9 slide, centered in the window, with each block at its frame", async () => {
    await openPinned("#/pinned/1");
    const slide = await box(".dc-scene[data-scene='pinned']");
    expect(slide.width / slide.height).toBeCloseTo(16 / 9, 2);
    expect(slide.x).toBeCloseTo(0, 0);
    for (const id of Object.keys(frames) as (keyof typeof frames)[]) await expectAtFrame(id);
    expect(blocked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("stays 16 by 9 and centered in a window of another shape", async () => {
    await page.setViewportSize({ width: 1800, height: 700 });
    await openPinned("#/pinned/1");
    const slide = await box(".dc-scene[data-scene='pinned']");
    const stage = await box(".dc-stage");
    expect(slide.width / slide.height).toBeCloseTo(16 / 9, 2);
    expect(slide.width).toBeLessThan(1800);
    expect(slide.x + slide.width / 2).toBeCloseTo(stage.x + stage.width / 2, 0);
    for (const id of Object.keys(frames) as (keyof typeof frames)[]) await expectAtFrame(id);
  });

  it("shows a pinned block with its step and not before", async () => {
    await openPinned();
    const quote = page.locator("[data-id='pin-quote']");
    expect(await quote.getAttribute("data-revealed")).toBe("false");
    expect(await quote.isVisible()).toBe(false);
    await page.keyboard.press("ArrowRight");
    await settled();
    expect(await quote.getAttribute("data-revealed")).toBe("true");
    expect(await quote.isVisible()).toBe(true);
    // The block slides in as it appears, so it is measured once that has finished.
    await quote.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    await expectAtFrame("pin-quote");
    expect(problems).toEqual([]);
  });

  it("loads a pinned picture from the folder", async () => {
    await openPinned("#/pinned/1");
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>("[data-id='pin-image'] img")?.complete === true,
    );
    expect(
      await page
        .locator("[data-id='pin-image'] img")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("keeps the room of each pinned block in the template, where nothing can see or reach it", async () => {
    await openPinned("#/pinned/1");
    const ghosts = page.locator(".dc-scene[data-scene='pinned'] .dc-ghost");
    expect(await ghosts.count()).toBe(Object.keys(frames).length);
    for (const ghost of await ghosts.all()) {
      const state = await ghost.evaluate((node) => ({
        visibility: getComputedStyle(node).visibility,
        height: node.getBoundingClientRect().height,
        id: node.closest("[data-id]")?.getAttribute("data-id") ?? null,
      }));
      expect(state.visibility).toBe("hidden");
      expect(state.height).toBeGreaterThan(0);
      expect(state.id).toBeNull();
    }
    expect(problems).toEqual([]);
  });

  it("gives way to the flow in a window too narrow for a slide, with every block in reach", async () => {
    await page.setViewportSize({ width: 600, height: 900 });
    await openPinned("#/pinned/1");
    // The pinned blocks follow the template here, so the room kept for them in it is not drawn.
    for (const ghost of await page.locator(".dc-ghost").all()) {
      expect(await ghost.evaluate((node) => getComputedStyle(node).display)).toBe("none");
    }
    for (const id of Object.keys(frames)) {
      const found = await box(`[data-id='${id}']`);
      expect(
        await page.locator(`[data-id='${id}']`).evaluate((node) => getComputedStyle(node).position),
      ).toBe("static");
      expect(found.x).toBeGreaterThanOrEqual(0);
      expect(found.x + found.width).toBeLessThanOrEqual(600);
    }
    // The picture keeps a real height instead of collapsing in the flow.
    expect((await box("[data-id='pin-image'] img")).height).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  it("is not pinned in the reading view, which holds the same words as one page", async () => {
    await openPinned();
    await page.locator("[data-action='read']").click();
    await page.locator(".dc-reading").waitFor();
    const reading = page.locator(".dc-reading-scene[data-scene='pinned']");
    expect(await reading.textContent()).toContain("A paragraph pinned to the lower right.");
    expect(await page.locator(".dc-reading .dc-pinned").count()).toBe(0);
    expect(problems).toEqual([]);
  });
});
