import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  type Block,
  loadDoc,
  type NewScene,
  type Op,
  readCueMap,
  revisionOf,
} from "@depthcue/core";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadDeckDir } from "../src/loader.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let folder: string;
let server: RunningServer;
let context: BrowserContext;
let page: Page;
let problems: string[];

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
  root = mkdtempSync(join(tmpdir(), "depthcue-e2e-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({ folder, playerDir: builtPlayerDir(), editorDir: builtEditorDir(), port: 0 });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
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

const url = () => server.url;
const read = (locator: Locator) => locator.evaluate((node) => node.textContent ?? "");
const disk = () => {
  const loaded = loadDoc(loadDeckDir(folder));
  if (!loaded.doc) throw new Error("the deck on disk should be valid");
  return loaded.doc;
};
const headlineOnDisk = () => {
  const block = disk().scenes.opening?.blocks.find((candidate) => candidate.id === "opening-title");
  return block && "text" in block ? block.text : undefined;
};
const status = () => page.locator(".ed-status");
/** Waits for the bar to say the deck is saved. A text match would also match "Unsaved changes". */
const saved = () => page.locator(".ed-status[data-state='saved']").waitFor();
const headline = () => page.locator(".ed-frame [data-id='opening-title']");

/** An edit made by something other than the editor, such as an agent through the CLI. */
function external(ops: Op[]) {
  const doc = disk();
  const result = applyOps(doc, ops, revisionOf(doc));
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  for (const id of result.changed)
    writeFileSync(join(folder, "scenes", `${id}.json`), text(result.doc.scenes[id]));
}

const retitle = (text: string): Op => ({
  op: "block.set",
  scene: "opening",
  id: "opening-title",
  set: { text },
});

async function open() {
  await page.goto(url());
  await headline().waitFor();
}

async function typeAtEnd(text: string) {
  await headline().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

describe("the editor in a real browser", () => {
  it("opens the deck, edits text in place, saves it to the folder by itself and keeps the console clean", async () => {
    await open();
    expect(await page.title()).toContain("Why channel B now leads");
    expect(await page.locator(".ed-scene").count()).toBe(3);
    expect(await read(status())).toBe("Saved");
    expect(await page.locator("[data-action='save']").count()).toBe(0);

    await typeAtEnd(" this quarter");
    await saved();
    expect(headlineOnDisk()).toBe("Channel B now leads demand this quarter");
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("undoes everything typed into a field in one step", async () => {
    await open();
    await typeAtEnd(" this quarter, and then some more words");
    await page.keyboard.press("Control+z");
    expect(await read(headline())).toBe("Channel B now leads demand");
    expect(await read(status())).toBe("Saved");
    await page.keyboard.press("Control+Shift+z");
    expect(await read(headline())).toBe("Channel B now leads demand this quarter, and then some more words");
    expect(problems).toEqual([]);
  });

  it("refuses text the schema would reject and shows why, without touching the deck", async () => {
    await open();
    await headline().click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    expect(await read(page.locator(".ed-hint"))).toContain("cannot be empty");
    expect(await read(status())).toBe("Saved");
    await page.locator(".ed-scene").nth(1).click();
    await page.locator(".ed-scene").nth(0).click();
    expect(await read(headline())).toBe("Channel B now leads demand");
    expect(headlineOnDisk()).toBe("Channel B now leads demand");
  });

  it("brings unsaved work back after the tab is reloaded", async () => {
    // With the server unreachable the edit cannot reach the folder, so the browser's draft is all there is.
    await page.route("**/_depthcue/api/save", (route) => route.abort());
    await open();
    await typeAtEnd(" (draft)");
    await page.locator(".ed-status[data-state='error']").waitFor();
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(["depthcue:draft:channel-demand"]);
    await page.unroute("**/_depthcue/api/save");
    await page.reload();
    await headline().waitFor();
    expect(await read(headline())).toBe("Channel B now leads demand (draft)");
    expect(await read(page.locator(".ed-notice"))).toContain("Unsaved changes from your last visit are back");
    expect(await read(status())).toBe("Unsaved changes");
    expect(headlineOnDisk()).toBe("Channel B now leads demand");

    await page.getByRole("button", { name: "Discard the draft" }).click();
    await saved();
    expect(await read(headline())).toBe("Channel B now leads demand");
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    // The refused request is the one this test caused on purpose; the browser logs it as a failed load.
    expect(problems.filter((line) => !line.includes("net::ERR_FAILED"))).toEqual([]);
  });

  it("draws each scene's real layout in its thumbnail, scaled to fit, and redraws it after an edit", async () => {
    await open();
    await page.waitForFunction(() => document.querySelectorAll(".ed-thumb-frame").length === 3);
    const fits = await page.evaluate(() =>
      [...document.querySelectorAll(".ed-thumb")].map((thumb) => {
        const frame = thumb.querySelector(".ed-thumb-frame")?.getBoundingClientRect();
        // Inside the thumbnail's border, which is what the strip measures to pick the scale.
        const { clientWidth, clientHeight } = thumb;
        return (
          frame && Math.abs(frame.width - clientWidth) < 1.5 && Math.abs(frame.height - clientHeight) < 1.5
        );
      }),
    );
    expect(fits).toEqual([true, true, true]);
    expect(await read(page.locator("[data-id='opening'] .ed-thumb"))).toContain("Channel B now leads demand");

    await typeAtEnd(" zzz");
    await page.waitForFunction(() =>
      document.querySelector("[data-id='opening'] .ed-thumb")?.textContent?.includes("zzz"),
    );
    expect(problems).toEqual([]);
  });

  it("duplicates and deletes a scene from the strip, and the folder follows", async () => {
    await open();
    await page.locator("[data-id='demand']").hover();
    await page.locator("[data-id='demand'] [data-action='duplicate-scene']").click();
    await page.locator("[data-id='demand-copy']").waitFor();
    await saved();
    expect(disk().deck.scenes).toEqual(["opening", "demand", "demand-copy", "method"]);
    expect(disk().scenes["demand-copy"]?.blocks).toEqual(disk().scenes.demand?.blocks);

    await page.locator("[data-id='demand-copy'] [data-action='delete-scene']").click();
    await page.locator("[data-id='demand-copy']").waitFor({ state: "detached" });
    await saved();
    expect(disk().deck.scenes).toEqual(["opening", "demand", "method"]);
    expect(problems).toEqual([]);
  });

  it("moves a scene with the keyboard, which stays on the button, and the folder follows", async () => {
    await open();
    const later = page.locator("[data-id='opening'] [data-action='move-scene-later']");
    await later.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector(".ed-scene-list > li")?.getAttribute("data-id") === "demand",
    );
    await saved();
    expect(disk().deck.scenes).toEqual(["demand", "opening", "method"]);
    // The rows are put back in a new order, which would drop the keyboard if it were not handed back.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-action"))).toBe(
      "move-scene-later",
    );
    expect(await page.evaluate(() => document.activeElement?.closest("li")?.getAttribute("data-id"))).toBe(
      "opening",
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector(".ed-scene-list > li:last-child")?.getAttribute("data-id") === "opening",
    );
    await saved();
    expect(disk().deck.scenes).toEqual(["demand", "method", "opening"]);
    expect(problems).toEqual([]);
  });

  it("adds a scene and renames it from the Scene popover, and the deck on disk is valid", async () => {
    await open();
    await page.locator("[data-action='add-scene']").click();
    await page.locator("[data-id='new-scene']").waitFor();
    await page.locator(".ed-scene-tools [data-tb='scene']").click();
    const title = page.locator("[data-field='panel:title']");
    await title.fill("Where we landed");
    await saved();
    expect(disk().scenes["new-scene"]?.title).toBe("Where we landed");
    expect(disk().deck.scenes).toContain("new-scene");
    expect(problems).toEqual([]);
  });

  it("changes who leads a scene and its layout from the top bar, and the folder follows", async () => {
    await open();
    const tools = page.locator(".ed-bar .ed-scene-tools");
    await tools.locator("[data-lead='agent']").click();
    await tools.locator("[data-layout='text-media']").click();
    expect(await tools.locator("[data-lead='agent']").getAttribute("aria-pressed")).toBe("true");
    expect(await tools.locator("[data-layout='text-media']").getAttribute("aria-pressed")).toBe("true");
    expect(await read(page.locator("[data-id='opening'] .ed-lead"))).toBe("Agent");
    await saved();
    expect(disk().scenes.opening).toMatchObject({ lead: "agent", layout: "text-media" });

    // One undo takes back one of the two choices.
    await page.keyboard.press("Control+z");
    await saved();
    expect(disk().scenes.opening).toMatchObject({ lead: "agent", layout: "title" });
    expect(problems).toEqual([]);
  });

  it("floats a toolbar against the chosen text, changes its role, and the folder follows", async () => {
    await open();
    await headline().click();
    const bar = page.locator(".ed-toolbar");
    await bar.waitFor();
    // It sits against the block without covering it: above, or below when the block is too near the top.
    await page.waitForFunction(() => document.querySelector(".ed-toolbar")?.getAttribute("data-side"));
    const [box, block] = await Promise.all([bar.boundingBox(), headline().boundingBox()]);
    if (!box || !block) throw new Error("the toolbar and the heading should both be on screen");
    expect(box.y + box.height <= block.y + 1 || box.y >= block.y + block.height - 1).toBe(true);
    expect(await read(bar.locator("[data-tb='count']"))).toBe("26 / 90");

    await bar.locator("[data-tb='role']").selectOption("caption");
    await saved();
    expect(disk().scenes.opening?.blocks[0]).toMatchObject({ id: "opening-title", role: "caption" });
    expect(await read(bar.locator("[data-tb='count']"))).toBe("26 / 160");
    expect(problems).toEqual([]);
  });

  it("keeps the toolbar inside the slide and off the chosen block, for every text on the demo deck", async () => {
    await open();
    const texts: Array<[string, string]> = [
      ["opening", "opening-title"],
      ["opening", "opening-sub"],
      ["demand", "claim-shift"],
      ["method", "method-heading"],
      ["method", "method-body"],
    ];
    for (const [sceneId, id] of texts) {
      await page.locator(`.ed-scene[data-scene='${sceneId}']`).click();
      await page.locator(`.ed-frame [data-id='${id}']`).first().click();
      await page.waitForFunction(() => document.querySelector(".ed-toolbar")?.getAttribute("data-side"));
      const [frame, bar, block, side] = await Promise.all([
        page.locator(".ed-frame").boundingBox(),
        page.locator(".ed-toolbar").boundingBox(),
        page.locator(`.ed-frame [data-id='${id}']`).first().boundingBox(),
        page.locator(".ed-toolbar").getAttribute("data-side"),
      ]);
      if (!frame || !bar || !block) throw new Error(`${id} should be on screen`);
      expect(bar.x, id).toBeGreaterThanOrEqual(frame.x - 1);
      expect(bar.x + bar.width, id).toBeLessThanOrEqual(frame.x + frame.width + 1);
      expect(bar.y, id).toBeGreaterThanOrEqual(frame.y - 1);
      if (side === "above") expect(bar.y + bar.height, id).toBeLessThanOrEqual(block.y + 1);
      if (side === "below") expect(bar.y, id).toBeGreaterThanOrEqual(block.y + block.height - 1);
    }
    expect(problems).toEqual([]);
  });

  it("edits a chart's title and rows in a popover that stays on the slide, and the folder follows", async () => {
    await open();
    await page.locator(".ed-scene[data-scene='demand']").click();
    await page.locator(".ed-frame [data-id='chart-demand']").click();
    const bar = page.locator(".ed-toolbar");
    await bar.locator("[data-tb='data']").click();
    const pop = bar.locator(".ed-tb-pop:not([hidden])");
    await pop.waitFor();
    await bar.locator("[data-field='chart:title']").fill("Orders by channel");
    await bar.locator("[data-field='chart:row0:value']").fill("45");
    await bar.locator("[data-field='chart:addrow']").click();
    await saved();
    const chart = disk().scenes.demand?.blocks.find((block) => block.id === "chart-demand");
    expect(chart).toMatchObject({ title: "Orders by channel" });
    expect(chart && "data" in chart ? chart.data : []).toEqual([
      { label: "Channel A", value: 45 },
      { label: "Channel B", value: 60 },
      { label: "Item 3", value: 0 },
    ]);
    // The new row has the keyboard, so its label can be typed straight away.
    await page.keyboard.type("Channel C");
    await saved();
    const typed = disk().scenes.demand?.blocks.find((block) => block.id === "chart-demand");
    expect(typed && "data" in typed ? typed.data[2]?.label : undefined).toBe("Item 3Channel C");
    expect(problems).toEqual([]);
  });

  it("keeps a chart's popover inside the slide on a phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await page.locator(".ed-scene[data-scene='demand']").click();
    await page.locator(".ed-frame [data-id='chart-demand']").click();
    const bar = page.locator(".ed-toolbar");
    await bar.locator("[data-tb='data']").click();
    const pop = bar.locator(".ed-tb-pop:not([hidden])");
    await pop.waitFor();
    // Placement settles a frame after the popover opens.
    await page.waitForFunction(() => document.querySelector(".ed-toolbar")?.getAttribute("data-side"));
    const [host, box] = await Promise.all([page.locator(".ed-canvas-host").boundingBox(), pop.boundingBox()]);
    if (!host || !box) throw new Error("the slide and the popover should both be on screen");
    expect(box.x, "left").toBeGreaterThanOrEqual(host.x - 1);
    expect(box.x + box.width, "right").toBeLessThanOrEqual(host.x + host.width + 1);
    expect(box.y, "top").toBeGreaterThanOrEqual(host.y - 1);
    expect(box.y + box.height, "bottom").toBeLessThanOrEqual(host.y + host.height + 1);
    expect(problems).toEqual([]);
  });

  it("changes an image's alt text and caption, and uploads a replacement, from its toolbar", async () => {
    await open();
    await page.locator(".ed-scene[data-scene='method']").click();
    await page.locator(".ed-frame [data-id='method-diagram']").click();
    const bar = page.locator(".ed-toolbar");
    await bar.locator("[data-tb='edit']").click();
    await bar.locator("[data-field='image:alt']").fill("How the method runs");
    await bar.locator("[data-field='image:caption']").fill("Figure 1");
    await saved();
    const image = () => disk().scenes.method?.blocks.find((block) => block.id === "method-diagram");
    expect(image()).toMatchObject({ alt: "How the method runs", caption: "Figure 1" });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await bar
      .locator("[data-field='image:upload']")
      .setInputFiles({ name: "new.png", mimeType: "image/png", buffer: png });
    // The server adds a hash to the name of an upload, so the new path is matched rather than spelled out.
    await page.waitForFunction(() =>
      /^assets\/new-[0-9a-f]+\.png$/.test(
        document.querySelector<HTMLSelectElement>(".ed-toolbar [data-field='image:asset']")?.value ?? "",
      ),
    );
    await saved();
    const uploaded = image();
    const asset = uploaded && "asset" in uploaded ? uploaded.asset : "";
    expect(asset).toMatch(/^assets\/new-[0-9a-f]+\.png$/);
    expect(existsSync(join(folder, asset))).toBe(true);
    expect(problems).toEqual([]);
  });

  describe("a picture dropped or pasted on an image", () => {
    const PIXEL =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const figure = () => page.locator(".ed-frame [data-id='method-diagram']");
    const flagged = () => page.locator(".ed-frame [data-id='method-diagram'][data-alt-missing]");
    const imageOnDisk = () => {
      const block = disk().scenes.method?.blocks.find((candidate) => candidate.id === "method-diagram");
      if (block?.type !== "image") throw new Error("the image should be on disk");
      return block;
    };
    /** What the browser does for a real drop or paste: one event carrying a file the page can read. */
    const send = (kind: "drop" | "paste", file: { name: string; type: string }) =>
      figure().evaluate(
        (node, { kind, file, pixel }) => {
          const data = new DataTransfer();
          data.items.add(new File([Uint8Array.from(atob(pixel), (c) => c.charCodeAt(0))], file.name, file));
          if (kind === "paste") {
            node.dispatchEvent(
              new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
            );
            return;
          }
          for (const type of ["dragenter", "dragover", "drop"]) {
            node.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
          }
        },
        { kind, file, pixel: PIXEL },
      );
    const openMethod = async () => {
      await open();
      await page.locator(".ed-scene[data-scene='method']").click();
      await figure().waitFor();
    };

    it("replaces the image, asks for its alt text, and Ctrl+Z puts the old picture and words back", async () => {
      await openMethod();
      const before = imageOnDisk();
      await send("drop", { name: "dropped.png", type: "image/png" });
      await flagged().waitFor();
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.field)).toBe(
        "image:alt",
      );
      // The file's name is selected, so typing replaces it.
      await page.keyboard.type("The four steps");
      await saved();
      expect(imageOnDisk().asset).toMatch(/^assets\/dropped-[0-9a-f]+\.png$/);
      expect(imageOnDisk().alt).toBe("The four steps");
      expect(existsSync(join(folder, imageOnDisk().asset))).toBe(true);
      await flagged().waitFor({ state: "detached" });

      await page.keyboard.press("Control+z");
      await page.keyboard.press("Control+z");
      await saved();
      expect(imageOnDisk()).toMatchObject({ asset: before.asset, alt: before.alt });
      expect(problems).toEqual([]);
    });

    it("takes a pasted picture on the image that has the keyboard", async () => {
      await openMethod();
      await figure().focus();
      await send("paste", { name: "image.png", type: "image/png" });
      await flagged().waitFor();
      await saved();
      expect(imageOnDisk().asset).toMatch(/^assets\/image-[0-9a-f]+\.png$/);
      expect(problems).toEqual([]);
    });

    it("says a text file is not a picture, and changes nothing", async () => {
      await openMethod();
      const before = imageOnDisk();
      await send("drop", { name: "notes.txt", type: "text/plain" });
      await page.locator(".ed-hint[data-problem]").filter({ hasText: "not a picture file" }).waitFor();
      expect(await flagged().count()).toBe(0);
      expect(imageOnDisk()).toMatchObject({ asset: before.asset, alt: before.alt });
      expect(problems).toEqual([]);
    });
  });

  it("adds a source from the scene popover, then cites it from a text's toolbar, and the folder follows", async () => {
    await open();
    await page.locator(".ed-scene[data-scene='method']").click();
    const tools = page.locator(".ed-scene-tools");
    await tools.locator("[data-tb='scene']").click();
    await tools.locator("details[data-section='sources'] > summary").click();
    await tools.locator("[data-field='panel:source:add']").click();
    await tools.locator("[data-field^='panel:source:'][data-field$=':title']").fill("Annual report");
    await tools
      .locator("[data-field^='panel:source:'][data-field$=':url']")
      .fill("https://example.org/report");
    await saved();
    const sources = () => disk().scenes.method?.sources ?? [];
    expect(sources()).toMatchObject([{ title: "Annual report", url: "https://example.org/report" }]);

    await page.locator(".ed-frame [data-id='method-body']").click();
    const bar = page.locator(".ed-toolbar");
    await bar.locator("[data-tb='cite']").click();
    await bar.locator("input[data-tb='source']").check();
    await saved();
    const body = disk().scenes.method?.blocks.find((block) => block.id === "method-body");
    expect(body && "sourceIds" in body ? body.sourceIds : []).toEqual([sources()[0]?.id]);
    expect(problems).toEqual([]);
  });

  it("keeps the scene popover inside the window on a phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    // Wide letters push the Scene chip toward the right end of the bar, where its popover has the least room.
    // A browser without the page's fonts draws wide letters anyway, so this makes every machine see that case.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("*{font-family:Verdana,'DejaVu Sans',sans-serif !important}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    const chip = page.locator(".ed-scene-tools [data-tb='scene']");
    await chip.click();
    await page.locator(".ed-scene-tools details[data-section='sources'] > summary").click();
    const pop = page.locator(".ed-scene-tools .ed-tb-pop:not([hidden])");
    await pop.waitFor();
    const box = await pop.boundingBox();
    if (!box) throw new Error("the popover should be on screen");
    expect(box.x, "left").toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width, "right").toBeLessThanOrEqual(390 + 1);
    expect(box.y + box.height, "bottom").toBeLessThanOrEqual(844 + 1);
    // On failure the message names what reaches past the right edge, so a different browser's metrics can be read.
    const overflow = await page.evaluate(() => {
      const edge = document.documentElement.clientWidth;
      const past = [...document.body.querySelectorAll("*")]
        .map((node) => ({ node, right: Math.round(node.getBoundingClientRect().right) }))
        .filter(({ right }) => right > edge)
        .slice(0, 10)
        .map(({ node, right }) => `${node.tagName.toLowerCase()}.${node.className || "-"} right=${right}`);
      return { scroll: document.documentElement.scrollWidth, edge, past };
    });
    expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.edge);
    expect(problems).toEqual([]);
  });

  it("keeps a tall scene popover on the window and scrolled where it was when an edit redraws it", async () => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await open();
    const tools = page.locator(".ed-scene-tools");
    await tools.locator("[data-tb='scene']").click();
    await tools.locator("details[data-section='steps'] > summary").click();
    await tools.locator("[data-field='panel:step:add']").click();
    await tools.locator("details[data-section='sources'] > summary").click();
    await tools.locator("[data-field='panel:source:add']").click();
    const pop = tools.locator(".ed-tb-pop:not([hidden])");
    await pop.waitFor();
    const box = await pop.boundingBox();
    if (!box) throw new Error("the popover should be on screen");
    expect(box.y + box.height, "bottom").toBeLessThanOrEqual(600 + 1);
    await pop.evaluate((node) => {
      node.scrollTop = 150;
    });
    const before = await pop.evaluate((node) => node.scrollTop);
    expect(before, "the popover has something to scroll").toBeGreaterThan(0);
    // The field is changed in the page, because clicking into it would scroll it into view first.
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>("[data-field='panel:title']");
      if (!field) throw new Error("the title field is missing");
      field.value = "A new title";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await saved();
    expect(await pop.evaluate((node) => node.scrollTop)).toBe(before);
    expect(problems).toEqual([]);
  });

  it("chooses which blocks a claim rests on from its toolbar, and the folder follows", async () => {
    await open();
    await page.locator(".ed-scene[data-scene='demand']").click();
    await page
      .locator(".ed-frame [data-id='claim-shift'] [data-edit], .ed-frame [data-edit][data-id='claim-shift']")
      .first()
      .click();
    const bar = page.locator(".ed-toolbar");
    await bar.locator("[data-tb='evidence']").click();
    await bar.locator("input[data-field='panel:evidence:chart-demand']").uncheck();
    await saved();
    expect(disk().scenes.demand?.summary?.evidenceIds).toEqual([]);
    await bar.locator("input[data-field='panel:evidence:chart-demand']").check();
    await saved();
    expect(disk().scenes.demand?.summary?.evidenceIds).toEqual(["chart-demand"]);
    expect(problems).toEqual([]);
  });

  it("adds a chart and a claim from the quick bar and writes notes, and the folder follows", async () => {
    await open();
    await page.locator(".ed-scene[data-scene='method']").click();
    const row = page.locator(".ed-quick");
    await row.locator("[data-quick='bar-chart']").click();
    await row.locator("[data-quick='claim']").click();
    await saved();
    const scene = () => disk().scenes.method;
    expect(scene()?.blocks.map((block) => block.type)).toEqual(["text", "text", "image", "bar-chart"]);
    expect(scene()?.summary?.text).toBe("State the claim here.");
    // The new chart is chosen, so its toolbar is up and the next thing typed is not lost.
    await page.locator(".ed-toolbar [data-tb='data']").waitFor();

    await row.locator("[data-tb='notes']").click();
    await row.locator("[data-field='panel:notes']").fill("Start with the sample.");
    await saved();
    expect(scene()?.notes).toBe("Start with the sample.");
    expect(problems).toEqual([]);
  });

  it("edits the deck's title and theme from the Deck popover, and the folder follows", async () => {
    await open();
    await page.locator(".ed-actions [data-tb='deck']").click();
    const pop = page.locator(".ed-actions .ed-tb-pop:not([hidden])");
    await pop.locator("[data-field='panel:deck:title']").fill("Spring review");
    await pop.locator("[data-field='panel:deck:theme']").selectOption("ink");
    await saved();
    expect(disk().deck).toMatchObject({ title: "Spring review", theme: "ink" });
    expect(await page.locator(".ed-deck").textContent()).toBe("Spring review");
    expect(problems).toEqual([]);
  });

  it("keeps the notes and deck popovers inside the window on a phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("*{font-family:Verdana,'DejaVu Sans',sans-serif !important}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    for (const chip of [".ed-quick [data-tb='notes']", ".ed-actions [data-tb='deck']"]) {
      await page.locator(chip).click();
      const pop = page.locator(".ed-tb-pop:not([hidden])");
      await pop.waitFor();
      const box = await pop.boundingBox();
      if (!box) throw new Error(`the popover of ${chip} should be on screen`);
      expect(box.x, `${chip} left`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${chip} right`).toBeLessThanOrEqual(390 + 1);
      expect(box.y, `${chip} top`).toBeGreaterThanOrEqual(-1);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, `${chip} sideways scroll`).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
    expect(problems).toEqual([]);
  });

  it("follows the slide when the window is resized", async () => {
    await open();
    await headline().click();
    await page.waitForFunction(() => document.querySelector(".ed-toolbar")?.getAttribute("data-side"));
    const before = await headline().boundingBox();
    await page.setViewportSize({ width: 700, height: 800 });
    // The heading moves as the slide scales, and the toolbar stays lined up with its left edge.
    await page.waitForFunction(() => {
      const bar = document.querySelector(".ed-toolbar")?.getBoundingClientRect();
      const block = document.querySelector(".ed-frame [data-id='opening-title']")?.getBoundingClientRect();
      return bar && block && Math.abs(bar.x - block.x) <= 2;
    });
    expect((await headline().boundingBox())?.x).not.toBe(before?.x);
    expect(problems).toEqual([]);
  });

  it("is reached from the keyboard, and Escape steps back out and then lets go of the block", async () => {
    await open();
    await headline().click();
    await page.keyboard.press("Alt+F10");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-tb"))).toBe("role");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-id]")?.getAttribute("data-id")),
    ).toBe("opening-title");

    // Tab moves on to the next block, and the toolbar follows it.
    await page.keyboard.press("Tab");
    await page.waitForFunction(
      () => (document.querySelector("[data-tb='role']") as HTMLSelectElement | null)?.value === "body",
    );
    await page.keyboard.press("Escape");
    await page.locator(".ed-toolbar").waitFor({ state: "hidden" });
    expect(problems).toEqual([]);
  });

  it("removes a block with Delete, and Ctrl+Z brings it back", async () => {
    await open();
    await page.locator(".ed-scene[data-scene='method']").click();
    const diagram = page.locator(".ed-frame [data-id='method-diagram']");
    await diagram.focus();
    await page.keyboard.press("Delete");
    await diagram.waitFor({ state: "detached" });
    await saved();
    expect(disk().scenes.method?.blocks.map((block) => block.id)).toEqual(["method-heading", "method-body"]);

    await page.keyboard.press("Control+z");
    await diagram.waitFor();
    await saved();
    expect(disk().scenes.method?.blocks).toHaveLength(3);
    expect(problems).toEqual([]);
  });

  describe("a chart on the slide", () => {
    const bar = (row: number) => page.locator(`.ed-frame [data-id='chart-demand'] .dc-bar >> nth=${row}`);
    const chartOnDisk = () => {
      const block = disk().scenes.demand?.blocks.find((candidate) => candidate.id === "chart-demand");
      if (block?.type !== "bar-chart") throw new Error("the chart should be on disk");
      return block.data;
    };
    const openDemand = async () => {
      await open();
      await page.locator(".ed-scene[data-scene='demand']").click();
      await bar(0).waitFor();
    };
    const pixelsPerUnit = async () => {
      const wide = await bar(1).boundingBox();
      if (!wide) throw new Error("the largest bar should be drawn");
      return wide.width / 60;
    };

    it("drags a bar with the mouse, even once the pointer leaves it, and Ctrl+Z puts it back", async () => {
      await openDemand();
      const perUnit = await pixelsPerUnit();
      const box = await bar(0).boundingBox();
      if (!box) throw new Error("the bar should be drawn");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // Up and away from the bar, as a hand does, while going along.
      await page.mouse.move(x + perUnit * 5, y + 120, { steps: 6 });
      await page.mouse.move(x + perUnit * 10, y + 240, { steps: 6 });
      await page.mouse.up();
      await saved();
      expect(chartOnDisk()[0]?.value).toBeGreaterThanOrEqual(49);
      expect(chartOnDisk()[0]?.value).toBeLessThanOrEqual(51);
      expect(chartOnDisk()[1]?.value).toBe(60);
      expect(await read(page.locator(".ed-frame [data-id='chart-demand'] .dc-value >> nth=0"))).toMatch(
        /^5[01]%$/,
      );

      await page.keyboard.press("Control+z");
      await page.waitForFunction(
        () => document.querySelector(".ed-frame .dc-bar")?.getAttribute("aria-valuenow") === "40",
      );
      await saved();
      expect(chartOnDisk()[0]?.value).toBe(40);
      expect(problems).toEqual([]);
    });

    it("moves a bar with the arrow keys, five at a time with Shift, and the keyboard stays on it", async () => {
      await openDemand();
      await bar(0).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+ArrowRight");
      await saved();
      expect(chartOnDisk()[0]?.value).toBe(47);
      expect(
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return [
            active?.dataset.slider !== undefined,
            active?.dataset.row,
            active?.getAttribute("aria-valuetext"),
          ];
        }),
      ).toEqual([true, "0", "47%"]);

      // The whole visit is one undo step, and the keyboard is still on the bar afterwards.
      await page.keyboard.press("Control+z");
      await saved();
      expect(chartOnDisk()[0]?.value).toBe(40);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.row)).toBe(
        "0",
      );
      expect(problems).toEqual([]);
    });

    it("renames a bar where it is drawn, adds a bar and sorts from the toolbar, and the folder follows", async () => {
      await openDemand();
      const label = page.locator(".ed-frame [data-id='chart-demand'] th[scope='row'] >> nth=0");
      await label.click();
      await page.keyboard.press("Control+a");
      await page.keyboard.type("Direct");
      await page.keyboard.press("Enter");
      await saved();
      expect(chartOnDisk()[0]).toEqual({ label: "Direct", value: 40 });

      await page.locator(".ed-toolbar [data-tb='add-bar']").click();
      await saved();
      expect(chartOnDisk().map((row) => row.label)).toEqual(["Direct", "Channel B", "Item 3"]);

      await page.locator(".ed-toolbar [data-tb='sort-bars']").click();
      await saved();
      expect(chartOnDisk().map((row) => row.value)).toEqual([60, 40, 0]);
      expect(problems).toEqual([]);
    });
  });

  it("takes in a change made on disk while nothing is unsaved", async () => {
    await open();
    external([retitle("Rewritten by an agent")]);
    await headline().filter({ hasText: "Rewritten by an agent" }).waitFor();
    expect(await read(status())).toContain("Saved");
    expect(await page.locator(".ed-notice").count()).toBe(0);
  });

  it("does not overwrite an agent's change with a stale edit, and lets the visitor reload or keep a copy", async () => {
    // Saves are held back so the agent's change lands while the edit is still unsaved. Whichever of the two
    // reaches the folder first, the server refuses a stale save, so the outcome is the same conflict.
    await page.route("**/_depthcue/api/save", (route) => route.abort());
    await open();
    await typeAtEnd(" (mine)");
    external([retitle("Written by an agent")]);
    await page.locator(".ed-notice[data-kind='conflict']").waitFor();
    expect(headlineOnDisk()).toBe("Written by an agent");

    await page.getByRole("button", { name: "Reload" }).click();
    await headline().filter({ hasText: "Written by an agent" }).waitFor();
    expect(await page.locator(".ed-notice").count()).toBe(0);
    expect(await read(status())).toContain("Saved");

    await typeAtEnd(" (again)");
    external([retitle("Agent again")]);
    await page.locator(".ed-notice[data-kind='conflict']").waitFor();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Keep mine as copy" }).click();
    const copy = await download;
    expect(copy.suggestedFilename()).toBe("channel-demand-my-edits.json");
    const body = readFileSync((await copy.path()) as string, "utf8");
    expect(body).toContain("Written by an agent (again)");
    await page.locator(".ed-notice").waitFor({ state: "detached" });
    await headline().filter({ hasText: "Agent again" }).waitFor();
    expect(headlineOnDisk()).toBe("Agent again");
    expect(problems).toEqual([]);
  });

  it("recognises its own save and raises no conflict from the file change it causes", async () => {
    await open();
    for (const word of [" one", " two", " three"]) {
      await typeAtEnd(word);
      await page.keyboard.press("Control+s");
      await saved();
    }
    await page.waitForTimeout(300);
    expect(await page.locator(".ed-notice").count()).toBe(0);
    expect(await read(status())).toBe("Saved");
    expect(headlineOnDisk()).toBe("Channel B now leads demand one two three");
  });

  it("shows the saved deck in the player at /present", async () => {
    await open();
    await typeAtEnd(" now");
    await page.keyboard.press("Control+s");
    await saved();
    const present = await context.newPage();
    await present.goto(`${url()}present#/opening`);
    await present.locator(".dc-scene h1, .dc-scene h2").first().waitFor();
    expect(await read(present.locator(".dc-scene").first())).toContain("Channel B now leads demand now");
    await present.close();
  });

  it("fits a phone screen without sideways scrolling", async () => {
    await page.setViewportSize({ width: 390, height: 780 });
    await open();
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    expect(scroll).toBeLessThanOrEqual(width as number);
    expect(await status().isVisible()).toBe(true);
    expect(await headline().isVisible()).toBe(true);
    // The lead and layout buttons wrap onto their own row instead of running off the side.
    const tools = (await page.locator(".ed-scene-tools").boundingBox()) ?? { x: -1, width: 0 };
    expect(tools.x).toBeGreaterThanOrEqual(0);
    expect(tools.x + tools.width).toBeLessThanOrEqual(width as number);
  });

  it("serves a page that a script on another origin cannot read the token from", async () => {
    await open();
    const token = await page.locator("meta[name='depthcue-token']").getAttribute("content");
    expect(token).toBe(server.token);
    const verdicts = await page.evaluate(async () => {
      const call = (headers: Record<string, string>) =>
        fetch("/_depthcue/api/deck", { headers }).then((response) => response.status);
      return { without: await call({}) };
    });
    expect(verdicts.without).toBe(403);
    expect(readFileSync(join(folder, "deck.json"), "utf8")).toContain('"channel-demand"');
  });
});

