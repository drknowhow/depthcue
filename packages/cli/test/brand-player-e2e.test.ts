// The brand in a real browser, under the same Content-Security-Policy the player ships with: a served deck, its offline
// export and `depthcue render`. A copy of fixtures/decks/v0-4-brand is changed the way an author would change it (a longer
// byline, a frame moved in a template file, a picture behind a title) and the page is looked at: the colors on the pixels,
// the face the page loaded, where each slot, the logo and the footer are. What the pages do is in the other e2e files;
// this one is about the brand's look reaching all three places that draw a deck.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lookOf } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDeck } from "../src/deck-api.ts";
import { exportDeck } from "../src/export.ts";
import { launchBrowser, openRenderer } from "../src/render.ts";
import { builtPlayerDir, builtStandaloneDir, type RunningServer, startServer } from "../src/serve.ts";

const fixtureOf = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/decks/${name}`, import.meta.url));
const SHOTS = process.env.DEPTHCUE_SHOTS;

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string | undefined;
let problems: string[];
/** What to close after the test, last opened first. */
const closers: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  try {
    if (
      !existsSync(join(builtPlayerDir(), "player.js")) ||
      !existsSync(join(builtStandaloneDir(), "depthcue.js"))
    )
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
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-player-"));
  problems = [];
});

afterEach(async () => {
  const seen = problems;
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  expect(seen).toEqual([]);
});

// ---- the deck, changed the way an author would change it -------------------------------------------------------------

type Json = Record<string, any>;

const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));
function writeJson(path: string, json: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}
function editJson(path: string, change: (json: Json) => void): void {
  const json = readJson(path);
  change(json);
  writeJson(path, json);
}

/** A copy of the branded fixture, or of an old deck, in this test's folder. */
function copyDeck(name = "v0-4-brand", into = "deck"): string {
  const deck = join(root as string, into);
  cpSync(fixtureOf(name), deck, { recursive: true });
  return deck;
}

function addScene(deck: string, scene: Json & { id: string }): void {
  writeJson(join(deck, "scenes", `${scene.id}.json`), { schemaVersion: "0.4", ...scene });
  editJson(join(deck, "deck.json"), (manifest) => manifest.scenes.push(scene.id));
}

const text = (id: string, role: string, body: string, extra: Json = {}): Json => ({
  id,
  type: "text",
  role,
  text: body,
  ...extra,
});

const chart = (id: string, extra: Json = {}): Json => ({
  id,
  type: "chart",
  kind: "bar",
  title: "Ships handled each month",
  columns: [{ label: "Month" }, { label: "Berth A" }, { label: "Berth B" }],
  rows: [
    ["July", 40, 0],
    ["August", 42, 18],
    ["September", 44, 30],
  ],
  ...extra,
});

/** A scene of each of the three built-in templates, a style that fills with a strong color, and a template on a picture. */
function moreScenes(deck: string): void {
  editJson(join(deck, "brand", "brand.json"), (brand) => {
    brand.styles.banner = { name: "Banner", for: ["body"], fill: "action", pad: "m" };
  });
  mkdirSync(join(deck, "brand", "images"), { recursive: true });
  writeFileSync(
    join(deck, "brand", "images", "night.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f3a4f"/><stop offset="1" stop-color="#06151f"/></linearGradient></defs><rect width="1600" height="900" fill="url(#sky)"/><path d="M0 640c200-60 400-60 600 0s400 60 600 0 300-40 400-20v280H0z" fill="#0b2a3a"/><path d="M0 720c200-50 400-50 600 0s400 50 600 0 300-30 400-10v190H0z" fill="#081f2d"/></svg>',
  );
  writeFileSync(
    join(deck, "brand", "images", "bright.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><rect width="1600" height="900" fill="#ffffff"/></svg>',
  );
  writeJson(join(deck, "brand", "templates", "photo.json"), {
    schemaVersion: "0.4",
    id: "photo",
    name: "Photo",
    description: "A title over a picture, with a line under it.",
    background: { color: "text", image: "images/night.svg", scrim: 30 },
    chrome: "none",
    slots: [
      {
        id: "title",
        role: "title",
        frame: { x: 8, y: 36, w: 84, h: 26 },
        accepts: ["heading"],
        required: true,
        valign: "bottom",
        hint: "The title, in a few words.",
      },
      {
        id: "byline",
        role: "subtitle",
        frame: { x: 8, y: 66, w: 70, h: 12 },
        accepts: ["body"],
        hint: "One line under the title.",
      },
    ],
  });
  addScene(deck, {
    id: "part",
    title: "Part",
    template: "section",
    blocks: [
      text("part-kicker", "caption", "Part two", { slot: "kicker" }),
      text("part-title", "heading", "What changed", { slot: "title" }),
      text("part-lede", "body", "Three berths, one quarter.", { slot: "lede" }),
    ],
  });
  addScene(deck, {
    id: "claim",
    title: "Claim",
    template: "statement",
    summary: { id: "claim-claim", text: "Ships handled rose by a third.", evidenceIds: ["claim-chart"] },
    blocks: [chart("claim-chart", { slot: "evidence", sourceIds: ["berth-log"] })],
    sources: [{ id: "berth-log", title: "Harbor master's berth log" }],
  });
  addScene(deck, {
    id: "pair",
    title: "Pair",
    template: "two-column",
    blocks: [
      text("pair-title", "heading", "Two berths, two stories", { slot: "title" }),
      text("pair-left", "body", "Berth A never closed, and moved 40 ships in July.", { slot: "left" }),
      text("pair-right", "body", "Berth B reopened in August and caught up by September.", { slot: "right" }),
    ],
  });
  addScene(deck, {
    id: "banner",
    title: "Banner",
    layout: "text-media",
    blocks: [
      text("banner-heading", "heading", "A strong fill reverses its text"),
      text("banner-body", "body", "This block is filled with the brand's action color.", { style: "banner" }),
    ],
  });
  addScene(deck, {
    id: "photo",
    title: "Photo",
    template: "photo",
    blocks: [
      text("photo-title", "heading", "The harbor at night", { slot: "title" }),
      text("photo-byline", "body", "A title over a picture.", { slot: "byline" }),
    ],
  });
}

/** Scenes of the three built-in layouts, which have no template to keep clear of the brand's logo. */
function layoutScenes(deck: string): string[] {
  addScene(deck, {
    id: "lay-title",
    title: "Title layout",
    layout: "title",
    blocks: [
      text("lay-title-heading", "heading", "Where the harbor grew"),
      text("lay-title-sub", "body", "A walk through the third quarter."),
    ],
  });
  addScene(deck, {
    id: "lay-claim",
    title: "Claim layout",
    layout: "claim-evidence",
    // A short claim and no sources, as this slide is drawn with the largest logo in every corner: that logo reaches past
    // the margin every slide has, and the room it takes is room a long claim would need (the render check reports
    // `overflow`). A small logo takes none, which "gives a logo only the room its height needs" below shows.
    summary: { id: "lay-claim-claim", text: "Ships handled rose.", evidenceIds: ["lay-claim-chart"] },
    blocks: [chart("lay-claim-chart")],
  });
  addScene(deck, {
    id: "lay-media",
    title: "Text and media layout",
    layout: "text-media",
    blocks: [
      text("lay-media-heading", "heading", "The quarter started slow"),
      text("lay-media-body", "body", "Two of the three berths were closed for dredging until August."),
      text("lay-media-quote", "quote", "We planned for a flat quarter."),
    ],
  });
  return ["lay-title", "lay-claim", "lay-media"];
}

// ---- looking at a page -----------------------------------------------------------------------------------------------

const rgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

type Depthcue = { depthcue?: { settled(): Promise<void> } };

/**
 * Waits for the page to lay out what it has and for the fonts that layout asked for. A face is fetched only once text that
 * uses it is laid out, which is a frame after the scene is in, so the fonts are awaited after two frames, not before.
 */
const frames = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    await frame();
    await frame();
    await document.fonts.ready;
  });

/** Waits until the scene is on the page, its modules are hydrated and its fonts are in. */
async function settle(page: Page, scene: string): Promise<void> {
  await page.waitForSelector(`.dc-scene[data-scene="${scene}"]`);
  await page.evaluate(() => (window as unknown as Depthcue).depthcue?.settled());
  await frames(page);
}

/** What a page has loaded, for the message of a test that finds two pages differ. */
const loadedFaces = (page: Page): Promise<string> =>
  page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.status !== "unloaded")
      .map((face) => `${face.family} ${face.weight} ${face.style} ${face.status}`)
      .join("; "),
  );

/** How two pictures differ: the pixels that differ at all, and the largest step in any channel of any of them. */
interface Difference {
  changed: number;
  step: number;
  of: number;
  box: string;
}

/**
 * The most pixels two pictures of one page may differ in and still be the same page. Drawing a page twice in Chrome can
 * move a few edge pixels of text, by a rounding (88 of 921,600, by 1 step, on a Linux runner, between two pages that were
 * drawn the same); a changed color or font changes thousands, and by more than a step. A count in pixels,
 * and not a share of the picture, so a change of color too small to see cannot hide in the picture's size.
 */
const FEW_PIXELS = 256;
/** How many times a pair is photographed again, after a face that arrived late repainted, before it is called different. */
const RETAKES = 3;

/** Counts how two PNGs differ, in a blank page where nothing but the picture is. */
async function difference(blank: Page, left: Buffer, right: Buffer): Promise<Difference> {
  return blank.evaluate(
    async ([one, two]) => {
      const read = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d", {
          willReadFrequently: true,
        }) as OffscreenCanvasRenderingContext2D;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const [x, y] = [await read(one as string), await read(two as string)];
      if (x.width !== y.width || x.height !== y.height) {
        return { changed: x.width * x.height, step: 255, of: x.width * x.height, box: "the sizes differ" };
      }
      let [changed, step] = [0, 0];
      let [left, top, right, bottom] = [x.width, x.height, -1, -1];
      for (let at = 0; at < x.data.length; at += 4) {
        let most = 0;
        for (let channel = 0; channel < 4; channel++) {
          most = Math.max(
            most,
            Math.abs((x.data[at + channel] as number) - (y.data[at + channel] as number)),
          );
        }
        if (most === 0) continue;
        changed++;
        step = Math.max(step, most);
        const [column, row] = [(at / 4) % x.width, Math.floor(at / 4 / x.width)];
        [left, top, right, bottom] = [
          Math.min(left, column),
          Math.min(top, row),
          Math.max(right, column),
          Math.max(bottom, row),
        ];
      }
      return {
        changed,
        step,
        of: x.width * x.height,
        box: changed ? `${left},${top} to ${right},${bottom}` : "",
      };
    },
    [left.toString("base64"), right.toString("base64")] as const,
  );
}

const SAME: Difference = { changed: 0, step: 0, of: 0, box: "" };

/**
 * Whether the stages of two pages come out as the same picture. A third page is the control: the same deck drawn the same
 * way as the second, which says how much two drawings of one page differ on this machine (none, on Windows; a handful of
 * faint pixels on a Linux runner). The first two are the same when they differ in no more than `FEW_PIXELS` pixels and by
 * no larger a step in any channel than the control pair does, so what is allowed is what noise was seen to do, not a
 * share of the picture a real change can sit inside. A face that arrives late repaints, so the pictures are taken again a
 * few times before they are called different. What the difference was is said, in the log when it passes and in the
 * message when it does not.
 */
async function sameStage(a: Page, b: Page, control: Page, note: string): Promise<string | undefined> {
  const shoot = (page: Page) => page.locator(".dc-stage").screenshot({ animations: "disabled" });
  const blank = await a.context().newPage();
  const compare = async (left: Buffer, right: Buffer) =>
    left.equals(right) ? SAME : await difference(blank, left, right);
  try {
    let said = "";
    for (let attempt = 0; attempt <= RETAKES; attempt++) {
      if (attempt > 0) {
        await a.waitForTimeout(250);
        await Promise.all([frames(a), frames(b), frames(control)]);
      }
      const [first, second, third] = [await shoot(a), await shoot(b), await shoot(control)];
      const noise = await compare(second, third);
      const found = await compare(first, second);
      said = `${note}: ${found.changed} of ${found.of || "all the"} pixels differ, at most by ${found.step}, within ${found.box || "none"}; two drawings of the same page differed in ${noise.changed}, at most by ${noise.step}`;
      if (found.changed <= FEW_PIXELS && found.step <= noise.step) {
        if (found.changed > 0) console.log(said);
        return undefined;
      }
    }
    return `${said}; loaded: [${await loadedFaces(a)}] and [${await loadedFaces(b)}]`;
  } finally {
    await blank.close();
  }
}

/** Watches a page for the errors a refused script, style or font would raise. */
function watch(page: Page, withConsole = true): void {
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  if (withConsole) {
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
  }
}

interface Served {
  server: RunningServer;
  page: Page;
  context: BrowserContext;
  /** Every answer the server gave this page, by path. */
  responses: Array<{ status: number; path: string }>;
  /** Opens a scene. `fresh` loads the page again first, so the drawing has no history of an earlier scene. */
  go(scene: string, options?: { fresh?: boolean }): Promise<Page>;
}

/**
 * Serves a deck folder and opens it. By default the page has the player's own Content-Security-Policy and the controls
 * the audience has. `clean` is what `depthcue render` shows: the controls hidden, so a 16 by 9 slide is exactly the
 * viewport, which is how a slot's box is measured against its frame.
 */
async function serve(
  folder: string,
  options: { clean?: boolean; quiet?: boolean; width?: number; height?: number } = {},
): Promise<Served> {
  const server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  closers.push(() => server.close());
  const context = await (browser as Browser).newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? (options.clean ? 720 : 781) },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    colorScheme: "light",
    ...(options.clean ? { bypassCSP: true } : {}),
  });
  closers.push(() => context.close());
  const page = await context.newPage();
  watch(page, !options.quiet);
  const responses: Served["responses"] = [];
  page.on("response", (response) =>
    responses.push({ status: response.status(), path: response.url().replace(server.url, "/") }),
  );
  let styled = false;
  return {
    server,
    page,
    context,
    responses,
    async go(scene, more = {}) {
      if (more.fresh) {
        // A hash change alone does not load the page again, and the page that is left takes its added style with it.
        await page.goto("about:blank");
        styled = false;
      }
      await page.goto(`${server.url}#/${scene}`);
      if (options.clean && !styled) {
        styled = true;
        await page.addStyleTag({ content: ".dc-controls { display: none !important; }" });
      }
      await settle(page, scene);
      return page;
    },
  };
}

