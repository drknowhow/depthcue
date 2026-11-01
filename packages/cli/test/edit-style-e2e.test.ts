import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDoc, revisionOf } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { exportDeck } from "../src/export.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * The deck's look from the Style section of the Deck popover, in a real Chrome: a color picked on a swatch reaches the
 * deck file and the slide, a color that leaves text unreadable does not, a font pair loads the files it names, the
 * right-click menu opens the section, an export of a deck in another pair carries only that pair, and the editor and
 * `depthcue apply` write the same file for the same change.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

/** A server with no browser to render in. None of these tests is about layout, and none needs a second Chrome. */
const NO_LAYOUT: LayoutChecker = {
  async check() {
    return { available: false, message: "Layout checks are off in this test." };
  },
  async close() {},
};

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let folder: string;
let server: RunningServer;
let context: BrowserContext;
let page: Page;
let problems: string[];
/** Every font file the page asked for, with the status it got. */
let fontResponses: Array<{ name: string; status: number }>;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtEditorDir(), "editor.js")))
      throw new Error("The editor is not built. Run pnpm build.");
    if (!existsSync(join(builtPlayerDir(), "fonts", "all.css")))
      throw new Error("The fonts are not built. Run pnpm build.");
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
  root = mkdtempSync(join(tmpdir(), "depthcue-style-e2e-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({
    folder,
    playerDir: builtPlayerDir(),
    editorDir: builtEditorDir(),
    port: 0,
    layout: NO_LAYOUT,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  fontResponses = [];
  watch(page);
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

/** Collects what a page logs as an error and every font file it is sent. */
function watch(target: Page) {
  target.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  target.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  target.on("response", (response) => {
    const url = response.url();
    if (url.endsWith(".woff2"))
      fontResponses.push({ name: url.slice(url.lastIndexOf("/") + 1), status: response.status() });
  });
}

const docAt = (dir: string) => {
  const loaded = loadDoc(loadDeckDir(dir));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
const disk = () => docAt(folder);
const headline = () => page.locator(".ed-frame [data-id='opening-title']");
const popover = () => page.locator(".ed-actions .ed-tb-pop:not([hidden])");
const swatch = (color: string) => popover().locator(`[data-field='panel:deck:palette:${color}']`);

async function open() {
  await page.goto(server.url);
  await headline().waitFor();
}

/** Opens the Deck popover and its Style section, the way a person does. */
async function openStyle() {
  await page.locator(".ed-actions [data-tb='deck']").click();
  await popover().waitFor();
  const section = popover().locator("details[data-section='style']");
  if ((await section.getAttribute("open")) === null) await section.locator("summary").click();
  await swatch("evidence").waitFor();
}

/** Opens a scene of the strip by its number, from 1. */
async function goTo(number: number) {
  await page
    .locator(".ed-scene")
    .nth(number - 1)
    .click();
}

/** What a color picker does as it is dragged: an input event for each color, and no change until it closes. */
const drag = (color: string, value: string) =>
  swatch(color).evaluate((node, next) => {
    const input = node as HTMLInputElement;
    input.value = next;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
const release = (color: string) =>
  swatch(color).evaluate((node) => node.dispatchEvent(new Event("change", { bubbles: true })));

/** The first family of the heading's font stack, without its quotes. */
const headingFamily = () =>
  headline().evaluate((node) => {
    const first = getComputedStyle(node).fontFamily.split(",")[0] ?? "";
    return first.trim().replace(/^["']|["']$/g, "");
  });

/** The families of the faces the page has loaded, without quotes. */
const loadedFamilies = (target: Page = page) =>
  target.evaluate(() =>
    [
      ...new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family)),
    ].map((family) => family.replace(/^["']|["']$/g, "")),
  );

/** The evidence color an element is drawn in, whether the preset or the deck's palette gives it. */
const evidenceOn = (target: Page, selector: string) =>
  target
    .locator(selector)
    .first()
    .evaluate((node) => getComputedStyle(node).getPropertyValue("--dc-evidence").trim());
/** The evidence color the deck sets on the element itself, which is nothing while the palette does not name it. */
const evidenceSet = (target: Page, selector: string) =>
  target
    .locator(selector)
    .first()
    .evaluate((node) => (node as HTMLElement).style.getPropertyValue("--dc-evidence"));

describe("the Style section of the Deck popover in a real browser", () => {
  it("saves a picked color to the deck file and draws it on the slide, in the editor and at /present", async () => {
    await open();
    await goTo(2);
    await openStyle();
    const preset = await evidenceOn(page, ".ed-frame");
    expect(preset).not.toBe("#0044cc");
    expect(await evidenceSet(page, ".ed-frame")).toBe("");
    await swatch("evidence").fill("#0044cc");
    await expect.poll(() => disk().deck.palette).toEqual({ evidence: "#0044cc" });
    await page.locator(".ed-status[data-state='saved']").waitFor();
    expect(await evidenceOn(page, ".ed-frame")).toBe("#0044cc");
    // Every bar of the chart is drawn in the evidence color, so the pick is on the pixels and not only in a variable.
    const bar = page.locator(".ed-frame .dc-bar").first();
    await bar.waitFor();
    expect(await bar.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(0, 68, 204)");
    // The deck that was saved is the deck the audience sees.
    const present = await context.newPage();
    watch(present);
    // At the last step of the scene, where the chart is shown.
    await present.goto(`${server.url}present#/demand/2`);
    await present.locator(".dc-scene .dc-bar").first().waitFor();
    expect(await evidenceOn(present, ".dc-player")).toBe("#0044cc");
    expect(
      await present
        .locator(".dc-scene .dc-bar")
        .first()
        .evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe("rgb(0, 68, 204)");
    expect(problems).toEqual([]);
  });

  it("says a color that would leave text unreadable and keeps it out of the deck", async () => {
    await open();
    await openStyle();
    const before = readFileSync(join(folder, "deck.json"), "utf8");
    // Light text on the paper preset: below the contrast the deck requires.
    await drag("text", "#f5f2ea");
    const line = popover().locator("[data-color='text'] .ed-problem");
    await line.waitFor();
    expect(await line.textContent()).toMatch(/contrast|readable|text/i);
    expect(await page.locator(".ed-hint[data-problem]").count()).toBe(1);
    expect(await page.locator(".ed-hint[data-problem]").textContent()).toMatch(/contrast|readable|text/i);
    // The picker closes: the swatch goes back to what the deck says and the refusal is taken down.
    await release("text");
    await expect.poll(() => swatch("text").inputValue()).not.toBe("#f5f2ea");
    expect(await line.isHidden()).toBe(true);
    expect(await page.locator(".ed-hint[data-problem]").count()).toBe(0);
    // Nothing was saved, and the slide was never drawn in the refused color.
    await page.waitForTimeout(300);
    expect(readFileSync(join(folder, "deck.json"), "utf8")).toBe(before);
    expect(disk().deck.palette).toBeUndefined();
    expect(
      await headline().evaluate((node) => getComputedStyle(node).color),
      "the heading is still in the preset's text color",
    ).not.toBe("rgb(245, 242, 234)");
    expect(problems).toEqual([]);
  });

  it("puts a color back to the preset with Reset, one undo from the pick", async () => {
    await open();
    await openStyle();
    const preset = await evidenceOn(page, ".ed-frame");
    await swatch("evidence").fill("#0044cc");
    await expect.poll(() => disk().deck.palette).toEqual({ evidence: "#0044cc" });
    await popover().locator("[data-field='panel:deck:palette:evidence:reset']").click();
    await expect.poll(() => disk().deck.palette).toBeUndefined();
    expect(await evidenceSet(page, ".ed-frame")).toBe("");
    expect(await evidenceOn(page, ".ed-frame")).toBe(preset);
    await page.keyboard.press("Control+z");
    await expect.poll(() => disk().deck.palette).toEqual({ evidence: "#0044cc" });
    expect(problems).toEqual([]);
  });

  it("loads the faces of the font pair the deck has: Instrument Serif by default, IBM Plex Sans after Technical", async () => {
    await open();
    await expect.poll(() => headingFamily()).toBe("Instrument Serif");
    await expect.poll(() => loadedFamilies()).toContain("Instrument Serif");
    expect(await loadedFamilies()).not.toContain("IBM Plex Sans");
    await openStyle();
    await popover().locator("label.ed-choice[data-fonts='technical']").click();
    await expect.poll(() => disk().deck.fonts).toBe("technical");
    await page.locator(".ed-status[data-state='saved']").waitFor();
    expect(await headline().evaluate((node) => node.closest(".ed-frame")?.getAttribute("data-fonts"))).toBe(
      "technical",
    );
    await expect.poll(() => headingFamily()).toBe("IBM Plex Sans");
    // The page asked for the faces it shows and was given them, from this server and nowhere else.
    await expect.poll(() => loadedFamilies()).toContain("IBM Plex Sans");
    expect(fontResponses.length).toBeGreaterThan(0);
    expect(fontResponses.filter((response) => response.status !== 200)).toEqual([]);
    expect(fontResponses.map((response) => response.name)).toContain("IBMPlexSans-Regular.woff2");
    // The choice is the deck's, so it is in the file and a second look at the deck reads it from there.
    expect(readFileSync(join(folder, "deck.json"), "utf8")).toContain('"fonts": "technical"');
    expect(problems).toEqual([]);
  });

  it("opens from the slide's right-click menu with the section open and the focus inside it", async () => {
    await open();
    await goTo(3);
    const view = page.locator(".ed-canvas-host .dc-view");
    const box = await view.boundingBox();
    if (!box) throw new Error("the slide should have a box");
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8, { button: "right" });
    const menu = page.locator(".ed-menu:not(.ed-menu-sub)");
    await menu.waitFor();
    await page.getByRole("menuitem", { name: "Deck style", exact: true }).click();
    await popover().waitFor();
    expect(await popover().locator("details[data-section='style']").getAttribute("open")).not.toBeNull();
    // The menu has closed and given the focus back, and the focus went to the first control of the section.
    expect(await menu.isHidden()).toBe(true);
    const focused = await page.evaluate(() => {
      const node = document.activeElement;
      return {
        field: node?.getAttribute("data-field") ?? null,
        section: node?.closest("details")?.getAttribute("data-section") ?? null,
        open: (node?.closest("details") as HTMLDetailsElement | null)?.open ?? false,
      };
    });
    expect(focused).toEqual({ field: "panel:deck:theme", section: "style", open: true });
    expect(problems).toEqual([]);
  });

  it("keeps the popover with its Style section open inside the window, and scrolls it, on a laptop and a phone", async () => {
    for (const size of [
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await open();
      await openStyle();
      const box = await popover().boundingBox();
      if (!box) throw new Error("the popover should be on screen");
      const where = `${size.width}x${size.height}`;
      expect(box.x, `${where} left`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${where} right`).toBeLessThanOrEqual(size.width + 1);
      expect(box.y + box.height, `${where} bottom`).toBeLessThanOrEqual(size.height + 1);
      // It is taller than the room it has, so it scrolls and its last row, a font pair, can be reached.
      expect(await popover().evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
      await popover().evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await popover().locator("label.ed-choice[data-fonts='technical']").click();
      await expect.poll(() => disk().deck.fonts).toBe("technical");
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, `${where} sideways scroll`).toBeLessThanOrEqual(0);
      // Back to the default pair, so the next size starts from the same deck.
      await page.locator("label.ed-choice[data-fonts='editorial']").click();
      await expect.poll(() => disk().deck.fonts).toBe("editorial");
      await page.keyboard.press("Escape");
    }
    expect(problems).toEqual([]);
  });

  it("opens from the command palette too", async () => {
    await open();
    await page.keyboard.press("Control+k");
    await page.locator(".ed-palette-option").first().waitFor();
    await page.keyboard.type("deck style");
    await page.locator(".ed-palette-option[data-command='deck-style']").waitFor();
    await page.keyboard.press("Enter");
    await popover().waitFor();
    expect(await popover().locator("details[data-section='style']").getAttribute("open")).not.toBeNull();
    expect(problems).toEqual([]);
  });
});

/**
 * The deck file and each scene file under `dir`, by path. `review.json` is left out: `depthcue apply` records an
 * agent's change in it for the person to look over, and the editor's author is that person.
 */
function written(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (name.endsWith(".json") && name !== "review.json")
        out[relative(dir, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  visit(dir);
  return out;
}

const capture = () => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) } };
};

describe("one change, two ways in", () => {
  it("writes the same files from the editor as `depthcue apply` does for the same color and font pair", async () => {
    // The agent's copy of the deck, changed from the command line the way an agent changes it.
    const agent = join(root, "agent");
    cpSync(demo, agent, { recursive: true });
    const opsFile = join(root, "ops.json");
    writeFileSync(
      opsFile,
      JSON.stringify([
        { op: "deck.set", set: { palette: { evidence: "#0044cc" } } },
        { op: "deck.set", set: { fonts: "modern" } },
      ]),
    );
    const done = capture();
    const code = await run(["apply", agent, opsFile, "--base-rev", revisionOf(docAt(agent))], done.io);
    expect(code, done.errors.join("\n")).toBe(0);

    // The person's copy, changed in the editor with the mouse.
    await open();
    await openStyle();
    await swatch("evidence").fill("#0044cc");
    await expect.poll(() => disk().deck.palette).toEqual({ evidence: "#0044cc" });
    await popover().locator("label.ed-choice[data-fonts='modern']").click();
    await expect.poll(() => disk().deck.fonts).toBe("modern");
    await page.locator(".ed-status[data-state='saved']").waitFor();

    const mine = written(folder);
    const theirs = written(agent);
    expect(Object.keys(mine).sort()).toEqual(Object.keys(theirs).sort());
    expect(mine["deck.json"]).toBe(theirs["deck.json"]);
    expect(mine).toEqual(theirs);
    expect(JSON.parse(mine["deck.json"] as string)).toMatchObject({
      schemaVersion: "0.3",
      palette: { evidence: "#0044cc" },
      fonts: "modern",
    });
    expect(problems).toEqual([]);
  });
});

describe("an export of a deck in another font pair", () => {
  it("carries the files of that pair and no other, and shows them from a folder with the network off", async () => {
    const opsFile = join(root, "ops.json");
    writeFileSync(opsFile, JSON.stringify([{ op: "deck.set", set: { fonts: "technical" } }]));
    const done = capture();
    expect(
      await run(["apply", folder, opsFile, "--base-rev", revisionOf(disk())], done.io),
      done.errors.join("\n"),
    ).toBe(0);

    const out = join(root, "out");
    const result = exportDeck({ folder, out, notes: true });
    if (!result.ok) throw new Error(`the export failed: ${JSON.stringify(result.diagnostics)}`);
    expect(result.summary.fonts).toBe("technical");
    expect(readdirSync(join(out, "fonts")).sort()).toEqual([
      "IBMPlexMono-Regular.woff2",
      "IBMPlexSans-Bold.woff2",
      "IBMPlexSans-Italic.woff2",
      "IBMPlexSans-Regular.woff2",
      "technical.css",
    ]);

    // Nothing but files may load: the network is off, and anything else that asks is counted.
    if (!browser) throw new Error("the browser should be up");
    const offline = await browser.newContext({ viewport: { width: 1280, height: 800 }, offline: true });
    const blocked: string[] = [];
    const requested: string[] = [];
    try {
      await offline.route(
        (url) => url.protocol !== "file:",
        (route) => {
          blocked.push(route.request().url());
          return route.abort();
        },
      );
      const exported = await offline.newPage();
      watch(exported);
      exported.on("request", (request) => requested.push(request.url()));
      await exported.goto(pathToFileURL(join(out, "index.html")).href);
      const heading = exported.locator(".dc-scene h1, .dc-scene h2").first();
      await heading.waitFor();
      await exported.evaluate(() =>
        (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled(),
      );
      const family = () =>
        heading.evaluate((node) =>
          (getComputedStyle(node).fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim(),
        );
      expect(await family()).toBe("IBM Plex Sans");
      await expect.poll(() => loadedFamilies(exported)).toContain("IBM Plex Sans");
      expect(await loadedFamilies(exported)).not.toContain("Instrument Serif");
      expect(requested.every((url) => url.startsWith("file:"))).toBe(true);
      expect(blocked).toEqual([]);
      const fonts = requested
        .filter((url) => url.endsWith(".woff2"))
        .map((url) => url.slice(url.lastIndexOf("/") + 1));
      expect(fonts.length).toBeGreaterThan(0);
      for (const name of fonts)
        expect(name, "an exported page asked for a face of another pair").toMatch(/^IBMPlex/);
      expect(requested.map((url) => url.slice(url.lastIndexOf("/") + 1))).toContain("technical.css");
      expect(problems).toEqual([]);
    } finally {
      await offline.close();
    }
  });
});
