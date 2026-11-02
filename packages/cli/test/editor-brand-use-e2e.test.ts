import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Block,
  blockStylesOf,
  type Doc,
  loadDoc,
  type NewScene,
  type Op,
  retemplate,
  revisionOf,
} from "@depthcue/core";
import JSZip from "jszip";
import type { Browser, BrowserContext, Page, Route } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { exportDeck } from "../src/export.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, pptxOutOf, type RunningServer, startServer } from "../src/serve.ts";

/*
 * Using a brand in the editor, in a real Chrome, on copies of the branded fixture and of an older deck with no brand:
 * the template picker, Change template, the empty slots of a template scene and their hints, the Style menu, the brand's
 * chrome on the slide, the lazy part all of that lives in, and for each change the files `depthcue apply` writes for it.
 */

const harborDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const oldDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-3", import.meta.url));
const BRAND_PART = "/_depthcue/editor/branduse.js";
const BUILT_INS = "/_depthcue/editor/builtins.js";
const NOT_LOADED =
  "Could not load the templates and styles. Check that depthcue edit is still running, then try again.";
const CHART_HINT = "The chart or table that shows the finding.";

const NO_LAYOUT: LayoutChecker = {
  async check() {
    return { available: false, message: "Layout checks are off in this test." };
  },
  async close() {},
};

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let server: RunningServer | undefined;
let context: BrowserContext;
let page: Page;
let problems: string[];
/** Each of the editor's own files the page fetched, with the status it got. */
let fetched: string[];
let opsFiles: number;

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
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-use-e2e-"));
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  fetched = [];
  opsFiles = 0;
  watch(page);
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

function watch(target: Page) {
  target.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  target.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  target.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/_depthcue/editor/")) fetched.push(`${path} ${response.status()}`);
  });
}

// ---- decks on disk ---------------------------------------------------------------------------------------------------

const docAt = (dir: string): Doc => {
  const loaded = loadDoc(loadDeckDir(dir));
  if (!loaded.doc) throw new Error(`the deck in ${dir} should be valid`);
  return loaded.doc;
};

const capture = () => {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) } };
};

/** Changes a deck from the command line, the way an agent changes it. */
async function agentApply(dir: string, ops: readonly Op[]) {
  const file = join(root, `ops-${++opsFiles}.json`);
  writeFileSync(file, JSON.stringify(ops));
  const done = capture();
  const code = await run(["apply", dir, file, "--base-rev", revisionOf(docAt(dir))], done.io);
  expect(code, done.errors.join("\n")).toBe(0);
}

/** A copy of a fixture deck, for the test to change. */
function copy(fixture: string, name: string): string {
  const dir = join(root, name);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

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

/** Every file under `dir`, with its bytes and the time it was last written. */
function everything(dir: string): Record<string, { bytes: string; at: number }> {
  const out: Record<string, { bytes: string; at: number }> = {};
  const visit = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else
        out[relative(dir, path).replaceAll("\\", "/")] = {
          bytes: readFileSync(path).toString("base64"),
          at: stat.mtimeMs,
        };
    }
  };
  visit(dir);
  return out;
}

const sceneOn = (dir: string, id: string) => docAt(dir).scenes[id];
const blockOn = (dir: string, sceneId: string, id: string): Block | undefined =>
  sceneOn(dir, sceneId)?.blocks.find((block) => block.id === id);

// ---- the editor ------------------------------------------------------------------------------------------------------

async function open(dir: string, scene?: string) {
  server = await startServer({
    folder: dir,
    playerDir: builtPlayerDir(),
    editorDir: builtEditorDir(),
    port: 0,
    layout: NO_LAYOUT,
  });
  await page.goto(server.url);
  await slide().waitFor();
  if (scene) await goTo(scene);
}

const slide = (id?: string) =>
  page.locator(
    id === undefined ? ".ed-canvas-host .dc-scene" : `.ed-canvas-host .dc-scene[data-scene='${id}']`,
  );
const block = (id: string) => page.locator(`.ed-frame [data-id='${id}']`);
const hint = () => page.locator(".ed-hint");
const dialog = (name: string) => page.locator(`dialog[data-dialog='${name}']`);
/** Waits for the bar to say the deck is saved. */
const saved = () => page.locator(".ed-status[data-state='saved']").waitFor();

async function goTo(id: string) {
  await page.locator(`.ed-scene[data-scene='${id}']`).click();
  await slide(id).waitFor();
}

/** The block the editor has chosen: the one marked, or the text the caret is in. */
const chosen = () =>
  page.evaluate(
    () =>
      document.querySelector(".ed-frame [data-selected]")?.getAttribute("data-id") ??
      document.activeElement?.closest(".ed-frame [data-id]")?.getAttribute("data-id") ??
      null,
  );

/** Chooses a block the way a person does: a click, which puts the caret in a text. */
async function choose(id: string) {
  await block(id).click();
  await expect.poll(chosen).toBe(id);
}

