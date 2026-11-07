import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Block, chartFromBarChart, loadDoc, replaceBlockOps } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * The chart block in a real Chrome: adding one, pasting numbers into its grid, switching its kind from the right-click
 * menu, and converting an old bar chart, each ending in the scene file on disk. Then the same chart written by an agent
 * through `depthcue apply`, which has to be the same file, and every kind in the player and in an exported page that
 * has no network.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const charts = fileURLToPath(new URL("../../../fixtures/decks/charts", import.meta.url));

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
  root = mkdtempSync(join(tmpdir(), "depthcue-chart-e2e-"));
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

/** A copy of a deck, served by an editor of its own, in a page of its own. */
async function openDeck(source = demo, prepare?: (folder: string) => void): Promise<Deck> {
  const folder = join(root, `deck-${decks.length}`);
  cpSync(source, folder, { recursive: true });
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
  await page.locator(".ed-frame .dc-scene").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const deck = { folder, server, page };
  decks.push(deck);
  return deck;
}

const sceneFile = (folder: string, scene = "method") =>
  readFileSync(join(folder, "scenes", `${scene}.json`), "utf8");
const diskOf = (folder: string) => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
type Chart = Extract<Block, { type: "chart" }>;
const chartOf = (folder: string, scene = "method", id = "method-chart"): Chart | undefined =>
  diskOf(folder).scenes[scene]?.blocks.find(
    (block): block is Chart => block.type === "chart" && block.id === id,
  );

/** Opens a scene of the strip by its number, from 1. */
async function goTo(page: Page, number: number) {
  await page
    .locator(".ed-scene")
    .nth(number - 1)
    .click();
}

const CHART = ".ed-frame [data-id='method-chart']";
const cell = (page: Page, row: number, column: number) =>
  page.locator(`.ed-chart-grid [data-row="${row}"][data-col="${column}"]`);
const menu = (page: Page) => page.locator(".ed-menu:not(.ed-menu-sub)");
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const kindItem = (page: Page, kind: string) => page.locator(`[data-command='chart-${kind}']`);

/** Adds a chart to the method scene from the quick bar, and waits for it to be drawn and on disk. */
async function addChart(deck: Deck) {
  await goTo(deck.page, 3);
  await deck.page.locator("[data-quick='insert']").click();
  await deck.page.locator("[data-quick='chart']").click();
  await deck.page.locator(`${CHART} svg.dc-plot`).waitFor();
  await expect.poll(() => chartOf(deck.folder)?.kind).toBe("bar");
}

/** Right-clicks the chart and chooses a kind from the submenu of Chart type. */
async function chooseKind(page: Page, kind: string, id = "method-chart") {
  await page.locator(`.ed-frame [data-id='${id}']`).click({ button: "right" });
  await menu(page).waitFor();
  await menuItem(page, "Chart type").click();
  await kindItem(page, kind).click();
  await menu(page).waitFor({ state: "hidden" });
}

/** What a spreadsheet puts on the clipboard for four rows of three numbers. */
const NUMBERS = [
  [1, 2, 3],
  [4, 5, 6],
  [7, 8, 9],
  [10, 11, 12],
]
  .map((row) => row.join("\t"))
  .join("\n");

/** The chart the editor session below ends with, which the agent test writes by hand. */
const FINAL: Chart = {
  id: "method-chart",
  type: "chart",
  kind: "stacked-bar",
  columns: [{ label: "Category" }, { label: "Value" }, { label: "Column 3" }],
  rows: [
    ["1", 2, 3],
    ["4", 5, 6],
    ["7", 8, 9],
    ["10", 11, 12],
  ],
};

/** Adds a chart, pastes four rows of three numbers into its grid, and switches it to a line and then to a stacked bar. */
async function editAChart(deck: Deck) {
  const { page } = deck;
  await addChart(deck);
  expect(chartOf(deck.folder)).toEqual({
    id: "method-chart",
    type: "chart",
    kind: "bar",
    columns: [{ label: "Category" }, { label: "Value" }],
    rows: [
      ["First", 3],
      ["Second", 5],
      ["Third", 4],
    ],
  });

  // The numbers, pasted at the first cell of the grid in the Data popover. A press starts the cell and Escape leaves it.
  await page.locator(".ed-toolbar [data-tb='data']").click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), NUMBERS);
  await cell(page, 0, 0).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+v");
  await expect.poll(() => chartOf(deck.folder)?.rows.length).toBe(4);
  await page.keyboard.press("Escape");

  await chooseKind(page, "line");
  await expect.poll(() => chartOf(deck.folder)?.kind).toBe("line");
  await chooseKind(page, "stacked-bar");
  await expect.poll(() => chartOf(deck.folder)?.kind).toBe("stacked-bar");
}

