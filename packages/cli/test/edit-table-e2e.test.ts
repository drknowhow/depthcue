import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Block, loadDoc } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { run } from "../src/index.ts";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * The table block in a real Chrome: adding one, typing in its cells with Tab, pasting cells from a spreadsheet, and the
 * menu of a cell, each ending in the scene file on disk. Then the same table written by an agent through
 * `depthcue apply`, which has to be the same file, and the table in the player and in an exported page.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

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
  root = mkdtempSync(join(tmpdir(), "depthcue-table-e2e-"));
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

/** A copy of the demo deck, served by an editor of its own, in a page of its own. */
async function openDeck(prepare?: (folder: string) => void): Promise<Deck> {
  const folder = join(root, `deck-${decks.length}`);
  cpSync(demo, folder, { recursive: true });
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
  await page.locator(".ed-frame [data-id='opening-title']").waitFor();
  const deck = { folder, server, page };
  decks.push(deck);
  return deck;
}

const sceneFile = (folder: string) => readFileSync(join(folder, "scenes", "method.json"), "utf8");
const diskOf = (folder: string) => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
type Table = Extract<Block, { type: "table" }>;
const tableOf = (folder: string): Table | undefined =>
  diskOf(folder).scenes.method?.blocks.find((block): block is Table => block.type === "table");

/** Opens a scene of the strip by its number, from 1. */
async function goTo(page: Page, number: number) {
  await page
    .locator(".ed-scene")
    .nth(number - 1)
    .click();
}

const TABLE = ".ed-frame [data-id='method-table']";
const cell = (page: Page, row: number, column: number) =>
  page.locator(`${TABLE} [data-row="${row}"][data-col="${column}"]`);
const menu = (page: Page) => page.locator(".ed-menu:not(.ed-menu-sub)");
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

/** Puts a table in the method scene from the quick bar, and waits for its grid. */
async function addTable(deck: Deck) {
  await goTo(deck.page, 3);
  await deck.page.locator("[data-quick='table']").click();
  await deck.page.locator(`${TABLE} [role='grid']`).waitFor();
  await expect.poll(() => tableOf(deck.folder)?.id).toBe("method-table");
}

/** What a spreadsheet puts on the clipboard for a block of five rows and four columns. */
const SHEET = [
  ["North", "12", "13", "x"],
  ["South", "14", "15", "y"],
  ["East", "16", "17", "z"],
  ["West", "18", "19", "w"],
  ["Central", "20", "21", "v"],
]
  .map((row) => row.join("\t"))
  .join("\n");

/** The table the editor session below ends with, which the agent test writes by hand. */
const FINAL_COLUMNS = [
  { label: "Column 1" },
  { label: "Column 2" },
  { label: "Column 3" },
  { label: "Column 4" },
];
const FINAL_ROWS = [
  ["Apples", "Pears", "Plums", null],
  ["North", "12", "13", "x"],
  ["South", "14", "15", "y"],
  [null, null, null, null],
  ["East", "16", "17", "z"],
  ["West", "18", "19", "w"],
  ["Central", "20", "21", "v"],
];

/** Adds a table, types three cells with Tab, pastes five rows of four cells below them and inserts a row from a cell's menu. */
async function editATable(deck: Deck) {
  const { page } = deck;
  await addTable(deck);
  expect(tableOf(deck.folder)).toEqual({
    id: "method-table",
    type: "table",
    columns: [{ label: "Column 1" }, { label: "Column 2" }, { label: "Column 3" }],
    rows: [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ],
  });

  // Three cells typed with Tab. A press starts the cell, and Tab commits it and lands on the next.
  await cell(page, 0, 0).click();
  await page.keyboard.type("Apples");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Pears");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Plums");
  await page.keyboard.press("Enter");
  await expect.poll(() => tableOf(deck.folder)?.rows[0]).toEqual(["Apples", "Pears", "Plums"]);

  // Cells from a spreadsheet, pasted at the first cell of the second row.
  await page.evaluate((text) => navigator.clipboard.writeText(text), SHEET);
  await cell(page, 1, 0).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+v");
  await expect.poll(() => tableOf(deck.folder)?.rows.length).toBe(6);
  expect(tableOf(deck.folder)?.columns).toEqual(FINAL_COLUMNS);

  // A row below the second row, from the menu of a cell in it.
  await cell(page, 2, 1).click({ button: "right" });
  await menu(page).waitFor();
  expect(await menu(page).getAttribute("aria-label")).toBe("Cell menu");
  await menuItem(page, "Insert row below").click();
  await expect.poll(() => tableOf(deck.folder)?.rows).toEqual(FINAL_ROWS);
}

