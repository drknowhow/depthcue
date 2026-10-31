import { describe, expect, it } from "vitest";
import {
  type CommandResult,
  LEASE_EXPIRE_MS,
  LEASE_RENEW_MS,
  type Lease,
  type LeaseCommand,
  type RevokeReason,
} from "../src/index.ts";
import { makeRig, random, SCENES } from "./lease-kit.ts";

const flush = async () => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

type Kind = "valid" | "stale" | "duplicate" | "wrongLease" | "wrongEpoch" | "badAction" | "outside" | "junk";
const KINDS: Kind[] = [
  "valid",
  "valid",
  "valid",
  "valid",
  "stale",
  "duplicate",
  "wrongLease",
  "wrongEpoch",
  "badAction",
  "outside",
  "junk",
];
const JUNK: unknown[] = [null, 5, "next", [], {}, { leaseId: 1 }, { action: "next" }];
const BAD_ACTIONS = ["apply", "edit", "__proto__", "constructor", "patch", "block.set"];

/**
 * One randomised session: a human and an agent act in any order while the clock runs, with hosts that throw, hang,
 * answer late or answer at once. Every step checks the rules that must hold whatever the order. The seed replays it.
 */
async function session(seed: number, steps: number): Promise<string[]> {
  const dice = random(seed);
  const violations: string[] = [];
  const note = (text: string) => violations.push(`seed ${seed}: ${text}`);
  const sent = new Map<number, string>();
  const started = new Set<number>();
  let tags = 0;

  const rig = makeRig({
    runLimitMs: 2000,
    run: (action, args, signal) => {
      const tag = (args as { tag: number }).tag;
      const state = rig.controller.state();
      if (state.holder !== "agent") {
        note(`command ${tag} started with a human in control`);
        return false;
      }
      const leaseId = state.lease.id;
      if (sent.get(tag) !== leaseId)
        note(`command ${tag} started under lease ${leaseId}, not ${sent.get(tag)}`);
      if (started.has(tag)) note(`command ${tag} started twice`);
      started.add(tag);

      const apply = () => {
        // The host's side of the contract: the signal says whether this lease is still the one out.
        const now = rig.controller.state();
        const current = now.holder === "agent" && now.lease.id === leaseId;
        if (current === signal.aborted)
          note(`command ${tag}: lease current=${current} but aborted=${signal.aborted}`);
        return signal.aborted ? false : rig.perform(action, args);
      };
      const roll = dice.next();
      if (roll < 0.03) throw new Error("the host threw");
      if (roll < 0.06) return new Promise<boolean>(() => {});
      if (roll < 0.09) return Promise.reject(new Error("the host rejected"));
      if (roll < 0.5) return apply();
      return new Promise<boolean>((resolve) => {
        rig.clock.timers.set(() => resolve(apply()), dice.int(1500));
      });
    },
  });

  const { controller, clock } = rig;
  let model: { id: string; validUntil: number; scenes: string[] } | undefined;
  let known: { id: string; epoch: number; scenes: string[] } | undefined;
  let lastAccepted: LeaseCommand | undefined;
  let sequence = 0;
  let lastEpoch = 0;
  let lastRev = 0;
  const granted: string[] = [];
  const revoked: string[] = [];
  const pending: Promise<void>[] = [];
  let settledCount = 0;

  controller.subscribe((event) => {
    if (event.type === "granted") granted.push(event.lease.id);
    if (event.type === "revoked") {
      revoked.push(event.leaseId);
      if (model?.id === event.leaseId) model = undefined;
    }
  });

  const scenesFor = () => {
    const from = dice.int(SCENES.length);
    const size = 1 + dice.int(SCENES.length);
    const chosen = new Set<string>([rig.scene]);
    for (let n = 0; n < size; n += 1) chosen.add(SCENES[(from + n) % SCENES.length] as string);
    return [...chosen];
  };

  const check = () => {
    const state = controller.state();
    if (state.epoch < lastEpoch) note(`epoch went from ${lastEpoch} to ${state.epoch}`);
    if (state.rev < lastRev) note(`rev went from ${lastRev} to ${state.rev}`);
    lastEpoch = state.epoch;
    lastRev = state.rev;
    if (model && clock.now() >= model.validUntil) model = undefined;
    if (state.holder === "agent") {
      if (!model || model.id !== state.lease.id)
        note("the agent holds a lease the presenter did not grant or renew");
      if (state.lease.expiresAt <= clock.now()) note("the agent holds an expired lease");
      if (!state.lease.scenes.includes(rig.scene))
        note(`the agent holds a lease while the deck is on ${rig.scene}`);
    } else if (model) {
      note(`the lease ${model.id} is still valid but control is with the human`);
    }
  };

  const submit = (kind: Kind) => {
    const state = controller.state();
    const body = kind === "outside" ? "goto" : dice.pick(["next", "previous", "goto", "invoke"] as const);
    const tag = ++tags;
    const scope = known?.scenes ?? SCENES;
    const inScope = dice.pick(scope);
    const outside = SCENES.filter((scene) => !scope.includes(scene));
    const args =
      body === "goto"
        ? { scene: kind === "outside" && outside.length > 0 ? dice.pick(outside) : inScope, tag }
        : body === "invoke"
          ? { block: "x", command: "play", tag }
          : { tag };
    const base: LeaseCommand = {
      leaseId: known?.id ?? "lease-none",
      epoch: known?.epoch ?? 0,
      sequence: ++sequence,
      expectedRev: state.rev,
      action: body,
      args,
    };
    let command: unknown = base;
    let mustFail = kind !== "valid";
    if (kind === "stale") {
      if (state.rev === 0) mustFail = false;
      else command = { ...base, expectedRev: state.rev - 1 };
    }
    if (kind === "duplicate") {
      if (lastAccepted) command = lastAccepted;
      else mustFail = false;
    }
    if (kind === "wrongLease") command = { ...base, leaseId: "nope" };
    if (kind === "wrongEpoch") command = { ...base, epoch: base.epoch + 1 };
    if (kind === "badAction") command = { ...base, action: dice.pick(BAD_ACTIONS) };
    if (kind === "junk") command = dice.pick(JUNK);
    if (kind === "outside" && outside.length === 0) mustFail = false;
    const named = (command as { args?: { tag?: number }; leaseId?: string } | null)?.args?.tag;
    if (typeof named === "number") sent.set(named, (command as LeaseCommand).leaseId);
    const wasCurrent = state.holder === "agent" && state.lease.id === base.leaseId;
    const promise = controller.submit(command).then((result: CommandResult) => {
      settledCount += 1;
      if (!result.ok) return;
      if (mustFail) note(`a ${kind} command was accepted`);
      if (!wasCurrent)
        note(`a command was accepted for lease ${base.leaseId}, which was not out when it was sent`);
      lastAccepted = command as LeaseCommand;
    });
    pending.push(promise);
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = dice.next();
    const before = rig.index;
    if (roll < 0.1) {
      const scenes = scenesFor();
      try {
        const lease: Lease = controller.grant({ scenes });
        model = { id: lease.id, validUntil: lease.expiresAt, scenes };
        known = { id: lease.id, epoch: lease.epoch, scenes };
      } catch {
        note("a grant that included the scene on screen was refused");
      }
    } else if (roll < 0.14) {
      const outsideScene = SCENES.filter((scene) => scene !== rig.scene);
      let threw = false;
      try {
        controller.grant({ scenes: outsideScene });
      } catch {
        threw = true;
      }
      if (!threw) note("a grant that left out the scene on screen was accepted");
    } else if (roll < 0.3) {
      const expected = model !== undefined && clock.now() < model.validUntil;
      const result = controller.renew({ leaseId: known?.id, epoch: known?.epoch });
      const wanted = expected && model?.id === known?.id;
      if (result.ok !== wanted) note(`a renewal answered ok=${result.ok}, expected ${wanted}`);
      if (result.ok && model) model.validUntil = result.expiresAt;
    } else if (roll < 0.33) {
      if (controller.renew(dice.pick(JUNK)).ok) note("a junk renewal was accepted");
    } else if (roll < 0.45) {
      rig.move(dice.int(SCENES.length));
      if (model && !model.scenes.includes(rig.scene)) model = undefined;
    } else if (roll < 0.49) {
      controller.takeover();
      model = undefined;
      if (rig.index !== before) note("taking control back moved the deck");
    } else if (roll < 0.51) {
      controller.disconnect();
      model = undefined;
      if (rig.index !== before) note("a disconnect moved the deck");
    } else if (roll < 0.53) {
      controller.agentError();
      model = undefined;
      if (rig.index !== before) note("an agent error moved the deck");
    } else if (roll < 0.8) {
      submit(dice.pick(KINDS));
    } else if (roll < 0.97) {
      // Time passes. Mostly in small steps; sometimes the event loop stalls and no timer runs.
      const ms = dice.int(2500);
      if (dice.chance(0.1)) clock.jump(ms + 3000);
      else clock.advance(ms);
    } else {
      clock.advance(dice.int(7000));
    }
    await flush();
    check();
  }

  controller.takeover();
  model = undefined;
  clock.advance(100_000);
  await flush();
  check();
  if (settledCount !== pending.length) note(`${pending.length - settledCount} commands were never answered`);
  if (clock.pending !== 0) note(`${clock.pending} timers are still waiting`);
  const state = controller.state();
  if (state.holder !== "human") note("the lease survived a takeover and a long wait");
  for (const id of granted) {
    const count = revoked.filter((one) => one === id).length;
    if (count !== 1) note(`lease ${id} was revoked ${count} times`);
  }
  return violations;
}