describe("the chart block in a real browser", () => {
  it("adds a chart, takes pasted numbers, and switches to a line and a stacked bar from the right-click menu, and the file holds exactly that", async () => {
    const deck = await openDeck();
    await editAChart(deck);
    expect(chartOf(deck.folder)).toEqual(FINAL);
    // The scene moved up to the version that has charts, and nothing else in the file was touched.
    const file = JSON.parse(sceneFile(deck.folder));
    expect(file.schemaVersion).toBe("0.3");
    expect(file.blocks.map((block: Block) => block.id)).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
      "method-chart",
    ]);
    expect(problems).toEqual([]);
  });

  it("draws the chart as the kind it is, and holds its data as a table for a screen reader", async () => {
    const deck = await openDeck();
    await editAChart(deck);
    const { page } = deck;
    // The block's own element is the figure.
    const figure = page.locator(`.ed-frame figure.dc-plot-figure[data-id='method-chart']`);
    expect(await figure.getAttribute("data-kind")).toBe("stacked-bar");
    expect(await figure.locator("svg.dc-plot").getAttribute("role")).toBe("img");
    expect(await figure.locator("svg.dc-plot").getAttribute("aria-label")).toBe("Stacked bar chart");
    expect(await figure.locator(".dc-sr-only th[scope='col']").allTextContents()).toEqual([
      "Category",
      "Value",
      "Column 3",
    ]);
    expect(await figure.locator(".dc-sr-only tbody tr").allTextContents()).toEqual([
      "123",
      "456",
      "789",
      "101112",
    ]);
    // Two series, so the legend names both, and the text of the axes is text.
    expect(await figure.locator(".dc-legend li").allTextContents()).toEqual(["Value", "Column 3"]);
    expect(await figure.locator("svg.dc-plot text").count()).toBeGreaterThan(3);
    expect(problems).toEqual([]);
  });

  it("greys a kind the data cannot take, with the reason, in a menu that stays open", async () => {
    const deck = await openDeck();
    await editAChart(deck);
    const { page } = deck;
    await page.locator(CHART).click({ button: "right" });
    await menuItem(page, "Chart type").click();
    const donut = kindItem(page, "donut");
    expect(await donut.getAttribute("aria-disabled")).toBe("true");
    expect(await donut.locator(".ed-menu-why").textContent()).toBe(
      "A donut shows one series, and this one has 2.",
    );
    // Playwright refuses to press a disabled item, and a person can, so press it anyway.
    await donut.click({ force: true });
    expect(await menu(page).isVisible()).toBe(true);
    expect(chartOf(deck.folder)?.kind).toBe("stacked-bar");
    // The kind it is shows as chosen.
    expect(await kindItem(page, "stacked-bar").getAttribute("aria-checked")).toBe("true");
    await page.keyboard.press("Escape");
    expect(problems).toEqual([]);
  });

  it("takes each change back with one Undo: the kind, the kind, the paste, and the chart itself", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await editAChart(deck);
    await page.keyboard.press("Control+z");
    await expect.poll(() => chartOf(deck.folder)?.kind).toBe("line");
    await page.keyboard.press("Control+z");
    await expect.poll(() => chartOf(deck.folder)?.kind).toBe("bar");
    expect(chartOf(deck.folder)?.rows).toHaveLength(4);
    await page.keyboard.press("Control+z");
    await expect
      .poll(() => chartOf(deck.folder)?.rows)
      .toEqual([
        ["First", 3],
        ["Second", 5],
        ["Third", 4],
      ]);
    expect(chartOf(deck.folder)?.columns).toHaveLength(2);
    await page.keyboard.press("Control+z");
    await expect.poll(() => chartOf(deck.folder)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("writes the same file as an agent that makes the same change through depthcue apply", async () => {
    const editor = await openDeck();
    await editAChart(editor);
    // An agent in another deck: the same chart added after the picture, and the same data and kind set by hand.
    const agent = join(root, "agent");
    cpSync(demo, agent, { recursive: true });
    applyTo(agent, [
      {
        op: "block.add",
        scene: "method",
        after: "method-diagram",
        block: {
          id: "method-chart",
          type: "chart",
          kind: "bar",
          columns: [{ label: "Category" }, { label: "Value" }],
          rows: [
            ["First", 3],
            ["Second", 5],
            ["Third", 4],
          ],
        },
      },
    ]);
    applyTo(agent, [
      {
        op: "block.set",
        scene: "method",
        id: "method-chart",
        set: { columns: FINAL.columns, rows: FINAL.rows },
      },
    ]);
    applyTo(agent, [{ op: "block.set", scene: "method", id: "method-chart", set: { kind: "line" } }]);
    applyTo(agent, [{ op: "block.set", scene: "method", id: "method-chart", set: { kind: "stacked-bar" } }]);
    await expect.poll(() => sceneFile(editor.folder)).toBe(sceneFile(agent));
    expect(readFileSync(join(editor.folder, "deck.json"), "utf8")).toBe(
      readFileSync(join(agent, "deck.json"), "utf8"),
    );
  });

  it("shows why a cell was refused, with the fix, and keeps what the chart had", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await addChart(deck);
    await page.locator(".ed-toolbar [data-tb='data']").click();
    await cell(page, 0, 0).click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Enter");
    const hint = (await page.locator(".ed-hint").textContent()) ?? "";
    expect(hint).toContain("Row 1 has no category label.");
    expect(hint).toContain("Write the label for this row, or remove the row.");
    expect(chartOf(deck.folder)?.rows[0]).toEqual(["First", 3]);
    // A second series on a donut is refused with the core's reason.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await chooseKind(page, "donut");
    await expect.poll(() => chartOf(deck.folder)?.kind).toBe("donut");
    await page.locator(".ed-toolbar [data-tb='data']").click();
    await cell(page, 0, 1).click();
    await page.keyboard.press("Escape");
    await page.locator("[data-chart='series']").click();
    expect(await page.locator(".ed-hint").textContent()).toContain(
      "A donut shows one series, and this one has 2.",
    );
    expect(chartOf(deck.folder)?.columns).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  it("opens the data from the menu with the keyboard on the grid, and adds a row and a series from its buttons", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await addChart(deck);
    await page.locator(CHART).click({ button: "right" });
    await menu(page).waitFor();
    await menuItem(page, "Edit data").click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-row"))).toBe("-1");
    await page.locator("[data-chart='row']").click();
    await expect.poll(() => chartOf(deck.folder)?.rows.length).toBe(4);
    await page.locator("[data-chart='series']").click();
    await expect.poll(() => chartOf(deck.folder)?.columns.length).toBe(3);
    // The first series is "Value", so the new one is the second.
    expect(chartOf(deck.folder)?.columns[2]).toEqual({ label: "Series 2" });
    expect(problems).toEqual([]);
  });

  it("converts an old bar chart to a chart of the kind chosen, under the same id, and an agent's conversion is the same file", async () => {
    const editor = await openDeck();
    const { page } = editor;
    await goTo(page, 2);
    const old = page.locator(".ed-frame [data-id='chart-demand']");
    await old.locator(".dc-bar[role='slider']").first().waitFor();
    const beforeFile = sceneFile(editor.folder, "demand");
    const beforeScene = JSON.parse(beforeFile);
    await old.click({ button: "right" });
    await menu(page).waitFor();
    // An old chart has no data grid yet, and offers every kind to convert it to.
    expect(await menu(page).locator("[data-command='chart-data']").count()).toBe(0);
    await menuItem(page, "Chart type").click();
    await kindItem(page, "line").click();
    await expect.poll(() => chartOf(editor.folder, "demand", "chart-demand")?.kind).toBe("line");
    const converted = chartOf(editor.folder, "demand", "chart-demand");
    expect(converted?.columns).toEqual([{ label: "Label" }, { label: "Value" }]);
    // The claim still cites the chart, and the file is otherwise as it was.
    const scene = diskOf(editor.folder).scenes.demand;
    expect(scene?.summary?.evidenceIds).toContain("chart-demand");
    expect(sceneFile(editor.folder, "demand")).not.toBe(beforeFile);
    expect(await page.locator(".ed-frame [data-id='chart-demand'] .dc-bar[role='slider']").count()).toBe(0);

    const agent = join(root, "agent");
    cpSync(demo, agent, { recursive: true });
    const before = diskOf(agent).scenes.demand;
    const bars = before?.blocks.find((block) => block.id === "chart-demand");
    if (!before || bars?.type !== "bar-chart") throw new Error("the demo should have its bar chart");
    applyTo(agent, replaceBlockOps(before, { ...chartFromBarChart(bars), kind: "line" }));
    await expect.poll(() => sceneFile(editor.folder, "demand")).toBe(sceneFile(agent, "demand"));

    // One Undo takes the conversion back, bar dragging and all.
    await page.keyboard.press("Control+z");
    // The editor writes its own formatting, so the file is the same scene and not the same bytes.
    await expect.poll(() => JSON.parse(sceneFile(editor.folder, "demand"))).toEqual(beforeScene);
    expect(problems).toEqual([]);
  });

  for (const size of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    it(`keeps the chart in view beside its data while the data is edited at ${size.width} wide`, async () => {
      const deck = await openDeck(charts);
      const { page } = deck;
      await page.setViewportSize(size);
      await goTo(page, 2);
      const chart = page.locator(".ed-frame [data-id='stacked-chart']");
      await chart.locator("svg.dc-plot").waitFor();
      await chart.click();
      await page.locator(".ed-toolbar [data-tb='data']").click();
      const pop = page.locator(".ed-toolbar .ed-tb-pop:not([hidden])");
      await pop.locator("[data-cell]").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      const [popBox, chartBox, slideBox] = await Promise.all([
        pop.boundingBox(),
        chart.boundingBox(),
        page.locator(".ed-frame").boundingBox(),
      ]);
      if (!popBox || !chartBox || !slideBox)
        throw new Error("the popover, the chart and the slide should all be drawn");
      // No part of the popover is over the chart. A wide window gives it the inspector's column, right of the slide;
      // a narrower one keeps it inside the slide.
      expect(popBox.x + popBox.width <= chartBox.x || popBox.x >= chartBox.x + chartBox.width).toBe(true);
      if (size.width >= 1440) {
        expect(popBox.x).toBeGreaterThanOrEqual(slideBox.x + slideBox.width);
        expect(popBox.x + popBox.width).toBeLessThanOrEqual(size.width);
      } else {
        expect(popBox.x).toBeGreaterThanOrEqual(slideBox.x);
        expect(popBox.x + popBox.width).toBeLessThanOrEqual(slideBox.x + slideBox.width);
      }
      // Four columns show in full: the grid does not scroll sideways, and the last column's words keep their padding.
      const fit = await pop.locator(".ed-chart-grid").evaluate((grid) => {
        const box = grid.getBoundingClientRect();
        const edges = [...grid.querySelectorAll("tr")].map((row) => {
          const last = row.lastElementChild as HTMLElement;
          const words = document.createRange();
          words.selectNodeContents(last);
          return { cell: last.getBoundingClientRect().right, words: words.getBoundingClientRect().right };
        });
        return {
          scrolls: grid.scrollWidth - grid.clientWidth,
          columns: grid.querySelectorAll("thead th").length,
          room: Math.min(...edges.map((edge) => box.right - 1 - edge.words)),
          inside: Math.max(...edges.map((edge) => edge.cell - box.right)),
        };
      });
      expect(fit.columns).toBe(4);
      expect(fit.scrolls).toBeLessThanOrEqual(0);
      expect(fit.inside).toBeLessThanOrEqual(0);
      // The words end well short of the border: at least the cell's padding, which is about 8 pixels.
      expect(fit.room).toBeGreaterThanOrEqual(6);
      // A number typed into the grid is on the chart before the cell is left.
      await cell(page, 1, 2).click();
      await page.keyboard.type("40");
      await page.keyboard.press("Enter");
      await expect.poll(() => chartOf(deck.folder, "stacked", "stacked-chart")?.rows[1]?.[2]).toBe(40);
      expect(await chart.locator(".dc-sr-only tbody tr").nth(1).locator("th, td").allTextContents()).toEqual([
        "2023",
        "14",
        "40",
        "6",
      ]);
      expect(problems).toEqual([]);
    });
  }

  it("recolors every series when the deck's palette changes, in the editor and at /present", async () => {
    const deck = await openDeck(charts);
    const { page } = deck;
    await goTo(page, 2);
    const fills = (target: Page, scene: string) =>
      target.evaluate((id) => {
        const plot = document.querySelector(`[data-id='${id}'] svg.dc-plot`);
        const fillOf = (slot: string) => {
          const mark = plot?.querySelector(`.dc-mark[data-s='${slot}']`);
          return mark ? getComputedStyle(mark).fill : "";
        };
        return { first: fillOf("1"), second: fillOf("2"), third: fillOf("3") };
      }, `${scene}-chart`);
    await page.locator(".ed-frame [data-id='stacked-chart'] svg.dc-plot").waitFor();
    const before = await fills(page, "stacked");
    // Paper's evidence and action colors lead, in that order.
    expect(before.first).toBe("rgb(43, 85, 230)");
    expect(before.second).toBe("rgb(199, 58, 24)");
    await page.locator(".ed-bar-deck [data-tb='deck']").click();
    const popover = page.locator(".ed-bar-deck .ed-tb-pop:not([hidden])");
    const section = popover.locator("details[data-section='style']");
    if ((await section.getAttribute("open")) === null) await section.locator("summary").click();
    await popover.locator("[data-field='panel:deck:palette:evidence']").fill("#0044cc");
    await expect.poll(() => diskOf(deck.folder).deck.palette).toEqual({ evidence: "#0044cc" });
    await page.locator(".ed-status[data-state='saved']").waitFor();
    const after = await fills(page, "stacked");
    expect(after.first).toBe("rgb(0, 68, 204)");
    expect(after.second).toBe(before.second);
    // The third series is a mix of the two, so a new evidence color moves it too.
    expect(after.third).not.toBe(before.third);
    const present = await context.newPage();
    await present.goto(`${deck.server.url}present#/stacked`);
    await present.locator(".dc-scene svg.dc-plot").waitFor();
    expect(await fills(present, "stacked")).toEqual(after);
    expect(problems).toEqual([]);
  });
});

