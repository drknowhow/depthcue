import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readLink } from "../src/link.ts";
import { launchBrowser } from "../src/render.ts";
import { builtPlayerDir, type RunningServer, startServer } from "../src/serve.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));

/** What an agent gets back from the link: the page's answer, and where the deck is. */
type Answer = Record<string, unknown> & {
  ok?: boolean;
  code?: string;
  holder?: string;
  epoch?: number;
  rev?: number;
  lease?: { id: string; epoch: number };
  position?: { scene: string; step: number; steps: number };
};

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let server: RunningServer;
let context: BrowserContext;
let page: Page;
let problems: string[];
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
  root = mkdtempSync(join(tmpdir(), "depthcue-link-"));
  const folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  server = await startServer({ folder, playerDir: builtPlayerDir(), port: 0 });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  sequence = 0;
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

afterEach(async () => {
  await context?.close();
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

/** A call the way an agent makes it: from outside the browser, with the secret from the link. */
async function call(op: string, body: unknown = {}, token = server.agentToken) {
  const response = await fetch(`${server.url}_depthcue/lease/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Depthcue-Token": token },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Answer };
}

const grant = () => page.locator('[data-lease-action="grant"]');
const takeOver = () => page.locator('[data-lease-action="takeover"]');
const scene = () => page.locator(".dc-scene").getAttribute("data-scene");

/** Opens a page and waits until the server knows it, so the first call has somewhere to go. */
async function open(hash = "") {
  await page.goto(`${server.url}${hash}`);
  await page.locator(".dc-lease").waitFor({ state: "attached" });
  for (let tries = 0; tries < 40; tries++) {
    if ((await call("state")).status === 200) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("The page never attached to the server.");
}

/** Hands the demand scene to the agent with a real click, and returns the first command it may send. */
async function handOver() {
  await open("#/demand/0");
  await page.locator(".dc-scene[data-scene='demand']").waitFor();
  await grant().click();
  await takeOver().waitFor();
  return command("next");
}

async function command(action: string, args?: unknown) {
  const { json } = await call("state");
  if (json.holder !== "agent" || !json.lease) throw new Error("No lease is out.");
  return {
    leaseId: json.lease.id,
    epoch: json.lease.epoch,
    sequence: ++sequence,
    expectedRev: json.rev,
    action,
    args,
  };
}

describe("the agent link in a real browser", () => {
  it("reaches the open page, which says the person is presenting and where the deck is", async () => {
    await open();
    const { status, json } = await call("state");
    expect(status).toBe(200);
    expect(json).toMatchObject({
      holder: "human",
      position: { scene: "opening", step: 0, steps: 0 },
    });
    expect(problems).toEqual([]);
  });

  it("says there is no page when none is open", async () => {
    const { status, json } = await call("state");
    expect(status).toBe(503);
    expect(json.code).toBe("no-page");
  });

  it("refuses a wrong secret and never reaches the page", async () => {
    await open();
    const { status, json } = await call("state", {}, "guess");
    expect(status).toBe(401);
    expect(json.code).toBe("unauthorized");
  });

  it("moves the deck for an agent that was handed control, and the page shows it", async () => {
    await handOver();
    const first = await call("submit", await command("next"));
    expect(first.json).toMatchObject({ ok: true, holder: "agent", position: { scene: "demand", step: 1 } });
    const second = await call("submit", await command("next"));
    expect(second.json.position).toEqual({ scene: "demand", step: 2, steps: 2 });
    expect(await scene()).toBe("demand");
    // The scene's last step is the edge of what it was given.
    const edge = await call("submit", await command("next"));
    expect(edge.json).toMatchObject({ ok: false, code: "out-of-scope", holder: "agent" });
    expect(problems).toEqual([]);
  });

  it("will not move a deck whose person is presenting, however it asks", async () => {
    await open();
    const forged = { leaseId: "x", epoch: 0, sequence: 1, expectedRev: 0, action: "next" };
    const { json } = await call("submit", forged);
    expect(json.ok).toBe(false);
    expect(json.holder).toBe("human");
    expect(await scene()).toBe("opening");
  });

  it("keeps the lease for as long as the agent renews it through the link, and loses it when it stops", async () => {
    const sent = await handOver();
    // Four seconds is more than the three a lease lasts, so only the renewals keep it.
    for (let beat = 0; beat < 4; beat++) {
      const renewed = await call("renew", { leaseId: sent.leaseId, epoch: sent.epoch });
      expect(renewed.json.ok).toBe(true);
      await new Promise((done) => setTimeout(done, 1000));
    }
    expect((await call("state")).json.holder).toBe("agent");
    await page.waitForFunction(
      () => document.querySelector(".dc-lease-text")?.textContent === "Agent timed out",
      undefined,
      { timeout: 6000 },
    );
    const after = await call("state");
    expect(after.json.holder).toBe("human");
    expect(after.json.epoch).toBe(sent.epoch + 1);
    expect((await call("submit", sent)).json.ok).toBe(false);
  }, 20_000);

  it("tells the agent the person took over, and refuses what it sends after", async () => {
    const sent = await handOver();
    await page.keyboard.press("Escape");
    const state = await call("state");
    expect(state.json).toMatchObject({ holder: "human", epoch: sent.epoch + 1 });
    const late = await call("submit", sent);
    expect(late.json).toMatchObject({ ok: false, code: "stale-epoch" });
    expect(await scene()).toBe("demand");
  });

  it("lets the agent release control, and the page shows it", async () => {
    await handOver();
    const released = await call("release");
    expect(released.json).toMatchObject({ released: true, holder: "human" });
    await grant().waitFor();
    expect((await call("release")).json).toMatchObject({ released: false });
  });

  it("answers calls with 503 once the page is closed", async () => {
    await open();
    await page.close();
    for (let tries = 0; tries < 40; tries++) {
      const { status, json } = await call("state");
      if (status === 503) return expect(json.code).toBe("no-page");
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("The server still believed the page was open.");
  });

  it("goes to the newest page, so a reload does not strand the agent", async () => {
    await open("#/method/0");
    const reloaded = await context.newPage();
    reloaded.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    await reloaded.goto(`${server.url}#/demand/0`);
    await reloaded.locator(".dc-lease").waitFor({ state: "attached" });
    await page.close();
    let json: Answer = {};
    for (let tries = 0; tries < 40; tries++) {
      json = (await call("state")).json;
      if (json.position?.scene === "demand") break;
      await new Promise((done) => setTimeout(done, 50));
    }
    expect(json.position?.scene).toBe("demand");
  });

  it("is findable by an agent that only knows the folder", async () => {
    // The link file is written by `depthcue serve`, which starts its own server; here the helper stands in for it.
    const { writeLink } = await import("../src/link.ts");
    const folder = join(root, "deck");
    const remove = writeLink(folder, { url: server.url, token: server.agentToken, pid: process.pid });
    try {
      const found = readLink(folder);
      expect(found?.url).toBe(server.url);
      await open();
      const { status } = await call("state", {}, found?.token);
      expect(status).toBe(200);
    } finally {
      remove();
    }
  });
});