describe("clip cues in a real browser", () => {
  const cueFile = () => join(folder, "assets", "talk.cues.json");
  const clipNode = () => page.locator(".ed-frame [data-id='opening-clip']");
  const pop = () => page.locator(".ed-toolbar .ed-tb-pop:not([hidden])");
  const mapOnDisk = () => readCueMap(JSON.parse(readFileSync(cueFile(), "utf8")));
  /** Puts the playhead of the clip on the slide at `seconds`. */
  const playheadAt = (seconds: number) =>
    page.evaluate((to) => {
      const video = document.querySelector<HTMLVideoElement>(".ed-frame [data-id='opening-clip'] video");
      if (video) video.currentTime = to;
    }, seconds);
  const playhead = () =>
    page.evaluate(
      () => document.querySelector<HTMLVideoElement>(".ed-frame [data-id='opening-clip'] video")?.currentTime,
    );
  /**
   * Waits for the clip on the slide to be at `seconds`, which a loaded video reaches once its seek lands. A miss says
   * what the video was doing and whether it is still the one the page held, so a slow machine can be told from a
   * slide that was drawn again.
   */
  async function playheadIs(seconds: number) {
    try {
      await page.waitForFunction(
        (to) =>
          Math.abs(
            (document.querySelector<HTMLVideoElement>(".ed-frame [data-id='opening-clip'] video")
              ?.currentTime ?? Number.NaN) - to,
          ) < 0.05,
        seconds,
        { timeout: 10000 },
      );
    } catch (error) {
      const state = await page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>(".ed-frame [data-id='opening-clip'] video");
        const held = (window as unknown as { held: Element | null }).held;
        return {
          time: video?.currentTime,
          ready: video?.readyState,
          seeking: video?.seeking,
          network: video?.networkState,
          failed: video?.error?.code,
          sameVideo: video === held,
        };
      });
      throw new Error(`The clip should be at ${seconds}s: ${JSON.stringify(state)}`, { cause: error });
    }
  }

  /** What the page set the playhead of a video to since it loaded, whatever the browser then made of it. */
  const seeks = () => page.evaluate(() => (window as unknown as { seeks: number[] }).seeks);

  beforeEach(async () => {
    await page.addInitScript(() => {
      const seen: number[] = [];
      (window as unknown as { seeks: number[] }).seeks = seen;
      const own = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
      if (!own?.get || !own.set) return;
      const { get, set } = own;
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        configurable: true,
        get,
        set(this: HTMLMediaElement, value: number) {
          seen.push(value);
          set.call(this, value);
        },
      });
    });
    copyFileSync(
      fileURLToPath(new URL("./fixtures/tiny.webm", import.meta.url)),
      join(folder, "assets", "talk.webm"),
    );
    external([
      {
        op: "block.add",
        scene: "opening",
        block: { id: "opening-clip", type: "clip", source: "assets/talk.webm", alt: "The talk" },
      },
    ]);
  });

  async function openCues() {
    await open();
    // A press on the corner chooses the clip without pressing the player's own controls.
    await clipNode().click({ position: { x: 4, y: 4 } });
    await page.locator(".ed-toolbar [data-tb='cues']").click();
    await pop().waitFor();
  }

  it("starts a cue map from a marker added at the playhead, and the video stays where it was", async () => {
    await openCues();
    await page.evaluate(() => {
      (window as unknown as { held: Element | null }).held = document.querySelector(
        ".ed-frame [data-id='opening-clip'] video",
      );
    });
    await playheadAt(1);
    await pop().locator("[data-tb='cue-add']").click();
    await pop().locator(".ed-cue-row[data-cue='marker-1']").waitFor();

    const map = mapOnDisk();
    expect(map).toMatchObject({ source: "assets/talk.webm", width: 64, height: 36, fps: 30 });
    expect(map?.duration).toBeGreaterThan(1.9);
    expect(map?.cues).toEqual([{ id: "marker-1", type: "marker", in: 1, out: map?.duration }]);

    // The server tells the page that assets/ changed, a moment after the file was written, and the page reads the
    // deck again. That read used to count the new cue file as a new asset and draw the slide again.
    await page.waitForTimeout(500);
    const same = await page.evaluate(
      () =>
        (window as unknown as { held: Element | null }).held ===
        document.querySelector(".ed-frame [data-id='opening-clip'] video"),
    );
    expect(same).toBe(true);
    expect(await playhead()).toBe(1);
    await clipNode().locator(".dc-clip-cues [data-cue='marker-1']").waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-field"))).toBe(
      "cue:name:marker-1",
    );
    expect(problems).toEqual([]);
  });

  it("keeps the markers across a reload, jumps to them from the slide, and edits and removes them", async () => {
    await openCues();
    await playheadAt(1);
    await pop().locator("[data-tb='cue-add']").click();
    await pop().locator(".ed-cue-row[data-cue='marker-1']").waitFor();
    await playheadAt(0.5);
    await pop().locator("[data-tb='cue-add']").click();
    await pop().locator(".ed-cue-row[data-cue='marker-2']").waitFor();

    await page.reload();
    await headline().waitFor();
    const chips = clipNode().locator(".dc-clip-cues [data-cue]");
    await chips.nth(1).waitFor();
    expect(await chips.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-cue")))).toEqual([
      "marker-2",
      "marker-1",
    ]);
    await clipNode().locator("[data-cue='marker-1']").click();
    await clipNode().locator("[data-cue='marker-2']").click();
    expect(await seeks()).toEqual([1, 0.5]);

    await page.locator(".ed-toolbar [data-tb='cues']").click();
    await pop().locator("[data-field='cue:name:marker-1']").fill("the reveal");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".ed-frame [data-cue='the reveal']"));
    expect(mapOnDisk()?.cues.map((cue) => cue.id)).toEqual(["marker-2", "the reveal"]);

    await pop().locator(".ed-cue-row[data-cue='marker-2'] [data-tb='cue-remove']").click();
    await page.waitForFunction(() => !document.querySelector(".ed-frame [data-cue='marker-2']"));
    expect(mapOnDisk()?.cues.map((cue) => cue.id)).toEqual(["the reveal"]);
    expect(problems).toEqual([]);
  });

  it("takes a loaded video to a cue from its chip, forward and back", async () => {
    writeFileSync(
      cueFile(),
      JSON.stringify({
        format: "depthcue-cues/1",
        source: "assets/talk.webm",
        duration: 2,
        width: 64,
        height: 36,
        fps: 30,
        cues: [
          { id: "early", type: "marker", in: 0.5, out: 2 },
          { id: "late", type: "marker", in: 1.5, out: 2 },
        ],
      }),
    );
    await open();
    await clipNode().locator(".dc-clip-cues [data-cue='late']").waitFor();
    // The slide does not fetch the video until it is played, so this reads it first. A browser can seek a video it
    // has read only when the server answers byte ranges, which is what this checks.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const video = document.querySelector<HTMLVideoElement>(".ed-frame [data-id='opening-clip'] video");
          (window as unknown as { held: Element | null }).held = video;
          if (!video || video.readyState >= 1) return done();
          video.addEventListener("loadedmetadata", () => done(), { once: true });
          video.load();
        }),
    );
    await clipNode().locator("[data-cue='late']").click();
    await playheadIs(1.5);
    await clipNode().locator("[data-cue='early']").click();
    await playheadIs(0.5);
    expect(problems).toEqual([]);
  });

  it("leaves the build record of a built clip alone when a marker is added", async () => {
    const built = {
      format: "depthcue-cues/1",
      source: "assets/talk.webm",
      duration: 2,
      width: 64,
      height: 36,
      fps: 24,
      cues: [{ id: "dot", type: "circle", in: 0, out: 1 }],
      build: { key: "abc", kinescript: "kinescript 1.0.0", quality: "draft", scale: 1, scene: "talk.json" },
    };
    writeFileSync(cueFile(), JSON.stringify(built));
    await openCues();
    await playheadAt(1.5);
    await pop().locator("[data-tb='cue-add']").click();
    await pop().locator(".ed-cue-row[data-cue='marker-1']").waitFor();
    const after = JSON.parse(readFileSync(cueFile(), "utf8"));
    expect(after.build).toEqual(built.build);
    expect(after.fps).toBe(24);
    expect(after.cues.map((cue: { id: string }) => cue.id)).toEqual(["dot", "marker-1"]);
  });

  it("keeps the Cues popover inside the slide on a phone", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCues();
    await playheadAt(1);
    await pop().locator("[data-tb='cue-add']").click();
    await pop().locator(".ed-cue-row[data-cue='marker-1']").waitFor();
    await page.waitForFunction(() => document.querySelector(".ed-toolbar")?.getAttribute("data-side"));
    const [host, box] = await Promise.all([
      page.locator(".ed-canvas-host").boundingBox(),
      pop().boundingBox(),
    ]);
    if (!host || !box) throw new Error("the slide and the popover should both be on screen");
    expect(box.x, "left").toBeGreaterThanOrEqual(host.x - 1);
    expect(box.x + box.width, "right").toBeLessThanOrEqual(host.x + host.width + 1);
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    expect(scroll).toBeLessThanOrEqual(width as number);
    expect(problems).toEqual([]);
  });
});

