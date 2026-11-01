import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LayoutChecker } from "../src/edit-layout.ts";
import { run } from "../src/index.ts";
import { launchBrowser } from "../src/render.ts";
import { builtEditorDir, builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

/*
 * Text styles in a real Chrome: bold from the keyboard, a bulleted list, a link, a color for words, and a size and an
 * alignment for the block, each ending in the scene file on disk. Then the same file written by an agent through
 * `depthcue apply`, and the text in the player and in an exported page.
 */

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

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
  root = mkdtempSync(join(tmpdir(), "depthcue-text-e2e-"));
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
type Json = Record<string, unknown>;
const blockOf = (folder: string, id: string): Json | undefined =>
  (JSON.parse(sceneFile(folder)).blocks as Json[]).find((block) => block.id === id);
const textOf = (folder: string, id = "method-body") => blockOf(folder, id)?.text;

/** Opens a scene of the strip by its number, from 1. */
async function goTo(page: Page, number: number) {
  await page
    .locator(".ed-scene")
    .nth(number - 1)
    .click();
}

const BODY = ".ed-frame [data-id='method-body']";
const START = "Orders rose in every region.";

/** The method scene as a scene that reads markup, with a heading and one line of body text. */
function textScene(folder: string, body: Json = {}) {
  writeFileSync(
    join(folder, "scenes", "method.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.3",
        id: "method",
        title: "How we compared them",
        layout: "text-media",
        lead: "human",
        blocks: [
          { id: "method-heading", type: "text", role: "heading", text: "Channel B leads in every region" },
          { id: "method-body", type: "text", role: "body", text: START, ...body },
        ],
        reading: { text: START },
      },
      null,
      2,
    )}\n`,
  );
}
const prepared = (folder: string) => textScene(folder);

/** Puts the deck's own colors where a test can choose them: a palette is a 0.3 part of deck.json. */
function withPalette(palette: Record<string, string>) {
  return (folder: string) => {
    const file = join(folder, "deck.json");
    const deck = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, `${JSON.stringify({ ...deck, schemaVersion: "0.3", palette }, null, 2)}\n`);
    textScene(folder);
  };
}

/** Gives the keyboard to a text and selects the first `word` in it, which is what a double click on the word does. */
async function selectWord(page: Page, selector: string, word: string) {
  await page.locator(selector).focus();
  await page.evaluate(
    ([where, what]) => {
      const root = document.querySelector(where as string) as HTMLElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? "").indexOf(what as string);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + (what as string).length);
        const selection = getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      throw new Error(`"${what}" is not in ${where}`);
    },
    [selector, word],
  );
}

const bar = (page: Page, key: string) => page.locator(`.ed-fmt [data-fmt='${key}']`);
const hint = (page: Page) => page.locator(".ed-hint");

/** The markup the editing session below ends with, and the block it leaves. */
const FINAL_TEXT =
  "Orders **rose** in [every]{evidence} [region](https://example.com/orders).\n- first\n- second";

/**
 * Bolds a word with Ctrl+B, links another with Ctrl+K after an address that is refused, colors a third from the format
 * bar, types two bulleted items on lines of their own, and sets the block's size and alignment from its Style chip.
 */
async function formatABody(deck: Deck) {
  const { page } = deck;
  await goTo(page, 3);
  await page.locator(BODY).waitFor();

  await selectWord(page, BODY, "rose");
  await page.keyboard.press("Control+b");
  await expect.poll(() => textOf(deck.folder)).toBe("Orders **rose** in every region.");

  await selectWord(page, BODY, "region");
  // The box that asks for an address is not there until a link is asked for.
  expect(await page.locator(".ed-fmt-link").isVisible()).toBe(false);
  await page.keyboard.press("Control+k");
  // The key was the text's, so the palette stayed shut, and the box that asks for the address has the keyboard.
  expect(await page.locator(".ed-palette").isHidden()).toBe(true);
  const address = page.locator(".ed-fmt [data-fmt='link-address']");
  await address.waitFor({ state: "visible" });
  expect(await address.evaluate((node) => node === document.activeElement)).toBe(true);
  await address.fill("ftp://example.com/orders");
  await page.keyboard.press("Enter");
  expect(await page.locator(".ed-fmt-link .ed-problem").textContent()).toContain("https://");
  expect(textOf(deck.folder)).toBe("Orders **rose** in every region.");
  await address.fill("https://example.com/orders");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => textOf(deck.folder))
    .toBe("Orders **rose** in every [region](https://example.com/orders).");

  await selectWord(page, BODY, "every");
  await bar(page, "tone-evidence").click();
  await expect
    .poll(() => textOf(deck.folder))
    .toBe("Orders **rose** in [every]{evidence} [region](https://example.com/orders).");

  await page.locator(BODY).focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await bar(page, "bullets").click();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await expect.poll(() => textOf(deck.folder)).toBe(FINAL_TEXT);

  await page.locator(".ed-toolbar [data-tb='style']").click();
  await page.locator("[data-field='style:size']").selectOption("xl");
  await expect.poll(() => blockOf(deck.folder, "method-body")?.size).toBe("xl");
  await page.locator("[data-field='style:align']").selectOption("center");
  await expect.poll(() => blockOf(deck.folder, "method-body")?.align).toBe("center");
}

describe("text styles in a real browser", () => {
  it("bolds, links, colors and lists words, sets a block's size and alignment, and the scene file holds exactly that", async () => {
    const deck = await openDeck(prepared);
    await formatABody(deck);
    expect(blockOf(deck.folder, "method-body")).toEqual({
      id: "method-body",
      type: "text",
      role: "body",
      text: FINAL_TEXT,
      size: "xl",
      align: "center",
    });
    // The heading and the rest of the file were not touched.
    expect(blockOf(deck.folder, "method-heading")?.text).toBe("Channel B leads in every region");
    expect(JSON.parse(sceneFile(deck.folder)).schemaVersion).toBe("0.3");
    // The slide shows what the file says: a list, a link and a colored word, in the markup the player draws.
    const body = deck.page.locator(BODY);
    await expect.poll(() => body.locator("strong").allTextContents()).toEqual(["rose"]);
    expect(await body.locator("ul li").allTextContents()).toEqual(["first", "second"]);
    expect(await body.locator("a").getAttribute("href")).toBe("https://example.com/orders");
    expect(await body.locator("[data-tone='evidence']").textContent()).toBe("every");
    expect(problems).toEqual([]);
  });

  it("writes the same file as an agent that makes the same change through depthcue apply", async () => {
    const editor = await openDeck(prepared);
    await formatABody(editor);
    const agent = join(root, "agent");
    cpSync(demo, agent, { recursive: true });
    prepared(agent);
    const ops = join(root, "ops.json");
    writeFileSync(
      ops,
      JSON.stringify([
        {
          op: "block.set",
          scene: "method",
          id: "method-body",
          set: { text: FINAL_TEXT, size: "xl", align: "center" },
        },
      ]),
    );
    const errors: string[] = [];
    const rev: string[] = [];
    expect(run(["rev", agent], { out: (line) => rev.push(line), err: (line) => errors.push(line) })).toBe(0);
    const code = run(["apply", agent, ops, "--base-rev", rev[0] as string], {
      out: () => {},
      err: (line) => errors.push(line),
    });
    expect({ code, errors }).toEqual({ code: 0, errors: [] });
    await expect.poll(() => sceneFile(editor.folder)).toBe(sceneFile(agent));
    expect(readFileSync(join(editor.folder, "deck.json"), "utf8")).toBe(
      readFileSync(join(agent, "deck.json"), "utf8"),
    );
  });

  it("shows bold, a list, a link and a tone in the player and in an exported page", async () => {
    const deck = await openDeck(prepared);
    await formatABody(deck);
    const check = async (page: Page) => {
      const body = page.locator("[data-id='method-body']");
      await body.waitFor();
      expect(await body.locator("strong").allTextContents()).toEqual(["rose"]);
      expect(await body.locator("ul li").allTextContents()).toEqual(["first", "second"]);
      const link = body.locator("a");
      expect(await link.getAttribute("href")).toBe("https://example.com/orders");
      expect(await link.getAttribute("target")).toBe("_blank");
      expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
      const toned = body.locator("[data-tone='evidence']");
      expect(await toned.textContent()).toBe("every");
      // The tone is the deck's evidence color, as the page itself says it.
      const colors = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--dc-evidence)";
        (document.querySelector(".dc-player") as HTMLElement).append(probe);
        const evidence = getComputedStyle(probe).color;
        probe.remove();
        const word = document.querySelector("[data-id='method-body'] [data-tone='evidence']") as HTMLElement;
        return { evidence, word: getComputedStyle(word).color };
      });
      expect(colors.word).toBe(colors.evidence);
      // Size xl is drawn large, at least 24 CSS pixels at a 1280 by 720 stage, and centered.
      const look = await body.evaluate((node) => ({
        px: Number.parseFloat(getComputedStyle(node).fontSize),
        align: getComputedStyle(node).textAlign,
      }));
      expect(look.px).toBeGreaterThanOrEqual(24);
      expect(look.align).toBe("center");
    };

    const present = await context.newPage();
    await present.setViewportSize({ width: 1280, height: 720 });
    present.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    await present.goto(`${deck.server.url}present#/method`);
    await check(present);

    const out = join(root, "out");
    expect(run(["export", deck.folder, "--out", out], { out: () => {}, err: () => {} })).toBe(0);
    const exported = await context.newPage();
    await exported.setViewportSize({ width: 1280, height: 720 });
    exported.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    await exported.goto(`${pathToFileURL(join(out, "index.html")).href}#/method`);
    await check(exported);
    expect(problems).toEqual([]);
  });

  it("takes typing, then a format command, then more typing back one step at a time with Undo", async () => {
    const deck = await openDeck(prepared);
    const { page } = deck;
    await goTo(page, 3);
    await page.locator(BODY).focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Now");
    await expect.poll(() => textOf(deck.folder)).toBe(`${START} Now`);
    await selectWord(page, BODY, "rose");
    await page.keyboard.press("Control+b");
    await expect.poll(() => textOf(deck.folder)).toBe(`Orders **rose** in every region. Now`);
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");
    await expect.poll(() => textOf(deck.folder)).toBe(`Orders **rose** in every region. Now!`);

    await page.keyboard.press("Control+z");
    await expect.poll(() => textOf(deck.folder)).toBe(`Orders **rose** in every region. Now`);
    await page.keyboard.press("Control+z");
    await expect.poll(() => textOf(deck.folder)).toBe(`${START} Now`);
    await page.keyboard.press("Control+z");
    await expect.poll(() => textOf(deck.folder)).toBe(START);
    expect(problems).toEqual([]);
  });

  it("takes Enter as a new line in body text, and as the end of the edit in a heading", async () => {
    const deck = await openDeck(prepared);
    const { page } = deck;
    await goTo(page, 3);
    await page.locator(BODY).focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line");
    await expect.poll(() => textOf(deck.folder)).toBe(`${START}\nSecond line`);
    expect(await page.locator(BODY).evaluate((node) => node === document.activeElement)).toBe(true);

    const heading = page.locator(".ed-frame [data-id='method-heading']");
    await heading.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");
    await page.keyboard.press("Enter");
    await expect.poll(() => textOf(deck.folder, "method-heading")).toBe("Channel B leads in every region!");
    expect(await heading.evaluate((node) => node === document.activeElement)).toBe(false);
    expect(problems).toEqual([]);
  });

  it("pastes plain text only: markup and styles of what was copied are left behind, and lines that start a list make one", async () => {
    const deck = await openDeck(prepared);
    const { page } = deck;
    await goTo(page, 3);
    await page.locator(BODY).focus();
    await page.keyboard.press("Control+End");
    await page.evaluate((selector) => {
      const node = document.querySelector(selector) as HTMLElement;
      const data = new DataTransfer();
      data.setData(
        "text/html",
        '<b>rich</b><img src="x" onerror="window.pwned = 1"><script>window.pwned = 1</script><a href="javascript:alert(1)">x</a>',
      );
      data.setData("text/plain", "- one\n- two **plain**");
      node.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, BODY);
    await expect.poll(() => textOf(deck.folder)).toBe(`${START}\n- one\n- two \\*\\*plain\\*\\*`);
    const seen = await page.evaluate((selector) => {
      const node = document.querySelector(selector) as HTMLElement;
      return {
        elements: node.querySelectorAll("img, script, b, strong, a").length,
        items: [...node.querySelectorAll("ul li")].map((item) => item.textContent),
        pwned: (window as { pwned?: number }).pwned,
      };
    }, BODY);
    expect(seen).toEqual({ elements: 0, items: ["one", "two **plain**"], pwned: undefined });
    expect(problems).toEqual([]);
  });

  it("keeps the text of a scene below 0.3 as typed, with no format bar, until the scene is upgraded from its menu", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await goTo(page, 3);
    await page.locator(BODY).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Plain **stars** and 1. numbers");
    await expect.poll(() => textOf(deck.folder)).toBe("Plain **stars** and 1. numbers");
    expect(await page.locator(".ed-fmt").count()).toBe(0);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    expect(textOf(deck.folder)).toBe("Plain **stars** and 1. numbers");
    expect(JSON.parse(sceneFile(deck.folder)).schemaVersion).toBe("0.1");

    await page.locator(".ed-scene").nth(2).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Use text styles", exact: true }).click();
    await expect.poll(() => JSON.parse(sceneFile(deck.folder)).schemaVersion).toBe("0.3");
    // The characters are still the characters: the stars are escaped, so they are not bold.
    expect(textOf(deck.folder)).toBe("Plain \\*\\*stars\\*\\* and 1. numbers");
    await expect.poll(() => page.locator(BODY).textContent()).toBe("Plain **stars** and 1. numbers");
    expect(await page.locator(BODY).locator("strong").count()).toBe(0);
    await page.locator(BODY).focus();
    await bar(page, "bold").waitFor();
    expect(problems).toEqual([]);
  });

  it("upgrades a scene below 0.3 by the first style set on a block, and leaves its words as they were", async () => {
    const deck = await openDeck();
    const { page } = deck;
    await goTo(page, 3);
    const before = textOf(deck.folder);
    await page.locator(BODY).focus();
    await page.locator(".ed-toolbar [data-tb='style']").click();
    await page.locator("[data-field='style:size']").selectOption("l");
    await expect.poll(() => blockOf(deck.folder, "method-body")?.size).toBe("l");
    expect(JSON.parse(sceneFile(deck.folder)).schemaVersion).toBe("0.3");
    expect(textOf(deck.folder)).toBe(before);
    // The right-click menu of the block sets the same things. With the caret in the text a right-click is the browser's
    // own, so the keyboard goes elsewhere first.
    const menuOf = async (name: string, choice: string) => {
      await page.locator(".ed-scene").nth(1).click();
      await goTo(page, 3);
      await page.locator(BODY).click({ button: "right" });
      await page.locator(".ed-menu:not(.ed-menu-sub)").waitFor();
      await page.getByRole("menuitem", { name, exact: true }).hover();
      await page.getByRole("menuitem", { name: choice, exact: true }).click();
    };
    await menuOf("Align", "Center");
    await expect.poll(() => blockOf(deck.folder, "method-body")?.align).toBe("center");
    await menuOf("Size", "Medium");
    await expect.poll(() => blockOf(deck.folder, "method-body")?.size).toBeUndefined();
    await menuOf("Color", "Muted");
    await expect.poll(() => blockOf(deck.folder, "method-body")?.tone).toBe("muted");
    expect(textOf(deck.folder)).toBe(before);
    expect(problems).toEqual([]);
  });

  it("counts the characters that show and not the markup, and holds back what is over the limit with what to do", async () => {
    const deck = await openDeck((folder) => textScene(folder, { text: `**${"a".repeat(590)}**` }));
    const { page } = deck;
    await goTo(page, 3);
    await page.locator(BODY).focus();
    // The source is 594 characters and the slide shows 590, and the count is of what shows.
    await expect.poll(() => page.locator(".ed-tb-count").textContent()).toBe("590 / 600");
    expect(await page.locator(".ed-tb-count").getAttribute("data-near")).not.toBeNull();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("b".repeat(5));
    await expect.poll(() => String(textOf(deck.folder)).replaceAll("*", "").length).toBe(595);
    await page.keyboard.type("b".repeat(10));
    await expect
      .poll(() => hint(page).textContent())
      .toContain(
        "over the limit of 600. Shorten it, or move the detail into a body block or the reading text.",
      );
    // The file keeps a text that is within the limit: the keystrokes may be taken one at a time or together.
    const kept = String(textOf(deck.folder)).replaceAll("*", "").length;
    expect(kept).toBeGreaterThanOrEqual(595);
    expect(kept).toBeLessThanOrEqual(600);
    expect(problems).toEqual([]);
  });

  it("refuses a tone that is too faint for small text, says what to do, and takes it once the text is large", async () => {
    // An action color between 3:1 and 4.5:1 on the paper: readable large, not small.
    const deck = await openDeck(withPalette({ action: "#D9583A" }));
    const { page } = deck;
    await goTo(page, 3);
    await selectWord(page, BODY, "rose");
    await bar(page, "tone-action").click();
    await expect
      .poll(() => hint(page).textContent())
      .toContain("under the 4.5:1 that text of this size needs");
    expect(await hint(page).textContent()).toContain("size l or xl");
    expect(textOf(deck.folder)).toBe(START);

    await page.locator(".ed-toolbar [data-tb='style']").click();
    await page.locator("[data-field='style:size']").selectOption("l");
    await expect.poll(() => blockOf(deck.folder, "method-body")?.size).toBe("l");
    await selectWord(page, BODY, "rose");
    await bar(page, "tone-action").click();
    await expect.poll(() => textOf(deck.folder)).toBe("Orders [rose]{action} in every region.");

    // The same file passes the render check, which measures the pixels: size l is drawn at 24 pixels or more.
    const lines: string[] = [];
    const code = await run(["render", deck.folder, "method"], {
      out: (line) => lines.push(line),
      err: () => {},
    });
    expect({ code, last: lines.at(-1) }).toEqual({ code: 0, last: "1 scene rendered, 0 errors, 0 warnings" });
    expect(problems).toEqual([]);
  }, 90_000);

  it("shows the format bar while the keyboard is in the text, with each color drawn in the deck's own", async () => {
    const deck = await openDeck(withPalette({ evidence: "#0B6E4F" }));
    const { page } = deck;
    await goTo(page, 3);
    expect(await page.locator(".ed-fmt").count()).toBe(0);
    await page.locator(BODY).focus();
    await bar(page, "bold").waitFor();
    expect(await page.locator(".ed-fmt").isVisible()).toBe(true);
    const swatch = await bar(page, "tone-evidence")
      .locator(".ed-fmt-dot")
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(swatch).toBe("rgb(11, 110, 79)");
    // Choosing something else on the slide puts the bar away.
    await page.locator(".ed-frame [data-id='method-heading']").focus();
    await bar(page, "bold").waitFor();
    expect(await page.locator(".ed-fmt").isVisible()).toBe(true);
    await page.locator(".ed-toolbar [data-tb='role']").focus();
    await expect.poll(() => page.locator(".ed-fmt").isVisible()).toBe(false);
    expect(problems).toEqual([]);
  });

  it("keeps the toolbar and its format bar inside the slide area at 1024 wide, and the bar adds nothing to the toolbar's width", async () => {
    const { page } = await openDeck(prepared);
    await page.setViewportSize({ width: 1024, height: 768 });
    // A machine without Space Grotesk draws wider letters, as a Linux runner does. This makes every machine see that case.
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("*{font-family:Verdana,'DejaVu Sans',sans-serif !important}");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    });
    await goTo(page, 3);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(BODY).focus();
    await bar(page, "bold").waitFor();
    const seen = await page.evaluate(() => {
      const box = (node: Element) => node.getBoundingClientRect();
      const host = box(document.querySelector(".ed-canvas-host") as Element);
      const toolbar = document.querySelector(".ed-toolbar") as HTMLElement;
      const fmt = document.querySelector(".ed-fmt") as HTMLElement;
      const withBar = box(toolbar).width;
      const shown = [...fmt.querySelectorAll("button")].filter(
        (button) => button.getClientRects().length > 0,
      );
      const inside =
        shown.length >= 6 &&
        shown.every((button) => {
          const rect = box(button);
          return rect.left >= box(toolbar).left - 1 && rect.right <= box(toolbar).right + 1;
        });
      fmt.hidden = true;
      const without = box(toolbar).width;
      fmt.hidden = false;
      return {
        withinLeft: box(toolbar).left >= host.left - 1,
        withinRight: box(toolbar).right <= host.right + 1,
        withBar,
        without,
        inside,
      };
    });
    expect(seen.withinLeft).toBe(true);
    expect(seen.withinRight).toBe(true);
    expect(seen.inside).toBe(true);
    expect(Math.abs(seen.withBar - seen.without)).toBeLessThanOrEqual(1);
    expect(problems).toEqual([]);
  });
});