describe("the table block in a real browser", () => {
  it("adds a table, takes typed and pasted cells and a row from a cell menu, and the scene file holds exactly that", async () => {
    const deck = await openDeck();
    await editATable(deck);
    expect(tableOf(deck.folder)).toEqual({
      id: "method-table",
      type: "table",
      columns: FINAL_COLUMNS,
      rows: FINAL_ROWS,
    });
    // The scene moved up to the version that has tables, and nothing else in the file was touched.
    const file = JSON.parse(sceneFile(deck.folder));
    expect(file.schemaVersion).toBe("0.3");
    expect(file.blocks.map((block: Block) => block.id)).toEqual([
      "method-heading",
      "method-body",
      "method-diagram",
      "method-table",
    ]);
    expect(problems).toEqual([]);
  });

  it("takes each edit back with one Undo: the row, then the paste, then the three cells one at a time", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await editATable(deck);
    await page.keyboard.press("Control+z");
    await expect.poll(() => tableOf(deck.folder)?.rows.length).toBe(6);
    await page.keyboard.press("Control+z");
    await expect
      .poll(() => tableOf(deck.folder)?.rows)
      .toEqual([
        ["Apples", "Pears", "Plums"],
        [null, null, null],
        [null, null, null],
      ]);
    expect(tableOf(deck.folder)?.columns).toHaveLength(3);
    await page.keyboard.press("Control+z");
    await expect.poll(() => tableOf(deck.folder)?.rows[0]).toEqual(["Apples", "Pears", null]);
    expect(problems).toEqual([]);
  });

  it("writes the same file as an agent that makes the same change through depthcue apply", async () => {
    const editor = await openDeck();
    await editATable(editor);
    // An agent in another deck: the same table added after the picture, and the same rows set by hand.
    const agent = join(root, "agent");
    cpSync(demo, agent, { recursive: true });
    const ops = join(root, "ops.json");
    const apply = (list: unknown[]) => {
      writeFileSync(ops, JSON.stringify(list));
      const lines: string[] = [];
      const errors: string[] = [];
      const rev: string[] = [];
      expect(run(["rev", agent], { out: (line) => rev.push(line), err: (line) => errors.push(line) })).toBe(
        0,
      );
      const code = run(["apply", agent, ops, "--base-rev", rev[0] as string], {
        out: (line) => lines.push(line),
        err: (line) => errors.push(line),
      });
      expect({ code, errors }).toEqual({ code: 0, errors: [] });
    };
    apply([
      {
        op: "block.add",
        scene: "method",
        after: "method-diagram",
        block: {
          id: "method-table",
          type: "table",
          columns: [{ label: "Column 1" }, { label: "Column 2" }, { label: "Column 3" }],
          rows: [
            [null, null, null],
            [null, null, null],
            [null, null, null],
          ],
        },
      },
    ]);
    apply([
      {
        op: "block.set",
        scene: "method",
        id: "method-table",
        set: { columns: FINAL_COLUMNS, rows: FINAL_ROWS },
      },
    ]);
    await expect.poll(() => sceneFile(editor.folder)).toBe(sceneFile(agent));
    expect(readFileSync(join(editor.folder, "deck.json"), "utf8")).toBe(
      readFileSync(join(agent, "deck.json"), "utf8"),
    );
  });

  it("types numbers in a column of numbers, refuses words in it with the reason, and writes numbers and a unit", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await addTable(deck);
    // The first column holds numbers, from the cell menu.
    await cell(page, 1, 0).click({ button: "right" });
    await menuItem(page, "Make column numbers").click();
    await expect.poll(() => tableOf(deck.folder)?.columns[0]).toEqual({ label: "Column 1", kind: "number" });
    await cell(page, 0, 0).click();
    await page.keyboard.type("lots");
    await page.keyboard.press("Enter");
    expect(await page.locator(".ed-hint").textContent()).toContain('"lots" is not a number');
    // Still in the cell, so the next keys correct it.
    await page.keyboard.press("Control+a");
    await page.keyboard.type("4.5");
    await page.keyboard.press("Enter");
    await expect.poll(() => tableOf(deck.folder)?.rows[0]).toEqual([4.5, null, null]);
    // A unit, from the Table chip of the toolbar, shows in the header.
    await page.locator(".ed-toolbar [data-tb='table']").click();
    await page.locator("[data-field='table:col0:unit']").fill("kg");
    await expect
      .poll(() => tableOf(deck.folder)?.columns[0])
      .toEqual({
        label: "Column 1",
        kind: "number",
        unit: "kg",
      });
    expect(await cell(page, -1, 0).textContent()).toBe("Column 1 (kg)");
    expect(problems).toEqual([]);
  });

  it("copies the whole table with Ctrl C from a cell, and pastes it as a table of its own", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await addTable(deck);
    await cell(page, 0, 0).click();
    await page.keyboard.type("Tea");
    await page.keyboard.press("Tab");
    await page.keyboard.type("4");
    await page.keyboard.press("Enter");
    await cell(page, 0, 0).focus();
    await page.keyboard.press("Control+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "Column 1\tColumn 2\tColumn 3\nTea\t4\t\n\t\t\n\t\t",
    );
    await page.keyboard.press("Control+v");
    await expect
      .poll(() => diskOf(deck.folder).scenes.method?.blocks.filter((block) => block.type === "table").length)
      .toBe(2);
    expect(problems).toEqual([]);
  });

  it("shows the table in the player, loading the table module for it and for no deck without one", async () => {
    const withTable = await openDeck();
    await editATable(withTable);
    const requests: string[] = [];
    const present = await context.newPage();
    present.on("request", (request) => requests.push(request.url()));
    await present.goto(`${withTable.server.url}present#/method`);
    await present.locator(".dc-scene table.dc-table").waitFor();
    expect(await present.locator(".dc-scene table.dc-table th[scope='col']").allTextContents()).toEqual([
      "Column 1",
      "Column 2",
      "Column 3",
      "Column 4",
    ]);
    expect(await present.locator(".dc-scene table.dc-table tbody tr").count()).toBe(7);
    await expect.poll(() => requests.some((url) => /\/table\.js(\?|$)/.test(url))).toBe(true);
    await present.close();

    const plain = await openDeck();
    const seen: string[] = [];
    const bare = await context.newPage();
    bare.on("request", (request) => seen.push(request.url()));
    await bare.goto(`${plain.server.url}present#/method`);
    await bare.locator(".dc-scene").first().waitFor();
    await bare.waitForLoadState("networkidle");
    expect(seen.some((url) => /\/table\.js(\?|$)/.test(url))).toBe(false);
    expect(problems).toEqual([]);
  });

  it("keeps the quick bar, with its Table button, in one row at 1024 wide in a wide fallback face", async () => {
    const { page } = await openDeck();
    await page.setViewportSize({ width: 1024, height: 768 });
    // A machine without Space Grotesk draws wider letters, as a Linux runner does. This makes every machine see that case.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("*{font-family:Verdana,'DejaVu Sans',sans-serif !important}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    const seen = await page.evaluate(() => {
      const box = (selector: string) =>
        (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
      return { bar: box(".ed-quick"), button: box("[data-quick='table']"), stage: box(".ed-stage") };
    });
    expect(seen.button.width).toBeGreaterThan(0);
    // One row, and 40 pixels of the stage to spare, so a face wider than this one still does not wrap the bar.
    expect(seen.bar.height).toBeLessThan(seen.button.height * 2);
    expect(seen.bar.width).toBeLessThanOrEqual(seen.stage.width - 40);
    expect(problems).toEqual([]);
  });

  it("exports a page that shows the table as a table", async () => {
    const deck = await openDeck();
    await editATable(deck);
    const out = join(root, "out");
    const lines: string[] = [];
    expect(
      run(["export", deck.folder, "--out", out], { out: (line) => lines.push(line), err: () => {} }),
    ).toBe(0);
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    await page.goto(`${pathToFileURL(join(out, "index.html")).href}#/method`);
    const table = page.locator("table.dc-table");
    await table.first().waitFor({ state: "attached" });
    expect(await table.locator("tbody tr").count()).toBe(7);
    expect(await table.locator("th[scope='col']").count()).toBe(4);
    expect(await table.locator("tbody tr").nth(3).locator("td").allTextContents()).toEqual(["", "", "", ""]);
    expect(await page.locator("table.dc-table caption").count()).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);
  });

  it("passes the render check for a table that fits, and fails it, with the reason, for one that does not", async () => {
    const fits = await openDeck(withTableScene());
    const ok = await render(fits.folder);
    expect(ok.code).toBe(0);
    expect(ok.lines.at(-1)).toBe("1 scene rendered, 0 errors, 0 warnings");

    // Thirty rows of twelve columns of long words cannot be drawn on one slide at a size anyone can read.
    const words = (n: number) => `Row ${n} has a rather long label`;
    const crowded = await openDeck(
      withTableScene({
        columns: Array.from({ length: 12 }, (_, n) => ({ label: `Column ${n + 1}` })),
        rows: Array.from({ length: 30 }, (_, r) => Array.from({ length: 12 }, () => words(r))),
      }),
    );
    const bad = await render(crowded.folder);
    expect(bad.code).toBe(1);
    expect(bad.lines[0]).toMatch(/^FAIL method/);
    expect(bad.lines.at(-1)).toMatch(/^1 scene rendered, [1-9]\d* errors?, \d+ warnings?$/);
  }, 120_000);
});

