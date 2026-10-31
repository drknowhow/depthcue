import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildClip } from "../src/clip.ts";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

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
let server: RunningServer | undefined;
let context: BrowserContext;
let page: Page;
let problems: string[];
let requested: string[];

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "clip.js")))
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
  root = mkdtempSync(join(tmpdir(), "depthcue-clipmod-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });

  // The deck gets a scene with a clip, and the clip is built the way an author would build it.
  const deckFile = join(folder, "deck.json");
  const deck = JSON.parse(readFileSync(deckFile, "utf8"));
  writeFileSync(deckFile, JSON.stringify({ ...deck, scenes: [...deck.scenes, "clip-scene"] }));
  writeFileSync(
    join(folder, "scenes", "clip-scene.json"),
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
  await buildClip({ folder, scene: sceneFile, kine: [process.execPath, stub] });

  server = undefined;
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  requested = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const figure = () => page.locator("[data-id='intro-clip']");
const chips = () => page.locator(".dc-clip-cues [data-cue]");
const state = () => figure().getAttribute("data-module-state");
const settled = () =>
  page.evaluate(() => (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled());
const videoTime = () => page.evaluate(() => document.querySelector("video")?.currentTime);
const asked = (name: string) => requested.some((path) => path.endsWith(name));

/**
 * The server watches the deck folder and reloads the page when it changes, so a test that edits the deck
 * does that before this starts it. A late change event would re-render the clip under the test.
 */
async function serve(): Promise<RunningServer> {
  server ??= await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  return server;
}

async function openClip() {
  await page.goto(`${(await serve()).url}#/clip-scene/0`);
  await figure().waitFor();
  await settled();
  // The server reloads the page when the deck folder reports a change, which can re-render the clip after
  // settled() answered for the first render. Wait for the figure that is on the page now.
  await page.waitForFunction(
    () => document.querySelector("[data-id='intro-clip']")?.getAttribute("data-module-state") !== "pending",
  );
}

describe("the clip module in a real browser", () => {
  it("is not downloaded until a scene with a clip is shown, and then adds a chip for each cue", async () => {
    await page.goto((await serve()).url);
    await page.locator(".dc-scene[data-scene='opening']").waitFor();
    await settled();
    expect(asked("/clip.js")).toBe(false);
    expect(asked("/intro.cues.json")).toBe(false);

    await openClip();
    expect(asked("/clip.js")).toBe(true);
    expect(await state()).toBe("hydrated");
    expect(await chips().evaluateAll((all) => all.map((chip) => chip.getAttribute("data-cue")))).toEqual([
      "dot",
      "title",
      "sub",
    ]);
    expect(problems).toEqual([]);
  });

  it("jumps the video to a cue when its chip is pressed, and marks where the clip is", async () => {
    await openClip();
    await chips().nth(1).click();
    expect(await videoTime()).toBe(1);
    expect(await page.locator("[data-cue][aria-current='true']").getAttribute("data-cue")).toBe("title");
    await chips().nth(2).click();
    expect(await videoTime()).toBeCloseTo(1.8, 5);
    expect(await page.locator("[data-cue][aria-current='true']").getAttribute("data-cue")).toBe("sub");
    expect(problems).toEqual([]);
  });

  it("can be used from the keyboard", async () => {
    await openClip();
    await chips().first().focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    expect(await videoTime()).toBe(1);
  });

  it("runs a command from the page's player, as an agent holding the lease will", async () => {
    await openClip();
    const ran = await page.evaluate(() =>
      (
        window as unknown as { depthcue: { invoke(id: string, name: string, args: unknown): boolean } }
      ).depthcue.invoke("intro-clip", "seek", { cue: "sub" }),
    );
    expect(ran).toBe(true);
    expect(await videoTime()).toBeCloseTo(1.8, 5);
    const refused = await page.evaluate(() =>
      (
        window as unknown as { depthcue: { invoke(id: string, name: string, args: unknown): boolean } }
      ).depthcue.invoke("intro-clip", "seek", { cue: "nope" }),
    );
    expect(refused).toBe(false);
  });

  it("does not move the page when the chips arrive: they sit in room reserved from the start", async () => {
    await page.route("**/intro.cues.json", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto(`${(await serve()).url}#/clip-scene/0`);
    await figure().waitFor();
    expect(await state()).toBe("pending");
    expect(await chips().count()).toBe(0);
    const measure = () =>
      page.evaluate(() => {
        const node = document.querySelector("[data-id='intro-clip']") as HTMLElement;
        const box = node.getBoundingClientRect();
        const video = node.querySelector("video")?.getBoundingClientRect();
        return { top: box.top, height: box.height, videoTop: video?.top, videoHeight: video?.height };
      });
    const before = await measure();
    await chips().first().waitFor();
    const after = await measure();
    expect(after.height).toBeCloseTo(before.height, 1);
    expect(after.top).toBeCloseTo(before.top, 1);
    expect(after.videoTop).toBeCloseTo(before.videoTop ?? 0, 1);
    expect(after.videoHeight).toBeCloseTo(before.videoHeight ?? 0, 1);
  });

  it("leaves a plain clip when there is no cue map, and does not complain", async () => {
    rmSync(join(folder, "assets", "intro.cues.json"));
    await openClip();
    expect(await state()).toBe("hydrated");
    expect(await chips().count()).toBe(0);
    expect(await figure().getAttribute("data-cues")).toBe("none");
    expect(await page.locator("[data-id='intro-clip'] video").count()).toBe(1);
    expect(problems).toEqual([]);
  });

  it("leaves a plain clip when the cue map is not a cue map", async () => {
    writeFileSync(join(folder, "assets", "intro.cues.json"), '{"format":"other"}');
    await openClip();
    expect(await chips().count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("stays plain when the deck turns the module off, and never downloads it", async () => {
    const deckFile = join(folder, "deck.json");
    const deck = JSON.parse(readFileSync(deckFile, "utf8"));
    writeFileSync(deckFile, JSON.stringify({ ...deck, modules: { clip: "off" } }));
    await openClip();
    expect(await state()).toBe("off");
    expect(asked("/clip.js")).toBe(false);
    expect(asked("/intro.cues.json")).toBe(false);
    expect(await chips().count()).toBe(0);
  });
});
