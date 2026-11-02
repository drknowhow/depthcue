import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Block,
  type BlockStyle,
  BUILT_IN_TEMPLATES,
  type Doc,
  FILE_REVERT_REASON,
  loadDoc,
  type Op,
  retemplate,
  revisionOf,
  type Template,
} from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * Defining a brand in the editor, in a real Chrome, on copies of the branded fixtures and of an older deck with no brand:
 * the Brand panel, Save as template, the template editor and the drawer's rows for the brand's files. Each change is
 * checked against the files `depthcue apply` writes for the same operations.
 */

const harborDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-4-brand", import.meta.url));
const tidewellDeck = fileURLToPath(new URL("../../../fixtures/decks/tidewell-press", import.meta.url));
const oldDeck = fileURLToPath(new URL("../../../fixtures/decks/v0-3", import.meta.url));
const DEFINE_PART = "/_depthcue/editor/branddefine.js";

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
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-define-e2e-"));
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  fetched = [];
  opsFiles = 0;
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/_depthcue/editor/")) fetched.push(`${path} ${response.status()}`);
  });
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

// ---- decks on disk ---------------------------------------------------------------------------------------------------

const docAt = (dir: string): Doc => {
  const loaded = loadDoc(loadDeckDir(dir));
  if (!loaded.doc)
    throw new Error(`the deck in ${dir} should be valid: ${JSON.stringify(loaded.diagnostics)}`);
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

function copy(fixture: string, name: string): string {
  const dir = join(root, name);
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

/** Every JSON file of the deck, the brand's among them, by path. `review.json` is the reviewer's, so it is left out. */
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

const brandOf = (dir: string) => {
  const brand = docAt(dir).brand;
  if (!brand) throw new Error("the deck should have a brand");
  return brand;
};
const templateOf = (dir: string, id: string) => docAt(dir).templates?.[id] as Template;
const blockOn = (dir: string, sceneId: string, id: string): Block | undefined =>
  docAt(dir).scenes[sceneId]?.blocks.find((block) => block.id === id);
/** A template as `template.set` takes it. */
const toWrite = ({ id: _id, schemaVersion: _version, ...rest }: Template) => rest;

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
const dialog = (name: string) => page.locator(`dialog[data-dialog='${name}']`);
const saved = () => page.locator(".ed-status[data-state='saved']").waitFor();

async function goTo(id: string) {
  await page.locator(`.ed-scene[data-scene='${id}']`).click();
  await slide(id).waitFor();
}

const panel = () => page.locator(".ed-brand");
const field = (key: string) => panel().locator(`[data-field='${key}']`);
const said = () => panel().locator(".ed-brand-said");

/** Opens the Brand panel from the Deck popover, at a section when one is named. */
async function openBrand(tab?: string) {
  await page.locator("[data-tb='deck']").click();
  await page.locator("[data-action='brand']").click();
  await panel().waitFor();
  if (tab) {
    await panel().locator(`[data-tab='${tab}']`).click();
    await expect
      .poll(() => panel().locator(`[data-tab='${tab}']`).getAttribute("aria-selected"))
      .toBe("true");
  }
}

/** What a color picker does while it is dragged: an input with the color, and no change until it closes. */
async function drag(key: string, color: string) {
  await field(key).evaluate((node, value) => {
    const input = node as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, color);
}

async function pick(key: string, color: string) {
  await field(key).fill(color);
}

const definePart = () => fetched.filter((line) => line.startsWith(DEFINE_PART));

// ---- the Brand panel -------------------------------------------------------------------------------------------------

describe("the Brand panel in a real browser", () => {
  it("starts a brand on a deck with none, as `depthcue apply` writes it, and is used by keyboard", async () => {
    const mine = copy(oldDeck, "mine");
    const theirs = copy(oldDeck, "theirs");
    await open(mine, "overview");
    // Nothing asks for the part until the panel is opened.
    expect(definePart()).toEqual([]);
    await openBrand();
    expect(definePart()).toEqual([`${DEFINE_PART} 200`]);
    expect(await page.getByRole("complementary", { name: "Brand" }).count()).toBe(1);
    expect(await panel().locator("[role='tab']:visible").count()).toBe(0);
    await field("brand:start:name").fill("Acme Labs");
    expect(await field("brand:start:id").inputValue()).toBe("acme-labs");
    await field("brand:start").click();
    await expect.poll(() => docAt(mine).brand?.id).toBe("acme-labs");
    await saved();
    await agentApply(theirs, [{ op: "brand.set", set: { id: "acme-labs", name: "Acme Labs" } }]);
    expect(written(mine)).toEqual(written(theirs));

    // The sections are tabs: the arrows go through them, and Esc closes the panel and gives the keyboard back.
    const tabs = panel().locator("[role='tab']");
    expect(await tabs.allTextContents()).toEqual([
      "Logos",
      "Colors",
      "Fonts",
      "Chrome",
      "Styles",
      "Templates",
    ]);
    await panel().locator("[data-tab='colors']").focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-tab"))).toBe("fonts");
    expect(await panel().locator("[data-tab='fonts']").getAttribute("aria-selected")).toBe("true");
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-tab"))).toBe("templates");
    // A key typed in the panel is the panel's: T adds no text to the slide.
    await page.keyboard.press("t");
    expect(await slide("overview").locator("[data-id]").count()).toBe(
      docAt(mine).scenes.overview?.blocks.length ?? -1,
    );
    await page.keyboard.press("Escape");
    await panel().waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-tb"))).toBe("deck");
    // One step of Undo takes the brand back off.
    await page.keyboard.press("Control+z");
    await expect.poll(() => docAt(mine).brand).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("refuses a color that leaves text unreadable at its swatch, with the two colors and their contrast, and writes nothing", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "context");
    await openBrand("colors");
    const before = everything(mine);
    const canvasText = () =>
      slide("context")
        .locator("[data-id='context-heading']")
        .evaluate((node) => getComputedStyle(node).color);
    const shown = await canvasText();

    await drag("brand:colors:paper:text", "#f4f4f4");
    const line = panel().locator(".ed-brand-lines .ed-problem:not([hidden])");
    await line.waitFor();
    expect(await line.textContent()).toMatch(
      /"text" \(#f4f4f4\) on "(bg|surface)" \(#[0-9a-f]{6}\) has a contrast of [\d.]+:1, under the 4\.5:1/i,
    );
    // Said at the row of the swatch it is about.
    expect(
      await panel()
        .locator(".ed-brand-color", { has: page.locator("[data-field='brand:colors:paper:text']") })
        .locator(".ed-problem:not([hidden])")
        .count(),
    ).toBe(1);
    await page.waitForTimeout(1200);
    expect(everything(mine)).toEqual(before);
    expect(await canvasText()).toBe(shown);

    // A chart color has its own minimum, 3:1, and its own line.
    await drag("brand:chart:paper:0", "#eeeeee");
    await expect
      .poll(() =>
        panel().locator(".ed-brand-chart[data-theme='paper'] .ed-problem:not([hidden])").textContent(),
      )
      .toMatch(
        /Chart color 1 \(#eeeeee\) on paper slides \(#[0-9a-f]{6}\) has a contrast of [\d.]+:1, under the 3:1/i,
      );
    await page.waitForTimeout(600);
    expect(everything(mine)).toEqual(before);

    // A readable one is written, shows on the slide at once, and is what `depthcue apply` writes.
    await pick("brand:colors:paper:text", "#202a30");
    await expect.poll(() => brandOf(mine).colors?.paper?.text).toBe("#202a30");
    await expect.poll(canvasText).toBe("rgb(32, 42, 48)");
    await saved();
    const colors = brandOf(theirs).colors ?? {};
    await agentApply(theirs, [
      { op: "brand.set", set: { colors: { ...colors, paper: { ...colors.paper, text: "#202a30" } } } },
    ]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });

  it("changes the chrome and the canvas shows it at once, as `depthcue apply` writes it", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "context");
    await openBrand("chrome");
    await field("brand:chrome:footer-place").selectOption("end");
    await expect
      .poll(() => slide("context").locator(".dc-chrome .dc-foot:has(.dc-footer)").getAttribute("data-at"))
      .toBe("end");
    await field("brand:chrome:logo").selectOption("bottom-start");
    await expect
      .poll(() => slide("context").locator(".dc-chrome .dc-logo").getAttribute("data-corner"))
      .toBe("bottom-start");
    await saved();
    const chrome = brandOf(theirs).chrome ?? {};
    // Harbor's footer has its words, so only the place changes.
    const footer = chrome.footer as NonNullable<typeof chrome.footer>;
    await agentApply(theirs, [
      { op: "brand.set", set: { chrome: { ...chrome, footer: { ...footer, place: "end" } } } },
    ]);
    await agentApply(theirs, [
      {
        op: "brand.set",
        set: {
          chrome: {
            ...brandOf(theirs).chrome,
            logo: { ...brandOf(theirs).chrome?.logo, corner: "bottom-start" },
          },
        },
      },
    ] as Op[]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });

  it("says where each logo shows, and that a light logo alone all but vanishes on ink", async () => {
    const mine = copy(harborDeck, "mine");
    await agentApply(mine, [{ op: "deck.set", set: { theme: "ink" } }]);
    const before = everything(mine);
    await open(mine, "context");
    await openBrand("logos");
    const lines = panel().locator(".ed-brand-statement li");
    await lines.first().waitFor();
    const text = (await lines.allTextContents()).join("\n");
    expect(text).toMatch(/no plate behind it/);
    expect(text).toMatch(/Add a logo for dark slides/);
    expect(await panel().locator(".ed-brand-statement li[data-warn]").count()).toBeGreaterThan(0);
    // The light logo is shown on the paper ground it is drawn for.
    const shown = panel().locator(".ed-brand-logo[data-logo='light'] img");
    await expect
      .poll(() => shown.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    // Opening the panel writes nothing.
    await page.waitForTimeout(800);
    expect(everything(mine)).toEqual(before);
    expect(problems).toEqual([]);
  });

  it("edits a style with its preview on both presets and on the blocks that use it, as `depthcue apply` writes it", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "context");
    await openBrand("styles");
    await field("brand:style:quiet-panel:edit").click();
    const editor = panel().locator(".ed-brand-editor[data-editing='quiet-panel']");
    await editor.waitFor();
    // A sample of each kind the style is for, on paper and on ink, drawn by the player.
    expect(await editor.locator(".ed-brand-preview-row").count()).toBe(2);
    expect(await editor.locator(".ed-brand-figure .dc-scene").count()).toBe(4);
    const sample = editor.locator(".ed-brand-preview-row[data-theme='paper'] [data-id='sample']").first();
    const fillOf = (locator: typeof sample) =>
      locator.evaluate((node) => getComputedStyle(node).backgroundColor);
    const block = slide("context").locator("[data-id='context-body']");
    const [sampleBefore, blockBefore] = [await fillOf(sample), await fillOf(block)];
    // Its text is drawn large enough to read at the panel's size.
    expect(
      await sample.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(12);

    await field("brand:style:quiet-panel:fill").selectOption("action");
    await expect.poll(() => fillOf(sample)).not.toBe(sampleBefore);
    await expect.poll(() => fillOf(block)).not.toBe(blockBefore);
    await expect.poll(() => brandOf(mine).styles?.["quiet-panel"]?.fill).toBe("action");
    await saved();
    // One field changed, in the patch form: the same bytes as the whole style written back with it.
    await agentApply(theirs, [{ op: "style.set", id: "quiet-panel", set: { fill: "action" } }]);
    expect(written(mine)).toEqual(written(theirs));
    const whole = copy(harborDeck, "whole");
    const style = brandOf(whole).styles?.["quiet-panel"] as BlockStyle;
    await agentApply(whole, [{ op: "style.set", id: "quiet-panel", style: { ...style, fill: "action" } }]);
    expect(written(whole)).toEqual(written(theirs));

    // A built-in is copied into the brand under its own id, and then is the brand's to change.
    await field("brand:style:callout:copy").click();
    await expect.poll(() => brandOf(mine).styles?.callout?.name).toBeDefined();
    await panel().locator(".ed-brand-editor[data-editing='callout']").waitFor();
    expect(problems).toEqual([]);
  });

  it("lists the templates with their pictures, and refuses to remove one a scene uses, naming it", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "growth");
    await openBrand("templates");
    const entry = panel().locator(".ed-brand-template[data-template='chart-and-note']");
    await entry.waitFor();
    expect(await entry.locator(".ed-mini .dc-scene").count()).toBe(1);
    expect(await entry.textContent()).toContain("1 scene");
    const before = everything(mine);
    await field("brand:template:chart-and-note:remove").click();
    await expect.poll(() => said().textContent()).toContain('"Growth"');
    await page.waitForTimeout(800);
    expect(everything(mine)).toEqual(before);

    // Renamed where it is listed, and a built-in copied into the brand under its own id.
    await field("brand:template:chart-and-note:name").fill("Chart with a note");
    await expect.poll(() => templateOf(mine, "chart-and-note")?.name).toBe("Chart with a note");
    const builtIn = Object.keys(BUILT_IN_TEMPLATES).find(
      (id) => !Object.hasOwn(docAt(mine).templates ?? {}, id),
    ) as string;
    await field(`brand:template:${builtIn}:copy`).click();
    await expect.poll(() => templateOf(mine, builtIn)?.name).toBe(BUILT_IN_TEMPLATES[builtIn]?.name);
    await saved();
    await agentApply(theirs, [
      { op: "template.set", id: "chart-and-note", set: { name: "Chart with a note" } },
      { op: "template.set", id: builtIn, template: toWrite(BUILT_IN_TEMPLATES[builtIn] as Template) },
    ]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });
});

// ---- Save as template ------------------------------------------------------------------------------------------------

describe("Save as template in a real browser", () => {
  it("makes a template of the scene and puts the scene on it, as `depthcue apply` writes it", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "context");
    await page.locator(".ed-scene[data-scene='context']").click({ button: "right" });
    await page.locator(".ed-menu-item", { hasText: "Save as template…" }).first().click();
    const box = dialog("save-template");
    await box.waitFor();
    // A slot for each block, with a role from its kind; the first heading is the title.
    const slots = box.locator(".ed-save-slot");
    expect(
      await slots.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.slot)),
    ).toEqual(["body", "title", "body-2", "body-3"]);
    await box.locator("[data-field='save:name']").fill("Context page");
    await box.locator("[data-field='save:description']").fill("A heading, a panel of text and a quote.");
    await box.locator("[data-field='save:slot:title:hint']").fill("What changed, in one line.");
    await box.locator("[data-field='save:slot:title:required']").check();
    await box.locator("[data-dialog-action='save']").click();
    await box.locator("[data-dialog-action='put-on']").waitFor();
    await expect.poll(() => templateOf(mine, "context-page")?.name).toBe("Context page");
    const made = templateOf(mine, "context-page");
    expect(made).toMatchObject({
      name: "Context page",
      description: "A heading, a panel of text and a quote.",
    });
    expect(made.slots.find((slot) => slot.id === "title")).toMatchObject({
      role: "title",
      accepts: ["heading"],
      required: true,
      hint: "What changed, in one line.",
    });
    await saved();
    await agentApply(theirs, [{ op: "template.set", id: "context-page", template: toWrite(made) }]);
    expect(written(mine)).toEqual(written(theirs));

    // Put on it: each block goes to the slot it made.
    await box.locator("[data-dialog-action='put-on']").click();
    await box.waitFor({ state: "detached" });
    await expect.poll(() => docAt(mine).scenes.context?.template).toBe("context-page");
    const wanted: Record<string, string> = {
      "context-kicker": "body",
      "context-heading": "title",
      "context-body": "body-2",
      "context-quote": "body-3",
    };
    for (const [id, slot] of Object.entries(wanted)) expect(blockOn(mine, "context", id)?.slot).toBe(slot);
    await saved();
    // Change template's own operations, then whatever puts each block in the slot it made.
    await agentApply(theirs, retemplate(docAt(theirs), "context", { template: "context-page" }).ops);
    const fixes: Op[] = [];
    for (const block of docAt(theirs).scenes.context?.blocks ?? []) {
      const slot = wanted[block.id] as string;
      if (block.slot !== slot) fixes.push({ op: "block.set", scene: "context", id: block.id, set: { slot } });
      if (block.frame !== undefined) fixes.push({ op: "block.unframe", scene: "context", id: block.id });
    }
    if (fixes.length > 0) await agentApply(theirs, fixes);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });

  it("on a deck with no brand, says a template belongs to one and offers to start it", async () => {
    const mine = copy(oldDeck, "mine");
    const before = everything(mine);
    await open(mine, "overview");
    await page.locator(".ed-scene-tools [data-tb='scene']").click();
    await page.locator("[data-field='panel:save-template']").click();
    const box = dialog("save-template");
    await box.waitFor();
    expect(await box.textContent()).toContain("this deck has none yet");
    await box.locator("[data-dialog-action='start-brand']").click();
    await panel().locator("[data-field='brand:start:name']").waitFor();
    await page.waitForTimeout(800);
    expect(everything(mine)).toEqual(before);
    expect(problems).toEqual([]);
  });
});