/**
 * A computed style of the first element that matches, found and read in one turn of the page. The page can draw the scene
 * again a moment after it settles (a page of the dev server does when a file it watches reports a change), and an element
 * found before that and read after it is gone from the page, and has no style to give.
 */
const style = (page: Page, selector: string, property: string): Promise<string> =>
  page.evaluate(
    ([where, name]) => {
      const element = document.querySelector(where as string);
      return element ? getComputedStyle(element).getPropertyValue(name as string) : "";
    },
    [selector, property] as const,
  );

/** A box as a fraction of the scene it is in, in percent, so it does not depend on the size the page was opened at. */
async function share(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const scene = (element.closest(".dc-scene") as HTMLElement).getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        x: ((box.left - scene.left) / scene.width) * 100,
        y: ((box.top - scene.top) / scene.height) * 100,
        w: (box.width / scene.width) * 100,
        h: (box.height / scene.height) * 100,
      };
    });
}

// ---- a served deck ---------------------------------------------------------------------------------------------------

describe("a deck with a brand, served", () => {
  it("draws every color of the brand: the template's, the accent bar and the chart's marks", async () => {
    const deck = copyDeck();
    const served = await serve(deck);
    const welcome = await served.go("welcome");
    // The cover's template asks for the brand's action color behind the slide.
    expect(await style(welcome, ".dc-scene", "background-color")).toBe(rgb("#0B6E6E"));

    const growth = await served.go("growth");
    expect((await style(growth, ".dc-scene", "--dc-action")).trim().toUpperCase()).toBe("#0B6E6E");
    expect((await style(growth, ".dc-scene", "--dc-evidence")).trim().toUpperCase()).toBe("#2D4BB8");
    expect(await style(growth, ".dc-accent", "background-color")).toBe(rgb("#0B6E6E"));
    const fills = await growth
      .locator(".dc-mark")
      .evaluateAll((marks) => [...new Set(marks.map((mark) => getComputedStyle(mark).fill))]);
    expect(fills).toEqual([rgb("#0B6E6E"), rgb("#2D4BB8"), rgb("#B4531F")]);
  }, 60_000);

  it("takes the chart's colors for the deck's theme: the ink theme has its own set", async () => {
    const deck = copyDeck();
    editJson(join(deck, "deck.json"), (manifest) => {
      manifest.theme = "ink";
    });
    const served = await serve(deck);
    const growth = await served.go("growth");
    const fills = await growth
      .locator(".dc-mark")
      .evaluateAll((marks) => [...new Set(marks.map((mark) => getComputedStyle(mark).fill))]);
    expect(fills).toEqual([rgb("#4FC4C4"), rgb("#8FA5FF"), rgb("#F0A06A")]);
  }, 60_000);

  it("loads the brand's own faces from the deck folder and draws the text with them", async () => {
    const served = await serve(copyDeck());
    const growth = await served.go("growth");
    const asked = served.responses.filter((response) => response.path.startsWith("/brand/fonts/"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((response) => response.status === 200)).toBe(true);
    expect(new Set(asked.map((response) => response.path))).toEqual(
      new Set(["/brand/fonts/HarborSans-Bold.woff2", "/brand/fonts/HarborSans-Regular.woff2"]),
    );
    const loaded = await growth.evaluate(() =>
      [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => `${face.family} ${face.weight}`),
    );
    expect(loaded).toContain("Harbor Display 700");
    expect(loaded).toContain("Harbor Sans 400");
    expect(loaded).toContain("Harbor Sans 700");
    expect(await style(growth, ".dc-heading", "font-family")).toContain("Harbor Display");
    expect(await style(growth, ".dc-body", "font-family")).toContain("Harbor Sans");
    // The policy refuses a <style> element, so the faces must have come in through the constructed stylesheet.
    expect(await growth.evaluate(() => document.querySelectorAll("style").length)).toBe(0);
    expect(await growth.evaluate(() => document.adoptedStyleSheets.length)).toBeGreaterThan(0);
  }, 60_000);

  it("puts the logo, footer, number and accent at the places the brand names, and none on a template that asks for none", async () => {
    const served = await serve(copyDeck());
    const growth = await served.go("growth");
    const logo = await share(growth, ".dc-logo");
    expect(logo.x).toBeGreaterThan(75);
    expect(logo.y).toBeLessThan(10);
    expect(
      await growth
        .locator(".dc-logo")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    ).toBe(true);
    expect(await growth.locator(".dc-logo").getAttribute("alt")).toBe("Harbor Analytics");
    expect(await growth.locator(".dc-logo").getAttribute("src")).toContain("brand/logos/harbor.svg");
    const footer = await share(growth, ".dc-foot[data-at='start']");
    expect(footer.x).toBeLessThan(10);
    expect(footer.y).toBeGreaterThan(90);
    expect(await growth.locator(".dc-footer").textContent()).toBe("Harbor Analytics, for internal use");
    const number = await share(growth, ".dc-foot[data-at='end']");
    expect(number.x).toBeGreaterThan(90);
    expect(await growth.locator(".dc-number").textContent()).toBe("3");
    const accent = await share(growth, ".dc-accent");
    expect(accent.y).toBeLessThan(1);
    expect(accent.w).toBeGreaterThan(99);

    // The cover's template says "none": nothing of the brand's chrome is on it.
    const welcome = await served.go("welcome");
    expect(await welcome.locator(".dc-chrome").count()).toBe(0);
  }, 60_000);

  it("sets the sources of a template slide as one flowing line along the foot, which wraps when it must", async () => {
    const deck = copyDeck();
    addScene(deck, {
      id: "few",
      title: "Few sources",
      template: "two-column",
      blocks: [
        text("few-title", "heading", "Two berths", { slot: "title" }),
        text("few-left", "body", "Berth A never closed.", { slot: "left" }),
      ],
      sources: [
        { id: "few-1", title: "Berth log" },
        { id: "few-2", title: "Dredging report" },
        { id: "few-3", title: "Audit" },
      ],
    });
    addScene(deck, {
      id: "many",
      title: "Many sources",
      template: "two-column",
      blocks: [
        text("many-title", "heading", "Two berths", { slot: "title" }),
        text("many-left", "body", "Berth A never closed.", { slot: "left" }),
      ],
      sources: Array.from({ length: 8 }, (_, at) => ({
        id: `many-${at + 1}`,
        title: `Harbor master's berth log for July to September, as audited by the port authority (${at + 1})`,
      })),
    });
    const served = await serve(deck, { clean: true });
    const rows = (page: Page) =>
      page.evaluate(() => {
        const band = document.querySelector<HTMLElement>(".dc-sources") as HTMLElement;
        const parts = [...band.querySelectorAll<HTMLElement>("p, li")];
        // The label is a smaller type than the sources, so a row is the parts whose middles are within a few pixels.
        const middles = parts
          .flatMap((part) => [...part.getClientRects()].map((rect) => (rect.top + rect.bottom) / 2))
          .sort((a, b) => a - b);
        const rows = middles.filter(
          (middle, at) => at === 0 || middle - (middles[at - 1] as number) > 8,
        ).length;
        return {
          rows,
          position: getComputedStyle(band).position,
          label: band.querySelector("p")?.textContent ?? "",
          sources: band.querySelectorAll("li").length,
          bottom: band.getBoundingClientRect().bottom,
        };
      });
    // A few short ones: the label and every source share one line, at the foot.
    const few = await rows(await served.go("few"));
    expect(few).toMatchObject({ rows: 1, position: "absolute", label: "Sources", sources: 3 });
    expect(few.bottom).toBeLessThan(720);
    expect(few.bottom).toBeGreaterThan(660);
    // Many long ones are the same running line, wrapped at the slide's width: more rows, still one block along the foot.
    const many = await rows(await served.go("many"));
    expect(many.rows).toBeGreaterThan(1);
    expect(many.sources).toBe(8);
    expect(Math.abs(many.bottom - few.bottom)).toBeLessThanOrEqual(1);
  }, 60_000);
  it("shows the logo alone on a template whose chrome is minimal", async () => {
    const deck = copyDeck();
    moreScenes(deck);
    const served = await serve(deck);
    const part = await served.go("part");
    expect(await part.locator(".dc-chrome .dc-logo").count()).toBe(1);
    expect(await part.locator(".dc-foot, .dc-accent, .dc-footer, .dc-number").count()).toBe(0);
  }, 60_000);

  it("draws a style's fill, border, edge and radius, and reverses the text on a strong fill", async () => {
    const deck = copyDeck();
    moreScenes(deck);
    const served = await serve(deck);
    const context = await served.go("context");
    const body = "[data-id='context-body']";
    const surface = (await style(context, ".dc-scene", "--dc-surface")).trim();
    expect(await style(context, body, "background-color")).toBe(rgb(surface));
    expect(await style(context, body, "border-top-width")).toBe("1px");
    expect(Number.parseFloat(await style(context, body, "border-top-left-radius"))).toBeGreaterThan(0);
    expect(Number.parseFloat(await style(context, body, "padding-top"))).toBeGreaterThan(0);
    // The built-in callout has an edge down its start side in the action color.
    const quote = "[data-id='context-quote']";
    expect(Number.parseFloat(await style(context, quote, "border-left-width"))).toBeGreaterThan(3);
    expect(await style(context, quote, "border-left-color")).toBe(rgb("#0B6E6E"));

    const banner = await served.go("banner");
    const filled = "[data-id='banner-body']";
    expect(await style(banner, filled, "background-color")).toBe(rgb("#0B6E6E"));
    const ground = (await style(banner, ".dc-scene", "--dc-bg")).trim();
    expect(await style(banner, filled, "color")).toBe(rgb(ground));
    // A block with no fill keeps the ink on the page.
    expect(await style(banner, "[data-id='banner-heading']", "color")).not.toBe(rgb(ground));
  }, 60_000);

  it("puts every slot's box within a pixel of its frame on a 1280 by 720 slide, on the fixture's templates and the built-in ones", async () => {
    const deck = copyDeck();
    moreScenes(deck);
    const opened = openDeck(deck);
    if (!opened.ok) throw new Error(`the deck has errors: ${JSON.stringify(opened.diagnostics)}`);
    const look = lookOf(opened.doc);
    const served = await serve(deck, { clean: true });
    let checked = 0;
    for (const id of ["welcome", "growth", "part", "claim", "pair", "photo"]) {
      const scene = opened.doc.scenes[id];
      const template = look.templates[scene?.template ?? ""];
      if (!template) throw new Error(`no template for ${id}`);
      const page = await served.go(id);
      const slide = await page.locator(".dc-scene").evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.left, y: box.top, w: box.width, h: box.height };
      });
      expect(Math.abs(slide.w - 1280), `${id} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(slide.h - 720), `${id} height`).toBeLessThanOrEqual(1);
      const drawn = await page.locator(".dc-slot").evaluateAll((slots) =>
        slots.map((slot) => {
          const box = slot.getBoundingClientRect();
          return {
            id: (slot as HTMLElement).dataset.slot ?? "",
            x: box.left,
            y: box.top,
            w: box.width,
            h: box.height,
          };
        }),
      );
      expect(drawn.length, `${id}: a slot with something in it is drawn`).toBeGreaterThan(0);
      for (const box of drawn) {
        const frame = template.slots.find((slot) => slot.id === box.id)?.frame;
        if (!frame) throw new Error(`${id}: the page drew a slot "${box.id}" the template does not have`);
        const want = {
          x: slide.x + (frame.x / 100) * 1280,
          y: slide.y + (frame.y / 100) * 720,
          w: (frame.w / 100) * 1280,
          h: (frame.h / 100) * 720,
        };
        for (const key of ["x", "y", "w", "h"] as const) {
          expect(Math.abs(box[key] - want[key]), `${id}/${box.id} ${key}`).toBeLessThanOrEqual(1);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(14);
  }, 90_000);

  it("moves a block when its slot's frame is edited in the template file, on every scene that uses the template", async () => {
    const deck = copyDeck();
    const growth = readJson(join(deck, "scenes", "growth.json"));
    addScene(deck, {
      ...growth,
      id: "growth-two",
      title: "Growth again",
      blocks: growth.blocks.map((block: Json) => ({
        ...block,
        id: String(block.id).replace("growth", "growth-two"),
      })),
    });
    const served = await serve(deck);
    const slot = ".dc-slot[data-slot='title']";
    for (const [scene, id] of [
      ["growth", "growth-title"],
      ["growth-two", "growth-two-title"],
    ] as const) {
      const page = await served.go(scene);
      expect(Math.round((await share(page, slot)).x), `${scene} before`).toBe(6);
      expect(Math.round((await share(page, `[data-id='${id}']`)).x), `${id} before`).toBe(6);
    }

    editJson(join(deck, "brand", "templates", "chart-and-note.json"), (template) => {
      const title = template.slots.find((entry: Json) => entry.id === "title");
      title.frame = { x: 20, y: 6, w: 60, h: 14 };
    });

    // The server reloads the page when the brand folder changes; the new frame must be on both scenes.
    const page = served.page;
    await expect.poll(async () => Math.round((await share(page, slot).catch(() => ({ x: -1 }))).x)).toBe(20);
    await settle(page, "growth-two");
    expect(Math.round((await share(page, "[data-id='growth-two-title']")).x)).toBe(20);
    const first = await served.go("growth");
    expect(Math.round((await share(first, slot)).x)).toBe(20);
    expect(Math.round((await share(first, "[data-id='growth-title']")).x)).toBe(20);
  }, 90_000);
});

// ---- text on a strong background ------------------------------------------------------------------------------------

/** The contrast of two `rgb(...)` colors, as WCAG counts it. */
function contrastOf(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const [red, green, blue] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const value = Number(part) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** A color of the slide itself, as `rgb(...)`, whatever a strong background has done to the colors under it. */
const slideColor = (page: Page, variable: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    (document.querySelector(".dc-player") as HTMLElement).append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, variable);

describe("text on a strong background", () => {
  const WIDE = 4.5;

  /** What the block is drawn in and on, and what the slide's own ink is. */
  async function look(page: Page, block: string) {
    return {
      color: await style(page, block, "color"),
      ground: await style(page, block, "background-color"),
      ink: await slideColor(page, "--dc-ink"),
      paper: await slideColor(page, "--dc-bg"),
      muted: await slideColor(page, "--dc-ink-muted"),
    };
  }

  it("draws a surface panel inside a dark section in the slide's own ink, and reads it", async () => {
    const deck = copyDeck();
    moreScenes(deck);
    // The built-in callout fills with the slide's surface: a light panel on the section's dark ground.
    editJson(join(deck, "scenes", "part.json"), (scene) => {
      scene.blocks[2].style = "callout";
    });
    const served = await serve(deck, { clean: true });
    const part = await served.go("part");
    const panel = await look(part, "[data-id='part-lede']");
    expect(panel.color).toBe(panel.ink);
    expect(panel.ground).not.toBe(panel.paper);
    expect(contrastOf(panel.color, panel.ground), "the panel's text on the panel").toBeGreaterThanOrEqual(
      WIDE,
    );
    // The rest of the section is still the reversed text on the dark ground.
    const title = await look(part, "[data-id='part-title']");
    expect(title.color).toBe(title.paper);
    expect(
      contrastOf(title.color, await style(part, ".dc-scene", "background-color")),
    ).toBeGreaterThanOrEqual(WIDE);

    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    expect((await renderer.render("part", { screenshot: false })).diagnostics).toEqual([]);
  }, 90_000);

  it("draws the fixture's quiet panel on its cover in the slide's own ink, and reads it", async () => {
    const deck = copyDeck();
    editJson(join(deck, "scenes", "welcome.json"), (scene) => {
      scene.blocks[2].style = "quiet-panel";
      scene.blocks[2].text = "The analytics team";
    });
    // A panel has padding and a border the plain byline does not, so the byline slot is made roomier for it.
    editJson(join(deck, "brand", "templates", "cover.json"), (template) => {
      template.slots.find((entry: Json) => entry.id === "byline").frame = { x: 8, y: 66, w: 60, h: 22 };
    });
    expect(openDeck(deck).ok).toBe(true);
    const served = await serve(deck, { clean: true });
    const welcome = await served.go("welcome");
    const panel = await look(welcome, "[data-id='welcome-byline']");
    expect(panel.color).toBe(panel.ink);
    expect(contrastOf(panel.color, panel.ground), "the panel's text on the panel").toBeGreaterThanOrEqual(
      WIDE,
    );
    // The panel's border is the slide's line, and its muted text, were there any, the slide's muted.
    const title = await look(welcome, "[data-id='welcome-title']");
    expect(title.color).toBe(title.paper);
    expect(
      contrastOf(title.color, await style(welcome, ".dc-scene", "background-color")),
    ).toBeGreaterThanOrEqual(3);

    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    expect((await renderer.render("welcome", { screenshot: false })).diagnostics).toEqual([]);
  }, 90_000);

  it("draws a block that names its own tone in that tone, on a strong cover too", async () => {
    const deck = copyDeck();
    // A cover on a teal both the slide's ink (3.3:1, enough for a large title) and its paper (4.9:1) can be read on, so the\n    // brand is sound, and the author asks for the ink on the title.
    editJson(join(deck, "brand", "brand.json"), (brand) => {
      brand.colors.paper.action = "#0C7575";
    });
    addScene(deck, {
      id: "cover-ink",
      title: "Cover in ink",
      template: "cover",
      blocks: [text("cover-ink-title", "heading", "Where the harbor grew", { slot: "title", tone: "text" })],
    });
    // The only scene, so the deck has no other scene to fail the light teal.
    editJson(join(deck, "deck.json"), (manifest) => {
      manifest.scenes = ["cover-ink"];
    });
    const opened = openDeck(deck);
    expect(opened.ok, JSON.stringify(opened.diagnostics)).toBe(true);
    const served = await serve(deck, { clean: true });
    const cover = await served.go("cover-ink");
    const title = await look(cover, "[data-id='cover-ink-title']");
    expect(title.color).toBe(title.ink);
    expect(title.color).not.toBe(title.paper);
    const ground = await style(cover, ".dc-scene", "background-color");
    expect(ground).toBe(rgb("#0C7575"));
    expect(contrastOf(title.color, ground)).toBeGreaterThanOrEqual(3);

    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    expect((await renderer.render("cover-ink", { screenshot: false })).diagnostics).toEqual([]);
  }, 90_000);

  it("draws a muted block of the slide's own in the slide's muted color, not the reversed one", async () => {
    const deck = copyDeck();
    editJson(join(deck, "brand", "brand.json"), (brand) => {
      brand.colors.paper.action = "#0C7575";
    });
    addScene(deck, {
      id: "cover-muted",
      title: "Cover with a muted line",
      template: "cover",
      blocks: [
        text("cover-muted-title", "heading", "Where the harbor grew", { slot: "title", tone: "text" }),
        text("cover-muted-byline", "body", "The analytics team", { slot: "byline", tone: "muted" }),
      ],
    });
    editJson(join(deck, "deck.json"), (manifest) => {
      manifest.scenes = ["cover-muted"];
    });
    const served = await serve(deck, { clean: true });
    const cover = await served.go("cover-muted");
    const byline = await look(cover, "[data-id='cover-muted-byline']");
    expect(byline.color).toBe(byline.muted);
    expect(byline.color).not.toBe(byline.paper);
  }, 90_000);

  it("leaves the fixture's reversed text on its cover as it was", async () => {
    const served = await serve(copyDeck(), { clean: true });
    const welcome = await served.go("welcome");
    for (const block of ["welcome-kicker", "welcome-title", "welcome-byline"]) {
      const drawn = await look(welcome, `[data-id='${block}']`);
      // The kicker is in the brand's action color (its own tone); the others are the reversed text.
      if (block === "welcome-kicker") continue;
      expect(drawn.color, block).toBe(drawn.paper);
    }
  }, 60_000);
});

// ---- the offline export ----------------------------------------------------------------------------------------------

describe("a deck with a brand, exported", () => {
  it("shows the brand's face, logo and colors with every request that is not a file blocked", async () => {
    const deck = copyDeck();
    const result = exportDeck({ folder: deck, out: join(root as string, "out") });
    if (!result.ok) throw new Error(`the export failed: ${JSON.stringify(result.diagnostics)}`);
    const index = pathToFileURL(join(result.summary.out, "index.html")).href;

    // The network is off for this page: nothing but files may load, and anything else that asks is counted.
    const context = await (browser as Browser).newContext({
      viewport: { width: 1280, height: 781 },
      reducedMotion: "reduce",
      offline: true,
    });
    closers.push(() => context.close());
    const blocked: string[] = [];
    await context.route(
      (url) => url.protocol !== "file:",
      (route) => {
        blocked.push(route.request().url());
        return route.abort();
      },
    );
    const page = await context.newPage();
    watch(page);
    const asked: string[] = [];
    page.on("request", (request) => asked.push(request.url()));

    await page.goto(`${index}#/welcome`);
    await settle(page, "welcome");
    expect(await style(page, ".dc-scene", "background-color")).toBe(rgb("#0B6E6E"));

    await page.goto(`${index}#/growth`);
    await settle(page, "growth");
    const fills = await page
      .locator(".dc-mark")
      .evaluateAll((marks) => [...new Set(marks.map((mark) => getComputedStyle(mark).fill))]);
    expect(fills).toEqual([rgb("#0B6E6E"), rgb("#2D4BB8"), rgb("#B4531F")]);
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => `${face.family} ${face.weight}`),
    );
    expect(loaded).toContain("Harbor Display 700");
    expect(loaded).toContain("Harbor Sans 400");
    expect(await style(page, ".dc-heading", "font-family")).toContain("Harbor Display");
    expect(
      await page
        .locator(".dc-logo")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    ).toBe(true);
    expect(await page.locator(".dc-footer").textContent()).toBe("Harbor Analytics, for internal use");
    expect(await page.locator(".dc-number").textContent()).toBe("3");
    expect(asked.some((url) => url.endsWith("/brand/fonts/HarborSans-Bold.woff2"))).toBe(true);
    expect(asked.some((url) => url.endsWith("/brand/logos/harbor.svg"))).toBe(true);
    expect(blocked).toEqual([]);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: 1280, height: 720 });
      for (const scene of ["welcome", "context", "growth"]) {
        await page.goto(`${index}#/${scene}`);
        await settle(page, scene);
        await page.screenshot({ path: join(SHOTS, `brand-export-${scene}.png`), animations: "disabled" });
      }
    }
  }, 90_000);
});