/** Applies operations to a deck folder through the command an agent uses. */
function applyTo(folder: string, list: unknown[]) {
  const ops = join(root, "ops.json");
  writeFileSync(ops, JSON.stringify(list));
  const lines: string[] = [];
  const errors: string[] = [];
  const rev: string[] = [];
  expect(run(["rev", folder], { out: (line) => rev.push(line), err: (line) => errors.push(line) })).toBe(0);
  const code = run(["apply", folder, ops, "--base-rev", rev[0] as string], {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  });
  expect({ code, errors }).toEqual({ code: 0, errors: [] });
}

/** What each scene of the charts deck draws: its kind, the data series it colors, and the rows of its table. */
const KINDS = [
  { scene: "bar", kind: "bar", label: "Bar", slots: 2, legend: 2, rows: 4 },
  { scene: "stacked", kind: "stacked-bar", label: "Stacked bar", slots: 3, legend: 3, rows: 4 },
  { scene: "line", kind: "line", label: "Line", slots: 2, legend: 2, rows: 8 },
  { scene: "area", kind: "area", label: "Area", slots: 2, legend: 2, rows: 6 },
  { scene: "scatter", kind: "scatter", label: "Scatter", slots: 2, legend: 2, rows: 6 },
  { scene: "donut", kind: "donut", label: "Donut", slots: 5, legend: 0, rows: 5 },
] as const;

