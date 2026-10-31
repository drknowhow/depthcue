import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult, LeaseState, RenewResult } from "@depthcue/core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/demo", import.meta.url));

/** What a page lets an agent call. */
interface Agent {
  state(): LeaseState;
  renew(input: unknown): RenewResult;
  submit(input: unknown): Promise<CommandResult>;
  release(): boolean;
}
type Handle = { depthcue: { lease?: Agent } };

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let server: RunningServer;
let context: BrowserContext;
let page: Page;
let problems: string[];
let requested: string[];
let sequence: number;

beforeAll(async () => {
  try {
    if (!existsSync(join(builtPlayerDir(), "lease.js")))
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

beforeEach(async (test) => {
  if (!browser) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-lease-"));
  const folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  requested = [];
  sequence = 0;
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

const grant = () => page.locator('[data-lease-action="grant"]');
const takeOver = () => page.locator('[data-lease-action="takeover"]');
const pill = () => page.locator(".dc-lease-text");
const scene = () => page.locator(".dc-scene").getAttribute("data-scene");
const count = () => page.locator(".dc-count").textContent();
const asked = (name: string) => requested.some((path) => path.endsWith(name));
const state = () => page.evaluate(() => ((window as unknown as Handle).depthcue.lease as Agent).state());
const holder = async () => (await state()).holder;

/** A command for the lease that is out now, sent the way an agent's link would send it. */
async function send(action: string, args?: unknown): Promise<CommandResult> {
  const now = await state();
  if (now.holder !== "agent") throw new Error("No lease is out.");
  const command = {
    leaseId: now.lease.id,
    epoch: now.lease.epoch,
    sequence: ++sequence,
    expectedRev: now.rev,
    action,
    args,
  };
  return page.evaluate(
    (sent) => ((window as unknown as Handle).depthcue.lease as Agent).submit(sent),
    command,
  );
}

/** Opens the agent-led scene of the demo and hands control over with a real click. */
async function handOver() {
  await page.goto(`${server.url}#/demand/0`);
  await page.locator(".dc-scene[data-scene='demand']").waitFor();
  await grant().click();
  await takeOver().waitFor();
  expect(await holder()).toBe("agent");
}

describe("the control lease in a real browser", () => {
  it("is loaded by the served page, shows who presents, and offers an agent nothing that hands over control", async () => {
    await page.goto(server.url);
    await page.locator(".dc-scene[data-scene='opening']").waitFor();
    await pill().waitFor();
    expect(asked("/lease.js")).toBe(true);
    expect(await pill().textContent()).toBe("You present");
    expect(
      await page.evaluate(() => Object.keys((window as unknown as Handle).depthcue.lease ?? {}).sort()),
    ).toEqual(["release", "renew", "state", "submit"]);
    expect(problems).toEqual([]);
  });

  it("downloads and shows nothing of it when the page does not ask, as in an exported deck", async () => {
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      return route.fulfill({ response, body: (await response.text()).replace(" data-lease", "") });
    });
    await page.goto(server.url);
    await page.locator(".dc-scene[data-scene='opening']").waitFor();
    expect(asked("/lease.js")).toBe(false);
    expect(await page.locator(".dc-lease").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as Handle).depthcue.lease)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("is not handed over by a script that clicks the button", async () => {
    await page.goto(`${server.url}#/demand/0`);
    await grant().waitFor();
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-lease-action="grant"]')?.click());
    expect(await holder()).toBe("human");
    expect(await pill().textContent()).toBe("You present");
  });

  it("lets the agent drive the section it was given, and nothing beyond it", async () => {
    await handOver();
    expect(await pill().textContent()).toBe("Agent presenting");
    const start = await count();
    expect((await send("next")).ok).toBe(true);
    await page.waitForFunction(
      (before) => document.querySelector(".dc-count")?.textContent !== before,
      start,
    );
    expect(await holder()).toBe("agent");
    expect((await send("next")).ok).toBe(true);
    const edge = await send("next");
    expect(edge.ok).toBe(false);
    expect(!edge.ok && edge.code).toBe("out-of-scope");
    expect(await scene()).toBe("demand");
    expect(await holder()).toBe("agent");
    expect(problems).toEqual([]);
  });

  it("is not ended by the agent's own moves, and is ended by the person's back button", async () => {
    // The player writes a history entry when the scene changes, so the person gets there with a click first.
    await page.goto(server.url);
    await page.locator(".dc-scene[data-scene='opening']").waitFor();
    await page.locator('[data-action="next"]').click();
    await page.locator(".dc-scene[data-scene='demand']").waitFor();
    await grant().click();
    await takeOver().waitFor();
    expect((await send("next")).ok).toBe(true);
    expect(await holder()).toBe("agent");
    await page.goBack();
    await page.waitForFunction(
      () => document.querySelector(".dc-lease-text")?.textContent === "You took over",
    );
    expect(await holder()).toBe("human");
    expect(await scene()).toBe("opening");
  });

  it("goes back to the person on a key press, before the key moves the deck", async () => {
    await handOver();
    const late = await state();
    if (late.holder !== "agent") throw new Error("No lease is out.");
    await page.keyboard.press("ArrowRight");
    expect(await holder()).toBe("human");
    expect(await pill().textContent()).toBe("You took over");
    expect(await grant().isVisible()).toBe(true);
    const refused = await page.evaluate(
      (sent) => ((window as unknown as Handle).depthcue.lease as Agent).submit(sent),
      {
        leaseId: late.lease.id,
        epoch: late.lease.epoch,
        sequence: 99,
        expectedRev: late.rev,
        action: "next",
      },
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.code).toBe("stale-epoch");
  });

  it("goes back to the person on Escape and on the take over button", async () => {
    await handOver();
    const at = await count();
    await page.keyboard.press("Escape");
    expect(await holder()).toBe("human");
    expect(await count()).toBe(at);
    await grant().click();
    await takeOver().click();
    expect(await holder()).toBe("human");
    expect(await count()).toBe(at);
  });

  it("keeps the lease while the agent renews it, and gives control back when it stops", async () => {
    await handOver();
    const at = await count();
    for (let beat = 0; beat < 4; beat += 1) {
      await page.waitForTimeout(1000);
      const now = await state();
      if (now.holder !== "agent") throw new Error("The lease ended while it was being renewed.");
      const renewed = await page.evaluate(
        (input) => ((window as unknown as Handle).depthcue.lease as Agent).renew(input),
        { leaseId: now.lease.id, epoch: now.lease.epoch },
      );
      expect(renewed.ok).toBe(true);
    }
    expect(await holder()).toBe("agent");
    await page.waitForFunction(
      () => document.querySelector(".dc-lease-text")?.textContent === "Agent timed out",
      null,
      { timeout: 6000 },
    );
    expect(await holder()).toBe("human");
    expect(await count()).toBe(at);
  }, 20_000);

  it("goes back to the person when the address changes", async () => {
    await handOver();
    await page.evaluate(() => {
      location.hash = "#/method/0";
    });
    await page.waitForFunction(
      () => document.querySelector(".dc-lease-text")?.textContent === "You took over",
    );
    expect(await holder()).toBe("human");
  });
});