const pickerOpener = () => page.locator(".ed-add-scene [data-action='pick-template']");
const changeOpener = () => page.locator(".ed-scene-tools [data-action='change-template']");
const styleChip = () => page.locator(".ed-toolbar [data-tb='style']");
const styleChoices = () => page.locator(".ed-toolbar .ed-styles input[data-style]");

const brandFetches = () => fetched.filter((line) => line.startsWith(BRAND_PART));

// ---- the template picker ---------------------------------------------------------------------------------------------

describe("the template picker in a real browser", () => {
  it("adds a scene from the brand's template, as the files `depthcue apply` writes for it", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "welcome");
    await pickerOpener().click();
    const picker = dialog("picker");
    await picker.waitFor();
    expect(await page.getByRole("dialog", { name: "Add a scene" }).count()).toBe(1);
    expect(await picker.locator(".ed-pick-group").allTextContents()).toEqual([
      "Harbor Analytics",
      "Built in",
      "Layouts",
    ]);
    // The brand's cover replaces Depthcue's own, so it is listed once, as the brand's.
    expect(await picker.locator("[data-pick='template:cover']").count()).toBe(1);
    // Each choice is a slide the player drew, in the deck's look.
    const choices = await picker.locator(".ed-pick").count();
    expect(await picker.locator(".ed-pick .ed-mini .dc-scene").count()).toBe(choices);
    // The keyboard starts on the first choice and the arrows go through them.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-pick"))).toBe(
      "template:chart-and-note",
    );
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-pick"))).toBe(
      "template:cover",
    );
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await picker.waitFor({ state: "detached" });

    await expect.poll(() => docAt(mine).deck.scenes).toEqual(["welcome", "new-scene", "context", "growth"]);
    await saved();
    await slide("new-scene").waitFor();

    await agentApply(theirs, [
      {
        op: "scene.add",
        after: "welcome",
        scene: {
          id: "new-scene",
          title: "New scene",
          template: "chart-and-note",
          blocks: [
            { id: "new-scene-heading", type: "text", role: "heading", text: "New scene", slot: "title" },
          ],
        },
      },
    ]);
    expect(written(mine)).toEqual(written(theirs));
    expect(brandFetches()).toEqual([`${BRAND_PART} 200`]);
    expect(problems).toEqual([]);
  });

  it("gives a deck with no brand Depthcue's own templates, drawn in the deck's own colors and fonts", async () => {
    const mine = copy(oldDeck, "mine");
    const theirs = copy(oldDeck, "theirs");
    await open(mine, "overview");
    // Nothing on an older deck asks for the brand part until it is used.
    expect(brandFetches()).toEqual([]);
    await pickerOpener().click();
    const picker = dialog("picker");
    await picker.waitFor();
    expect(await picker.locator(".ed-pick-group").allTextContents()).toEqual(["Built in", "Layouts"]);
    expect(brandFetches()).toEqual([`${BRAND_PART} 200`]);
    const columns = picker.locator("[data-pick='template:two-column']");
    // The deck's action color and its font pair, as the slides it already has are drawn in.
    const look = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            action: style.getPropertyValue("--dc-action").trim().toLowerCase(),
            font: style.fontFamily,
          };
        });
    const thumb = await look(
      "dialog[data-dialog='picker'] [data-pick='template:two-column'] .dc-scene .dc-heading",
    );
    const existing = await look(".ed-canvas-host .dc-scene [data-id='overview-title']");
    expect(thumb.action).toBe("#a8341a");
    expect(thumb.font).toBe(existing.font);
    await columns.click();
    await picker.waitFor({ state: "detached" });
    await expect.poll(() => docAt(mine).deck.scenes).toEqual(["overview", "new-scene", "data", "legacy"]);
    await saved();
    const drawn = await look(
      ".ed-canvas-host .dc-scene[data-scene='new-scene'] [data-id='new-scene-heading']",
    );
    expect(drawn).toEqual(existing);

    const added = sceneOn(mine, "new-scene");
    expect(added).toMatchObject({
      template: "two-column",
      blocks: [{ id: "new-scene-heading", slot: "title" }],
    });
    await agentApply(theirs, [
      {
        op: "scene.add",
        after: "overview",
        scene: {
          id: "new-scene",
          title: "New scene",
          template: "two-column",
          blocks: [
            { id: "new-scene-heading", type: "text", role: "heading", text: "New scene", slot: "title" },
          ],
        },
      },
    ]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });
});

// ---- Change template -------------------------------------------------------------------------------------------------

