import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLink } from "@depthcue/cli/link";
import { createLeaseController, type LeaseAction, type LeaseController } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresent, IDLE_LET_GO_MS, type Present, RENEW_EVERY_MS } from "../src/present.ts";

let folder: string;
let removeLink: (() => void) | undefined;
let present: Present;
let controller: LeaseController;
let at: number;
let sent: Array<{ op: string; body: any; headers: Record<string, string> }>;
/** Set to make the fake server fail a call the way a stopped server or a closed page would. */
let fail: ((op: string) => Response | Error | undefined) | undefined;

const SCENES = ["a", "b", "c"];

/** A page's lease: the real controller over a deck of three scenes. */
function page() {
  const host = {
    scene: () => SCENES[at] as string,
    // The scene an action would land on, which is what the lease checks against the scenes it was given.
    target: (action: LeaseAction, args: unknown) => {
      if (action === "next") return SCENES[Math.min(at + 1, SCENES.length - 1)];
      if (action === "previous") return SCENES[Math.max(at - 1, 0)];
      if (action === "goto") return SCENES.find((id) => id === (args as { scene?: string }).scene);
      return SCENES[at];
    },
    run: (action: LeaseAction, args: unknown) => {
      const before = at;
      if (action === "next") at = Math.min(at + 1, SCENES.length - 1);
      if (action === "previous") at = Math.max(at - 1, 0);
      if (action === "goto") at = SCENES.indexOf((args as { scene: string }).scene);
      if (at !== before) controller.changed();
      return at !== before;
    },
  };
  controller = createLeaseController({ host });
}

const position = () => ({ scene: SCENES[at], step: 0, steps: 0 });

async function answer(op: string, input: unknown) {
  if (op === "state") return { ...controller.state(), position: position() };
  if (op === "renew") return { ...controller.renew(input), position: position() };
  if (op === "submit") return { ...(await controller.submit(input)), position: position() };
  const released = controller.disconnect();
  return { released, ...controller.state(), position: position() };
}

const fetchFake = (async (url: URL | string, init: RequestInit) => {
  const op = new URL(url).pathname.split("/").pop() as string;
  const body = JSON.parse(String(init.body));
  sent.push({ op, body, headers: init.headers as Record<string, string> });
  const broken = fail?.(op);
  if (broken instanceof Error) throw broken;
  if (broken) return broken;
  return new Response(JSON.stringify(await answer(op, body)));
}) as typeof fetch;

beforeEach(() => {
  vi.useFakeTimers();
  folder = mkdtempSync(join(tmpdir(), "depthcue-present-"));
  mkdirSync(join(folder, "scenes"));
  removeLink = writeLink(folder, { url: "http://127.0.0.1:4173/", token: "tok-1", pid: 1 });
  at = 0;
  sent = [];
  fail = undefined;
  page();
  present = createPresent(folder, { fetch: fetchFake });
});

afterEach(() => {
  present.close();
  controller.destroy();
  removeLink?.();
  rmSync(folder, { recursive: true, force: true });
  vi.useRealTimers();
});

interface Reply {
  isError: boolean;
  text: string;
  json: any;
}