// ---- the template editor ---------------------------------------------------------------------------------------------

describe("the template editor in a real browser", () => {
  const editor = () => page.locator(".ed-tpl");
  const box = (slot: string) => editor().locator(`.ed-tpl-slot[data-slot='${slot}']`);
  const side = (key: string) => editor().locator(`[data-field='${key}']`);

  async function openEditor(template: string) {
    await openBrand("templates");
    await field(`brand:template:${template}:edit`).click();
    await editor().waitFor();
  }

  /** The slide of the template editor, in the page's pixels. */
  async function slideBox() {
    const found = await editor().locator(".ed-tpl-slide").boundingBox();
    if (!found) throw new Error("the template's slide should be drawn");
    return found;
  }

  /** Drags from the middle of `from` by a part of the slide, and lets go after a look at the guides. */
  async function dragBy(from: string, dx: number, dy: number) {
    const slideAt = await slideBox();
    const start = await editor().locator(from).boundingBox();
    if (!start) throw new Error(`${from} should be drawn`);
    const x = start.x + start.width / 2;
    const y = start.y + start.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + slideAt.width * dx, y + slideAt.height * dy, { steps: 10 });
    const guides = await editor().locator(".ed-guide").count();
    await page.mouse.up();
    return guides;
  }

  it("moves and sizes a slot with the snapping guides, renames it with its blocks, and writes what `depthcue apply` writes", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "growth");
    await openEditor("chart-and-note");
    expect(await editor().locator(".ed-tpl-slot").count()).toBe(3);
    // The scenes on the template are drawn under it.
    expect(await editor().locator(".ed-tpl-scenes li[data-scene='growth'] .dc-scene").count()).toBe(1);

    // Left by 3.5 of the slide's hundred: the note's left edge, at 64.5, snaps to the chart's right edge at 64.
    expect(await dragBy(".ed-tpl-slot[data-slot='note']", -0.035, 0)).toBeGreaterThan(0);
    await expect
      .poll(() => templateOf(mine, "chart-and-note").slots[2]?.frame)
      .toEqual({ x: 64, y: 24, w: 26, h: 68 });
    // Its foot, from 92 up by 41.5 to 50.5, snaps to the middle of the slide.
    expect(
      await dragBy(".ed-tpl-slot[data-slot='note'] .ed-handle[data-handle='se']", 0, -0.415),
    ).toBeGreaterThan(0);
    await expect
      .poll(() => templateOf(mine, "chart-and-note").slots[2]?.frame)
      .toEqual({ x: 64, y: 24, w: 26, h: 26 });

    // A new name takes the block in the slot with it.
    await side("tpl:slot:id").fill("aside");
    await side("tpl:slot:id").press("Tab");
    await expect.poll(() => templateOf(mine, "chart-and-note").slots[2]?.id).toBe("aside");
    expect(blockOn(mine, "growth", "growth-note")?.slot).toBe("aside");
    await expect.poll(() => box("aside").count()).toBe(1);
    await saved();

    // The agent's way to the same template: the slot operations, each slot by itself.
    const slot = { op: "slot.set", template: "chart-and-note", id: "note" } as const;
    await agentApply(theirs, [{ ...slot, set: { frame: { x: 64, y: 24, w: 26, h: 68 } } }]);
    await agentApply(theirs, [{ ...slot, set: { frame: { x: 64, y: 24, w: 26, h: 26 } } }]);
    await agentApply(theirs, [{ op: "slot.rename", template: "chart-and-note", id: "note", to: "aside" }]);
    expect(written(mine)).toEqual(written(theirs));

    // Each change was one step of Undo.
    await editor().locator(".ed-tpl-head").click();
    await page.keyboard.press("Control+z");
    await expect.poll(() => templateOf(mine, "chart-and-note").slots[2]?.id).toBe("note");
    expect(blockOn(mine, "growth", "growth-note")?.slot).toBe("note");
    expect(templateOf(mine, "chart-and-note").slots[2]?.frame).toEqual({ x: 64, y: 24, w: 26, h: 26 });

    // Done goes back to the scene it came from.
    await editor().locator("[data-action='template-done']").click();
    await editor().waitFor({ state: "detached" });
    await slide("growth").waitFor();
    expect(problems).toEqual([]);
  });

  it("refuses to remove a slot a block is in, naming the block, and pins it where the slot was when asked", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "growth");
    await openEditor("chart-and-note");
    await box("chart").click();
    await expect.poll(() => box("chart").getAttribute("aria-pressed")).toBe("true");
    const before = everything(mine);
    await side("tpl:slot:remove").click();
    const refusal = page.locator(".ed-tpl > .ed-problem");
    await expect.poll(() => refusal.isVisible()).toBe(true);
    expect(await refusal.textContent()).toMatch(/The chart slot holds Chart: .*\(Growth\)/);
    await page.waitForTimeout(800);
    expect(everything(mine)).toEqual(before);

    await side("tpl:slot:remove-pin").click();
    await expect
      .poll(() => templateOf(mine, "chart-and-note").slots.map((slot) => slot.id))
      .toEqual(["title", "note"]);
    expect(blockOn(mine, "growth", "growth-chart")).toMatchObject({ frame: { x: 6, y: 24, w: 58, h: 68 } });
    expect(blockOn(mine, "growth", "growth-chart")?.slot).toBeUndefined();
    await saved();
    await agentApply(theirs, [{ op: "slot.remove", template: "chart-and-note", id: "chart", to: null }]);
    expect(written(mine)).toEqual(written(theirs));
    expect(problems).toEqual([]);
  });
});