describe("moving blocks between slots in a real browser", () => {
  const grip = (id: string) => page.locator(`.ed-grip[data-grip='${id}']`);
  const block = (id: string) => page.locator(`.ed-frame [data-id='${id}']`);
  const sceneOnDisk = (id: string) => disk().scenes[id];
  const orderOnDisk = (id: string) => sceneOnDisk(id)?.blocks.map((entry) => entry.id);
  const hint = () => page.locator(".ed-hint");

  async function openScene(id: string, anchor: string) {
    await page.goto(url());
    await page.locator(`.ed-scene[data-scene='${id}']`).click();
    await block(anchor).waitFor();
  }

  /** Takes hold of a grip, as a hand does: the pointer goes to it first, which is what shows it. */
  async function lift(id: string) {
    await block(id).hover();
    await grip(id).hover();
    await page.mouse.down();
  }

  async function carryTo(id: string, where: { x: number; y: number }) {
    const box = await block(id).boundingBox();
    if (!box) throw new Error(`block ${id} should be drawn`);
    await page.mouse.move(box.x + where.x, box.y + where.y, { steps: 8 });
    // A hand never stops dead, and a browser reports a drag over a new element only with the next movement.
    await page.mouse.move(box.x + where.x + 2, box.y + where.y + 1);
  }

  it("puts a block before another of its slot by dragging the grip, and one Undo puts it back", async () => {
    await openScene("opening", "opening-sub");
    await lift("opening-sub");
    await carryTo("opening-title", { x: 20, y: 4 });
    expect(await block("opening-title").getAttribute("data-place")).toBe("before");
    await page.mouse.up();
    await saved();
    expect(orderOnDisk("opening")).toEqual(["opening-sub", "opening-title"]);
    expect(await page.locator("[data-place], [data-dragging]").count()).toBe(0);

    await page.keyboard.press("Control+z");
    await saved();
    expect(orderOnDisk("opening")).toEqual(["opening-title", "opening-sub"]);
    expect(problems).toEqual([]);
  });

  it("swaps a block of the evidence with one of the support, and the claim cites the one that took its place", async () => {
    external([
      {
        op: "block.add",
        scene: "demand",
        block: { id: "demand-note", type: "text", role: "body", text: "A note." },
      },
    ]);
    await openScene("demand", "demand-note");
    await lift("demand-note");
    await carryTo("chart-demand", { x: 30, y: 30 });
    expect(await block("chart-demand").getAttribute("data-place")).toBe("swap");
    await page.mouse.up();
    await saved();
    expect(orderOnDisk("demand")).toEqual(["demand-note", "chart-demand"]);
    expect(sceneOnDisk("demand")?.summary?.evidenceIds).toEqual(["demand-note"]);
    expect(
      await page.evaluate(
        () => document.querySelector(".ed-frame .dc-evidence-region [data-id='demand-note']") !== null,
      ),
    ).toBe(true);
    expect(problems).toEqual([]);
  });

  it("says why text cannot go among the media, and changes nothing when it is dropped there", async () => {
    await openScene("method", "method-diagram");
    await lift("method-body");
    await carryTo("method-diagram", { x: 30, y: 30 });
    await page.waitForFunction(() => document.querySelector(".ed-hint[data-problem]") !== null);
    expect(await read(hint())).toContain("Text goes in the text area");
    expect(await block("method-diagram").getAttribute("data-place")).toBe("refused");
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("[data-place]") === null);
    expect(orderOnDisk("method")).toEqual(["method-heading", "method-body", "method-diagram"]);
    expect(await read(status())).toBe("Saved");
    expect(problems).toEqual([]);
  });

  it("keeps the text of a field a person can type in when a block is dropped on it", async () => {
    await openScene("opening", "opening-sub");
    const before = await read(block("opening-title"));
    await lift("opening-sub");
    await carryTo("opening-title", { x: 20, y: 4 });
    await page.mouse.up();
    await saved();
    expect(await read(block("opening-title"))).toBe(before);
    expect(problems).toEqual([]);
  });
});