/** The folder's method scene with a heading and a table in the place of its text and picture. */
function withTableScene(over: Partial<Pick<Table, "columns" | "rows">> = {}) {
  return (folder: string) => {
    const file = join(folder, "scenes", "method.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: "0.3",
        id: "method",
        title: "How we compared them",
        layout: "text-media",
        lead: "human",
        blocks: [
          { id: "method-heading", type: "text", role: "heading", text: "Channel B leads in every region" },
          {
            id: "method-table",
            type: "table",
            title: "Orders by region",
            columns: over.columns ?? [
              { label: "Region" },
              { label: "Channel A", kind: "number", unit: "%" },
              { label: "Channel B", kind: "number", unit: "%" },
              { label: "Note" },
            ],
            rows: over.rows ?? [
              ["North", 38, 62, "Largest gap"],
              ["South", 44, 56, null],
              ["East", 47, 53, "Closing"],
              ["West", 41, 59, null],
              ["Central", 49, 51, "Near even"],
            ],
          },
        ],
        reading: { text: "Channel B has the larger share in every region." },
      }),
    );
  };
}

/** The render check of the method scene in a folder, as the command prints it. */
async function render(folder: string) {
  const lines: string[] = [];
  const code = await run(["render", folder, "method"], { out: (line) => lines.push(line), err: () => {} });
  return { code, lines };
}