// ---- the brand folder's files ----------------------------------------------------------------------------------------

/** A small logo the server's checks take: shapes only, in the SVG namespace. */
const LOGO = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" rx="6" fill="#f4f1ea"/><circle cx="20" cy="20" r="10" fill="#0b2545"/><rect x="38" y="14" width="70" height="12" fill="#0b2545"/></svg>',
);
/** A logo the checks refuse: it would run a script. */
const UNSAFE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><rect width="10" height="10"/></svg>',
);
const fontFile = join(tidewellDeck, "brand/fonts/TidewellText-Regular.woff2");

/** Writes bytes to a file of their own outside the decks, to hand to the command line. */
function loose(name: string, bytes: Buffer): string {
  const dir = join(root, `loose-${++opsFiles}`);
  mkdirSync(dir);
  writeFileSync(join(dir, name), bytes);
  return join(dir, name);
}

/** `depthcue brand add` or `brand remove`, as an agent runs it. Answers with what `--json` printed. */
async function brandCommand(...args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  const done = capture();
  const code = await run(["brand", ...args, "--json"], done.io);
  return { code, json: JSON.parse(done.lines.join("\n")) as Record<string, unknown> };
}

describe("the brand folder's files in a real browser", () => {
  it("sends a logo through the server's checks and names it for dark slides, as `brand add` and `depthcue apply` write them", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    await open(mine, "context");
    await openBrand("logos");
    await field("brand:logos:dark:upload").setInputFiles({
      name: "harbor-dark.svg",
      mimeType: "image/svg+xml",
      buffer: LOGO,
    });
    await expect.poll(() => brandOf(mine).logos?.dark).toBe("logos/harbor-dark.svg");
    await saved();
    expect(readFileSync(join(mine, "brand/logos/harbor-dark.svg"))).toEqual(LOGO);
    // The panel shows the new logo on the ink ground it is for, and lists the file as in use.
    await expect
      .poll(() =>
        panel()
          .locator(".ed-brand-logo[data-logo='dark'] img")
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    expect(await panel().locator("[data-file='logos/harbor-dark.svg']").textContent()).toContain("In use");
    expect(await said().isHidden()).toBe(true);

    const added = await brandCommand("add", loose("harbor-dark.svg", LOGO), theirs, "--kind", "logo");
    expect(added.code, JSON.stringify(added.json)).toBe(0);
    await agentApply(theirs, [
      { op: "brand.set", set: { logos: { ...brandOf(theirs).logos, dark: added.json.path } } } as Op,
    ]);
    expect(written(mine)).toEqual(written(theirs));
    expect(readFileSync(join(theirs, "brand/logos/harbor-dark.svg"))).toEqual(LOGO);
    // The upload was the person's, so the list of changes has nothing to show for it.
    await page.locator("[data-action='review']").click();
    await page.locator(".ed-review-empty:not([hidden])").waitFor();
    expect(await page.locator(".ed-review .ed-ri").count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("says the server's refusal as the server words it, and writes nothing", async () => {
    const mine = copy(harborDeck, "mine");
    const other = copy(harborDeck, "other");
    const refused = await brandCommand("add", loose("mark.svg", UNSAFE), other, "--kind", "logo");
    expect(refused.code).toBe(1);
    const before = everything(mine);
    await open(mine, "context");
    await openBrand("logos");
    await field("brand:logos:dark:upload").setInputFiles({
      name: "mark.svg",
      mimeType: "image/svg+xml",
      buffer: UNSAFE,
    });
    await expect.poll(() => said().textContent()).toBe(refused.json.message);
    await page.waitForTimeout(800);
    expect(everything(mine)).toEqual(before);
    expect(await page.locator(".ed-status").getAttribute("data-state")).toBe("saved");
    // The refused request is the one console error the page should have.
    expect(problems.filter((line) => !line.includes("status of 422"))).toEqual([]);
  });

  it("adds a font file as a new face for headings and text, with the license written, as the command line does", async () => {
    const mine = copy(harborDeck, "mine");
    const theirs = copy(harborDeck, "theirs");
    const bytes = readFileSync(fontFile);
    await open(mine, "context");
    await openBrand("fonts");
    await field("brand:fonts:file-license").fill("OFL-1.1");
    await field("brand:fonts:upload").setInputFiles({
      name: "TidewellText-Regular.woff2",
      mimeType: "font/woff2",
      buffer: bytes,
    });
    // The face takes the family the file names itself by; the fixture's font names the one it stands in for.
    const family = "Depthcue Classic Sans";
    await expect
      .poll(() => {
        const fonts = brandOf(mine).fonts;
        return typeof fonts === "object" ? fonts.display.family : fonts;
      })
      .toBe(family);
    await saved();
    const face = {
      family,
      license: "OFL-1.1",
      files: [{ file: "fonts/TidewellText-Regular.woff2", weight: 400, style: "normal" }],
    };
    const fonts = brandOf(mine).fonts as Exclude<ReturnType<typeof brandOf>["fonts"], string>;
    expect([fonts?.display, fonts?.body]).toEqual([face, face]);

    const added = await brandCommand("add", fontFile, theirs, "--kind", "font");
    expect(added.code, JSON.stringify(added.json)).toBe(0);
    expect((added.json.sniffed as { family: string }).family).toBe(family);
    const own = brandOf(theirs).fonts as NonNullable<typeof fonts>;
    await agentApply(theirs, [
      { op: "brand.set", set: { fonts: { ...own, display: face, body: face } } } as Op,
    ]);
    expect(written(mine)).toEqual(written(theirs));
    // The slide's faces come from the file that was sent. A built-in has the same family, so the rule is what tells.
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.adoptedStyleSheets
            .flatMap((sheet) => [...sheet.cssRules])
            .some(
              (rule) =>
                rule instanceof CSSFontFaceRule &&
                rule.style.getPropertyValue("font-family").includes("Depthcue Classic Sans") &&
                rule.style.getPropertyValue("src").includes("brand/fonts/TidewellText-Regular.woff2"),
            ),
        ),
      )
      .toBe(true);
    expect(problems).toEqual([]);
  });

  it("deletes a file nothing names after asking, never one the brand names, and keeps an edit made just before", async () => {
    const mine = copy(harborDeck, "mine");
    writeFileSync(join(mine, "brand/logos/spare.svg"), LOGO);
    await open(mine, "context");
    await openBrand("logos");
    const spare = panel().locator("[data-file='logos/spare.svg']");
    await spare.waitFor();
    expect(await panel().locator("[data-file='logos/harbor.svg']").textContent()).toContain("In use");
    expect(await field("brand:file:logos/harbor.svg:remove").count()).toBe(0);

    // An edit not yet saved is saved before the file goes, since the server reads the files on disk.
    await field("brand:logos:alt").fill("Harbor Analytics, the mark");
    await field("brand:logos:alt").press("Tab");
    await field("brand:file:logos/spare.svg:remove").click();
    await expect.poll(() => said().textContent()).toMatch(/^Delete brand\/logos\/spare\.svg\?/);
    expect(existsSync(join(mine, "brand/logos/spare.svg"))).toBe(true);
    await field("brand:file:delete").click();
    await spare.waitFor({ state: "detached" });
    expect(existsSync(join(mine, "brand/logos/spare.svg"))).toBe(false);
    expect(brandOf(mine).logos?.alt).toBe("Harbor Analytics, the mark");
    await saved();
    expect(await page.locator(".ed-status").getAttribute("data-state")).toBe("saved");
    expect(problems).toEqual([]);
  });
});

// ---- the drawer's brand rows -----------------------------------------------------------------------------------------

describe("the changes of a brand in the review drawer", () => {
  const rows = () => page.locator(".ed-review .ed-ri");
  const row = (id: string) => page.locator(`.ed-review .ed-ri[data-id='${id}']`);

  it("names each part of the brand plainly, and accepts and reverts each", async () => {
    const mine = copy(harborDeck, "mine");
    const kicker = brandOf(mine).styles?.kicker as BlockStyle;
    const cover = templateOf(mine, "cover");
    await agentApply(mine, [
      { op: "brand.set", set: { name: "Harbor Analytics Group" } },
      { op: "style.set", id: "kicker", style: { ...kicker, tone: "evidence" } },
      { op: "template.set", id: "cover", template: { ...toWrite(cover), name: "Cover page" } },
    ]);
    await open(mine, "welcome");
    await page.locator("[data-action='review']").click();
    await rows().first().waitFor();
    const where = async (id: string) => row(id).locator(".ed-ri-where").textContent();
    expect(await where("deck/brand/name")).toBe("Brand name");
    expect(await where("deck/style:kicker")).toBe("Style: Kicker");
    expect(await where("deck/template:cover")).toBe("Template: Cover page");
    expect(await row("deck/style:kicker").locator(".ed-df").textContent()).toContain('tone: "evidence"');

    await row("deck/brand/name").locator("[data-action='accept-change']").click();
    await row("deck/brand/name").waitFor({ state: "detached" });
    expect(brandOf(mine).name).toBe("Harbor Analytics Group");
    await row("deck/style:kicker").locator("[data-action='revert-change']").click();
    await expect.poll(() => brandOf(mine).styles?.kicker).toEqual(kicker);
    await row("deck/template:cover").locator("[data-action='revert-change']").click();
    await expect.poll(() => templateOf(mine, "cover")?.name).toBe("Cover");
    await expect.poll(() => rows().count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("offers to choose a scene together with the brand change it waits for, as the command line hints", async () => {
    const mine = copy(harborDeck, "mine");
    await agentApply(mine, [
      {
        op: "template.set",
        id: "big-quote",
        template: {
          name: "Big quote",
          description: "One quote across the slide.",
          slots: [
            {
              id: "quote",
              role: "body",
              frame: { x: 8, y: 20, w: 84, h: 60 },
              accepts: ["quote"],
              hint: "The quote.",
            },
          ],
        },
      },
      {
        op: "scene.add",
        after: "growth",
        scene: {
          id: "said",
          title: "Said",
          template: "big-quote",
          blocks: [{ id: "said-quote", type: "text", role: "quote", text: "We grew.", slot: "quote" }],
        },
      },
    ]);
    await open(mine, "said");
    await page.locator("[data-action='review']").click();
    await row("scene:said").waitFor();
    expect(await row("deck/template:big-quote").locator(".ed-ri-where").textContent()).toBe(
      "Template: Big quote",
    );
    await row("scene:said").locator("[data-action='accept-change']").click();
    const offer = page.locator(".ed-review-together");
    await offer.waitFor();
    expect(await offer.textContent()).toContain("Template: Big quote");
    await offer.locator("[data-action='accept-together']").click();
    await row("scene:said").waitFor({ state: "detached" });
    await row("deck/template:big-quote").waitFor({ state: "detached" });
    expect(problems).toEqual([]);
  });

  it("lists a font the agent added as a row of its own, says why Revert leaves it, and accepts it", async () => {
    const mine = copy(harborDeck, "mine");
    const added = await brandCommand("add", fontFile, mine, "--kind", "font");
    expect(added.code, JSON.stringify(added.json)).toBe(0);
    await open(mine, "context");
    await page.locator("[data-action='review']").click();
    const font = row("deck/file:fonts/TidewellText-Regular.woff2");
    await font.waitFor();
    expect(await font.locator(".ed-ri-where").textContent()).toBe("Font file TidewellText-Regular.woff2");
    expect(await font.locator(".ed-df").textContent()).toBe("brand/fonts/TidewellText-Regular.woff2");
    const before = everything(mine);
    await font.locator("[data-action='revert-change']").click();
    const problem = page.locator(".ed-review-problem");
    await expect.poll(() => problem.textContent()).toBe(FILE_REVERT_REASON);
    expect(await font.count()).toBe(1);
    expect(everything(mine)).toEqual(before);
    await font.locator("[data-action='accept-change']").click();
    await font.waitFor({ state: "detached" });
    expect(existsSync(join(mine, "brand/fonts/TidewellText-Regular.woff2"))).toBe(true);
    expect(problems).toEqual([]);
  });

  it("offers a font's own change with the brand change that names it, as the command line hints", async () => {
    const mine = copy(harborDeck, "mine");
    // The agent sends a font and names it for the body text.
    const added = await brandCommand("add", fontFile, mine, "--kind", "font");
    expect(added.code, JSON.stringify(added.json)).toBe(0);
    const fonts = brandOf(mine).fonts as Exclude<ReturnType<typeof brandOf>["fonts"], string | undefined>;
    const body = {
      family: "Tidewell Text",
      license: "OFL-1.1",
      files: [{ file: "fonts/TidewellText-Regular.woff2", weight: 400 as const, style: "normal" as const }],
    };
    await agentApply(mine, [{ op: "brand.set", set: { fonts: { ...fonts, body } } }]);
    await open(mine, "context");
    await page.locator("[data-action='review']").click();
    await row("deck/brand/fonts").waitFor();
    await row("deck/brand/fonts").locator("[data-action='accept-change']").click();
    const offer = page.locator(".ed-review-together");
    await offer.waitFor();
    expect(await offer.textContent()).toContain("Font file TidewellText-Regular.woff2");
    await offer.locator("[data-action='accept-together']").click();
    await row("deck/brand/fonts").waitFor({ state: "detached" });
    await row("deck/file:fonts/TidewellText-Regular.woff2").waitFor({ state: "detached" });
    expect(problems).toEqual([]);
  });

  it("leaves a revert of a brand change that names a file now gone, saying to put the file back first", async () => {
    const mine = copy(harborDeck, "mine");
    // Before any review: a dark logo on disk and named, as a person left it.
    writeFileSync(join(mine, "brand/logos/harbor-dark.svg"), LOGO);
    const brandFile = join(mine, "brand/brand.json");
    const json = JSON.parse(readFileSync(brandFile, "utf8"));
    writeFileSync(
      brandFile,
      `${JSON.stringify({ ...json, logos: { ...json.logos, dark: "logos/harbor-dark.svg" } }, null, 2)}\n`,
    );
    // The agent un-names it and takes the file out.
    const { dark: _dark, ...logos } = brandOf(mine).logos ?? { alt: "" };
    await agentApply(mine, [{ op: "brand.set", set: { logos } }]);
    const removed = await brandCommand(
      "remove",
      "logos/harbor-dark.svg",
      mine,
      "--base-rev",
      revisionOf(docAt(mine)),
    );
    expect(removed.code, JSON.stringify(removed.json)).toBe(0);
    await open(mine, "context");
    await page.locator("[data-action='review']").click();
    await row("deck/brand/logos").waitFor();
    expect(await row("deck/file:logos/harbor-dark.svg").locator(".ed-ri-where").textContent()).toBe(
      "Logo file harbor-dark.svg",
    );
    await row("deck/brand/logos").locator("[data-action='revert-change']").click();
    await expect
      .poll(() => page.locator(".ed-review-problem").textContent())
      .toBe("brand/logos/harbor-dark.svg does not exist. Put the file back, then revert this change.");
    expect(await row("deck/brand/logos").count()).toBe(1);
    expect(brandOf(mine).logos?.dark).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

// ---- older decks -----------------------------------------------------------------------------------------------------

describe("decks opened with the Brand panel", () => {
  for (const [name, fixture] of [
    ["an older deck", oldDeck],
    ["Tidewell Press", tidewellDeck],
    ["Harbor", harborDeck],
  ] as const) {
    it(`leaves ${name} as it was when the panel is only looked through`, async () => {
      const mine = copy(fixture, "mine");
      const before = everything(mine);
      await open(mine);
      await openBrand();
      if (docAt(mine).brand) {
        for (const tab of ["logos", "colors", "fonts", "chrome", "styles", "templates"]) {
          await panel().locator(`[data-tab='${tab}']`).click();
          await panel().locator(".ed-brand-section > *").first().waitFor();
        }
      }
      await page.keyboard.press("Escape");
      await panel().waitFor({ state: "detached" });
      await page.waitForTimeout(1500);
      expect(everything(mine)).toEqual(before);
      expect(problems).toEqual([]);
    });
  }
});

describe("the panel beside the slide", () => {
  it("leaves a 1280px window's slide drawn as a slide, and gives the right of the stage to the list of changes", async () => {
    const mine = copy(harborDeck, "mine");
    await open(mine, "growth");
    await openBrand("templates");
    // A stage under 640px wide lays a framed slide out as a column (player.css): the panel leaves the slide more.
    const slide = await page.evaluate(() => {
      const scene = document.querySelector(".ed-canvas-host .dc-scene[data-framed]");
      const rect = scene?.getBoundingClientRect();
      return rect && { width: rect.width, ratio: rect.width / rect.height, viewport: innerWidth };
    });
    expect(slide?.viewport).toBe(1280);
    expect(slide?.width).toBeGreaterThan(640);
    expect(slide?.ratio).toBeCloseTo(16 / 9, 1);

    // The deck's popover opens over the list of changes, and its Brand… closes the list.
    await page.locator("[data-action='review']").click();
    await page.locator(".ed-review:not([hidden])").waitFor();
    expect(await page.locator(".ed-brand").count()).toBe(0);
    await openBrand();
    expect(await page.locator(".ed-review").isHidden()).toBe(true);
    expect(problems).toEqual([]);
  });

  it("lies over the slide as a drawer in a 1024px window, keeps the keyboard, and closes with Escape", async () => {
    await page.setViewportSize({ width: 1024, height: 800 });
    const mine = copy(harborDeck, "mine");
    await open(mine, "growth");
    const host = page.locator(".ed-canvas-host");
    const before = await host.boundingBox();
    await openBrand("colors");
    const after = await host.boundingBox();
    const drawer = await panel().boundingBox();
    if (!before || !after || !drawer) throw new Error("the slide and the panel should be drawn");
    // The slide stays where and as large as it was, and the panel lies over its right side.
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(drawer.x).toBeLessThan(after.x + after.width);
    const scene = await page.evaluate(() => {
      const rect = document.querySelector(".ed-canvas-host .dc-scene[data-framed]")?.getBoundingClientRect();
      return rect && { width: rect.width, ratio: rect.width / rect.height };
    });
    expect(scene?.width).toBeGreaterThan(640);
    expect(scene?.ratio).toBeCloseTo(16 / 9, 1);

    // Tab and Shift+Tab go round inside the drawer, past its last control and its first.
    const inside = () => page.evaluate(() => document.activeElement?.closest(".ed-brand") !== null);
    const stops = await panel().evaluate(
      (element) =>
        [
          ...element.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]"),
        ].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0).length,
    );
    for (let press = 0; press < stops + 3; press++) {
      await page.keyboard.press("Tab");
      expect(await inside(), `Tab ${press + 1}`).toBe(true);
    }
    for (let press = 0; press < stops + 3; press++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside(), `Shift+Tab ${press + 1}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await panel().waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-tb"))).toBe("deck");

    // A press on the slide outside it closes it too, and only that: the block under it is not chosen.
    const chosen = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".ed-canvas-host [data-selected]")].map((node) =>
          node.getAttribute("data-id"),
        ),
      );
    await openBrand("colors");
    const chosenBefore = await chosen();
    expect(chosenBefore).not.toContain("growth-chart");
    const at = await slide("growth").locator("[data-id='growth-chart']").boundingBox();
    if (!at) throw new Error("the chart should be drawn");
    expect(at.x + 20).toBeLessThan(drawer.x);
    await page.mouse.click(at.x + 20, at.y + 20);
    await panel().waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-tb"))).toBe("deck");
    await page.waitForTimeout(200);
    expect(await chosen()).toEqual(chosenBefore);
    // The next press is the slide's again.
    await page.mouse.click(at.x + 20, at.y + 20);
    await expect.poll(chosen).toContain("growth-chart");
    expect(problems).toEqual([]);
  });
});

// ---- screenshots -----------------------------------------------------------------------------------------------------

/**
 * The screenshots Dimitri looks at, written only when DEPTHCUE_SHOTS names a folder: each section of the panel, a refused
 * swatch, the logo statement, a style's preview, Save as template, the template editor mid-drag, the drawer's brand rows,
 * a logo and a font sent, a logo refused, a brand file's row with what Revert says of it, and the panel as a drawer in a
 * 1024px window, on both presets.
 */
const SHOTS = process.env.DEPTHCUE_SHOTS;
describe.skipIf(!SHOTS)("screenshots of defining a brand", () => {
  for (const preset of ["paper", "ink"] as const) {
    it(`on ${preset}`, async () => {
      const dir = SHOTS as string;
      mkdirSync(dir, { recursive: true });
      const shot = (name: string) =>
        page.screenshot({ path: join(dir, `brand-define-${name}-${preset}.png`) });
      const mine = copy(harborDeck, "mine");
      await agentApply(mine, [{ op: "deck.set", set: { theme: preset } }]);
      await open(mine, "context");
      await openBrand();
      for (const tab of ["logos", "colors", "fonts", "chrome", "styles", "templates"]) {
        await panel().locator(`[data-tab='${tab}']`).click();
        await page.waitForTimeout(400);
        await shot(`panel-${tab}`);
      }
      await panel().locator("[data-tab='colors']").click();
      await drag(`brand:colors:${preset}:text`, preset === "paper" ? "#f4f4f4" : "#202020");
      await panel().locator(".ed-brand-lines .ed-problem:not([hidden])").waitFor();
      await shot("refused-swatch");
      await page.keyboard.press("Escape");

      await openBrand("styles");
      await field("brand:style:quiet-panel:edit").click();
      await panel().locator(".ed-brand-editor").scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot("style-preview");
      await page.keyboard.press("Escape");

      await page.locator(".ed-scene[data-scene='context']").click({ button: "right" });
      await page.locator(".ed-menu-item", { hasText: "Save as template…" }).first().click();
      await dialog("save-template").waitFor();
      await page.waitForTimeout(300);
      await shot("save-template");
      await page.keyboard.press("Escape");

      await goTo("growth");
      await openBrand("templates");
      await field("brand:template:chart-and-note:edit").click();
      const note = page.locator(".ed-tpl-slot[data-slot='note']");
      await note.waitFor();
      const area = await page.locator(".ed-tpl-slide").boundingBox();
      const at = await note.boundingBox();
      if (!area || !at) throw new Error("the template editor should be drawn");
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x + at.width / 2 - area.width * 0.035, at.y + at.height / 2, { steps: 8 });
      await page.waitForTimeout(200);
      await shot("template-editor-drag");
      await page.mouse.up();
      await page.locator("[data-action='template-done']").click();
      await saved();

      await agentApply(mine, [{ op: "brand.set", set: { name: "Harbor Analytics Group" } }]);
      await page.locator("[data-action='review']").click();
      await page.locator(".ed-review .ed-ri").first().waitFor();
      await page.waitForTimeout(300);
      await shot("review-rows");

      // The brand folder's files: a logo sent, one refused, a font sent, and the agent's font in the list of changes.
      await openBrand("logos");
      await field("brand:logos:dark:upload").setInputFiles({
        name: "harbor-dark.svg",
        mimeType: "image/svg+xml",
        buffer: LOGO,
      });
      await expect.poll(() => brandOf(mine).logos?.dark).toBe("logos/harbor-dark.svg");
      await saved();
      await page.waitForTimeout(400);
      await shot("upload-logo");
      await field("brand:logos:light:upload").setInputFiles({
        name: "mark.svg",
        mimeType: "image/svg+xml",
        buffer: UNSAFE,
      });
      await expect.poll(() => said().isVisible()).toBe(true);
      await shot("upload-refused");
      await panel().locator("[data-tab='fonts']").click();
      await field("brand:fonts:file-license").fill("OFL-1.1");
      await field("brand:fonts:file-role").selectOption("display");
      await field("brand:fonts:upload").setInputFiles({
        name: "TidewellText-Regular.woff2",
        mimeType: "font/woff2",
        buffer: readFileSync(fontFile),
      });
      await expect
        .poll(() => {
          const fonts = brandOf(mine).fonts;
          return typeof fonts === "object" ? fonts.display.family : fonts;
        })
        .toBe("Depthcue Classic Sans");
      await saved();
      await panel().locator(".ed-brand-face[data-family='Depthcue Classic Sans']").scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot("upload-font");
      await page.keyboard.press("Escape");
      const agentFont = join(tidewellDeck, "brand/fonts/TidewellDisplay-Regular.woff2");
      expect((await brandCommand("add", agentFont, mine, "--kind", "font")).code).toBe(0);
      await page.locator("[data-action='review']").click();
      const fileRow = page.locator(
        ".ed-review .ed-ri[data-id='deck/file:fonts/TidewellDisplay-Regular.woff2']",
      );
      await fileRow.waitFor();
      await fileRow.locator("[data-action='revert-change']").click();
      await page.locator(".ed-review-problem:not([hidden])").waitFor();
      await page.waitForTimeout(300);
      await shot("file-rows");

      // In a 1024px window the panel is a drawer over the slide.
      await page.setViewportSize({ width: 1024, height: 800 });
      await openBrand("chrome");
      await page.waitForTimeout(400);
      await shot("drawer-1024");
      // The refused logo is the one console error the page should have.
      expect(problems.filter((line) => !line.includes("status of 422"))).toEqual([]);
    }, 240_000);
  }
});