describe("Change template in a real browser", () => {
  it("names the block that fits no slot, keeps it pinned, and writes what `depthcue apply` writes", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "growth");
    // A template scene shows its template where a layout scene shows its three layouts, so the bar is no wider.
    expect(await changeOpener().textContent()).toBe("Chart and note");
    expect(await page.locator(".ed-scene-tools [data-layout]").first().isVisible()).toBe(false);
    await changeOpener().click();
    const box = dialog("retemplate");
    await box.waitFor();
    await box.locator("label:has(input[value='template:cover'])").click();
    const unplaced = box.locator(".ed-retemplate-unplaced li");
    await unplaced.first().waitFor();
    expect(await unplaced.count()).toBe(1);
    expect(await unplaced.first().textContent()).toMatch(
      /^Chart.*stays on the slide, pinned where it is now/,
    );
    // The preview is the slide as it will be, drawn by the player.
    expect(await box.locator(".ed-retemplate-preview .dc-scene[data-template='cover']").count()).toBe(1);
    await box.locator("[data-dialog-action='apply']").click();
    await box.waitFor({ state: "detached" });

    await expect.poll(() => sceneOn(mine, "growth")?.template).toBe("cover");
    await saved();
    const chart = blockOn(mine, "growth", "growth-chart");
    expect(chart?.slot).toBeUndefined();
    const frame = chart?.frame;
    if (!frame) throw new Error("the chart should stay on the slide, pinned");
    // Kept where it was: inside the chart slot of the template it came from.
    expect(frame.x).toBeGreaterThanOrEqual(5);
    expect(frame.x + frame.w).toBeLessThanOrEqual(65);

    const moved = retemplate(docAt(theirs), "growth", { template: "cover" });
    expect(moved.unplaced).toEqual(["growth-chart"]);
    await agentApply(theirs, [
      ...moved.ops,
      { op: "block.set", scene: "growth", id: "growth-chart", set: { slot: null } },
      { op: "block.frame", scene: "growth", id: "growth-chart", frame },
    ]);
    expect(written(mine)).toEqual(written(theirs));

    // One step of Undo takes all of it back.
    await page.keyboard.press("Control+z");
    await expect.poll(() => sceneOn(mine, "growth")?.template).toBe("chart-and-note");
    expect(blockOn(mine, "growth", "growth-chart")?.slot).toBe("chart");
    expect(problems).toEqual([]);
  });

  it("is on the scene's right-click menu in the strip", async () => {
    await open(copy(harborDeck, "mine"), "growth");
    await page.locator(".ed-scene[data-scene='growth']").click({ button: "right" });
    await page.locator(".ed-menu-item", { hasText: "Change template…" }).first().click();
    await dialog("retemplate").waitFor();
    expect(problems).toEqual([]);
  });
});

// ---- empty slots ------------------------------------------------------------------------------------------------------