const sceneOnDisk = (id: string) => disk().scenes[id];
const idsOnDisk = (id: string) => sceneOnDisk(id)?.blocks.map((entry) => entry.id);
const note = (id: string, text: string): Block => ({ id, type: "text", role: "body", text });

/** A scene added by something other than the editor: its file, and its place in the deck. */
function addScene(scene: NewScene) {
  const doc = disk();
  const result = applyOps(doc, [{ op: "scene.add", scene }], revisionOf(doc));
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(folder, "deck.json"), text(result.doc.deck));
  for (const id of result.changed)
    writeFileSync(join(folder, "scenes", `${id}.json`), text(result.doc.scenes[id]));
}

async function openScene(id: string, anchor: string) {
  await page.goto(url());
  await page.locator(`.ed-scene[data-scene='${id}']`).click();
  await page.locator(`.ed-frame [data-id='${anchor}']`).waitFor();
}

describe("empty areas of the slide in a real browser", () => {
  const block = (id: string) => page.locator(`.ed-frame [data-id='${id}']`);
  const ghost = (slot: string) => page.locator(`.ed-frame .ed-ghost[data-ghost='${slot}']`);
  const grip = (id: string) => page.locator(`.ed-grip[data-grip='${id}']`);

  it("adds text to Evidence from its place, cited by the claim, and one Undo takes it back", async () => {
    addScene({
      id: "lab",
      title: "Lab",
      layout: "claim-evidence",
      summary: { id: "lab-claim", text: "A claim", evidenceIds: [] },
      blocks: [note("lab-note", "A note.")],
    });
    await openScene("lab", "lab-note");
    await ghost("evidence").locator(".ed-ghost-open").click();
    await ghost("evidence").locator("[data-ghost-kind='text']").click();
    await saved();
    expect(idsOnDisk("lab")).toEqual(["lab-note", "lab-text"]);
    expect(sceneOnDisk("lab")?.summary?.evidenceIds).toEqual(["lab-text"]);
    expect(await ghost("evidence").count()).toBe(0);
    expect(
      await page.evaluate(
        () => document.querySelector(".ed-frame .dc-evidence-region [data-id='lab-text']") !== null,
      ),
    ).toBe(true);
    // The new block has the keyboard, ready to be typed over.
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-id]")?.getAttribute("data-id")),
    ).toBe("lab-text");

    await page.keyboard.press("Control+z");
    await saved();
    expect(idsOnDisk("lab")).toEqual(["lab-note"]);
    expect(sceneOnDisk("lab")?.summary?.evidenceIds).toEqual([]);
    expect(await ghost("evidence").count()).toBe(1);
    expect(problems).toEqual([]);
  });

  it("draws the media area a text-only slide leaves out, and a chart added there fills it", async () => {
    addScene({ id: "talk", title: "Talk", layout: "text-media", blocks: [note("talk-body", "Words.")] });
    await openScene("talk", "talk-body");
    expect(await page.locator(".ed-frame .dc-media-region").count()).toBe(1);
    const [text, place] = await Promise.all([block("talk-body").boundingBox(), ghost("media").boundingBox()]);
    if (!text || !place) throw new Error("the text and the empty media area should both be drawn");
    expect(place.x).toBeGreaterThan(text.x + text.width - 1);
    await ghost("media").locator(".ed-ghost-open").click();
    await ghost("media").locator("[data-ghost-kind='bar-chart']").click();
    await saved();
    expect(idsOnDisk("talk")).toEqual(["talk-body", "talk-chart"]);
    expect(await page.locator(".ed-frame .dc-media-region [data-id='talk-chart']").count()).toBe(1);
    expect(await page.locator(".ed-frame [data-ghost]").count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("takes a block dragged onto the empty Evidence place, and the claim cites it", async () => {
    addScene({
      id: "pick",
      title: "Pick",
      layout: "claim-evidence",
      summary: { id: "pick-claim", text: "A claim", evidenceIds: [] },
      blocks: [note("pick-one", "One."), note("pick-two", "Two.")],
    });
    await openScene("pick", "pick-two");
    await block("pick-two").hover();
    await grip("pick-two").hover();
    await page.mouse.down();
    const place = await ghost("evidence").boundingBox();
    if (!place) throw new Error("the empty Evidence area should be drawn");
    await page.mouse.move(place.x + place.width / 2, place.y + place.height / 2, { steps: 8 });
    await page.mouse.move(place.x + place.width / 2 + 2, place.y + place.height / 2 + 1);
    expect(await page.locator(".ed-frame .dc-evidence-region").getAttribute("data-place")).toBe("into");
    await page.mouse.up();
    await saved();
    expect(sceneOnDisk("pick")?.summary?.evidenceIds).toEqual(["pick-two"]);
    expect(await ghost("evidence").count()).toBe(0);
    expect(await page.locator(".ed-frame [data-place], .ed-frame [data-dragging]").count()).toBe(0);
    expect(problems).toEqual([]);
  });
});

describe("build order in a real browser", () => {
  const badge = (id: string) => page.locator(`.ed-badge[data-badge='${id}']`);
  const toggle = () => page.locator("[data-quick='build']");
  const stepsOnDisk = (id: string) =>
    (disk().scenes[id]?.steps ?? []).map((step) => [step.id, ...step.reveal]);
  const note = (id: string, text: string): Block => ({ id, type: "text", role: "body", text });

  /** A scene added by something other than the editor: its file, and its place in the deck. */
  function addScene(scene: NewScene) {
    const doc = disk();
    const result = applyOps(doc, [{ op: "scene.add", scene }], revisionOf(doc));
    if (!result.ok) throw new Error(result.diagnostics[0]?.message);
    const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(folder, "deck.json"), text(result.doc.deck));
    for (const id of result.changed)
      writeFileSync(join(folder, "scenes", `${id}.json`), text(result.doc.scenes[id]));
  }

  async function openScene(id: string, anchor: string) {
    await page.goto(url());
    await page.locator(`.ed-scene[data-scene='${id}']`).click();
    await page.locator(`.ed-frame [data-id='${anchor}']`).waitFor();
  }

  const numbers = () =>
    page.locator(".ed-badge").evaluateAll((nodes) => nodes.map((node) => node.textContent));

  it("shows the steps beside the parts of the demo scene and moves one with a choice, and Undo puts it back", async () => {
    await openScene("demand", "claim-shift");
    expect(await page.locator(".ed-badge").count()).toBe(0);
    expect(await toggle().getAttribute("aria-pressed")).toBe("false");

    await toggle().click();
    expect(await toggle().getAttribute("aria-pressed")).toBe("true");
    expect(await numbers()).toEqual(["1", "2"]);

    // Each badge sits inside the slide, level with its part.
    const host = await page.locator(".ed-canvas-host").boundingBox();
    for (const id of ["claim-shift", "chart-demand"]) {
      const [part, mark] = await Promise.all([
        page.locator(`.ed-frame [data-id='${id}']`).boundingBox(),
        badge(id).boundingBox(),
      ]);
      if (!host || !part || !mark) throw new Error(`${id} and its badge should both be drawn`);
      expect(mark.x).toBeGreaterThanOrEqual(host.x);
      expect(mark.x + mark.width).toBeLessThanOrEqual(host.x + host.width + 1);
      expect(Math.abs(mark.y - part.y)).toBeLessThan(4);
    }

    await badge("chart-demand").click();
    expect(await page.locator(".ed-build-menu [role='menuitemradio']").allTextContents()).toEqual([
      "From the start",
      "Step 1",
      "Step 2",
      "A new step",
    ]);
    await page.locator(".ed-build-menu").getByText("Step 1", { exact: true }).click();
    await saved();
    expect(stepsOnDisk("demand")).toEqual([["show-claim", "claim-shift", "chart-demand"]]);
    expect(await numbers()).toEqual(["1", "1"]);

    await page.keyboard.press("Control+z");
    await saved();
    expect(stepsOnDisk("demand")).toEqual([
      ["show-claim", "claim-shift"],
      ["show-evidence", "chart-demand"],
    ]);
    expect(await numbers()).toEqual(["1", "2"]);
    expect(problems).toEqual([]);
  });

  it("gives a part a step of its own, takes another back to the start, and lets Escape close the list", async () => {
    addScene({
      id: "order",
      title: "Order",
      layout: "claim-evidence",
      summary: { id: "order-claim", text: "A claim", evidenceIds: ["order-a"] },
      blocks: [note("order-a", "A."), note("order-b", "B."), note("order-c", "C.")],
      steps: [
        { id: "order-s1", reveal: ["order-claim"] },
        { id: "order-s2", reveal: ["order-a", "order-b"] },
      ],
    });
    await openScene("order", "order-c");
    await toggle().click();
    expect(await numbers()).toEqual(["1", "2", "2", "•"]);

    await badge("order-a").click();
    await page.keyboard.press("Escape");
    expect(await page.locator(".ed-build-menu").count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-badge"))).toBe("order-a");

    await badge("order-a").click();
    await page.locator(".ed-build-menu").getByText("A new step", { exact: true }).click();
    await saved();
    expect(stepsOnDisk("order")).toEqual([
      ["order-s1", "order-claim"],
      ["order-s2", "order-b"],
      ["order-step-3", "order-a"],
    ]);
    expect(await numbers()).toEqual(["1", "3", "2", "•"]);

    await badge("order-claim").click();
    await page.locator(".ed-build-menu").getByText("From the start", { exact: true }).click();
    await saved();
    expect(stepsOnDisk("order")).toEqual([
      ["order-s2", "order-b"],
      ["order-step-3", "order-a"],
    ]);
    expect(await numbers()).toEqual(["•", "2", "1", "•"]);
    expect(problems).toEqual([]);
  });

  it("stays on for the next scene and writes nothing to the deck by being looked at", async () => {
    await openScene("demand", "claim-shift");
    const before = readFileSync(join(folder, "scenes", "demand.json"), "utf8");
    await toggle().click();
    await page.locator(".ed-scene").first().click();
    await page.locator(".ed-frame [data-id='opening-title']").waitFor();
    expect(await page.locator(".ed-badge").count()).toBeGreaterThan(0);
    await toggle().click();
    expect(await page.locator(".ed-badge").count()).toBe(0);
    expect(readFileSync(join(folder, "scenes", "demand.json"), "utf8")).toBe(before);
    expect(problems).toEqual([]);
  });
});

describe("pinning in a real browser", () => {
  const block = (id: string) => page.locator(`.ed-frame [data-id='${id}']`);
  const free = () => page.locator(".ed-toolbar [data-tb='free']");
  const layout = () => page.locator(".ed-toolbar [data-tb='layout']");
  const blockOnDisk = (scene: string, id: string) =>
    disk().scenes[scene]?.blocks.find((entry) => entry.id === id);
  const frameOnDisk = (scene: string, id: string) => blockOnDisk(scene, id)?.frame;
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-id") ?? null);

  async function openScene(id: string, anchor: string) {
    await page.goto(url());
    await page.locator(`.ed-scene[data-scene='${id}']`).click();
    await block(anchor).waitFor();
  }

  const boxOf = async (id: string) => {
    const box = await block(id).boundingBox();
    if (!box) throw new Error(`block ${id} should be drawn`);
    return box;
  };

  /** Pixels, on a slide about a thousand wide: a tenth of a percent, plus text that sets a little differently. */
  const SAME = 10;
  const expectSameBox = async (
    id: string,
    before: { x: number; y: number; width: number; height: number },
  ) => {
    const after = await boxOf(id);
    for (const key of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(after[key] - before[key]),
        `${id} ${key}: ${before[key]} then ${after[key]}`,
      ).toBeLessThan(SAME);
  };

  it("pins a picture where it stands, so it does not jump, and the folder follows", async () => {
    await openScene("method", "method-diagram");
    const before = await boxOf("method-diagram");
    await block("method-diagram").click();
    await free().click();
    await saved();
    const frame = frameOnDisk("method", "method-diagram");
    expect(frame).toBeDefined();
    await page.locator(".ed-frame .dc-pinned").first().waitFor();
    await expectSameBox("method-diagram", before);
    expect(await page.locator(".ed-toolbar [data-tb='free']").getAttribute("aria-pressed")).toBe("true");
    expect(problems).toEqual([]);
  });

  it("pins a text from its toolbar without moving it, and Layout puts it back", async () => {
    await openScene("method", "method-body");
    const before = await boxOf("method-body");
    await block("method-body").click();
    await free().click();
    await saved();
    expect(frameOnDisk("method", "method-body")).toBeDefined();
    await expectSameBox("method-body", before);

    await block("method-body").click();
    await layout().click();
    await saved();
    expect(frameOnDisk("method", "method-body")).toBeUndefined();
    await expectSameBox("method-body", before);
    expect(problems).toEqual([]);
  });

  it("moves no other block when one is pinned, or when it is dragged far away, or when it goes back", async () => {
    await openScene("method", "method-diagram");
    const before = new Map<string, Awaited<ReturnType<typeof boxOf>>>();
    for (const id of ["method-heading", "method-body"]) before.set(id, await boxOf(id));
    const unmoved = async () => {
      for (const [id, box] of before) await expectSameBox(id, box);
    };

    await block("method-diagram").click();
    await free().click();
    await saved();
    await unmoved();

    const slide = await page.locator(".ed-frame .dc-pins").boundingBox();
    const picture = await boxOf("method-diagram");
    if (!slide) throw new Error("the slide should be drawn");
    await page.mouse.move(picture.x + picture.width / 2, picture.y + picture.height / 2);
    await page.mouse.down();
    await page.mouse.move(slide.x + slide.width * 0.2, slide.y + slide.height * 0.2, { steps: 8 });
    await page.mouse.up();
    await saved();
    await unmoved();

    await block("method-diagram").click();
    await layout().click();
    await saved();
    await unmoved();
    expect(problems).toEqual([]);
  });

  it("pins and unpins with P, and the keyboard stays on the block", async () => {
    await openScene("method", "method-diagram");
    await block("method-diagram").click();
    await page.keyboard.press("p");
    await saved();
    expect(frameOnDisk("method", "method-diagram")).toBeDefined();
    expect(await focused()).toBe("method-diagram");
    await page.keyboard.press("p");
    await saved();
    expect(frameOnDisk("method", "method-diagram")).toBeUndefined();
    expect(await focused()).toBe("method-diagram");
    expect(problems).toEqual([]);
  });

  it("nudges a pinned block with the arrow keys, and one Undo takes back the whole run", async () => {
    await openScene("method", "method-diagram");
    await block("method-diagram").click();
    await page.keyboard.press("p");
    await saved();
    const start = frameOnDisk("method", "method-diagram");
    if (!start) throw new Error("the picture should be pinned");
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight"]) await page.keyboard.press(key);
    await page.keyboard.press("Shift+ArrowDown");
    await saved();
    const moved = frameOnDisk("method", "method-diagram");
    expect(moved?.x).toBeCloseTo(Math.min(start.x + 3, 100 - start.w), 5);
    expect(moved?.y).toBeCloseTo(Math.min(start.y + 5, 100 - start.h), 5);
    expect(await focused()).toBe("method-diagram");

    await page.keyboard.press("Control+z");
    await saved();
    expect(frameOnDisk("method", "method-diagram")).toEqual(start);
    expect(problems).toEqual([]);
  });

  it("sets a pinned block's size from the Pinned popover, and the folder follows", async () => {
    await openScene("method", "method-diagram");
    await block("method-diagram").click();
    await free().click();
    await saved();
    await page.locator(".ed-toolbar [data-tb='frame']").click();
    const width = page.locator(".ed-toolbar [data-field='frame:w']");
    await width.fill("33");
    await saved();
    expect(frameOnDisk("method", "method-diagram")?.w).toBe(33);
    await page.locator(".ed-toolbar [data-tb='align-center']").click();
    await saved();
    const centered = frameOnDisk("method", "method-diagram");
    expect(centered?.w).toBe(33);
    expect(centered?.x).toBeCloseTo((100 - 33) / 2, 5);
    expect(problems).toEqual([]);
  });

  it("types in a pinned text after Enter, and gives the keyboard back to the block when Enter finishes", async () => {
    await openScene("method", "method-body");
    await block("method-body").click();
    await free().click();
    await saved();
    expect(await block("method-body").getAttribute("contenteditable")).toBeNull();

    await block("method-body").focus();
    await page.keyboard.press("Enter");
    expect(await block("method-body").getAttribute("contenteditable")).not.toBeNull();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Pinned too.");
    await page.keyboard.press("Enter");
    await saved();
    const body = blockOnDisk("method", "method-body");
    expect(body && "text" in body ? body.text : "").toMatch(/ Pinned too\.$/);
    expect(await focused()).toBe("method-body");
    expect(await block("method-body").getAttribute("contenteditable")).toBeNull();
    expect(await block("method-body").getAttribute("tabindex")).toBe("0");
    expect(frameOnDisk("method", "method-body")).toBeDefined();
    expect(problems).toEqual([]);
  });

  /** The slide pinned blocks sit on, in pixels. */
  const slideBox = async () => {
    const box = await page.locator(".ed-frame .dc-pins").boundingBox();
    if (!box) throw new Error("the slide should be drawn");
    return box;
  };

  async function pinPicture() {
    await openScene("method", "method-diagram");
    await block("method-diagram").click();
    await page.keyboard.press("p");
    await saved();
    const start = frameOnDisk("method", "method-diagram");
    if (!start) throw new Error("the picture should be pinned");
    return start;
  }

  /** Presses in the middle of a block and moves the pointer by `dx` and `dy` pixels, then lets go unless told not to. */
  async function dragBy(id: string, dx: number, dy: number, release = true) {
    const box = await boxOf(id);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 });
    if (release) await page.mouse.up();
  }

  /** Percent of a slide, as a distance a frame may be off by when a snap line was in reach. */
  const REACH = 1.3;

  it("moves a pinned picture by dragging it, as one undo step, and keeps it chosen", async () => {
    const start = await pinPicture();
    const slide = await slideBox();
    await dragBy("method-diagram", slide.width * 0.05, 0);
    await saved();
    const moved = frameOnDisk("method", "method-diagram");
    expect(moved?.x).toBeGreaterThan(start.x);
    expect(Math.abs((moved?.x ?? 0) - Math.min(start.x + 5, 100 - start.w))).toBeLessThan(REACH);
    expect(moved?.y).toBeCloseTo(start.y, 0);
    expect(await block("method-diagram").getAttribute("data-selected")).not.toBeNull();

    await page.keyboard.press("Control+z");
    await saved();
    expect(frameOnDisk("method", "method-diagram")).toEqual(start);
    expect(problems).toEqual([]);
  });

  it("draws a guide while an edge is on a line, and pulls the block onto the safe margin", async () => {
    await pinPicture();
    const slide = await slideBox();
    await dragBy("method-diagram", slide.width * 0.1, 0);
    await saved();
    const box = await boxOf("method-diagram");
    const reach = slide.x + slide.width * 0.045 - box.x;
    await dragBy("method-diagram", reach, 0, false);
    expect(await page.locator(".ed-guide[data-axis='x']").count()).toBeGreaterThan(0);
    await page.mouse.up();
    await saved();
    expect(frameOnDisk("method", "method-diagram")?.x).toBe(4);
    expect(await page.locator(".ed-guide").count()).toBe(0);
    expect(problems).toEqual([]);
  });

  it("moves freely while Alt is held, and Escape puts the block back", async () => {
    const start = await pinPicture();
    const slide = await slideBox();
    const box = await boxOf("method-diagram");
    const reach = slide.x + slide.width * 0.045 - box.x;
    await page.keyboard.down("Alt");
    await dragBy("method-diagram", reach, 0, false);
    expect(await page.locator(".ed-guide").count()).toBe(0);
    await page.keyboard.up("Alt");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expectSameBox("method-diagram", box);
    expect(frameOnDisk("method", "method-diagram")).toEqual(start);
    expect(await block("method-diagram").getAttribute("data-selected")).not.toBeNull();
    expect(problems).toEqual([]);
  });

  it("stays chosen when the pointer is let go far from the block", async () => {
    await pinPicture();
    const slide = await slideBox();
    await dragBy("method-diagram", slide.width * 0.9, slide.height * 0.9);
    await saved();
    const moved = frameOnDisk("method", "method-diagram");
    expect(moved && moved.x + moved.w).toBeCloseTo(100, 0);
    expect(await block("method-diagram").getAttribute("data-selected")).not.toBeNull();
    expect(await page.locator(".ed-toolbar").isVisible()).toBe(true);
    expect(problems).toEqual([]);
  });

  it("resizes from a corner handle and keeps the opposite corner", async () => {
    const start = await pinPicture();
    const slide = await slideBox();
    const handle = page.locator(".ed-handle[data-handle='se']");
    const spot = await handle.boundingBox();
    if (!spot) throw new Error("the handle should be drawn");
    const x = spot.x + spot.width / 2;
    const y = spot.y + spot.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - slide.width * 0.05, y - slide.height * 0.03, { steps: 12 });
    await page.mouse.up();
    await saved();
    const resized = frameOnDisk("method", "method-diagram");
    expect(resized?.x).toBeCloseTo(start.x, 0);
    expect(resized?.y).toBeCloseTo(start.y, 0);
    expect(Math.abs((resized?.w ?? 0) - (start.w - 5))).toBeLessThan(REACH);
    expect(Math.abs((resized?.h ?? 0) - (start.h - 3))).toBeLessThan(REACH);

    await page.keyboard.press("Control+z");
    await saved();
    expect(frameOnDisk("method", "method-diagram")).toEqual(start);
    expect(problems).toEqual([]);
  });

  it("moves a pinned text by pressing and dragging it, without putting a caret in it", async () => {
    await openScene("method", "method-body");
    await block("method-body").click();
    await free().click();
    await saved();
    const start = frameOnDisk("method", "method-body");
    if (!start) throw new Error("the text should be pinned");
    const slide = await slideBox();
    await dragBy("method-body", slide.width * 0.05, slide.height * 0.05);
    await saved();
    const moved = frameOnDisk("method", "method-body");
    expect(moved?.y).toBeGreaterThan(start.y);
    expect(await block("method-body").getAttribute("contenteditable")).toBeNull();
    const body = blockOnDisk("method", "method-body");
    expect(body && "text" in body ? body.text : "").not.toBe("");
    expect(problems).toEqual([]);
  });

  describe("after a change of layout, and Auto layout", () => {
    const PINNED = ["method-body", "method-diagram"];
    const autoLayout = () => page.locator(".ed-scene-tools [data-auto]");
    /** Waits until nothing on the page is still sliding into place. */
    const settled = () => page.waitForFunction(() => document.getAnimations().length === 0);

    /** Pins the text and the picture of the method slide, then drags each well away from its slot. */
    async function pinAndMove() {
      for (const id of PINNED) {
        await block(id).click();
        await free().click();
        await saved();
      }
      const slide = await slideBox();
      await dragBy("method-body", slide.width * 0.02, slide.height * 0.3);
      await saved();
      await dragBy("method-diagram", -slide.width * 0.25, slide.height * 0.15);
      await saved();
    }

    const boxesOf = async (ids: string[]) => {
      const found = new Map<string, Awaited<ReturnType<typeof boxOf>>>();
      for (const id of ids) found.set(id, await boxOf(id));
      return found;
    };

    it("keeps pinned blocks where they are, and in the file, when the layout changes", async () => {
      await openScene("method", "method-diagram");
      await pinAndMove();
      const frames = PINNED.map((id) => frameOnDisk("method", id));
      const moved = await boxesOf(PINNED);

      await page.locator(".ed-scene-tools [data-layout='title']").click();
      await saved();
      expect(await page.locator(".ed-scene-tools [data-layout='title']").getAttribute("aria-pressed")).toBe(
        "true",
      );
      for (const [id, box] of moved) await expectSameBox(id, box);
      expect(PINNED.map((id) => frameOnDisk("method", id))).toEqual(frames);
      expect(problems).toEqual([]);
    });

    it("puts every pinned block back in its slot, and one Undo pins them all again", async () => {
      await openScene("method", "method-diagram");
      const slots = await boxesOf(["method-heading", ...PINNED]);
      await autoLayout().waitFor({ state: "hidden" });
      await pinAndMove();
      const moved = await boxesOf(PINNED);
      await autoLayout().waitFor();

      await autoLayout().click();
      await autoLayout().waitFor({ state: "hidden" });
      await settled();
      await saved();
      for (const id of PINNED) expect(frameOnDisk("method", id)).toBeUndefined();
      expect(await page.locator(".ed-frame .dc-pinned").count()).toBe(0);
      for (const [id, box] of slots) await expectSameBox(id, box);

      await page.keyboard.press("Control+z");
      await autoLayout().waitFor();
      await saved();
      for (const id of PINNED) expect(frameOnDisk("method", id)).toBeDefined();
      for (const [id, box] of moved) await expectSameBox(id, box);
      expect(problems).toEqual([]);
    });

    /** Presses Auto layout and answers which blocks have started to slide by the time the slide is drawn. */
    async function slidingOnAutoLayout(reducedMotion: boolean) {
      if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
      await openScene("method", "method-diagram");
      await pinAndMove();
      return page.evaluate(async () => {
        document.querySelector<HTMLElement>(".ed-scene-tools [data-auto]")?.click();
        // The slide starts a microtask after it is drawn, which is this one.
        await Promise.resolve();
        // Only the slide counts. A transition from the stylesheet, cut to nothing by a reduced-motion rule, is not it.
        return document.getAnimations().flatMap((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          const scripted = !(animation instanceof CSSTransition || animation instanceof CSSAnimation);
          return scripted && target instanceof HTMLElement && target.matches(".dc-block[data-id]")
            ? [target.dataset.id as string]
            : [];
        });
      });
    }

    it("slides the blocks from where they stood to their slots instead of jumping", async () => {
      expect((await slidingOnAutoLayout(false)).sort()).toEqual(PINNED);
      await settled();
      expect(problems).toEqual([]);
    });

    it("puts the toolbar where the chosen block is going, and leaves it there as the block arrives", async () => {
      await openScene("method", "method-diagram");
      await pinAndMove();
      const toolbar = page.locator(".ed-toolbar");
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".ed-scene-tools [data-auto]")?.click();
      });
      // Two frames on, the block is still on its way and the toolbar has been placed against it.
      const frames = (count: number) =>
        page.evaluate(
          (n) =>
            new Promise<void>((resolve) => {
              const step = (left: number) =>
                left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
              step(n);
            }),
          count,
        );
      await frames(2);
      await settled();
      const placed = await toolbar.boundingBox();
      // A change in the size of the window places the toolbar again, with nothing sliding.
      await page.setViewportSize({ width: 1276, height: 800 });
      await frames(3);
      const fresh = await toolbar.boundingBox();
      if (!placed || !fresh) throw new Error("the toolbar should be drawn");
      expect(Math.abs(placed.x - fresh.x)).toBeLessThan(8);
      expect(Math.abs(placed.y - fresh.y)).toBeLessThan(8);
      expect(problems).toEqual([]);
    });

    it("jumps for a visitor who asks for less motion", async () => {
      expect(await slidingOnAutoLayout(true)).toEqual([]);
      expect(await page.locator(".ed-frame .dc-pinned").count()).toBe(0);
      expect(problems).toEqual([]);
    });
  });
});