// ---- depthcue render -------------------------------------------------------------------------------------------------

describe("depthcue render, on a deck with a brand", () => {
  async function render(folder: string, scene: string, options: { screenshot?: boolean } = {}) {
    const renderer = await openRenderer(folder);
    closers.push(() => renderer.close());
    return renderer.render(scene, { screenshot: options.screenshot ?? false });
  }
  const codes = (result: { diagnostics: Array<{ code: string }> }) => result.diagnostics.map((d) => d.code);

  it("renders the fixture's three scenes with nothing to report", async () => {
    const deck = copyDeck();
    expect(openDeck(deck).ok).toBe(true);
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    for (const scene of ["welcome", "context", "growth"]) {
      const result = await renderer.render(scene);
      expect(result.diagnostics, scene).toEqual([]);
      expect(result.png?.length, `${scene} has a picture`).toBeGreaterThan(1000);
    }
  }, 90_000);

  it("reports a slot-overflow when a slot's blocks are taller than the slot", async () => {
    const deck = copyDeck();
    editJson(join(deck, "scenes", "welcome.json"), (scene) => {
      scene.blocks[2].text = `${"The analytics team presents the third quarter, berth by berth, ".repeat(3)}and what comes next.`;
    });
    const result = await render(deck, "welcome");
    expect(codes(result)).toContain("slot-overflow");
    const found = result.diagnostics.find((d) => d.code === "slot-overflow");
    expect(found?.severity).toBe("error");
    expect(found?.message).toContain('"byline"');
    expect(found?.path).toBe("/blocks/2");
  }, 60_000);

  it("reports a chrome-overlap when a slot runs under the logo, and nothing when the title keeps to its side", async () => {
    const deck = copyDeck();
    // A title slot that reaches the logo's corner with the text at its end, so the first line sits under the logo.
    editJson(join(deck, "brand", "templates", "chart-and-note.json"), (template) => {
      template.slots.find((entry: Json) => entry.id === "title").frame = { x: 6, y: 6, w: 88, h: 14 };
    });
    editJson(join(deck, "scenes", "growth.json"), (scene) => {
      scene.blocks[0].align = "end";
    });
    const result = await render(deck, "growth");
    expect(codes(result)).toContain("chrome-overlap");
    const found = result.diagnostics.find((d) => d.code === "chrome-overlap");
    expect(found?.message).toContain("logo");
    expect(found?.message).toContain('"growth-title"');
  }, 60_000);

  it("reports a background-low-contrast on a bright picture, measured on the pixels, and passes a dark one or a stronger scrim", async () => {
    const deck = copyDeck();
    moreScenes(deck);
    const template = join(deck, "brand", "templates", "photo.json");
    const withPicture = (image: string, scrim: number) =>
      editJson(template, (json) => {
        json.background = { color: "text", image, scrim };
      });

    withPicture("images/bright.svg", 0);
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const bright = await renderer.render("photo", { screenshot: false });
    expect(codes(bright)).toContain("background-low-contrast");
    const found = bright.diagnostics.find((d) => d.code === "background-low-contrast");
    expect(found?.severity).toBe("error");
    expect(found?.message).toContain("template's picture");

    // The same page with a scrim of the template's color over the picture is readable.
    withPicture("images/bright.svg", 90);
    expect(codes(await renderer.render("photo", { screenshot: false }))).not.toContain(
      "background-low-contrast",
    );

    // And a dark picture needs none: what counts is the picture as drawn, not the token the template names.
    withPicture("images/night.svg", 0);
    expect(codes(await renderer.render("photo", { screenshot: false }))).not.toContain(
      "background-low-contrast",
    );
  }, 90_000);

  /**
   * A two-column slide of the built-in template: the title, a column of `sentences` sentences on the left and one on the
   * right, and the sources they cite. A source's title is as long as `title` says, and the sources are set along the foot.
   */
  function pairWithSources(
    deck: string,
    id: string,
    sentences: number,
    sources: { count: number; title: string },
  ) {
    const sentence = "Berth A never closed, and moved forty ships in July before the dredging began.";
    const body = (side: string) =>
      text(`${id}-${side}`, "body", Array(sentences).fill(sentence).join(" "), { slot: side });
    const cited = Array.from({ length: sources.count }, (_, at) => `${id}-source-${at + 1}`);
    addScene(deck, {
      id,
      title: "Pair with sources",
      template: "two-column",
      blocks: [
        text(`${id}-title`, "heading", "Two berths, two stories", { slot: "title" }),
        body("left"),
        body("right"),
      ],
      sources: cited.map((source, at) => ({ id: source, title: `${sources.title} (${at + 1})` })),
    });
  }
  const LONG_SOURCE =
    "Harbor master's berth log for July to September, as audited by the port authority and filed with its annual review of the berths";

  it("reports the sources along the foot that lie over a slot's content, which the slot's own check cannot see", async () => {
    const deck = copyDeck();
    // Six sentences in each column and eight sources: the columns are inside their slots, which run to the foot, and the
    // sources are set over their last lines.
    pairWithSources(deck, "crowded", 6, { count: 8, title: LONG_SOURCE });
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const result = await renderer.render("crowded", { screenshot: false });
    const found = result.diagnostics.filter((d) => d.code === "sources-overlap");
    expect(found.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.message).toContain("The sources along the foot of the slide overlap");
    expect(found.map((d) => d.message).join(" ")).toMatch(/"crowded-(left|right)"/);
    // It says what to change: fewer or shorter sources, or less above them.
    expect(found[0]?.fix).toContain("fewer or shorter sources");
    expect(found[0]?.path).toMatch(/^\/blocks\/\d+$/);
  }, 60_000);

  it("reports nothing when the content stops above the sources, or the sources are few and short", async () => {
    const deck = copyDeck();
    pairWithSources(deck, "roomy-long", 3, { count: 8, title: LONG_SOURCE });
    pairWithSources(deck, "roomy-short", 4, { count: 1, title: "Harbor master's berth log" });
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    for (const scene of ["roomy-long", "roomy-short"]) {
      expect((await renderer.render(scene, { screenshot: false })).diagnostics, scene).toEqual([]);
    }
  }, 60_000);

  it("reports the sources that lie over the logo in a bottom corner, and nothing with the logo where it was", async () => {
    const deck = copyDeck();
    // Three long sources set over several lines along the foot, under content that stops well above them.
    pairWithSources(deck, "foot-logo", 3, { count: 3, title: LONG_SOURCE });
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const render = async (logo: { corner: string; size: string }) => {
      editJson(join(deck, "brand", "brand.json"), (brand) => {
        brand.chrome.logo = logo;
      });
      return renderer.render("foot-logo", { screenshot: false });
    };

    // The fixture's own logo, small in the top corner: nothing is under the sources.
    expect((await render({ corner: "top-end", size: "s" })).diagnostics).toEqual([]);

    const found = (await render({ corner: "bottom-end", size: "l" })).diagnostics.filter(
      (d) => d.code === "sources-overlap",
    );
    expect(found.length, "the sources reach the logo at the foot").toBeGreaterThan(0);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.message).toContain("overlap the brand's logo by");
    // It says what to change in the logo, not only in the sources.
    expect(found[0]?.fix).toContain("fewer or shorter sources");
    expect(found[0]?.fix).toContain("make the logo smaller");
    expect(found[0]?.fix).toContain("move it to a top corner");
  }, 60_000);
  it("reports the sources that run into a chart's own citation, and not the one source that sits under it", async () => {
    const deck = copyDeck();
    // The chart cites one source, and the foot lists it with two more: the foot grows to a second line, which comes up
    // over the citation at the bottom of the chart.
    editJson(join(deck, "scenes", "growth.json"), (scene) => {
      scene.sources = [1, 2, 3].map((n) => ({
        id: `src-${n}`,
        title: `Harbor master's berth log, volume ${n}, July to September`,
      }));
      scene.blocks[1].sourceIds = ["src-1"];
    });
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const found = (await renderer.render("growth", { screenshot: false })).diagnostics.filter(
      (d) => d.code === "sources-overlap",
    );
    expect(found.map((d) => d.message).join(" ")).toContain('overlap "growth-chart"');
  }, 60_000);
  it("gives a logo only the room its height needs at the top: a slide that fits without the small logo fits with it", async () => {
    const withLogo = copyDeck("v0-4-brand", "with-logo");
    const without = copyDeck("v0-4-brand", "without-logo");
    editJson(join(without, "brand", "brand.json"), (brand) => {
      delete brand.chrome.logo;
    });
    // The same claim-evidence slide at ever longer claims, up to the one that is too long for the stage either way. A
    // small logo sits in the margin every slide has, so it must change nothing about what fits; with the room a
    // logo of its size does not need, the claim that just fits (18 words, here) ran 14px over the stage.
    const claim =
      "Ships handled rose by a third once the berths reopened in August and the gain held through September, October and November, with all three running at capacity".split(
        " ",
      );
    const counts = [8, 14, 16, 17, 18, 19, 20, 30];
    for (const deck of [withLogo, without]) {
      for (const count of counts) {
        addScene(deck, {
          id: `claim-${count}`,
          title: "Claim",
          layout: "claim-evidence",
          summary: {
            id: `claim-${count}-claim`,
            text: claim.slice(0, count).join(" "),
            evidenceIds: [`claim-${count}-chart`],
          },
          blocks: [chart(`claim-${count}-chart`)],
        });
      }
    }
    const [one, other] = [await openRenderer(withLogo), await openRenderer(without)];
    closers.push(
      () => one.close(),
      () => other.close(),
    );
    const seen: Record<number, string[]> = {};
    for (const count of counts) {
      const id = `claim-${count}`;
      const [a, b] = [
        await one.render(id, { screenshot: false }),
        await other.render(id, { screenshot: false }),
      ];
      seen[count] = codes(b);
      expect(codes(a), `${id}: the same findings with the small logo as without it`).toEqual(codes(b));
      expect(
        a.diagnostics.map((d) => d.message),
        `${id}: and the same by as much`,
      ).toEqual(b.diagnostics.map((d) => d.message));
    }
    // The range runs from a slide that fits to one that does not, so the comparison above is about the edge.
    expect(seen[8], "8 words fit").toEqual([]);
    expect(seen[30], "30 words do not").toContain("overflow");
  }, 120_000);

  it("pads the top of a slide as far as the logo reaches past the margin every slide has, and no further", async () => {
    const deck = copyDeck();
    layoutScenes(deck);
    const served = await serve(deck, { clean: true });
    const room = async () => {
      // A blank page first: going to the same address with only its hash unchanged would not load the page again.
      await served.page.goto("about:blank");
      const page = await served.go("lay-title");
      // The scene is found and read in one turn of the page: the page can draw it again a moment after it settles (the
      // dev server does when a file it watches reports a change), and a scene found before that and read after it is
      // no longer in the page, and has no style to give. A turn that finds no scene is tried again.
      for (let attempt = 0; attempt < 5; attempt++) {
        await frames(page);
        const em = await page.evaluate(() => {
          const scene = document.querySelector(".dc-scene");
          if (!scene?.isConnected) return Number.NaN;
          const computed = getComputedStyle(scene);
          return Number.parseFloat(computed.paddingTop) / Number.parseFloat(computed.fontSize);
        });
        if (!Number.isNaN(em)) return em;
      }
      throw new Error("the scene has no padding to read");
    };
    const logoOf = (size?: string) =>
      editJson(join(deck, "brand", "brand.json"), (brand) => {
        if (size) brand.chrome.logo = { corner: "top-end", size };
        else delete brand.chrome.logo;
      });
    logoOf();
    const margin = await room();
    logoOf("s");
    expect(await room(), "a small logo ends inside the margin").toBeCloseTo(margin, 1);
    logoOf("m");
    expect(await room(), "a medium logo reaches a little past it").toBeGreaterThan(margin);
    const medium = await room();
    logoOf("l");
    expect(await room(), "and a large one further").toBeGreaterThan(medium);
    expect(medium - margin, "by a medium logo's height, not by more").toBeLessThanOrEqual(1.1);
    // A logo at the foot pads the foot, and leaves the top at the margin.
    editJson(join(deck, "brand", "brand.json"), (brand) => {
      brand.chrome.logo = { corner: "bottom-end", size: "l" };
    });
    expect(await room(), "a logo at the foot leaves the top at the margin").toBeCloseTo(margin, 1);
  }, 90_000);
  it("keeps the chrome off the content of the three built-in layouts in every corner, with the largest logo", async () => {
    const deck = copyDeck();
    const scenes = layoutScenes(deck);
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    for (const corner of ["top-start", "top-end", "bottom-start", "bottom-end"]) {
      editJson(join(deck, "brand", "brand.json"), (brand) => {
        brand.chrome.logo = { corner, size: "l" };
      });
      for (const scene of scenes) {
        const result = await renderer.render(scene, { screenshot: false });
        expect(codes(result), `${scene} with the logo at ${corner}`).toEqual([]);
      }
    }
  }, 120_000);
});