describe("the empty slots of a template scene in a real browser", () => {
  it("show their hints in the editor only, and a click adds what the slot takes, as `depthcue apply` does", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    const scene: NewScene = {
      id: "findings",
      title: "Findings",
      template: "chart-and-note",
      blocks: [{ id: "findings-title", type: "text", role: "heading", text: "One finding", slot: "title" }],
    };
    for (const dir of [mine, theirs]) await agentApply(dir, [{ op: "scene.add", after: "growth", scene }]);
    await open(mine, "findings");

    const slots = slide("findings").locator(".ed-slot");
    await slots.first().waitFor();
    expect(
      await slots.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.slot)),
    ).toEqual(["chart", "note"]);
    const chart = slide("findings").locator(".ed-slot[data-slot='chart']");
    expect(await chart.locator(".ed-slot-hint").textContent()).toBe(CHART_HINT);
    expect(await chart.getAttribute("data-required")).not.toBeNull();
    expect(await chart.locator(".ed-slot-required").textContent()).toBe("Required");
    // It sits where the template puts the slot.
    const [slotBox, slideBox] = await Promise.all([chart.boundingBox(), slide("findings").boundingBox()]);
    if (!slotBox || !slideBox) throw new Error("the slot and the slide should be drawn");
    expect((slotBox.x - slideBox.x) / slideBox.width).toBeCloseTo(0.06, 2);

    // The hint is the editor's: the strip's picture, the player and the exported page have none of it.
    const thumb = page.locator(".ed-scene-list > li[data-id='findings'] .ed-thumb");
    expect(await thumb.locator(".ed-slot").count()).toBe(0);
    expect(await thumb.textContent()).not.toContain(CHART_HINT);
    const present = await context.newPage();
    watch(present);
    await present.goto(`${server?.url}present#/findings`);
    await present.locator(".dc-scene[data-scene='findings']").waitFor();
    expect(await present.locator(".ed-slot").count()).toBe(0);
    expect(await present.locator("body").textContent()).not.toContain(CHART_HINT);
    await present.close();
    const out = join(root, "out");
    const exported = exportDeck({ folder: mine, out });
    if (!exported.ok) throw new Error(`the export failed: ${JSON.stringify(exported.diagnostics)}`);
    const offline = await context.newPage();
    await offline.goto(`${pathToFileURL(join(exported.summary.out, "index.html")).href}#/findings`);
    await offline.locator(".dc-scene[data-scene='findings']").waitFor();
    expect(await offline.locator(".ed-slot").count()).toBe(0);
    expect(await offline.locator("body").textContent()).not.toContain(CHART_HINT);
    await offline.close();

    // The note takes a text or a quote, so its button asks which.
    const note = slide("findings").locator(".ed-slot[data-slot='note']");
    await note.locator(".ed-slot-add").click();
    await note.locator("[data-slot-kind='body']").click();
    await expect.poll(() => sceneOn(mine, "findings")?.blocks.length).toBe(2);
    await saved();
    const added = sceneOn(mine, "findings")?.blocks[1] as Block;
    expect(added).toMatchObject({ type: "text", role: "body", slot: "note" });
    expect(await slide("findings").locator(".ed-slot").count()).toBe(1);
    await agentApply(theirs, [{ op: "block.add", scene: "findings", block: added }]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });

  /**
   * What is under the pointer at a point of the slide, given in percent of it: an empty slot, or the id of a block. With
   * `press`, it is clicked there too.
   */
  async function clickAt(sceneId: string, x: number, y: number, press = true) {
    const box = await slide(sceneId).boundingBox();
    if (!box) throw new Error("the slide should be drawn");
    const at = { x: box.x + (box.width * x) / 100, y: box.y + (box.height * y) / 100 };
    const hit = await page.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      return node?.closest(".ed-slot") ? "slot" : (node?.closest("[data-id]")?.getAttribute("data-id") ?? "");
    }, at);
    if (press) await page.mouse.click(at.x, at.y);
    return hit;
  }

  it("lie under a block pinned over them, so a click there chooses the block", async () => {
    const mine = copy(harborDeck, "mine");
    // Growth moved to Cover: its chart fits no slot there and stays pinned, over Cover's empty kicker slot.
    const moved = retemplate(docAt(mine), "growth", { template: "cover" });
    await agentApply(mine, [
      ...moved.ops,
      { op: "block.set", scene: "growth", id: "growth-chart", set: { slot: null } },
      { op: "block.frame", scene: "growth", id: "growth-chart", frame: { x: 6, y: 24, w: 58, h: 68 } },
    ]);
    await open(mine, "growth");
    await slide("growth").locator(".ed-slot[data-slot='kicker']").waitFor();
    // Inside the kicker slot (8 to 68 across, 20 to 28 down) and the chart (6 to 64, 24 to 92).
    expect(await clickAt("growth", 30, 26)).toBe("growth-chart");
    await expect.poll(chosen).toBe("growth-chart");
    expect(sceneOn(mine, "growth")?.blocks).toHaveLength(3);
    // Where the chart is not, the slot is still there to take a click.
    expect(await clickAt("growth", 66, 24, false)).toBe("slot");
    expect(problems).toEqual([]);
  });

  it("lie under a filled slot inside them, as a title on a slide-sized picture slot of an imported layout", async () => {
    const mine = copy(harborDeck, "mine");
    writeFileSync(
      join(mine, "brand", "templates", "over-picture.json"),
      JSON.stringify({
        schemaVersion: "0.4",
        id: "over-picture",
        name: "Title over a picture",
        description: "A picture across the whole slide, with the title on it.",
        slots: [
          {
            id: "picture",
            role: "picture",
            frame: { x: 0, y: 0, w: 100, h: 100 },
            accepts: ["image"],
            hint: "The picture, across the whole slide.",
          },
          {
            id: "title",
            role: "title",
            frame: { x: 8, y: 60, w: 84, h: 20 },
            accepts: ["heading"],
            required: true,
            hint: "The title, on the picture.",
          },
        ],
      }),
    );
    const scene: NewScene = {
      id: "over",
      title: "Over",
      template: "over-picture",
      blocks: [{ id: "over-title", type: "text", role: "heading", text: "Over the picture", slot: "title" }],
    };
    await agentApply(mine, [{ op: "scene.add", after: "growth", scene }]);
    await open(mine, "over");
    await slide("over").locator(".ed-slot[data-slot='picture']").waitFor();
    expect(await clickAt("over", 30, 70)).toBe("over-title");
    await expect.poll(chosen).toBe("over-title");
    expect(await slide("over").locator(".ed-slot-menu:not([hidden])").count()).toBe(0);
    // Above the title, the picture slot still asks for its picture.
    expect(await clickAt("over", 50, 25)).toBe("slot");
    await slide("over").locator(".ed-slot[data-slot='picture'] .ed-slot-menu:not([hidden])").waitFor();
    expect(problems).toEqual([]);
  });
});

// ---- the Style menu --------------------------------------------------------------------------------------------------

