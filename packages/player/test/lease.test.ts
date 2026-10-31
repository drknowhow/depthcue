// @vitest-environment happy-dom
import type { CommandResult, LeaseCommand, LeaseEvent } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LeaseMount, mountLease } from "../src/lease.ts";
import type { PlayerSource } from "../src/load.ts";
import { mountPlayer, type Player } from "../src/player.ts";
import { demoSource, sceneWith } from "./helpers.ts";

let host: HTMLElement;
let player: Player | undefined;
let lease: LeaseMount | undefined;
let current: PlayerSource;
let sequence = 0;

beforeEach(() => {
  history.replaceState(null, "", "/");
  host = document.createElement("div");
  document.body.append(host);
  sequence = 0;
});

afterEach(() => {
  lease?.destroy();
  player?.destroy();
  lease = undefined;
  player = undefined;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface MountOptions {
  source?: PlayerSource;
  /** Whether a click that a script made can hand over control. Default true, so tests can click. */
  scripted?: boolean;
  noticeMs?: number;
}

function mount(options: MountOptions = {}) {
  current = options.source ?? demoSource();
  player = mountPlayer(host, current, { reducedMotion: true, onChange: (state) => lease?.changed(state) });
  lease = mountLease({
    player,
    source: () => current,
    allowScriptedGrant: options.scripted ?? true,
    ...(options.noticeMs === undefined ? {} : { noticeMs: options.noticeMs }),
  });
  return { player, lease };
}

/** A deck of scenes named s0, s1, ... with the given leads. */
function deckOf(leads: ReadonlyArray<"human" | "agent" | "shared" | undefined>): PlayerSource {
  const base = demoSource();
  const scenes = leads.map((lead, index) =>
    sceneWith({ id: `s${index}`, ...(lead === undefined ? {} : { lead }) }),
  );
  return { ...base, deck: { ...base.deck, scenes: scenes.map((scene) => scene.id) }, scenes };
}

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

const control = (selector: string) => host.querySelector<HTMLButtonElement>(selector) as HTMLButtonElement;
const grant = () => control('[data-lease-action="grant"]');
const takeOver = () => control('[data-lease-action="takeover"]');
const chip = () => host.querySelector<HTMLElement>(".dc-lease") as HTMLElement;
const pill = () => host.querySelector(".dc-lease-text")?.textContent;
const spoken = () => host.querySelector('.dc-lease [role="status"]')?.textContent;
const count = () => host.querySelector(".dc-count")?.textContent;
const sceneId = () => host.querySelector<HTMLElement>(".dc-scene")?.dataset.scene;
const holder = () => lease?.controller.state().holder;

/** A well-formed command for the lease that is out now. */
function command(overrides: Partial<LeaseCommand> = {}): LeaseCommand {
  const state = lease?.controller.state();
  if (state?.holder !== "agent") throw new Error("No lease is out.");
  return {
    leaseId: state.lease.id,
    epoch: state.lease.epoch,
    sequence: ++sequence,
    expectedRev: state.rev,
    action: "next",
    ...overrides,
  };
}

const send = (overrides: Partial<LeaseCommand> = {}): Promise<CommandResult> =>
  (lease as LeaseMount).agent.submit(command(overrides));

/** Mounts, moves to a scene by hand and hands control to the agent from there. */
function leased(scene: number, options: MountOptions = {}) {
  const mounted = mount(options);
  if (scene > 0) mounted.player.go({ scene, step: 0 });
  grant().click();
  expect(holder()).toBe("agent");
  return mounted;
}

describe("the chip", () => {
  it("sits in the controls bar before the read button and starts with the person presenting", () => {
    mount();
    const bar = control(".dc-controls");
    expect(chip().parentElement).toBe(bar);
    expect(chip().nextElementSibling).toBe(control('[data-action="read"]'));
    expect(chip().dataset.holder).toBe("human");
    expect(pill()).toBe("You present");
    expect(grant().hidden).toBe(false);
    expect(takeOver().hidden).toBe(true);
  });

  it("says who is presenting out loud, and keeps the full sentence in the title", () => {
    leased(1);
    expect(chip().dataset.holder).toBe("agent");
    expect(pill()).toBe("Agent presenting");
    expect(spoken()).toBe("The agent is presenting this scene. Press Escape to take over.");
    expect(chip().title).toBe(spoken());
    expect(grant().hidden).toBe(true);
    expect(takeOver().hidden).toBe(false);
    expect(host.querySelector(".dc-lease-text")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("hides the hand-over button in read mode and brings it back in present mode", () => {
    const { player } = mount();
    player.setMode("read");
    expect(grant().hidden).toBe(true);
    player.setMode("present");
    expect(grant().hidden).toBe(false);
  });

  it("is removed on destroy, and the keys it watched stop doing anything", () => {
    leased(1);
    const mounted = lease as LeaseMount;
    const takeover = vi.spyOn(mounted.controller, "takeover");
    mounted.destroy();
    // The player goes on calling the page's onChange; the page drops its reference, as a real one would.
    lease = undefined;
    expect(host.querySelector(".dc-lease")).toBeNull();
    press("Escape");
    control('[data-action="next"]').click();
    expect(takeover).not.toHaveBeenCalled();
  });

  it("leaves no timer behind on destroy while an agent holds control", () => {
    vi.useFakeTimers();
    mount();
    const idle = vi.getTimerCount();
    grant().click();
    expect(vi.getTimerCount()).toBeGreaterThan(idle);
    (lease as LeaseMount).destroy();
    expect(vi.getTimerCount()).toBe(idle);
  });

  it("leaves no timer behind on destroy, even while a reason is showing", () => {
    vi.useFakeTimers();
    mount();
    const idle = vi.getTimerCount();
    grant().click();
    press("Escape");
    expect(vi.getTimerCount()).toBeGreaterThan(idle);
    (lease as LeaseMount).destroy();
    expect(vi.getTimerCount()).toBe(idle);
  });
});

describe("handing over", () => {
  it("ignores a click that a script made unless the page was told to accept one", () => {
    mount({ scripted: false });
    grant().click();
    expect(holder()).toBe("human");
    expect(pill()).toBe("You present");
  });

  it("ignores a click on the chip's own padding", () => {
    mount();
    chip().click();
    expect(holder()).toBe("human");
  });

  it("gives the agent the run of neighbouring scenes that share the lead of the one on screen", () => {
    mount({ source: deckOf(["human", "human", "agent", "agent", "human"]) });
    (player as Player).go({ scene: 1, step: 0 });
    grant().click();
    const state = (lease as LeaseMount).controller.state();
    expect(state.holder === "agent" && state.lease.scenes).toEqual(["s0", "s1"]);
    expect(state.holder === "agent" && state.lease.actions).toEqual(["next", "previous", "goto", "invoke"]);
    expect(spoken()).toBe("The agent is presenting 2 scenes. Press Escape to take over.");
  });

  it("treats a scene with no lead as human-led", () => {
    mount({ source: deckOf([undefined, "human", "agent"]) });
    grant().click();
    const state = (lease as LeaseMount).controller.state();
    expect(state.holder === "agent" && state.lease.scenes).toEqual(["s0", "s1"]);
  });

  it("scopes an agent-led scene to that scene and the agent-led scenes next to it", () => {
    leased(1);
    const state = (lease as LeaseMount).controller.state();
    expect(state.holder === "agent" && state.lease.scenes).toEqual(["demand"]);
  });

  it("says so for a moment when the section is too big to hand over, then goes back", () => {
    vi.useFakeTimers();
    mount({ source: deckOf(Array.from({ length: 1001 }, () => "human")), noticeMs: 4000 });
    grant().click();
    expect(holder()).toBe("human");
    expect(pill()).toBe("Could not hand over");
    expect(spoken()).toMatch(/1000 scenes/);
    vi.advanceTimersByTime(3999);
    expect(pill()).toBe("Could not hand over");
    vi.advanceTimersByTime(1);
    expect(pill()).toBe("You present");
  });

  it("gives an agent nothing to call that would hand over control", () => {
    mount();
    expect(Object.keys((lease as LeaseMount).agent).sort()).toEqual(["release", "renew", "state", "submit"]);
  });
});

describe("what the agent can do", () => {
  it("moves through the steps of its scene, and the count follows", async () => {
    leased(1);
    const start = count();
    expect((await send()).ok).toBe(true);
    const first = count();
    expect(first).not.toBe(start);
    expect((await send()).ok).toBe(true);
    expect(count()).not.toBe(first);
    expect(sceneId()).toBe("demand");
    expect(holder()).toBe("agent");
  });

  it("is refused at the edge of its section and the deck stays where it was", async () => {
    leased(1);
    await send();
    await send();
    const before = count();
    const result = await send();
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("out-of-scope");
    expect(count()).toBe(before);
    expect(sceneId()).toBe("demand");
    expect(holder()).toBe("agent");
  });

  it("cannot go back out of its section either", async () => {
    leased(1);
    const result = await send({ action: "previous" });
    expect(!result.ok && result.code).toBe("out-of-scope");
    expect(sceneId()).toBe("demand");
  });

  it("goes to a step of its own scene, and not to another scene or one that does not exist", async () => {
    leased(1);
    expect((await send({ action: "goto", args: { scene: "demand", step: 2 } })).ok).toBe(true);
    expect((player as Player).state.position).toEqual({ scene: 1, step: 2 });
    const outside = await send({ action: "goto", args: { scene: "method" } });
    expect(!outside.ok && outside.code).toBe("out-of-scope");
    const nowhere = await send({ action: "goto", args: { scene: "nowhere" } });
    expect(!nowhere.ok && nowhere.code).toBe("unknown-target");
    expect((player as Player).state.position).toEqual({ scene: 1, step: 2 });
  });

  it("reports a goto that changes nothing as not run", async () => {
    leased(1);
    const result = await send({ action: "goto", args: { scene: "demand", step: 0 } });
    expect(!result.ok && result.code).toBe("not-run");
  });

  it("runs a block command once the module has had its turn", async () => {
    leased(1);
    const mounted = player as Player;
    const settled = vi.spyOn(mounted, "settled");
    const invoke = vi.spyOn(mounted, "invoke").mockReturnValue(true);
    const result = await send({
      action: "invoke",
      args: { block: "chart-demand", command: "highlight", args: { series: "b" } },
    });
    expect(result.ok).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("chart-demand", "highlight", { series: "b" });
  });

  it("cannot reach a block that is not in the scene on screen", async () => {
    leased(1);
    const invoke = vi.spyOn(player as Player, "invoke");
    const result = await send({ action: "invoke", args: { block: "method-body", command: "highlight" } });
    expect(!result.ok && result.code).toBe("unknown-target");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not run a block command if control left while the module was loading", async () => {
    leased(1);
    const mounted = player as Player;
    let release: () => void = () => {};
    vi.spyOn(mounted, "settled").mockReturnValue(new Promise<void>((done) => (release = done)));
    const invoke = vi.spyOn(mounted, "invoke").mockReturnValue(true);
    const pending = send({ action: "invoke", args: { block: "chart-demand", command: "highlight" } });
    await Promise.resolve();
    (lease as LeaseMount).controller.takeover();
    release();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is not taken off the deck by its own moves", async () => {
    leased(1);
    await send();
    await send({ action: "previous" });
    expect(holder()).toBe("agent");
    expect((lease as LeaseMount).controller.state().holder).toBe("agent");
  });

  it("gives control back, with a reason, when it leaves", () => {
    leased(1);
    expect((lease as LeaseMount).agent.release()).toBe(true);
    expect(holder()).toBe("human");
    expect(pill()).toBe("Agent left");
    expect(spoken()).toBe("The agent disconnected, so control is back with you.");
  });

  it("keeps control while it renews, and loses it three seconds after it stops", () => {
    vi.useFakeTimers();
    leased(1);
    const mounted = lease as LeaseMount;
    const renew = () => {
      const state = mounted.controller.state();
      if (state.holder !== "agent") throw new Error("No lease is out.");
      return mounted.agent.renew({ leaseId: state.lease.id, epoch: state.lease.epoch });
    };
    for (let beat = 0; beat < 5; beat += 1) {
      vi.advanceTimersByTime(1000);
      expect(renew().ok).toBe(true);
    }
    expect(holder()).toBe("agent");
    vi.advanceTimersByTime(3000);
    expect(holder()).toBe("human");
    expect(pill()).toBe("Agent timed out");
    expect(spoken()).toBe("The agent stopped responding, so control is back with you.");
  });

  it("loses control when anything but the agent moves the deck", () => {
    leased(1);
    (player as Player).go({ scene: 2, step: 0 });
    expect(holder()).toBe("human");
    expect(pill()).toBe("You took over");
  });

  it("still notices the person after the agent has moved the deck", async () => {
    leased(1);
    await send();
    expect(holder()).toBe("agent");
    (player as Player).go({ scene: 2, step: 0 });
    expect(holder()).toBe("human");
    expect(pill()).toBe("You took over");
  });

  it("keeps control through a deck edit that moves its scene to another place in the deck", () => {
    const { player } = leased(1);
    const demo = demoSource();
    current = { ...demo, scenes: [sceneWith({ id: "added" }), ...demo.scenes] };
    player.update(current);
    expect(sceneId()).toBe("demand");
    expect(holder()).toBe("agent");
  });

  it("does not announce the same sentence again each time the deck moves", async () => {
    leased(1);
    const node = host.querySelector('.dc-lease [role="status"]')?.firstChild;
    expect(node).toBeTruthy();
    await send();
    await send();
    expect(host.querySelector('.dc-lease [role="status"]')?.firstChild).toBe(node);
  });

  it("goes back to the person when the mode changes by some other route", () => {
    leased(1);
    (player as Player).setMode("read");
    expect(holder()).toBe("human");
  });

  it("is not disturbed by the person opening the notes", () => {
    leased(1);
    const changed = vi.spyOn((lease as LeaseMount).controller, "changed");
    (player as Player).toggleNotes();
    expect(changed).not.toHaveBeenCalled();
    expect(holder()).toBe("agent");
    (player as Player).next();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("the person takes over", () => {
  const reasons = (events: LeaseEvent[]) =>
    events.flatMap((event) => (event.type === "revoked" ? [event.reason] : []));

  // Each key is pressed where the player would do nothing with it, so only the page's own handler can react:
  // the person pressing a navigation key wants control, whether or not the deck has anywhere to go.
  it.each([
    ["Escape", 1],
    ["r", 1],
    ["ArrowLeft", 0],
    ["PageUp", 0],
    ["Home", 0],
    ["ArrowRight", 2],
    ["PageDown", 2],
    [" ", 2],
    ["Enter", 2],
    ["End", 2],
  ])("on %j with the deck at scene %i", (key, at) => {
    leased(at);
    const events: LeaseEvent[] = [];
    (lease as LeaseMount).controller.subscribe((event) => events.push(event));
    press(key);
    expect(holder()).toBe("human");
    expect(reasons(events)).toEqual(["takeover"]);
    expect(pill()).toBe("You took over");
    expect(spoken()).toBe("You took control back.");
  });

  it("before a key moves the deck, so the agent never answers it", () => {
    leased(1);
    const seen: Array<string | null | undefined> = [];
    (lease as LeaseMount).controller.subscribe((event) => {
      if (event.type === "revoked") seen.push(count());
    });
    const before = count();
    press("ArrowRight");
    expect(seen).toEqual([before]);
    expect(count()).not.toBe(before);
  });

  it.each([
    ["the r key", () => press("r")],
    ["the read button", () => control('[data-action="read"]').click()],
  ])("and before %s changes the mode", (_name, act) => {
    leased(1);
    const seen: string[] = [];
    (lease as LeaseMount).controller.subscribe((event) => {
      if (event.type === "revoked") seen.push((player as Player).state.mode);
    });
    act();
    expect(seen).toEqual(["present"]);
    expect((player as Player).state.mode).toBe("read");
  });

  it.each([
    ["the notes key", () => press("n")],
    ["a key with Ctrl held", () => press("ArrowRight", { ctrlKey: true })],
    ["a key with Alt held", () => press("ArrowRight", { altKey: true })],
    ["a key with Meta held", () => press("Escape", { metaKey: true })],
    ["a key the player does not use", () => press("x")],
    [
      "an arrow key on a video",
      () => press("ArrowRight", {}, host.appendChild(document.createElement("video"))),
    ],
    ["space on a button", () => press(" ", {}, control('[data-action="notes"]'))],
    ["space on a video", () => press(" ", {}, host.appendChild(document.createElement("video")))],
    [
      "enter on a link",
      () => press("Enter", {}, host.appendChild(Object.assign(document.createElement("a"), { href: "#x" }))),
    ],
    [
      "a key typed into a field",
      () => press("ArrowRight", {}, host.appendChild(document.createElement("input"))),
    ],
  ])("but not on %s", (_name, act) => {
    leased(1);
    act();
    expect(holder()).toBe("agent");
  });

  it("but not on a key that something earlier in the page already handled", () => {
    leased(1);
    window.addEventListener("keydown", (event) => event.preventDefault(), { capture: true, once: true });
    press("ArrowRight");
    expect(holder()).toBe("agent");
  });

  it.each([
    ["next", 2],
    ["previous", 0],
    ["read", 1],
  ])("on the %s button, even where it has nowhere to go", (action, at) => {
    leased(at);
    control(`[data-action="${action}"]`).click();
    expect(holder()).toBe("human");
    expect(pill()).toBe("You took over");
  });

  it("but not on the notes button", () => {
    leased(1);
    control('[data-action="notes"]').click();
    expect(holder()).toBe("agent");
  });

  it("on the take over button", () => {
    leased(1);
    takeOver().click();
    expect(holder()).toBe("human");
    expect(takeOver().hidden).toBe(true);
    expect(grant().hidden).toBe(false);
  });

  it.each([["hashchange"], ["popstate"]])("on the browser's %s, once the player has followed it", (type) => {
    leased(1);
    history.replaceState(null, "", "#/method/0");
    window.dispatchEvent(new Event(type));
    expect(sceneId()).toBe("method");
    expect(holder()).toBe("human");
    expect(pill()).toBe("You took over");
  });

  it("and the agent's late commands are refused with the reason", async () => {
    leased(1);
    const late = command();
    press("Escape");
    const result = await (lease as LeaseMount).agent.submit(late);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("stale-epoch");
  });

  it("and can hand over again from where they are", () => {
    leased(1);
    press("Escape");
    expect(grant().hidden).toBe(false);
    grant().click();
    expect(holder()).toBe("agent");
    expect(pill()).toBe("Agent presenting");
  });

  it("and the reason stays six seconds when the page gives no other time", () => {
    vi.useFakeTimers();
    leased(1);
    press("Escape");
    vi.advanceTimersByTime(5999);
    expect(pill()).toBe("You took over");
    vi.advanceTimersByTime(1);
    expect(pill()).toBe("You present");
  });

  it("and a second reason gets its own full time, not what was left of the first", () => {
    vi.useFakeTimers();
    leased(1, { noticeMs: 6000 });
    press("Escape");
    grant().click();
    vi.advanceTimersByTime(2000);
    press("Escape");
    vi.advanceTimersByTime(4500);
    expect(pill()).toBe("You took over");
    vi.advanceTimersByTime(1500);
    expect(pill()).toBe("You present");
  });

  it("and the reason fades back to the person presenting", () => {
    vi.useFakeTimers();
    leased(1, { noticeMs: 2500 });
    press("Escape");
    expect(pill()).toBe("You took over");
    vi.advanceTimersByTime(2499);
    expect(pill()).toBe("You took over");
    vi.advanceTimersByTime(1);
    expect(pill()).toBe("You present");
  });

  it("and a new hand-over shows the agent presenting while the reason would still be on screen", () => {
    leased(1);
    press("Escape");
    expect(pill()).toBe("You took over");
    grant().click();
    expect(pill()).toBe("Agent presenting");
  });
});

describe("a deck that changes under it", () => {
  it("finds a scene added after it mounted, and refuses it as out of scope rather than unknown", async () => {
    const { player } = leased(0, { source: deckOf(["human", "human", "human"]) });
    current = deckOf(["human", "human", "human", "human"]);
    player.update(current);
    const state = (lease as LeaseMount).controller.state();
    expect(state.holder === "agent" && state.lease.scenes).toEqual(["s0", "s1", "s2"]);
    const result = await send({ action: "goto", args: { scene: "s3" } });
    expect(!result.ok && result.code).toBe("out-of-scope");
  });
});