/**
 * The screenshots Dimitri looks at, written only when DEPTHCUE_SHOTS names a folder: a text being formatted with the
 * format bar showing, and a slide that has every style, each at the two sizes a presenter meets.
 */
const SHOTS = process.env.DEPTHCUE_SHOTS;
describe.skipIf(!SHOTS)("screenshots of text styles", () => {
  const SIZES = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ];
  const everyStyle = (folder: string) => {
    writeFileSync(
      join(folder, "scenes", "method.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.3",
          id: "method",
          title: "How we compared them",
          layout: "text-media",
          lead: "human",
          blocks: [
            {
              id: "method-heading",
              type: "text",
              role: "heading",
              text: "Channel B leads in *every* region",
            },
            {
              id: "method-body",
              type: "text",
              role: "body",
              size: "l",
              text: "Orders **rose** in [every]{evidence} region, see the [method](https://example.com/method).\n- Bulleted and *italic*\n- Colored [action]{action}\n1. First\n2. Second",
            },
            {
              id: "method-quote",
              type: "text",
              role: "quote",
              align: "center",
              tone: "evidence",
              text: "One count, **one** source",
            },
            {
              id: "method-caption",
              type: "text",
              role: "caption",
              size: "s",
              tone: "muted",
              align: "end",
              text: "Counted once, in the channel of the sale",
            },
          ],
          reading: { text: START },
        },
        null,
        2,
      )}\n`,
    );
  };

  for (const size of SIZES) {
    it(`formats and presents at ${size.width}x${size.height}`, async () => {
      const dir = SHOTS as string;
      mkdirSync(dir, { recursive: true });
      const deck = await openDeck(everyStyle);
      const { page } = deck;
      await page.setViewportSize(size);
      await goTo(page, 3);
      await page.evaluate(() => document.fonts.ready);
      await selectWord(page, BODY, "rose");
      await bar(page, "bold").waitFor();
      await page.screenshot({ path: join(dir, `text-format-bar-${size.width}x${size.height}.png`) });
      await page.keyboard.press("Control+k");
      await page.locator(".ed-fmt [data-fmt='link-address']").fill("ftp://x");
      await page.keyboard.press("Enter");
      await page.screenshot({ path: join(dir, `text-link-refused-${size.width}x${size.height}.png`) });
      await page.keyboard.press("Escape");
      const present = await context.newPage();
      await present.setViewportSize(size);
      await present.goto(`${deck.server.url}present#/method`);
      await present.locator(".dc-scene [data-id='method-body'] ul").waitFor();
      await present.evaluate(() => document.fonts.ready);
      await present.waitForLoadState("networkidle");
      await present.screenshot({ path: join(dir, `text-styles-player-${size.width}x${size.height}.png`) });
      await present.close();
      expect(problems).toEqual([]);
    }, 60_000);
  }
});