/** What the page draws for the chart of the scene on show. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const figure = document.querySelector<HTMLElement>(".dc-scene figure.dc-plot-figure");
    const plot = figure?.querySelector("svg.dc-plot");
    return {
      kind: figure?.dataset.kind,
      role: plot?.getAttribute("role"),
      label: plot?.getAttribute("aria-label") ?? "",
      slots: new Set(
        [...(plot?.querySelectorAll("[data-s]") ?? [])].map((node) => node.getAttribute("data-s")),
      ).size,
      legend: figure?.querySelectorAll(".dc-legend li").length ?? 0,
      texts: plot?.querySelectorAll("text").length ?? 0,
      tableRows: figure?.querySelectorAll(".dc-sr-only tbody tr").length ?? 0,
      box: plot?.getBoundingClientRect().width ?? 0,
    };
  });

describe("every kind of chart in the player and in an exported page", () => {
  it("draws each kind in the player, with a legend for its series and a table for a screen reader", async () => {
    const deck = await openDeck(charts);
    for (const { scene, kind, label, slots, legend, rows } of KINDS) {
      const present = await context.newPage();
      present.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      await present.goto(`${deck.server.url}present#/${scene}`);
      await present.locator(".dc-scene svg.dc-plot").waitFor();
      await present.evaluate(() => document.fonts.ready);
      const seen = await drawn(present);
      expect(seen, scene).toMatchObject({ kind, role: "img", slots, legend, tableRows: rows });
      expect(seen.label.startsWith(`${label} chart`), scene).toBe(true);
      expect(seen.texts, scene).toBeGreaterThan(2);
      expect(seen.box, scene).toBeGreaterThan(200);
      await present.close();
    }
    expect(problems).toEqual([]);
  });

  it("exports a page that draws every kind with no network", async () => {
    const deck = await openDeck(charts);
    const out = join(root, "out");
    expect(run(["export", deck.folder, "--out", out], { out: () => {}, err: () => {} })).toBe(0);
    const outside: string[] = [];
    for (const { scene, kind, label, slots, legend, rows } of KINDS) {
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("request", (request) => {
        if (!request.url().startsWith("file:") && !request.url().startsWith("data:"))
          outside.push(request.url());
      });
      await page.goto(`${pathToFileURL(join(out, "index.html")).href}#/${scene}`);
      await page.locator(".dc-scene svg.dc-plot").waitFor();
      const seen = await drawn(page);
      expect(seen, scene).toMatchObject({ kind, role: "img", slots, legend, tableRows: rows });
      expect(seen.label.startsWith(`${label} chart`), scene).toBe(true);
      await page.close();
    }
    expect(outside).toEqual([]);
    expect(problems).toEqual([]);
  });

  for (const theme of ["paper", "ink"]) {
    it(`writes each donut share in a color that reads on its part, on the ${theme} preset`, async () => {
      const deck = await openDeck(charts, (folder) => {
        const file = join(folder, "deck.json");
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), theme }, null, 2));
      });
      const present = await context.newPage();
      await present.goto(`${deck.server.url}present#/donut`);
      await present.locator(".dc-scene svg.dc-plot").waitFor();
      await present.evaluate(() => document.fonts.ready);
      const ratios = await present.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
        // Any color the page computes, as the red, green and blue the screen shows.
        const rgb = (value: string) => {
          paint.clearRect(0, 0, 1, 1);
          paint.fillStyle = value;
          paint.fillRect(0, 0, 1, 1);
          return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3) as number[];
        };
        const light = (channels: number[]) => {
          const [r = 0, g = 0, b = 0] = channels.map((channel) => {
            const v = channel / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        return [...document.querySelectorAll(".dc-scene text.dc-share")].map((label) => {
          const part = label
            .closest("svg")
            ?.querySelector(`path.dc-mark[data-s='${label.getAttribute("data-s")}']`);
          const [a, b] = [label, part as Element].map((node) => light(rgb(getComputedStyle(node).fill)));
          const [high, low] = [Math.max(a as number, b as number), Math.min(a as number, b as number)];
          return { share: label.textContent, ratio: Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100 };
        });
      });
      expect(ratios.map((entry) => entry.share)).toEqual(["43%", "29%", "14%", "10%"]);
      for (const { share, ratio } of ratios)
        expect(ratio, `${theme} ${share} of ${JSON.stringify(ratios)}`).toBeGreaterThanOrEqual(4.5);
      // No halo is painted over the glyphs.
      expect(
        await present
          .locator(".dc-scene text.dc-share")
          .first()
          .evaluate((node) => getComputedStyle(node).stroke),
      ).toBe("none");
      expect(problems).toEqual([]);
    });
  }

  it("puts the sentences of a chart in the table that a screen reader gets, with its unit in the header", async () => {
    const deck = await openDeck(charts);
    const present = await context.newPage();
    await present.goto(`${deck.server.url}present#/stacked`);
    await present.locator(".dc-scene svg.dc-plot").waitFor();
    const table = present.locator(".dc-scene .dc-sr-only table");
    expect(await table.locator("th[scope='col']").allTextContents()).toEqual([
      "Year",
      "Hardware ($M)",
      "Software ($M)",
      "Services ($M)",
    ]);
    expect(await table.locator("tbody tr").nth(2).locator("th, td").allTextContents()).toEqual([
      "2024",
      "13",
      "15",
      "8",
    ]);
    expect(problems).toEqual([]);
  });

  it("passes the render check for every kind, and fails it, with the reason, for a chart in a frame too small to read", async () => {
    const fits = await openDeck(charts);
    const ok = await render(fits.folder);
    expect(ok.lines.at(-1)).toBe("7 scenes rendered, 0 errors, 0 warnings");
    expect(ok.code).toBe(0);

    const tiny = await openDeck(charts, (folder) => {
      const file = join(folder, "scenes", "framed.json");
      const scene = JSON.parse(readFileSync(file, "utf8"));
      for (const block of scene.blocks)
        if (block.id === "framed-orders") block.frame = { x: 5, y: 30, w: 9, h: 12 };
      writeFileSync(file, JSON.stringify(scene, null, 2));
    });
    const bad = await render(tiny.folder, "framed");
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toMatch(/^FAIL framed/);
    expect(bad.lines.join("\n")).toContain("framed-orders");
  }, 180_000);
});

/** The render check of a deck, or one scene of it, as the command prints it. */
async function render(folder: string, scene?: string) {
  const lines: string[] = [];
  const code = await run(["render", folder, ...(scene ? [scene] : [])], {
    out: (line) => lines.push(line),
    err: () => {},
  });
  return { code, lines };
}