describe("the quick bar in a real browser", () => {
  const bar = () => page.locator(".ed-quick");
  const block = (id: string) => page.locator(`.ed-frame [data-id='${id}']`);
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error("the element should be drawn");
    return box;
  };

  /** What a person sees of the bar at a window size: where it is, how many rows, and whether the page scrolls. */
  async function layout(width: number, height: number) {
    await page.setViewportSize({ width, height });
    await page.goto(url());
    await bar().waitFor();
    return page.evaluate(() => {
      const rect = (selector: string) => {
        const box = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const main = document.querySelector(".ed-main") as HTMLElement;
      return {
        bar: rect(".ed-quick"),
        slide: rect(".ed-frame"),
        stage: rect(".ed-stage"),
        scrolls: main.scrollHeight > main.clientHeight + 1,
        wide: document.documentElement.scrollWidth > window.innerWidth,
        window: { width: window.innerWidth, height: window.innerHeight },
      };
    });
  }

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
  ] as const) {
    it(`floats at the foot of the stage, in one row under the slide, at ${width} by ${height}`, async () => {
      const seen = await layout(width, height);
      // Under the slide, so nothing of the slide is covered, and in the middle of the stage.
      expect(seen.bar.top).toBeGreaterThanOrEqual(seen.slide.bottom);
      expect(seen.bar.bottom).toBeLessThanOrEqual(seen.stage.bottom);
      expect(seen.bar.bottom - seen.bar.top).toBeLessThan(60);
      const stageMiddle = (seen.stage.left + seen.stage.right) / 2;
      expect(Math.abs((seen.bar.left + seen.bar.right) / 2 - stageMiddle)).toBeLessThan(2);
      expect(seen.scrolls).toBe(false);
      expect(seen.wide).toBe(false);
      expect(problems).toEqual([]);
    });
  }

  it("stays at the foot of the window while a short window scrolls the slide under it", async () => {
    const seen = await layout(1024, 360);
    expect(seen.scrolls).toBe(true);
    expect(seen.bar.bottom).toBeLessThanOrEqual(seen.window.height);
    expect(seen.bar.top).toBeGreaterThan(seen.window.height / 2);
    await page.locator(".ed-main").evaluate((node) => node.scrollTo(0, node.scrollHeight));
    const after = await boxOf(bar());
    expect(Math.abs(after.y + after.height - seen.bar.bottom)).toBeLessThan(1);
    expect(problems).toEqual([]);
  });

  it("sits in the flow under the slide on a phone, inside the window", async () => {
    const seen = await layout(390, 844);
    expect(seen.bar.left).toBeGreaterThanOrEqual(0);
    expect(seen.bar.right).toBeLessThanOrEqual(seen.window.width);
    expect(seen.bar.top).toBeGreaterThanOrEqual(seen.slide.bottom);
    expect(seen.wide).toBe(false);
    expect(problems).toEqual([]);
  });

  it("opens the notes upward, inside the window and a little way from its edge", async () => {
    await layout(1024, 768);
    await page.locator("[data-tb='notes']").click();
    const pop = page.locator(".ed-quick .ed-tb-pop");
    await pop.waitFor();
    const [popBox, barBox] = await Promise.all([boxOf(pop), boxOf(bar())]);
    expect(popBox.y + popBox.height).toBeLessThanOrEqual(barBox.y);
    expect(popBox.x).toBeGreaterThanOrEqual(8 - 1);
    expect(popBox.x + popBox.width).toBeLessThanOrEqual(1024 - 8 + 1);
    expect(problems).toEqual([]);
  });

  it("adds into the area of the chosen block, after it, and one Undo takes it back", async () => {
    addScene({
      id: "qb",
      title: "Quick",
      layout: "claim-evidence",
      summary: { id: "qb-claim", text: "A claim", evidenceIds: ["qb-proof"] },
      blocks: [note("qb-proof", "Proof."), note("qb-side", "Side.")],
    });
    await openScene("qb", "qb-proof");
    await block("qb-proof").click();
    await bar().locator("[data-quick='text']").click();
    await saved();
    expect(idsOnDisk("qb")).toEqual(["qb-proof", "qb-text", "qb-side"]);
    expect(sceneOnDisk("qb")?.summary?.evidenceIds).toEqual(["qb-proof", "qb-text"]);
    // The new block has the keyboard, ready to be typed over.
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-id]")?.getAttribute("data-id")),
    ).toBe("qb-text");
    await page.keyboard.press("Control+z");
    await saved();
    expect(idsOnDisk("qb")).toEqual(["qb-proof", "qb-side"]);
    expect(sceneOnDisk("qb")?.summary?.evidenceIds).toEqual(["qb-proof"]);
    expect(problems).toEqual([]);
  });

  it("adds to the first empty area when nothing is chosen, and a chart fills the media area", async () => {
    addScene({ id: "qm", title: "Media", layout: "text-media", blocks: [note("qm-words", "Words.")] });
    await openScene("qm", "qm-words");
    await bar().locator("[data-quick='bar-chart']").click();
    await saved();
    expect(idsOnDisk("qm")).toEqual(["qm-words", "qm-chart"]);
    expect(await page.locator(".ed-frame .dc-media-region [data-id='qm-chart']").count()).toBe(1);
    expect(problems).toEqual([]);
  });
});

