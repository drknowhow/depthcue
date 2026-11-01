import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linkPath } from "@depthcue/cli/link";
import { launchBrowser } from "@depthcue/cli/render";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDepthcueServer, type DepthcueServer } from "../src/server.ts";

const demo = fileURLToPath(new URL("../../../fixtures/decks/v0-1", import.meta.url));
const cli = fileURLToPath(new URL("../../cli/dist/main.js", import.meta.url));

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Awaited<ReturnType<Browser["newContext"]>>["newPage"]>>;
type Context = Awaited<ReturnType<Browser["newContext"]>>;

let browser: Browser | undefined;
let skipReason: string | undefined;
let root: string;
let folder: string;
let server: ChildProcess | undefined;
let url: string;
let depthcue: DepthcueServer;
let client: Client;
let context: Context;
let page: Page;
let problems: string[];

beforeAll(async () => {
  try {
    if (!existsSync(cli)) throw new Error("The CLI is not built. Run pnpm build.");
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

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Starts `depthcue serve` the way a presenter would, and waits for it to say where it is. */
function serve(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "serve", folder, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`depthcue serve did not start: ${out}`)), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const found = /Serving .* at (http:\/\/\S+)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve({ child, url: found[1] as string });
      }
    });
    child.once("exit", () => reject(new Error(`depthcue serve exited: ${out}`)));
  });
}

beforeEach(async (test) => {
  if (!browser) {
    console.warn(`Skipped: ${skipReason}`);
    return test.skip();
  }
  root = mkdtempSync(join(tmpdir(), "depthcue-present-e2e-"));
  folder = join(root, "deck");
  cpSync(demo, folder, { recursive: true });
  const started = await serve();
  server = started.child;
  url = started.url;
  depthcue = createDepthcueServer(folder);
  client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([depthcue.server.connect(serverSide), client.connect(clientSide)]);
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
});

afterEach(async () => {
  await client?.close();
  await depthcue?.close();
  await context?.close();
  if (server) {
    const child = server;
    if (!exited(child)) {
      child.kill();
      await new Promise((done) => child.once("exit", done));
    }
    server = undefined;
  }
  // A server that is killed does not get to remove its link file.
  if (folder && existsSync(folder)) rmSync(linkPath(folder), { force: true });
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  isError: boolean;
  text: string;
  json: any;
}

async function present(args: Record<string, unknown> = {}): Promise<Reply> {
  const result = (await client.callTool({ name: "deck_present", arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content.find((part) => part.type === "text")?.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

const grant = () => page.locator('[data-lease-action="grant"]');
const takeOver = () => page.locator('[data-lease-action="takeover"]');
const step = () => page.locator(".dc-count").textContent();

/** Opens the agent-led scene, waits until the server has a page to talk to, and hands control over with a real click. */
async function handOver() {
  await page.goto(`${url}#/demand/0`);
  await page.locator(".dc-scene[data-scene='demand']").waitFor();
  await grant().waitFor();
  for (let tries = 0; tries < 40; tries++) {
    if (!(await present()).isError) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  await grant().click();
  await takeOver().waitFor();
}

describe("deck_present against a real server and page", () => {
  it("reports that the presenter holds control until they hand it over", async () => {
    await page.goto(`${url}#/demand/0`);
    await page.locator(".dc-scene[data-scene='demand']").waitFor();
    let reply = await present();
    for (let tries = 0; tries < 40 && reply.isError; tries++) {
      await new Promise((done) => setTimeout(done, 50));
      reply = await present();
    }
    expect(reply.json).toMatchObject({ holder: "human", position: { scene: "demand", step: 0, steps: 2 } });
    const refused = await present({ action: "next" });
    expect(refused.isError).toBe(true);
    expect(refused.json.code).toBe("no-lease");
    expect(await step()).toBe(await step());
    expect(problems).toEqual([]);
  });

  it("moves the deck after a real click hands over, and stops at the edge of what it was given", async () => {
    await handOver();
    const status = await present();
    expect(status.json).toMatchObject({
      holder: "agent",
      scenes: ["demand"],
      position: { scene: "demand", step: 0 },
    });
    const first = await present({ action: "next" });
    expect(first.json).toMatchObject({ ok: true, position: { scene: "demand", step: 1, steps: 2 } });
    await page.waitForFunction(() => document.querySelector(".dc-count")?.textContent?.includes("2"));
    expect((await present({ action: "next" })).json.position.step).toBe(2);
    const edge = await present({ action: "next" });
    expect(edge.isError).toBe(true);
    expect(edge.json).toMatchObject({ code: "out-of-scope", holder: "agent" });
    const back = await present({ action: "goto", scene: "demand", step: 0 });
    expect(back.json).toMatchObject({ ok: true, position: { scene: "demand", step: 0 } });
    expect(problems).toEqual([]);
  });

  it("keeps the lease alive by itself for longer than a lease lasts", async () => {
    await handOver();
    await present();
    // Three seconds is how long a lease lasts without a renewal; the tool's timer is the only thing renewing it.
    await new Promise((done) => setTimeout(done, 4500));
    expect(await takeOver().isVisible()).toBe(true);
    expect((await present({ action: "next" })).json.ok).toBe(true);
  }, 20_000);

  it("tells the agent when the presenter takes over, and not to try again", async () => {
    await handOver();
    await present();
    await page.keyboard.press("Escape");
    const late = await present({ action: "next" });
    expect(late.isError).toBe(true);
    expect(late.json.holder).toBe("human");
    expect(late.json.next).toContain("Do not retry");
    expect(await grant().isVisible()).toBe(true);
    const status = await present();
    expect(status.json).toMatchObject({ holder: "human", lastEnded: "takeover" });
  });

  it("hands control back when the agent releases it", async () => {
    await handOver();
    await present();
    const released = await present({ action: "release" });
    expect(released.json).toMatchObject({ released: true, holder: "human" });
    await grant().waitFor();
  });

  it("says no page is open once the page is closed", async () => {
    await handOver();
    await page.close();
    // A call that is already waiting when the page goes is told so; the first call after that finds no page.
    let first: string | undefined;
    for (let tries = 0; tries < 40; tries++) {
      const reply = await present();
      if (reply.isError) {
        first ??= reply.text;
        if (reply.text.includes("No page")) {
          expect(first).toMatch(/No page|page closed before it answered/);
          return;
        }
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`The server never said no page was open. The first complaint was: ${first}`);
  });

  it("says the server is gone once it stops, and keeps no lease it cannot renew", async () => {
    await handOver();
    await present();
    const child = server as ChildProcess;
    child.kill();
    await new Promise((done) => (exited(child) ? done(undefined) : child.once("exit", done)));
    const reply = await present({ action: "next" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/could not reach|No deck server/i);
  });
});