async function run(args: Record<string, unknown> = {}): Promise<Reply> {
  const result = await present.run(args);
  const text = (result.content[0] as { text: string }).text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

const handOver = (scenes: string[] = SCENES) => controller.grant({ scenes });
const count = (op: string) => sent.filter((one) => one.op === op).length;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("status", () => {
  it("says the presenter holds control, and where the deck is", async () => {
    const reply = await run();
    expect(reply.isError).toBe(false);
    expect(reply.json).toMatchObject({ holder: "human", rev: 0, position: { scene: "a" } });
    expect(reply.json.message).toContain("Hand to agent");
    expect(reply.json.next).toBeUndefined();
  });

  it("is what an empty call means", async () => {
    expect((await run({})).json.holder).toBe("human");
    expect(count("state")).toBe(1);
  });

  it("shows the scenes and actions an agent was given, and nothing of the lease's internals", async () => {
    handOver(["a", "b"]);
    const reply = await run({ action: "status" });
    expect(reply.json).toMatchObject({ holder: "agent", scenes: ["a", "b"], position: { scene: "a" } });
    expect(reply.json.actions).toEqual(["next", "previous", "goto", "invoke"]);
    expect(reply.text).not.toContain((controller.state() as any).lease.id);
  });

  it("sends the secret from the link file with every call", async () => {
    await run();
    expect(sent[0]?.headers).toMatchObject({
      "X-Depthcue-Token": "tok-1",
      "Content-Type": "application/json",
    });
  });
});

describe("when the link cannot be used", () => {
  it("says to start the server when the folder has no link file", async () => {
    removeLink?.();
    removeLink = undefined;
    const reply = await run();
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("depthcue serve");
    expect(sent).toEqual([]);
  });

  it("names the address when the server does not answer", async () => {
    fail = () => new Error("connect ECONNREFUSED");
    const reply = await run();
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("http://127.0.0.1:4173/");
    expect(reply.text).toContain("ECONNREFUSED");
  });

  it("passes on the server's own words when no page is open", async () => {
    fail = () =>
      new Response(
        JSON.stringify({ ok: false, code: "no-page", message: "No page is open for this deck." }),
        {
          status: 503,
        },
      );
    const reply = await run({ action: "next" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toBe("No page is open for this deck.");
  });

  it("says what the server answered when it gave no words", async () => {
    fail = () => new Response("{}", { status: 500 });
    expect((await run()).text).toBe("The deck server answered 500.");
  });
});

describe("moving the deck", () => {
  it("refuses while the presenter holds control, sends nothing that could move it, and says not to retry", async () => {
    const reply = await run({ action: "next" });
    expect(reply.isError).toBe(true);
    expect(reply.json).toMatchObject({ ok: false, code: "no-lease", holder: "human" });
    expect(reply.json.next).toContain("Do not retry");
    expect(count("submit")).toBe(0);
    expect(at).toBe(0);
  });

  it("moves the deck with the lease it was handed, and reports where the deck is", async () => {
    handOver();
    const first = await run({ action: "next" });
    expect(first.isError).toBe(false);
    expect(first.json).toMatchObject({ ok: true, holder: "agent", rev: 1, position: { scene: "b" } });
    expect((await run({ action: "next" })).json.position.scene).toBe("c");
    expect((await run({ action: "previous" })).json.position.scene).toBe("b");
  });

  it("asks the page for the lease once, then counts its own commands and the page's revision", async () => {
    handOver();
    await run({ action: "next" });
    await run({ action: "next" });
    expect(count("state")).toBe(1);
    const submits = sent.filter((one) => one.op === "submit").map((one) => one.body);
    expect(submits.map((one) => one.sequence)).toEqual([1, 2]);
    expect(submits.map((one) => one.expectedRev)).toEqual([0, 1]);
    expect(new Set(submits.map((one) => one.leaseId)).size).toBe(1);
    expect(submits[0].action).toBe("next");
    expect("args" in submits[0]).toBe(false);
  });

  it("keeps counting when the agent checks status in the middle of a lease", async () => {
    handOver();
    await run({ action: "next" });
    await run({ action: "status" });
    await run({ action: "next" });
    const submits = sent.filter((one) => one.op === "submit").map((one) => one.body);
    expect(submits.map((one) => one.sequence)).toEqual([1, 2]);
    expect(submits.map((one) => one.expectedRev)).toEqual([0, 1]);
  });

  it("starts counting from one for a lease it learns of behind its own back", async () => {
    handOver();
    await run({ action: "next" });
    controller.takeover();
    handOver();
    await run({ action: "status" });
    await run({ action: "next" });
    const last = sent.filter((one) => one.op === "submit").at(-1)?.body;
    expect(last).toMatchObject({ sequence: 1, epoch: 1 });
  });

  it("sends goto with its scene and step, and invoke with its block, command and arguments", async () => {
    handOver();
    await run({ action: "goto", scene: "c", step: 2 });
    await run({ action: "invoke", block: "chart", command: "play", args: { speed: 2 } });
    await run({ action: "goto", scene: "a" });
    const submits = sent.filter((one) => one.op === "submit").map((one) => one.body);
    expect(submits[0].args).toEqual({ scene: "c", step: 2 });
    expect(submits[1].args).toEqual({ block: "chart", command: "play", args: { speed: 2 } });
    expect(submits[2].args).toEqual({ scene: "a" });
  });

  it("sends invoke without arguments when it has none", async () => {
    handOver();
    await run({ action: "invoke", block: "chart", command: "play" });
    const body = sent.find((one) => one.op === "submit")?.body;
    expect(body.args).toEqual({ block: "chart", command: "play" });
  });

  it("checks that goto and invoke have what they need before it asks the page anything", async () => {
    handOver();
    const noScene = await run({ action: "goto" });
    expect(noScene.isError).toBe(true);
    expect(noScene.text).toContain("`scene`");
    for (const args of [
      { action: "invoke" },
      { action: "invoke", block: "x" },
      { action: "invoke", command: "x" },
    ]) {
      const reply = await run(args);
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("`block`");
    }
    expect(sent).toEqual([]);
  });

  it("rejects arguments that are not in the schema", async () => {
    for (const args of [
      { action: "fly" },
      { action: "next", extra: 1 },
      { action: "goto", step: -1, scene: "a" },
    ]) {
      const reply = await run(args);
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("Invalid arguments");
    }
    expect(sent).toEqual([]);
  });

  it("reports a refusal in the page's words, and keeps the lease it still has", async () => {
    handOver(["a", "b"]);
    await run({ action: "next" });
    const edge = await run({ action: "next" });
    expect(edge.isError).toBe(true);
    expect(edge.json).toMatchObject({
      ok: false,
      code: "out-of-scope",
      holder: "agent",
      position: { scene: "b" },
    });
    expect(typeof edge.json.message).toBe("string");
    expect(edge.json.next).toBeUndefined();
    expect((await run({ action: "previous" })).json.ok).toBe(true);
    expect(count("state")).toBe(1);
  });

  it("does not retry a command that failed, and says why", async () => {
    handOver();
    await run({ action: "status" });
    fail = (op) => (op === "submit" ? new Error("socket hang up") : undefined);
    const reply = await run({ action: "next" });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("socket hang up");
    expect(count("submit")).toBe(1);
  });

  it("learns the new revision from a refusal, so the agent's next try can work", async () => {
    handOver();
    await run({ action: "status" });
    // Something else moved the deck without ending the lease, so the agent's view is a revision behind.
    controller.changed();
    const stale = await run({ action: "next" });
    expect(stale.isError).toBe(true);
    expect(stale.json.code).toBe("stale-state");
    expect(stale.json.rev).toBe(1);
    expect((await run({ action: "next" })).json.ok).toBe(true);
    expect(count("submit")).toBe(2);
  });

  it("starts counting again for a new lease, and does not carry the old one's numbers", async () => {
    handOver();
    await run({ action: "next" });
    controller.takeover();
    expect((await run({ action: "next" })).json.holder).toBe("human");
    handOver();
    await run({ action: "next" });
    const last = sent.filter((one) => one.op === "submit").at(-1)?.body;
    expect(last.sequence).toBe(1);
    expect(last.epoch).toBe(1);
  });
});

describe("keeping the lease", () => {
  it("renews every second while the agent holds control, with the lease it was given", async () => {
    handOver();
    await run({ action: "status" });
    expect(count("renew")).toBe(0);
    await tick(RENEW_EVERY_MS);
    expect(count("renew")).toBe(1);
    await tick(RENEW_EVERY_MS * 9);
    expect(count("renew")).toBe(10);
    const renew = sent.find((one) => one.op === "renew")?.body;
    const lease = (controller.state() as any).lease;
    expect(renew).toEqual({ leaseId: lease.id, epoch: lease.epoch });
  });

  it("renews once a second however often the agent asks for status", async () => {
    handOver();
    for (let calls = 0; calls < 4; calls++) await run({ action: "status" });
    await tick(RENEW_EVERY_MS * 5);
    expect(count("renew")).toBe(5);
  });

  it("is pinned to the numbers docs/lease.md gives: a beat every second, two idle minutes", () => {
    expect(RENEW_EVERY_MS).toBe(1000);
    expect(IDLE_LET_GO_MS).toBe(120_000);
  });

  it("keeps control past the three seconds a lease lasts without renewal", async () => {
    handOver();
    await run({ action: "status" });
    await tick(20_000);
    expect(controller.state().holder).toBe("agent");
    expect((await run({ action: "next" })).json.ok).toBe(true);
  });

  it("does not renew a lease it was never asked about, or one the presenter holds", async () => {
    handOver();
    await tick(10_000);
    expect(count("renew")).toBe(0);
    controller.takeover();
    await run({ action: "status" });
    await tick(10_000);
    expect(count("renew")).toBe(0);
  });

  it("stops when the presenter takes over, and does not touch the new lease afterwards", async () => {
    handOver();
    await run({ action: "status" });
    await tick(RENEW_EVERY_MS * 2);
    controller.takeover();
    await tick(RENEW_EVERY_MS);
    const after = count("renew");
    await tick(10_000);
    expect(count("renew")).toBe(after);
    expect((await run({ action: "next" })).json).toMatchObject({ holder: "human", code: "no-lease" });
  });

  it("stops after the agent has been idle too long, and control goes back by itself", async () => {
    handOver();
    await run({ action: "status" });
    await tick(IDLE_LET_GO_MS - 1000);
    expect(controller.state().holder).toBe("agent");
    await tick(2000);
    const after = count("renew");
    await tick(10_000);
    expect(count("renew")).toBe(after);
    expect(controller.state().holder).toBe("human");
    expect((await run({ action: "next" })).json.holder).toBe("human");
  });

  it("counts any call as being there, so a working agent is not let go", async () => {
    handOver();
    await run({ action: "status" });
    for (let minute = 0; minute < 5; minute++) {
      await tick(IDLE_LET_GO_MS - 5000);
      expect((await run({ action: "status" })).json.holder).toBe("agent");
    }
  });

  it("stops when a renewal cannot be sent, and the lease runs out", async () => {
    handOver();
    await run({ action: "status" });
    fail = (op) => (op === "renew" ? new Error("offline") : undefined);
    await tick(RENEW_EVERY_MS);
    fail = undefined;
    const after = count("renew");
    await tick(10_000);
    expect(count("renew")).toBe(after);
    expect(controller.state().holder).toBe("human");
  });

  it("does not stack renewals while the page is slow to answer one", async () => {
    handOver();
    await run({ action: "status" });
    let release: (() => void) | undefined;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    const inner = fetchFake;
    present.close();
    present = createPresent(folder, {
      fetch: (async (url: URL, init: RequestInit) => {
        if (String(url).endsWith("/renew")) await slow;
        return inner(url, init);
      }) as typeof fetch,
    });
    await run({ action: "status" });
    await tick(RENEW_EVERY_MS * 5);
    expect(count("renew")).toBe(0);
    release?.();
    await tick(0);
    expect(count("renew")).toBe(1);
  });

  it("stops on release, and says whether anything was out", async () => {
    handOver();
    await run({ action: "status" });
    const released = await run({ action: "release" });
    expect(released.json).toMatchObject({ released: true, holder: "human" });
    await tick(10_000);
    expect(count("renew")).toBe(0);
    expect((await run({ action: "release" })).json).toMatchObject({ released: false, holder: "human" });
  });

  it("stops on close, and leaves no timer behind", async () => {
    handOver();
    await run({ action: "status" });
    present.close();
    controller.takeover();
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(count("renew")).toBe(0);
  });

  it("forgets the lease on close, so a later call asks the page again", async () => {
    handOver();
    await run({ action: "status" });
    present.close();
    await run({ action: "next" });
    expect(count("state")).toBe(2);
  });

  it("leaves no timer behind once it learns that control is gone", async () => {
    handOver();
    await run({ action: "status" });
    controller.takeover();
    await run({ action: "status" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops renewing a lease that the page no longer knows, even when someone else holds a lease now", async () => {
    handOver();
    await run({ action: "status" });
    controller.takeover();
    handOver();
    await tick(RENEW_EVERY_MS);
    expect(count("renew")).toBe(1);
    // The tool has forgotten the old lease, so the agent's next command asks the page for the one that is out.
    expect((await run({ action: "next" })).json.ok).toBe(true);
    expect(count("state")).toBe(2);
    await tick(5000);
    expect(controller.state().holder).toBe("agent");
    const ids = sent.filter((one) => one.op === "renew").map((one) => one.body.leaseId);
    expect(ids[1]).not.toBe(ids[0]);
    expect(new Set(ids.slice(1)).size).toBe(1);
  });

  it("ignores the answer to a renewal it sent for a lease it has since replaced", async () => {
    handOver();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      open = done;
    });
    let gated = false;
    present.close();
    present = createPresent(folder, {
      fetch: (async (url: URL, init: RequestInit) => {
        if (String(url).endsWith("/renew") && !gated) {
          gated = true;
          await gate;
        }
        return fetchFake(url, init);
      }) as typeof fetch,
    });
    await run({ action: "status" });
    await tick(RENEW_EVERY_MS);
    controller.takeover();
    handOver();
    await run({ action: "status" });
    open();
    await tick(0);
    const after = count("renew");
    await tick(RENEW_EVERY_MS * 3);
    expect(count("renew")).toBe(after + 3);
    expect(controller.state().holder).toBe("agent");
  });
});

describe("what the agent is told when the presenter takes over", () => {
  it("is the holder, why control ended and that it must not retry", async () => {
    handOver();
    await run({ action: "next" });
    controller.takeover();
    const late = await run({ action: "next" });
    expect(late.isError).toBe(true);
    expect(late.json).toMatchObject({ holder: "human", code: "stale-epoch" });
    expect(late.json.next).toContain("Do not retry");
    const status = await run({ action: "status" });
    expect(status.json).toMatchObject({ holder: "human", lastEnded: "takeover" });
    expect(status.isError).toBe(false);
  });

  it("reaches an agent whose command was already on its way", async () => {
    handOver();
    await run({ action: "status" });
    controller.takeover();
    const late = await run({ action: "next" });
    expect(late.isError).toBe(true);
    expect(late.json).toMatchObject({ ok: false, holder: "human" });
    expect(at).toBe(0);
  });
});