// ---- decks with no brand ---------------------------------------------------------------------------------------------

describe("a deck with no brand", () => {
  /** The same deck from a server with no look to give: the page is drawn from the deck alone, as it was before. */
  async function withoutLook(deck: string, options: { clean?: boolean } = {}) {
    // The 404 is the point of this page, so the browser's console note of it is not a problem.
    const served = await serve(deck, { quiet: true, ...options });
    await served.context.route("**/look.json", (route) => route.fulfill({ status: 404, body: "" }));
    return served;
  }

  it("tells a small change of color apart from rounding: a muted text color 16 steps lighter is a different picture", async () => {
    const deck = copyDeck("v0-1", "v0-1");
    // Four drawings of one slide, all the same size and with the page's policy off so a style can be added to one: three
    // as they are, and one with the color moved.
    const [one, two, three, four] = [
      await withoutLook(deck, { clean: true }),
      await withoutLook(deck, { clean: true }),
      await withoutLook(deck, { clean: true }),
      await withoutLook(deck, { clean: true }),
    ];
    const [a, b, c, shiftedPage] = [
      await one.go("demand"),
      await two.go("demand"),
      await three.go("demand"),
      await four.go("demand"),
    ];
    // The muted color of the page, read as the page has it, and moved 16 steps in each channel: not a change anyone
    // would call a different look, and what a drawing of the same page twice never does.
    const muted = await shiftedPage.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--dc-muted)";
      (document.querySelector(".dc-player") as HTMLElement).append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const [red, green, blue] = (muted.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [
      number,
      number,
      number,
    ];
    const shifted = `rgb(${[red, green, blue].map((channel) => Math.min(255, channel + 16)).join(", ")})`;
    expect(shifted).not.toBe(muted);
    await shiftedPage.addStyleTag({ content: `.dc-player { --dc-muted: ${shifted} !important; }` });
    await frames(shiftedPage);
    const message = await sameStage(shiftedPage, a, b, "demand with a lighter muted color");
    expect(message).toMatch(/pixels differ, at most by \d+, within/);
    // The control: the same page drawn twice is the same page, so the message above is about the color.
    expect(await sameStage(c, a, b, "demand twice")).toBeUndefined();
  }, 90_000);

  for (const name of ["v0-1", "v0-2", "v0-3", "demo", "charts"]) {
    it(`${name} is drawn the same with the look the server sends as without it`, async () => {
      const deck = copyDeck(name, name);
      const opened = openDeck(deck);
      if (!opened.ok) throw new Error(`the deck has errors: ${JSON.stringify(opened.diagnostics)}`);
      const scenes = opened.doc.deck.scenes;

      const withLook = await serve(deck);
      const [without, control] = [await withoutLook(deck), await withoutLook(deck)];

      // Each scene is a fresh load of each page. Chrome's drawing of a page after an in-page change of scene can differ
      // from another page's in a few edge pixels, by a rounding, though the DOM, the computed styles and every box are
      // the same: on a Linux runner 19 pixels of a donut and of one text edge, by at most 4 steps, between the page with
      // the look and two without it, and now and then between two without it. Opened fresh, 60 of 60 pairs were equal.
      for (const scene of scenes) {
        const a = await withLook.go(scene, { fresh: true });
        const b = await without.go(scene, { fresh: true });
        const c = await control.go(scene, { fresh: true });
        expect(
          await sameStage(a, b, c, `${name}/${scene}`),
          `${name}/${scene} looks the same with and without a look`,
        ).toBeUndefined();
        expect(await a.locator(".dc-chrome, .dc-slot, .dc-backdrop").count(), `${name}/${scene}`).toBe(0);
      }
    }, 150_000);
  }
});

// ---- the pictures Dimitri looks at -----------------------------------------------------------------------------------

describe.skipIf(!SHOTS)("screenshots of the brand", () => {
  it("writes a 1280 by 720 picture of every scene of the fixture and of the added ones", async () => {
    const dir = SHOTS as string;
    mkdirSync(dir, { recursive: true });
    const deck = copyDeck();
    moreScenes(deck);
    layoutScenes(deck);
    const renderer = await openRenderer(deck);
    closers.push(() => renderer.close());
    const opened = openDeck(deck);
    if (!opened.ok) throw new Error(`the deck has errors: ${JSON.stringify(opened.diagnostics)}`);
    for (const scene of opened.doc.deck.scenes) {
      const result = await renderer.render(scene);
      writeFileSync(join(dir, `brand-${scene}.png`), result.png as Buffer);
      console.log(`${scene}: ${result.diagnostics.map((d) => d.code).join(", ") || "no findings"}`);
    }
  }, 180_000);
});
