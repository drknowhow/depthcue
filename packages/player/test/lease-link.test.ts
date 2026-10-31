// @vitest-environment happy-dom
import type { CommandResult, LeaseCommand } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LeaseMount, mountLease } from "../src/lease.ts";
import type { PlayerSource } from "../src/load.ts";
import { mountPlayer, type Player } from "../src/player.ts";
import { demoSource } from "./helpers.ts";

let host: HTMLElement;
let player: Player;
let lease: LeaseMount;
let events: EventTarget;
let replies: Array<{ id: string; result: Record<string, unknown> }>;
let answered: ReturnType<typeof vi.fn>;
let sequence = 0;

beforeEach(() => {
  history.replaceState(null, "", "/");
  host = document.createElement("div");
  document.body.append(host);
  sequence = 0;
  replies = [];
  answered = vi.fn(async (_url: string, init: RequestInit) => {
    replies.push(JSON.parse(String(init.body)));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", answered);
  const source: PlayerSource = demoSource();
  player = mountPlayer(host, source, { reducedMotion: true, onChange: (state) => lease?.changed(state) });
  lease = mountLease({ player, source: () => source, allowScriptedGrant: true });
  events = new EventTarget();
  lease.link(events as EventSource);
});

afterEach(() => {
  lease.destroy();
  player.destroy();
  host.remove();
  vi.unstubAllGlobals();
});

/** What the server sends the page when an agent calls. */
const relay = (data: unknown) =>
  events.dispatchEvent(
    new MessageEvent("lease", { data: typeof data === "string" ? data : JSON.stringify(data) }),
  );

/** Relays a call and waits for the page's answer to it. */
async function ask(op: unknown, input?: unknown, id = `call-${replies.length + 1}`) {
  const before = replies.length;
  relay({ id, op, input });
  await vi.waitFor(() => expect(replies.length).toBe(before + 1));
  const reply = replies[before] as (typeof replies)[number];
  expect(reply.id).toBe(id);
  return reply.result;
}

const grant = () => host.querySelector<HTMLButtonElement>('[data-lease-action="grant"]')?.click();

/** Hands the agent the demand scene, then returns a command for the lease that is out. */
function leased(): LeaseCommand {
  player.go({ scene: 1, step: 0 });
  grant();
  const state = lease.controller.state();
  if (state.holder !== "agent") throw new Error("No lease is out.");
  return {
    leaseId: state.lease.id,
    epoch: state.lease.epoch,
    sequence: ++sequence,
    expectedRev: state.rev,
    action: "next",
  };
}

describe("where the deck is", () => {
  it("names the scene on screen, the step shown and how many steps the scene has", () => {
    expect(lease.agent.position()).toEqual({ scene: "opening", step: 0, steps: 0 });
    player.go({ scene: 1, step: 0 });
    expect(lease.agent.position()).toEqual({ scene: "demand", step: 0, steps: 2 });
    player.go({ scene: 1, step: 2 });
    expect(lease.agent.position()).toEqual({ scene: "demand", step: 2, steps: 2 });
  });
});

describe("a call the server relays", () => {
  it("is answered with a post to the reply route that only the page's own script can make", async () => {
    await ask("state");
    expect(answered).toHaveBeenCalledTimes(1);
    const [url, init] = answered.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/_depthcue/lease/reply");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-Depthcue-Reply": "1" });
  });

  it("answers state with who holds control, and where the deck is", async () => {
    expect(await ask("state")).toMatchObject({
      holder: "human",
      rev: 0,
      epoch: 0,
      position: { scene: "opening", step: 0, steps: 0 },
    });
    const sent = leased();
    const result = await ask("state");
    expect(result).toMatchObject({ holder: "agent", position: { scene: "demand" } });
    expect((result.lease as { id: string }).id).toBe(sent.leaseId);
  });

  it("answers renew from the lease, with the position beside it", async () => {
    const sent = leased();
    const ok = await ask("renew", { leaseId: sent.leaseId, epoch: sent.epoch });
    expect(ok.ok).toBe(true);
    expect(typeof ok.expiresAt).toBe("number");
    expect(ok.position).toEqual({ scene: "demand", step: 0, steps: 2 });
    const wrong = await ask("renew", { leaseId: "nope", epoch: sent.epoch });
    expect(wrong).toMatchObject({ ok: false, code: "unknown-lease", holder: "agent" });
    expect(wrong.position).toEqual({ scene: "demand", step: 0, steps: 2 });
  });

  it("runs a submit, waits for the move, and answers with the position after it", async () => {
    const sent = leased();
    const result = await ask("submit", sent);
    expect(result).toMatchObject({ ok: true, holder: "agent" });
    expect(result.position).toEqual({ scene: "demand", step: 1, steps: 2 });
    expect(player.state.position).toEqual({ scene: 1, step: 1 });
  });

  it("answers a refused submit with the lease's own words, and moves nothing", async () => {
    const sent = leased();
    const result = await ask("submit", { ...sent, epoch: sent.epoch + 1 });
    expect(result).toMatchObject({ ok: false, code: "stale-epoch" });
    expect(typeof result.message).toBe("string");
    expect(result.position).toEqual({ scene: "demand", step: 0, steps: 2 });
  });

  it("answers release by handing control back, and says whether anything was out", async () => {
    leased();
    const released = await ask("release");
    expect(released).toMatchObject({
      released: true,
      holder: "human",
      position: { scene: "demand", step: 0, steps: 2 },
    });
    expect(lease.controller.state().holder).toBe("human");
    expect(await ask("release")).toMatchObject({ released: false, holder: "human" });
  });

  it("tells an agent that the person took over, as soon as it asks", async () => {
    const sent = leased();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(await ask("state")).toMatchObject({ holder: "human", epoch: sent.epoch + 1 });
    const late = (await ask("submit", sent)) as unknown as CommandResult;
    expect(late.ok).toBe(false);
  });

  it("is refused for a call the page does not know, and never touches the lease", async () => {
    const sent = leased();
    for (const op of ["grant", "takeover", "", undefined, 7, null]) {
      expect(await ask(op, sent)).toMatchObject({ ok: false, code: "unknown-call" });
    }
    expect(lease.controller.state().holder).toBe("agent");
  });

  it("is dropped when it cannot be read, and sends nothing back", async () => {
    for (const data of [
      "",
      "{",
      "null",
      "[]",
      "42",
      JSON.stringify({ op: "state" }),
      JSON.stringify({ id: 7, op: "state" }),
    ]) {
      relay(data);
    }
    await new Promise((done) => setTimeout(done, 20));
    expect(answered).not.toHaveBeenCalled();
  });

  it("keeps working when the answer cannot be posted", async () => {
    answered.mockRejectedValueOnce(new Error("offline"));
    relay({ id: "lost", op: "state" });
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
    expect(await ask("state")).toMatchObject({ holder: "human" });
  });

  it("is answered once per call, with the id the call came with", async () => {
    relay({ id: "a", op: "state" });
    relay({ id: "b", op: "state" });
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies.map((one) => one.id).sort()).toEqual(["a", "b"]);
  });
});

describe("the event stream", () => {
  it("is let go of when the page links another, so a reconnect does not answer twice", async () => {
    const next = new EventTarget();
    lease.link(next as EventSource);
    relay({ id: "old", op: "state" });
    await new Promise((done) => setTimeout(done, 20));
    expect(answered).not.toHaveBeenCalled();
    next.dispatchEvent(new MessageEvent("lease", { data: JSON.stringify({ id: "new", op: "state" }) }));
    await vi.waitFor(() => expect(answered).toHaveBeenCalledTimes(1));
  });

  it("is let go of on destroy", async () => {
    lease.destroy();
    relay({ id: "late", op: "state" });
    await new Promise((done) => setTimeout(done, 20));
    expect(answered).not.toHaveBeenCalled();
    // The afterEach hook destroys the mount a second time.
  });
});