describe("the Style menu in a real browser", () => {
  it("offers only the styles for the block's kind, each drawn, and writes `block.set` as `depthcue apply` does", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "context");
    await choose("context-quote");
    await styleChip().click();
    await styleChoices().first().waitFor();
    const offered = await styleChoices().evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.style),
    );
    const forQuote = Object.entries(blockStylesOf(docAt(mine)))
      .filter(([, style]) => (style.for as readonly string[]).includes("quote"))
      .map(([id]) => id);
    expect(offered).toEqual(["none", ...forQuote]);
    expect(offered).toContain("quiet-panel");
    expect(offered).not.toContain("kicker");
    expect(await page.locator(".ed-toolbar .ed-styles input:checked").getAttribute("data-style")).toBe(
      "callout",
    );
    // Each choice, No style too, is the block drawn by the player in it.
    expect(await page.locator(".ed-toolbar .ed-styles .ed-style-choice .ed-mini .dc-scene").count()).toBe(
      forQuote.length + 1,
    );
    await page.locator(".ed-toolbar .ed-style-choice:has(input[data-style='quiet-panel'])").click();
    await expect.poll(() => blockOn(mine, "context", "context-quote")?.style).toBe("quiet-panel");
    await saved();
    await agentApply(theirs, [
      { op: "block.set", scene: "context", id: "context-quote", set: { style: "quiet-panel" } },
    ]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });

  it("gives a deck with no brand Depthcue's own styles for the block's kind", async () => {
    const mine = copy(oldDeck, "mine");
    const theirs = copy(oldDeck, "theirs");
    await open(mine, "overview");
    await choose("overview-body");
    await styleChip().click();
    await styleChoices().first().waitFor();
    const forBody = Object.entries(blockStylesOf(docAt(mine)))
      .filter(([, style]) => (style.for as readonly string[]).includes("body"))
      .map(([id]) => id);
    expect(forBody.length).toBeGreaterThan(0);
    expect(
      await styleChoices().evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.style)),
    ).toEqual(["none", ...forBody]);
    const style = forBody[0] as string;
    await page.locator(`.ed-toolbar .ed-style-choice:has(input[data-style='${style}'])`).click();
    await expect.poll(() => blockOn(mine, "overview", "overview-body")?.style).toBe(style);
    await saved();
    await agentApply(theirs, [{ op: "block.set", scene: "overview", id: "overview-body", set: { style } }]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });
});

// ---- the chrome ------------------------------------------------------------------------------------------------------

