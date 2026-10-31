import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOps, loadDoc, type Op, revisionOf } from "@depthcue/core";
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