describe("keyboard shortcuts in a real browser", () => {
  const bar = () => page.locator(".ed-quick");
  const sheet = () => page.locator(".ed-sheet");
  const focused = () =>
    page.evaluate(() => {
      const node = document.activeElement as HTMLElement | null;
      return node?.getAttribute("role") ?? node?.getAttribute("data-quick") ?? node?.tagName ?? null;
    });

  it("adds a text with T and a chart with C from the page, and one Undo takes each back", async () => {
    addScene({ id: "ks", title: "Keys", layout: "text-media", blocks: [note("ks-words", "Words.")] });
    await openScene("ks", "ks-words");
    await page.keyboard.press("c");
    await saved();
    expect(idsOnDisk("ks")).toEqual(["ks-words", "ks-chart"]);
    // The new chart has the keyboard now, and T still adds.
    await page.keyboard.press("t");
    await saved();
    expect(idsOnDisk("ks")).toEqual(["ks-words", "ks-text", "ks-chart"]);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await saved();
    expect(idsOnDisk("ks")).toEqual(["ks-words"]);
    expect(problems).toEqual([]);
  });

  it("types a t into a text being edited, and adds nothing", async () => {
    addScene({ id: "kt", title: "Typing", layout: "text-media", blocks: [note("kt-words", "Words.")] });
    await openScene("kt", "kt-words");
    await page.locator("[data-id='kt-words'] [data-edit], [data-id='kt-words'][data-edit]").click();
    await page.keyboard.press("End");
    await page.keyboard.type("tci?");
    await saved();
    expect(idsOnDisk("kt")).toEqual(["kt-words"]);
    const written = sceneOnDisk("kt")?.blocks[0];
    expect(written?.type === "text" ? written.text : undefined).toBe("Words.tci?");
    expect(await sheet().isHidden()).toBe(true);
    expect(problems).toEqual([]);
  });

  it("clicks the Image button's file input on I, on the key press's own user activation", async () => {
    addScene({ id: "ki", title: "Image", layout: "text-media", blocks: [note("ki-words", "Words.")] });
    await openScene("ki", "ki-words");
    const input = page.locator("[data-field='quick:image']");
    // A test cannot answer the browser's chooser, and the browser shows one only for a click made on a user
    // activation. So the click is stopped here and the activation it came with is what gets read.
    await input.evaluate((node) => {
      node.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          node.setAttribute("data-clicked", String(navigator.userActivation.isActive));
        },
        { once: true },
      );
    });
    await page.keyboard.press("i");
    await page.waitForSelector("[data-field='quick:image'][data-clicked]");
    expect(await input.getAttribute("data-clicked")).toBe("true");
    expect(problems).toEqual([]);
  });

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [1024, 360],
    [390, 844],
  ] as const) {
    it(`opens the list of keys with ? inside the window at ${width} by ${height}, and Escape gives the keyboard back`, async () => {
      await page.setViewportSize({ width, height });
      await page.goto(url());
      await bar().waitFor();
      await bar().locator("[data-quick='text']").focus();
      await page.keyboard.press("?");
      await sheet().waitFor();
      expect(await focused()).toBe("dialog");
      const box = await page.locator(".ed-sheet-card").boundingBox();
      if (!box) throw new Error("the sheet should be drawn");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      // Behind the sheet a letter adds nothing.
      await page.keyboard.press("t");
      await page.keyboard.press("Escape");
      await sheet().waitFor({ state: "hidden" });
      expect(await focused()).toBe("text");
      expect(problems).toEqual([]);
    });
  }

  it("opens from the ? button in the bar, which has a name for a screen reader", async () => {
    await page.goto(url());
    const button = bar().locator("[data-quick='keys']");
    expect(await button.getAttribute("aria-label")).toBe("Keyboard shortcuts");
    await button.click();
    await sheet().waitFor();
    await page.locator("[data-action='close-shortcuts']").click();
    await sheet().waitFor({ state: "hidden" });
    expect(problems).toEqual([]);
  });
});