describe("the brand's chrome on the editor's slide", () => {
  /** The middle of an element, in the page's pixels. */
  const middle = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector} should be drawn`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const FOOTER = ".ed-frame .dc-chrome .dc-footer";

  it("is drawn, and a click on the footer selects nothing", async () => {
    await open(copy(harborDeck, "mine"), "growth");
    expect(await page.locator(`${FOOTER}`).textContent()).toBe("Harbor Analytics, for internal use");
    expect(await page.locator(".ed-frame .dc-chrome .dc-logo").count()).toBe(1);
    await choose("growth-title");
    const at = await middle(FOOTER);
    // The chrome takes no pointer: what is under it is the slide.
    expect(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".dc-chrome") === null, at),
    ).toBe(true);
    await page.mouse.click(at.x, at.y);
    await expect.poll(chosen).toBeNull();
    expect(problems).toEqual([]);
  });

  it("lets a drag snap to the slide's margin under it, and a click on it reach the block below", async () => {
    const mine = copy(harborDeck, "mine");
    // A picture pinned low on the left of a slide with the brand's footer, which runs along the foot on the left.
    mkdirSync(join(mine, "assets"));
    cpSync(
      fileURLToPath(new URL("../../../fixtures/decks/v0-1/assets/method.svg", import.meta.url)),
      join(mine, "assets", "method.svg"),
    );
    const frame = { x: 4, y: 58, w: 44, h: 30 };
    await agentApply(mine, [
      {
        op: "block.add",
        scene: "context",
        block: { id: "context-picture", type: "image", asset: "assets/method.svg", alt: "A diagram.", frame },
      },
    ]);
    await open(mine, "context");
    const picture = block("context-picture");
    await picture.click();
    await expect.poll(chosen).toBe("context-picture");
    const pins = await page.locator(".ed-frame .dc-pins").boundingBox();
    const box = await picture.boundingBox();
    if (!pins || !box) throw new Error("the slide and the picture should be drawn");
    // Down by 7.6 of the slide's hundred: its foot reaches 95.6, inside the snap of the margin at 96, over the footer.
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + pins.height * 0.076, { steps: 12 });
    expect(await page.locator(".ed-guide[data-axis='y']").count()).toBeGreaterThan(0);
    await page.mouse.up();
    await expect.poll(() => blockOn(mine, "context", "context-picture")?.frame).toEqual({ ...frame, y: 66 });
    await saved();

    // A click on the footer, where the picture now lies under it, chooses the picture.
    // Let go of it first, with a click in the slide's right margin, where nothing is.
    await page.mouse.click(pins.x + pins.width * 0.985, pins.y + pins.height * 0.5);
    await expect.poll(chosen).toBeNull();
    const footer = await page.locator(FOOTER).boundingBox();
    const under = await picture.boundingBox();
    if (!footer || !under) throw new Error("the footer and the picture should be drawn");
    const left = Math.max(footer.x, under.x);
    const right = Math.min(footer.x + footer.width, under.x + under.width);
    const top = Math.max(footer.y, under.y);
    const bottom = Math.min(footer.y + footer.height, under.y + under.height);
    expect(right - left, "the picture should lie under the footer").toBeGreaterThan(4);
    expect(bottom - top, "the picture should lie under the footer").toBeGreaterThan(2);
    await page.mouse.click((left + right) / 2, (top + bottom) / 2);
    await expect.poll(chosen).toBe("context-picture");
    expect(problems).toEqual([]);
  });
});

// ---- the lazy parts --------------------------------------------------------------------------------------------------

describe("the parts the editor fetches on first use", () => {
  for (const chunk of [BRAND_PART, BUILT_INS]) {
    it(`says so plainly when ${chunk.slice(chunk.lastIndexOf("/") + 1)} does not arrive, keeps working, and tries again`, async () => {
      await open(copy(oldDeck, "mine"), "overview");
      const refuse = (route: { abort(): Promise<void> }) => route.abort();
      await page.route(`**${chunk}`, refuse);
      await pickerOpener().click();
      await expect.poll(() => hint().textContent()).toBe(NOT_LOADED);
      expect(await dialog("picker").count()).toBe(0);
      // The rest of the editor goes on.
      await goTo("data");
      await goTo("overview");
      await page.unroute(`**${chunk}`, refuse);
      await pickerOpener().click();
      await dialog("picker").waitFor();
      await page.keyboard.press("Escape");
      await dialog("picker").waitFor({ state: "detached" });
      // The failed fetch is the one console error the page should have.
      const refused = /Failed to fetch dynamically imported module|Failed to load resource: net::ERR_FAILED/;
      expect(problems.filter((line) => !refused.test(line))).toEqual([]);
    });
  }

  it("fetches the storyboard on first use, and says so plainly when it does not arrive", async () => {
    await open(copy(oldDeck, "mine"), "overview");
    const STORYBOARD = "/_depthcue/editor/storyboard.js";
    expect(fetched.filter((line) => line.startsWith(STORYBOARD))).toEqual([]);
    const refuse = (route: { abort(): Promise<void> }) => route.abort();
    await page.route(`**${STORYBOARD}`, refuse);
    await page.locator("[data-action='storyboard']").click();
    await expect
      .poll(() => hint().textContent())
      .toBe("Could not load the storyboard. Check that depthcue edit is still running, then try again.");
    await page.unroute(`**${STORYBOARD}`, refuse);
    await page.locator("[data-action='storyboard']").click();
    await page.locator(".ed-board").waitFor();
    expect(fetched.filter((line) => line.startsWith(STORYBOARD))).toEqual([`${STORYBOARD} 200`]);
  });
});

// ---- Download PowerPoint ---------------------------------------------------------------------------------------------

/** Opens Download PowerPoint from the Deck popover, ticks the options asked for, and saves the file it gets. */
async function downloadPptx(options: { pictures?: boolean } = {}) {
  await page.locator("[data-tb='deck']").click();
  await page.locator("[data-action='pptx']").click();
  const box = dialog("pptx");
  await box.waitFor();
  if (options.pictures) await box.locator("input[name='pictures']").check();
  const [file] = await Promise.all([
    page.waitForEvent("download", { timeout: 150_000 }),
    box.locator("[data-dialog-action='download']").click(),
  ]);
  await box.locator(".ed-pptx-saved").waitFor({ timeout: 30_000 });
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

/**
 * Sends the export's report with the file, as the export call would if it sent one: `depthcue export --json`'s summary
 * of the same deck (its fonts, slides, deck lines and warnings), as the `X-Depthcue-Report` header the dialog reads.
 */
async function reportWith(dir: string) {
  const done = capture();
  const code = await run(
    ["export", dir, "--format", "pptx", "--out", join(root, "report.pptx"), "--json"],
    done.io,
  );
  expect(code, done.errors.join("\n")).toBe(0);
  const summary = JSON.parse(done.lines.join("\n")) as Record<string, unknown>;
  const header = encodeURIComponent(
    JSON.stringify({
      fonts: summary.fonts,
      slides: summary.slides,
      deck: summary.deck,
      warnings: summary.diagnostics,
    }),
  );
  await page.route("**/_depthcue/api/export.pptx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "x-depthcue-report": header } });
  });
  return summary as {
    fonts: Array<{ family: string; embedded: string[] }>;
    slides: Array<{ title: string; left: string[] }>;
  };
}

/** The file `depthcue export` writes for the deck, where the live server's export says it would be. */
async function cliPptx(dir: string, ...switches: string[]) {
  const out = pptxOutOf(realpathSync(dir));
  const done = capture();
  const code = await run(["export", dir, "--format", "pptx", "--out", out, ...switches], done.io);
  expect(code, done.errors.join("\n")).toBe(0);
  return readFileSync(out);
}

describe("Download PowerPoint in a real browser", () => {
  it("saves the file the CLI writes, byte for byte, shows that it is being made, and writes nothing in the deck", async () => {
    const mine = copy(harborDeck, "harbor");
    const before = everything(mine);
    await open(mine, "growth");
    const exports: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/_depthcue/api/export.pptx")
        exports.push(request.postData() ?? "");
    });
    await page.locator("[data-tb='deck']").click();
    await page.locator("[data-action='pptx']").click();
    const box = dialog("pptx");
    await box.waitFor();
    expect(await page.getByRole("dialog", { name: "Download PowerPoint" }).count()).toBe(1);
    const [file] = await Promise.all([
      page.waitForEvent("download", { timeout: 150_000 }),
      (async () => {
        await box.locator("[data-dialog-action='download']").click();
        // While the file is made the dialog says so, and Download is off.
        await box.locator(".ed-pptx-progress progress").waitFor();
        expect(await box.locator("[data-dialog-action='download']").isDisabled()).toBe(true);
      })(),
    ]);
    await box.locator(".ed-pptx-saved").waitFor({ timeout: 30_000 });
    expect(file.suggestedFilename()).toBe("harbor.pptx");
    expect(exports.map((body) => JSON.parse(body))).toEqual([{ notes: true, pictures: false }]);
    expect(await box.locator(".ed-pptx-progress").isHidden()).toBe(true);
    expect(await box.locator(".ed-pptx-saved").textContent()).toMatch(
      /^Saved harbor\.pptx, \d+ KB, among your browser's downloads\. $/,
    );
    const bytes = readFileSync(await file.path());
    expect(everything(mine)).toEqual(before);
    expect((await cliPptx(mine)).equals(bytes)).toBe(true);
    expect(problems).toEqual([]);
  }, 300_000);

  it("in picture mode saves the file `depthcue export --pictures` writes, with an edit made just before it", async () => {
    const mine = copy(oldDeck, "old");
    await open(mine, "overview");
    await choose("overview-title");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Channel B leads now");
    // Straight away: Download saves an edit the autosave has not yet, since the file is made from the deck on disk.
    const got = await downloadPptx({ pictures: true });
    expect(got.name).toBe("old.pptx");
    const title = blockOn(mine, "overview", "overview-title");
    expect(title && "text" in title ? title.text : undefined).toMatch(/leads now$/);
    // Part for part. A slide's picture is the page as a browser drew it, and a chart drawn while another browser is busy
    // can differ in a few pixels between two exports of the same deck, so the pictures are compared by name and count,
    // and the file's digest of its own parts goes with them.
    const theirs = await JSZip.loadAsync(await cliPptx(mine, "--pictures"));
    const ours = await JSZip.loadAsync(got.bytes);
    const parts = (zip: JSZip) => Object.keys(zip.files).filter((name) => !zip.files[name]?.dir);
    expect(parts(ours)).toEqual(parts(theirs));
    expect(parts(ours).filter((name) => /^ppt\/media\/.+\.png$/.test(name))).toHaveLength(3);
    for (const name of parts(theirs)) {
      if (/^ppt\/media\/.+\.png$/.test(name) || name === "docProps/custom.xml") continue;
      const same = Buffer.from(await (ours.file(name) as JSZip.JSZipObject).async("uint8array")).equals(
        Buffer.from(await (theirs.file(name) as JSZip.JSZipObject).async("uint8array")),
      );
      expect(same, name).toBe(true);
    }
    expect(problems).toEqual([]);
  }, 300_000);

  it("lists the export's own report after the download when the call sends one", async () => {
    const mine = copy(harborDeck, "harbor");
    await open(mine, "growth");
    const summary = await reportWith(mine);
    await downloadPptx();
    const report = dialog("pptx").locator(".ed-pptx-report");
    const carried = summary.fonts.filter((font) => font.embedded.length > 0);
    expect(carried.length).toBeGreaterThan(0);
    expect(await report.locator("h3").allTextContents()).toContain("Fonts in the file");
    for (const font of carried) expect(await report.textContent()).toContain(font.family);
    const left = summary.slides.filter((slide) => slide.left.length > 0);
    for (const slide of left) expect(await report.textContent()).toContain(slide.title);
    for (const line of left.flatMap((slide) => slide.left))
      expect(await report.textContent()).toContain(line);
    expect(problems).toEqual([]);
  }, 300_000);

  it("says in plain words what went wrong, and the dialog stays open to try again", async () => {
    const mine = copy(oldDeck, "old");
    await open(mine, "overview");
    const refuse = (route: Route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "no-browser",
          message: "No Chrome or Edge was found to draw the slides.",
        }),
      });
    await page.route("**/_depthcue/api/export.pptx", refuse);
    await page.locator("[data-tb='deck']").click();
    await page.locator("[data-action='pptx']").click();
    await dialog("pptx").locator("[data-dialog-action='download']").click();
    await expect
      .poll(() => dialog("pptx").locator(".ed-problem").textContent())
      .toBe("No Chrome or Edge was found to draw the slides.");
    expect(await dialog("pptx").locator("[data-dialog-action='download']").isEnabled()).toBe(true);
    expect(problems.filter((line) => !line.includes("503"))).toEqual([]);
  });
});

// ---- older decks -----------------------------------------------------------------------------------------------------

describe("an older deck opened in the editor", () => {
  it("is left as it was when nothing is changed, with the picker, the Style menu and Change template opened", async () => {
    const mine = copy(oldDeck, "mine");
    const before = everything(mine);
    await open(mine, "overview");
    await pickerOpener().click();
    await dialog("picker").waitFor();
    await page.keyboard.press("Escape");
    await dialog("picker").waitFor({ state: "detached" });
    await choose("overview-body");
    await styleChip().click();
    await styleChoices().first().waitFor();
    await page.keyboard.press("Escape");
    // A layout scene has its three layouts in the bar and reaches Change template from the Scene popover.
    expect(await changeOpener().isVisible()).toBe(false);
    await page.locator(".ed-scene-tools [data-tb='scene']").click();
    await page.locator("[data-field='panel:change-template']").click();
    await dialog("retemplate").waitFor();
    await dialog("retemplate").locator("[data-dialog-action='cancel']").click();
    await goTo("data");
    await goTo("legacy");
    // Long enough for a save the editor would have made.
    await page.waitForTimeout(1500);
    expect(everything(mine)).toEqual(before);
    expect(problems).toEqual([]);
  });
});

// ---- screenshots -----------------------------------------------------------------------------------------------------

/**
 * The screenshots Dimitri looks at, written only when DEPTHCUE_SHOTS names a folder: the picker, Change template with a
 * block that fits no slot, empty slots with their hints, the Style menu and the chrome, on both presets.
 */
const SHOTS = process.env.DEPTHCUE_SHOTS;
describe.skipIf(!SHOTS)("screenshots of a brand in use", () => {
  for (const preset of ["paper", "ink"] as const) {
    it(`on ${preset}`, async () => {
      const dir = SHOTS as string;
      mkdirSync(dir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: join(dir, `brand-use-${name}-${preset}.png`) });
      const mine = copy(harborDeck, "mine");
      await agentApply(mine, [
        { op: "deck.set", set: { theme: preset } },
        {
          op: "scene.add",
          after: "growth",
          scene: {
            id: "findings",
            title: "Findings",
            template: "chart-and-note",
            blocks: [
              { id: "findings-title", type: "text", role: "heading", text: "One finding", slot: "title" },
            ],
          },
        },
      ]);
      await open(mine, "welcome");
      await pickerOpener().click();
      await dialog("picker").waitFor();
      await page.waitForTimeout(300);
      await shot("picker");
      await page.keyboard.press("Escape");

      await goTo("growth");
      await changeOpener().click();
      await dialog("retemplate").locator("label:has(input[value='template:cover'])").click();
      await dialog("retemplate").locator(".ed-retemplate-unplaced li").first().waitFor();
      await page.waitForTimeout(300);
      await shot("retemplate");
      await dialog("retemplate").locator("[data-dialog-action='cancel']").click();
      await page.waitForTimeout(300);
      await shot("chrome");

      await goTo("findings");
      await slide("findings").locator(".ed-slot").first().waitFor();
      await page.waitForTimeout(300);
      await shot("slots");

      await goTo("context");
      await choose("context-quote");
      await styleChip().click();
      await styleChoices().first().waitFor();
      // The deck's styles come after the block's own size, alignment and color, so the list is scrolled to.
      await page.locator(".ed-toolbar .ed-styles").evaluate((node) => node.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(300);
      await shot("styles");
      await page.keyboard.press("Escape");

      // The block's right-click menu, with its Style submenu open.
      await block("context-quote").click({ button: "right" });
      await page.locator(".ed-menu [data-submenu='Style']").click();
      await page.locator(".ed-menu-sub [data-command^='block-style-']").first().waitFor();
      await page.waitForTimeout(300);
      await shot("style-menu");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      // Download PowerPoint, after the file is in: as the export call is today, with no report, then with the CLI's
      // report of the same deck sent as the dialog would read it.
      await downloadPptx();
      await page.waitForTimeout(300);
      await shot("download");
      await dialog("pptx").locator("[data-dialog-action='cancel']").click();
      await reportWith(mine);
      await downloadPptx();
      await page.waitForTimeout(300);
      await shot("download-report");
      expect(problems).toEqual([]);
    }, 240_000);
  }
});
