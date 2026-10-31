import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let server: RunningServer;
let context: BrowserContext;
/** The window the room sees. */
let audience: Page;
/** The presenter's window. Opened by each test that needs it. */
let presenter: Page;
let problems: string[];

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "presenter.js")))
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

const watch = (page: Page, name: string) => {
  page.on("pageerror", (error) => problems.push(`${name} pageerror: ${error.message}`));
  // A refused script or style shows up as a console error, not a page error.
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`${name} console: ${message.text()}`);
  });
};

beforeEach(async (test) => {
  if (!browser) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-presenter-"));
  const folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  audience = await context.newPage();
  problems = [];
  watch(audience, "audience");
});

afterEach(async () => {
  const seen = problems;
  await context?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
  expect(seen).toEqual([]);
});

async function call(op: string, body: unknown = {}) {
  const response = await fetch(`${server.url}_depthcue/lease/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Depthcue-Token": server.agentToken },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

const grant = () => audience.locator('[data-lease-action="grant"]');
const takeOver = () => audience.locator('[data-lease-action="takeover"]');
const sceneOnScreen = () => audience.locator(".dc-scene").getAttribute("data-scene");
const pv = (selector: string) => presenter.locator(selector);

/** Opens the deck window and waits until the server knows it, so the agent's first call has somewhere to go. */
async function openAudience(hash = "") {
  await audience.goto(`${server.url}${hash}`);
  await audience.locator(".dc-lease").waitFor({ state: "attached" });
  for (let tries = 0; tries < 40; tries++) {
    if ((await call("state")).status === 200) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("The page never attached to the server.");
}

/** Opens the presenter's window by address, and waits until the deck window has told it where the deck is. */
async function openPresenter() {
  presenter = await context.newPage();
  watch(presenter, "presenter");
  await presenter.goto(`${server.url}?presenter`);
  await pv(".dc-pv-scene:not(:empty)").waitFor();
}

describe("the presenter view in a real browser", () => {
  it("shows the scene on screen with its notes and what comes next, and follows the audience", async () => {
    await openAudience();
    await openPresenter();
    await expect(pv(".dc-pv-scene").textContent()).resolves.toBe("Why channel B now leads");
    await expect(pv(".dc-pv-notes").textContent()).resolves.toContain("Open with the answer");
    await expect(pv(".dc-pv-label").textContent()).resolves.toBe("Next scene");
    await expect(pv(".dc-pv-next-title").textContent()).resolves.toBe("Demand is shifting");
    await expect(pv(".dc-pv-holder").textContent()).resolves.toBe("You present");

    await audience.locator('[data-action="next"]').click();
    await expect.poll(() => pv(".dc-pv-scene").textContent()).toBe("Demand is shifting");
    await expect(pv(".dc-pv-where").textContent()).resolves.toBe("Scene 2 of 3 · step 0 of 2 · Agent-led");
    await expect(pv(".dc-pv-label").textContent()).resolves.toBe("Next click: step 1 of 2");

    await audience.keyboard.press("ArrowRight");
    await expect.poll(() => pv(".dc-pv-where").textContent()).toContain("step 1 of 2");
  });

  it("moves the audience's deck from its Next and Previous buttons and from the arrow keys", async () => {
    await openAudience();
    await openPresenter();
    await pv('[data-pv="next"]').click();
    await expect.poll(sceneOnScreen).toBe("demand");
    await presenter.keyboard.press("ArrowRight");
    await expect.poll(() => audience.locator(".dc-count").textContent()).toContain("2");
    await pv('[data-pv="previous"]').click();
    await presenter.keyboard.press("PageUp");
    await expect.poll(sceneOnScreen).toBe("opening");
    await expect(pv('[data-pv="previous"]').getAttribute("aria-disabled")).resolves.toBe("true");
  });

  it("finds the deck where it already is when it opens late", async () => {
    await openAudience("#/demand/1");
    await openPresenter();
    await expect(pv(".dc-pv-where").textContent()).resolves.toBe("Scene 2 of 3 · step 1 of 2 · Agent-led");
  });

  it("shows when the person hands over, lets the agent move both windows, and hands back from its button", async () => {
    await openAudience("#/demand/0");
    await audience.locator(".dc-scene[data-scene='demand']").waitFor();
    await openPresenter();
    await grant().click();
    await expect.poll(() => pv(".dc-pv-holder").textContent()).toBe("Agent presenting");
    await pv('[data-pv="takeover"]').waitFor({ state: "visible" });

    const state = (await call("state")).json;
    const moved = await call("submit", {
      leaseId: state.lease.id,
      epoch: state.lease.epoch,
      sequence: 1,
      expectedRev: state.rev,
      action: "next",
    });
    expect(moved.json).toMatchObject({ ok: true, position: { scene: "demand", step: 1 } });
    await expect.poll(() => pv(".dc-pv-where").textContent()).toContain("step 1 of 2");

    await pv('[data-pv="takeover"]').click();
    await expect.poll(() => pv(".dc-pv-holder").textContent()).toBe("You present");
    await pv('[data-pv="takeover"]').waitFor({ state: "hidden" });
    await grant().waitFor({ state: "visible" });
    await expect(takeOver().isVisible()).resolves.toBe(false);
    expect((await call("state")).json.holder).toBe("human");
  });

  it("takes control back when Escape is pressed in the presenter's window", async () => {
    await openAudience("#/demand/0");
    await audience.locator(".dc-scene[data-scene='demand']").waitFor();
    await openPresenter();
    await grant().click();
    await takeOver().waitFor();
    await presenter.bringToFront();
    await presenter.keyboard.press("Escape");
    await grant().waitFor({ state: "visible" });
    await expect.poll(() => pv(".dc-pv-holder").textContent()).toBe("You present");
  });

  it("moves the deck from the presenter's window while the agent holds control, and ends the agent's turn", async () => {
    await openAudience("#/demand/0");
    await audience.locator(".dc-scene[data-scene='demand']").waitFor();
    await openPresenter();
    await grant().click();
    await takeOver().waitFor();
    await pv('[data-pv="next"]').click();
    await grant().waitFor({ state: "visible" });
    await expect.poll(() => pv(".dc-pv-holder").textContent()).toBe("You present");
    await expect.poll(() => pv(".dc-pv-where").textContent()).toContain("step 1 of 2");
    expect((await call("state")).json.holder).toBe("human");
  });

  it("is not a page the agent can call: with only this window open there is no page, and with both the deck window answers", async () => {
    presenter = await context.newPage();
    watch(presenter, "presenter");
    await presenter.goto(`${server.url}?presenter`);
    await pv(".dc-pv-holder").waitFor();
    await expect(pv(".dc-pv-holder").textContent()).resolves.toBe("Waiting for the deck window");
    const alone = await call("state");
    expect(alone.status).toBe(503);
    expect(alone.json.code).toBe("no-page");

    await openAudience("#/demand/1");
    await expect.poll(() => pv(".dc-pv-holder").textContent()).toBe("You present");
    const both = await call("state");
    expect(both.status).toBe(200);
    expect(both.json.position).toEqual({ scene: "demand", step: 1, steps: 2 });
  });

  it("opens from the deck window's button as a popup on the presenter address", async () => {
    await openAudience("#/demand/0");
    const opened = context.waitForEvent("page");
    await audience.locator("[data-presenter-open]").click();
    presenter = await opened;
    watch(presenter, "presenter");
    await pv(".dc-pv-scene:not(:empty)").waitFor();
    expect(new URL(presenter.url()).search).toBe("?presenter");
    expect(new URL(presenter.url()).hash).toBe("");
    await expect(pv(".dc-pv-where").textContent()).resolves.toBe("Scene 2 of 3 · step 0 of 2 · Agent-led");
  });

  it("has a timer that runs and starts over", async () => {
    await openAudience();
    await openPresenter();
    await expect(pv(".dc-pv-time").textContent()).resolves.toBe("0:00");
    await expect.poll(() => pv(".dc-pv-time").textContent(), { timeout: 5000 }).not.toBe("0:00");
    await pv('[data-pv="reset"]').click();
    await expect(pv(".dc-pv-time").textContent()).resolves.toBe("0:00");
  });

  it("loads none of the presenter code on a page whose shell does not ask for it, and ignores ?presenter there", async () => {
    const requested: string[] = [];
    audience.on("request", (request) => requested.push(new URL(request.url()).pathname));
    // The shell an exported deck would have: the same page without the lease and presenter attributes.
    await audience.route(/\/(\?presenter)?$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(" data-lease", "").replace(" data-presenter", "");
      await route.fulfill({ response, body });
    });
    await audience.goto(`${server.url}?presenter`);
    await audience.locator(".dc-scene").waitFor();
    await expect(audience.locator(".dc-presenter").count()).resolves.toBe(0);
    await expect(audience.locator("[data-presenter-open]").count()).resolves.toBe(0);
    await expect(audience.locator(".dc-lease").count()).resolves.toBe(0);
    expect(requested.filter((path) => /presenter|broadcast|lease/.test(path))).toEqual([]);
  });

  it("loads the presenter code only when the shell asks for it", async () => {
    const requested: string[] = [];
    audience.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await openAudience();
    expect(requested.some((path) => path.endsWith("/broadcast.js"))).toBe(true);
    // The deck window carries the button and the sender. The window with the view is a different page.
    expect(requested.some((path) => path.endsWith("/presenter.js"))).toBe(false);
  });

  it("keeps up when the deck's files change", async () => {
    await openAudience();
    await openPresenter();
    const file = join(root, "deck", "scenes", "opening.json");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const scene = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...scene, notes: "Rewritten while presenting." }));
    await expect
      .poll(() => pv(".dc-pv-notes").textContent(), { timeout: 8000 })
      .toBe("Rewritten while presenting.");
  });
});