/**
 * The screenshots Dimitri looks at, written only when DEPTHCUE_SHOTS names a folder: the data grid being edited with the
 * chart beside it, the menu of chart types open, and one slide for each kind in the player, at the two sizes a presenter
 * meets.
 */
const SHOTS = process.env.DEPTHCUE_SHOTS;
describe.skipIf(!SHOTS)("screenshots of a chart", () => {
  const SIZES = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ];

  for (const size of SIZES) {
    it(`edits and presents at ${size.width}x${size.height}`, async () => {
      const dir = SHOTS as string;
      mkdirSync(dir, { recursive: true });
      const tag = `${size.width}x${size.height}`;
      const deck = await openDeck(charts);
      const { page } = deck;
      await page.setViewportSize(size);
      await goTo(page, 2);
      const chart = page.locator(".ed-frame [data-id='stacked-chart']");
      await chart.locator("svg.dc-plot").waitFor();
      await page.evaluate(() => document.fonts.ready);
      // The data grid with a cell being typed in, and the chart beside it.
      await chart.click();
      await page.locator(".ed-toolbar [data-tb='data']").click();
      await cell(page, 1, 2).click();
      await page.keyboard.type("21");
      await page.screenshot({ path: join(dir, `chart-data-${tag}.png`) });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      // The menu of chart types, with the kinds a stacked chart's data cannot take shown greyed.
      await chart.click({ button: "right" });
      await menu(page).waitFor();
      await menuItem(page, "Chart type").click();
      await kindItem(page, "donut").waitFor();
      await page.screenshot({ path: join(dir, `chart-menu-${tag}.png`) });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      for (const { scene, kind } of [...KINDS, { scene: "framed", kind: "framed" }]) {
        const present = await context.newPage();
        await present.setViewportSize(size);
        await present.goto(`${deck.server.url}present#/${scene}`);
        // A pinned chart leaves a hidden copy in the flow of the page, and only the block itself carries its id.
        await present.locator(".dc-scene [data-id] svg.dc-plot").first().waitFor();
        await present.evaluate(() => document.fonts.ready);
        await present.waitForLoadState("networkidle");
        await present.screenshot({ path: join(dir, `chart-${kind}-${tag}.png`) });
        await present.close();
      }
      expect(problems).toEqual([]);
    }, 120_000);
  }
});