/**
 * The screenshots Dimitri looks at, written only when DEPTHCUE_SHOTS names a folder: the table being edited with the menu of
 * a cell open, and the same table in the player, each at the two sizes a presenter meets.
 */
const SHOTS = process.env.DEPTHCUE_SHOTS;
describe.skipIf(!SHOTS)("screenshots of a table", () => {
  const SIZES = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ];
  const prepare = withTableScene();

  for (const size of SIZES) {
    it(`edits and presents at ${size.width}x${size.height}`, async () => {
      const dir = SHOTS as string;
      mkdirSync(dir, { recursive: true });
      const deck = await openDeck(prepare);
      const { page } = deck;
      await page.setViewportSize(size);
      await goTo(page, 3);
      await cell(page, 2, 1).waitFor();
      await cell(page, 2, 1).click({ button: "right" });
      await menu(page).waitFor();
      await page.screenshot({ path: join(dir, `table-editing-${size.width}x${size.height}.png`) });
      await page.keyboard.press("Escape");
      // The keyboard went back to the cell, which F2 opens for typing.
      await page.keyboard.press("F2");
      await page.keyboard.type("52");
      await page.screenshot({ path: join(dir, `table-typing-${size.width}x${size.height}.png`) });
      await page.keyboard.press("Escape");
      const present = await context.newPage();
      await present.setViewportSize(size);
      await present.goto(`${deck.server.url}present#/method`);
      await present.locator(".dc-scene table.dc-table").waitFor();
      await present.waitForLoadState("networkidle");
      await present.screenshot({ path: join(dir, `table-player-${size.width}x${size.height}.png`) });
      await present.close();
      expect(problems).toEqual([]);
    }, 60_000);
  }
});
