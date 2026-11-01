import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { run } from "../src/index.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * The editor's brand checks are a chunk of their own, in a real Chrome: a deck without a brand opens without fetching
 * it, and a deck with one fetches it once and opens.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const CHUNK = "/_depthcue/editor/brandcheck.js";

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
let server: RunningServer | undefined;
let context: BrowserContext;
let page: Page;
let problems: string[];
let fetched: string[];

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
  root = mkdtempSync(join(tmpdir(), "depthcue-brand-e2e-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  fetched = [];
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

async function open() {
  server = await startServer({
    folder,
    playerDir: builtPlayerDir(),
    editorDir: builtEditorDir(),
    port: 0,
    layout: NO_LAYOUT,
  });
  await page.goto(server.url);
  await page.locator(".ed-frame [data-id='opening-title']").waitFor();
}

describe("the editor's brand checks in a real browser", () => {
  it("are not fetched for a deck without a brand", async () => {
    await open();
    expect(fetched).toContain("/_depthcue/editor/editor.js 200");
    expect(fetched.filter((line) => line.startsWith(CHUNK))).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("are fetched once for a deck with a brand, which then opens", async () => {
    const ops = join(root, "ops.json");
    writeFileSync(ops, JSON.stringify([{ op: "brand.set", set: { id: "acme", name: "Acme" } }]));
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    await run(["rev", folder], io);
    const code = await run(["apply", folder, ops, "--base-rev", lines.splice(0)[0] as string], io);
    expect(code, lines.join("\n")).toBe(0);
    await open();
    expect(fetched.filter((line) => line.startsWith(CHUNK))).toEqual([`${CHUNK} 200`]);
    expect(problems).toEqual([]);
  });

  it("wait for the chunk in one place: editor.js holds one copy of the module that loads it", () => {
    // Two copies, each with its own idea of whether the checks are in, opened a deck with a brand only some of the time.
    const script = readFileSync(join(builtEditorDir(), "editor.js"), "utf8");
    expect(script.split('import("./brandcheck.js")')).toHaveLength(2);
  });
});