describe("fault injection: random orders of grants, renewals, moves, faults and time", () => {
  it("keeps every rule through a few hundred seeded sessions", async () => {
    const found: string[] = [];
    for (let seed = 1; seed <= 400 && found.length < 10; seed += 1) found.push(...(await session(seed, 300)));
    expect(found).toEqual([]);
  }, 120_000);

  it("replays the same session from the same seed", async () => {
    expect(await session(7, 200)).toEqual(await session(7, 200));
  });
});

describe("a simulated 30-minute session", () => {
  const TICK = 100;
  const SESSION = 30 * 60_000;
  const SECTION = ["a", "b", "c"];
  const FAULTS = ["stall", "takeover", "throw", "hang", "disconnect", "exit", "regrant"] as const;

  it("hands control back cleanly after a fault every minute, and never loses the lease by itself", async () => {
    const dice = random(1800);
    const problems: string[] = [];
    let mode: "run" | "throw" | "hang" = "run";
    let performed = 0;
    const rig = makeRig({
      run: (action, args, signal) => {
        const state = rig.controller.state();
        if (state.holder !== "agent") {
          problems.push("a command started with a human in control");
          return false;
        }
        const leaseId = state.lease.id;
        if (mode === "throw") {
          mode = "run";
          throw new Error("the page broke");
        }
        if (mode === "hang") {
          mode = "run";
          return new Promise<boolean>(() => {});
        }
        return new Promise<boolean>((resolve) => {
          rig.clock.timers.set(() => {
            const now = rig.controller.state();
            const current = now.holder === "agent" && now.lease.id === leaseId;
            if (current === signal.aborted) problems.push("the signal and the lease disagree");
            if (signal.aborted) return resolve(false);
            performed += 1;
            resolve(rig.perform(action, args));
          }, dice.int(300));
        });
      },
    });
    const { controller, clock } = rig;

    const reasons = new Set<RevokeReason>();
    const refusals = new Map<string, number>();
    let accepted = 0;
    controller.subscribe((event) => {
      if (event.type === "revoked") reasons.add(event.reason);
      if (event.type === "command") {
        if (event.result.ok) accepted += 1;
        else refusals.set(event.result.code, (refusals.get(event.result.code) ?? 0) + 1);
      }
    });

    let lease: Lease | undefined;
    let rev = 0;
    let sequence = 0;
    let stalledUntil = -1;
    let stubbornUntil = -1;
    let regrantAt = 0;
    let lastCommand: LeaseCommand | undefined;
    let replayAt = -1;
    let spurious = 0;
    let drift = 0;
    const faultAt = (k: number) => k * 60_000;
    let nextFault = 1;

    const grant = () => {
      if (!SECTION.includes(rig.scene)) rig.move(0);
      lease = controller.grant({ scenes: SECTION });
      rev = controller.state().rev;
    };
    grant();

    const send = (action: "next" | "previous") => {
      if (!lease) return;
      const command: LeaseCommand = {
        leaseId: lease.id,
        epoch: lease.epoch,
        sequence: ++sequence,
        expectedRev: rev,
        action,
      };
      lastCommand = command;
      void controller.submit(command).then((result) => {
        rev = result.rev;
      });
    };

    for (let t = 0; t < SESSION; t += TICK) {
      // While the human holds control no command can be running, so the deck may only move when they move it.
      const holder = controller.state().holder;
      const parked = rig.index;
      clock.advance(TICK);
      await flush();
      if (holder === "human" && rig.index !== parked) drift += 1;
      const now = t + TICK;

      if (now >= faultAt(nextFault) && nextFault < 30) {
        const fault = FAULTS[(nextFault - 1) % FAULTS.length];
        nextFault += 1;
        if (fault === "stall") {
          stalledUntil = now + 4000;
          regrantAt = now + 6000;
        } else if (fault === "takeover") {
          controller.takeover();
          stubbornUntil = now + 5000;
          regrantAt = now + 5000;
          replayAt = now + 6000;
        } else if (fault === "throw") {
          mode = "throw";
          regrantAt = now + 5000;
        } else if (fault === "hang") {
          mode = "hang";
          regrantAt = now + 9000;
        } else if (fault === "disconnect") {
          controller.disconnect();
          regrantAt = now + 2000;
        } else if (fault === "exit") {
          rig.move(4);
          stubbornUntil = now + 3000;
          regrantAt = now + 3000;
        } else {
          grant();
          regrantAt = Number.POSITIVE_INFINITY;
        }
      }

      if (lease && now % LEASE_RENEW_MS === 0 && now >= stalledUntil) {
        const renewed = controller.renew({ leaseId: lease.id, epoch: lease.epoch });
        if (!renewed.ok && now >= stubbornUntil) lease = undefined;
      }
      if (lease && now % 2500 === 0)
        send(
          rig.index === 0 ? "next" : rig.index === 2 ? "previous" : dice.pick(["next", "previous"] as const),
        );
      if (replayAt === now && lastCommand) {
        const replay = await controller.submit(lastCommand);
        if (replay.ok) problems.push("a delayed command from an earlier lease was accepted");
        replayAt = -1;
      }

      const state = controller.state();
      if (state.holder === "human" && regrantAt <= now) {
        grant();
        regrantAt = Number.POSITIVE_INFINITY;
        stalledUntil = -1;
      }
      // Eight seconds after a fault, until the next one, nothing may take the lease away.
      const sinceFault = now % 60_000;
      if (sinceFault >= 10_000 && sinceFault < 59_000 && state.holder !== "agent") spurious += 1;
      if (clock.pending > 4) problems.push(`${clock.pending} timers are waiting at ${now} ms`);
    }

    expect(problems).toEqual([]);
    expect(spurious).toBe(0);
    expect(drift).toBe(0);
    expect(accepted).toBeGreaterThan(400);
    expect(performed).toBeGreaterThan(400);
    expect([...reasons].sort()).toEqual(
      ["agent-error", "disconnect", "expired", "replaced", "section-exit", "takeover"].sort(),
    );
    expect(refusals.get("expired") ?? 0).toBeGreaterThan(0);
    expect(refusals.get("stale-epoch") ?? 0).toBeGreaterThan(0);
    expect(LEASE_EXPIRE_MS).toBeGreaterThan(LEASE_RENEW_MS);

    controller.takeover();
    clock.advance(60_000);
    await flush();
    expect(clock.pending).toBe(0);
    expect(controller.state().holder).toBe("human");
  }, 120_000);
});
