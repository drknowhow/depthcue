import { describe, expect, it, vi } from "vitest";
import {
  type CommandResult,
  createLeaseController,
  LEASE_ACTIONS,
  LEASE_EXPIRE_MS,
  LEASE_RENEW_MS,
  type LeaseCommand,
  type LeaseEvent,
  REVOKE_TEXT,
  type Rejection,
  type RevokeReason,
} from "../src/index.ts";
import { deferred, makeRig, SCENES } from "./lease-kit.ts";

const code = (result: CommandResult) => (result.ok ? "ok" : result.code);

describe("granting", () => {
  it("starts with the human in control and nothing leased", () => {
    const rig = makeRig();
    expect(rig.controller.state()).toEqual({ holder: "human", rev: 0, epoch: 0 });
  });

  it("hands over a scoped lease that says when it runs out", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: ["a", "b", "c"] });
    expect(lease).toEqual({
      id: "lease-1",
      epoch: 0,
      expiresAt: rig.clock.now() + LEASE_EXPIRE_MS,
      scenes: ["a", "b", "c"],
      actions: [...LEASE_ACTIONS],
    });
    expect(rig.controller.state()).toMatchObject({ holder: "agent", lease });
  });

  it("refuses a grant that cannot work, and leaves the lease already out alone", () => {
    const rig = makeRig();
    const first = rig.controller.grant({ scenes: SCENES });
    expect(() => rig.controller.grant({ scenes: [] })).toThrow(RangeError);
    expect(() => rig.controller.grant({ scenes: ["b", "c"] })).toThrow(/scene on screen/);
    expect(() => rig.controller.grant({ scenes: ["a", 5 as never] })).toThrow(RangeError);
    const crowd = (size: number) => ["a", ...Array.from({ length: size - 1 }, (_, i) => `s${i}`)];
    expect(() => rig.controller.grant({ scenes: crowd(1001) })).toThrow(/at most 1000/);
    expect(() => rig.controller.grant({ scenes: ["a", "s".repeat(129)] })).toThrow(/at most 1000/);
    expect(() => rig.controller.grant({ scenes: ["a"], actions: [] })).toThrow(/only these actions/);
    expect(() => rig.controller.grant({ scenes: ["a"], actions: ["next", "apply" as never] })).toThrow(
      /only these actions/,
    );
    expect(rig.controller.state()).toMatchObject({ holder: "agent", epoch: 0, lease: { id: first.id } });
  });

  it("accepts a section of a thousand scenes", () => {
    const rig = makeRig();
    const scenes = ["a", ...Array.from({ length: 999 }, (_, i) => `s${i}`)];
    expect(rig.controller.grant({ scenes }).scenes).toHaveLength(1000);
  });

  it("lists each scene and action once", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: ["a", "a", "b"], actions: ["next", "next", "goto"] });
    expect(lease.scenes).toEqual(["a", "b"]);
    expect(lease.actions).toEqual(["next", "goto"]);
  });

  it("replaces a lease that is already out, so the first agent is no longer in charge", async () => {
    const rig = makeRig();
    const first = rig.controller.grant({ scenes: SCENES });
    const old = rig.command();
    const second = rig.controller.grant({ scenes: SCENES });
    expect(second.id).not.toBe(first.id);
    expect(second.epoch).toBe(1);
    expect(code(await rig.controller.submit(old))).toBe("unknown-lease");
    expect(rig.runs).toEqual([]);
    expect(rig.controller.state()).toMatchObject({ holder: "agent", epoch: 1 });
  });

  it("can hand over again after a lease has run out", () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.clock.advance(LEASE_EXPIRE_MS);
    expect(rig.controller.state().holder).toBe("human");
    const lease = rig.controller.grant({ scenes: SCENES });
    expect(lease.epoch).toBe(1);
    expect(rig.controller.state().holder).toBe("agent");
  });
});

describe("running commands", () => {
  it("runs a command, moves the deck and reports where things stand", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const result = await rig.controller.submit(rig.command({ action: "next" }));
    expect(result).toEqual({ ok: true, rev: 1, epoch: 0, holder: "agent" });
    expect(rig.scene).toBe("b");
    expect(rig.runs).toHaveLength(1);
    expect(rig.runs[0]).toMatchObject({ action: "next", scene: "a", leaseId: "lease-1" });
  });

  it("accepts every action in the list with the arguments each one takes", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const sent = [
      { action: "goto", args: { scene: "c" } },
      { action: "goto", args: { scene: "d", step: 2 } },
      { action: "previous" },
      { action: "previous", args: {} },
      { action: "invoke", args: { block: "intro-clip", command: "seek", args: { cue: "sub" } } },
      { action: "next" },
    ];
    const codes: string[] = [];
    for (const one of sent) codes.push(code(await rig.controller.submit(rig.command(one))));
    expect(codes).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(rig.scene).toBe("c");
  });

  it("says there was nothing to do, and keeps the lease", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.move(4);
    const result = await rig.controller.submit(rig.command({ action: "next" }));
    expect(result).toMatchObject({ ok: false, code: "not-run", holder: "agent" });
    expect(rig.controller.state().holder).toBe("agent");
  });

  it("runs commands one at a time, in the order they came", async () => {
    const gates = [deferred<boolean>(), deferred<boolean>(), deferred<boolean>()];
    const started: number[] = [];
    let call = 0;
    const rig = makeRig({
      run: () => {
        const n = call++;
        started.push(n);
        return (gates[n] as ReturnType<typeof deferred<boolean>>).promise;
      },
    });
    rig.controller.grant({ scenes: SCENES });
    const invoke = { action: "invoke", args: { block: "x", command: "play" } };
    const results = gates.map(() => rig.controller.submit(rig.command(invoke)));
    await Promise.resolve();
    expect(started).toEqual([0]);
    (gates[0] as ReturnType<typeof deferred<boolean>>).resolve(true);
    await results[0];
    expect(started).toEqual([0, 1]);
    (gates[1] as ReturnType<typeof deferred<boolean>>).resolve(true);
    (gates[2] as ReturnType<typeof deferred<boolean>>).resolve(false);
    expect((await Promise.all(results)).map(code)).toEqual(["ok", "ok", "not-run"]);
    expect(started).toEqual([0, 1, 2]);
  });
});

describe("what a command has to get right", () => {
  const goto = (scene: unknown, extra: object = {}) => ({ action: "goto", args: { scene, ...extra } });
  const invoke = (args: unknown) => ({ action: "invoke", args });

  const refused: [string, Partial<LeaseCommand> | ((c: LeaseCommand) => unknown), Rejection][] = [
    ["a lease id that is not the one out", { leaseId: "lease-9" }, "unknown-lease"],
    ["an epoch from another lease", (c) => ({ ...c, epoch: c.epoch + 1 }), "stale-epoch"],
    ["an action that edits the deck", { action: "apply" }, "unknown-action"],
    ["an edit by another name", { action: "block.set" }, "unknown-action"],
    ["an action called edit", { action: "edit" }, "unknown-action"],
    ["an action named after Object.prototype", { action: "__proto__" }, "unknown-action"],
    ["another inherited name", { action: "constructor" }, "unknown-action"],
    ["toString as an action", { action: "toString" }, "unknown-action"],
    ["an action in the wrong case", { action: "NEXT" }, "unknown-action"],
    ["an action with a space after it", { action: "next " }, "unknown-action"],
    ["goto with no arguments", { action: "goto" }, "malformed"],
    ["goto without a scene", { action: "goto", args: {} }, "malformed"],
    ["goto with a scene that is not text", goto(7), "malformed"],
    ["goto with a negative step", goto("b", { step: -1 }), "malformed"],
    ["goto with a step that is not whole", goto("b", { step: 1.5 }), "malformed"],
    ["goto with a step given as text", goto("b", { step: "2" }), "malformed"],
    ["invoke with no arguments", { action: "invoke" }, "malformed"],
    ["invoke with no command", invoke({ block: "x" }), "malformed"],
    ["invoke with no block", invoke({ command: "play" }), "malformed"],
    ["invoke with an empty command", invoke({ block: "x", command: "" }), "malformed"],
    ["next with arguments that are a list", { action: "next", args: [] }, "malformed"],
    ["next with null arguments", { action: "next", args: null }, "malformed"],
    ["a scene that does not exist", goto("zzz"), "unknown-target"],
    ["a scene that is not in the section", goto("e"), "out-of-scope"],
    ["a scene named after Object.prototype", goto("__proto__"), "unknown-target"],
  ];

  it.each(refused)("refuses %s, and does nothing", async (_label, change, expected) => {
    const rig = makeRig();
    rig.controller.grant({ scenes: ["a", "b", "c"] });
    const base = rig.command();
    const sent = typeof change === "function" ? change(base) : { ...base, ...change };
    const result = await rig.controller.submit(sent);
    expect(code(result)).toBe(expected);
    expect(result.ok ? "" : result.message).not.toBe("");
    expect(rig.runs).toEqual([]);
    expect(rig.scene).toBe("a");
    expect(rig.controller.state()).toMatchObject({ holder: "agent", rev: 0 });
  });

  const garbled: [string, unknown][] = [
    ["null", null],
    ["a string", "next"],
    ["a list", []],
    ["an empty object", {}],
    ["a lease id that is empty", { leaseId: "", epoch: 0, sequence: 0, expectedRev: 0, action: "next" }],
    [
      "a lease id that is far too long",
      { leaseId: "x".repeat(129), epoch: 0, sequence: 0, expectedRev: 0, action: "next" },
    ],
    [
      "an epoch given as text",
      { leaseId: "lease-1", epoch: "0", sequence: 0, expectedRev: 0, action: "next" },
    ],
    ["a negative sequence", { leaseId: "lease-1", epoch: 0, sequence: -1, expectedRev: 0, action: "next" }],
    [
      "a sequence that is not whole",
      { leaseId: "lease-1", epoch: 0, sequence: 0.5, expectedRev: 0, action: "next" },
    ],
    [
      "a rev that is not a number",
      { leaseId: "lease-1", epoch: 0, sequence: 0, expectedRev: Number.NaN, action: "next" },
    ],
    [
      "an infinite sequence",
      { leaseId: "lease-1", epoch: 0, sequence: Number.POSITIVE_INFINITY, expectedRev: 0, action: "next" },
    ],
    ["an empty action", { leaseId: "lease-1", epoch: 0, sequence: 0, expectedRev: 0, action: "" }],
  ];

  it.each(garbled)("refuses %s as malformed", async (_label, sent) => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    expect(code(await rig.controller.submit(sent))).toBe("malformed");
    expect(rig.runs).toEqual([]);
  });

  it("refuses an action the lease was not granted, while allowing the ones it was", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES, actions: ["next"] });
    expect(code(await rig.controller.submit(rig.command({ action: "previous" })))).toBe("out-of-scope");
    expect(code(await rig.controller.submit(rig.command(goto("c"))))).toBe("out-of-scope");
    expect(code(await rig.controller.submit(rig.command({ action: "next" })))).toBe("ok");
  });

  it("refuses a move that would leave the section, from inside it", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: ["a", "b"] });
    expect(code(await rig.controller.submit(rig.command({ action: "next" })))).toBe("ok");
    expect(code(await rig.controller.submit(rig.command({ action: "next" })))).toBe("out-of-scope");
    expect(rig.scene).toBe("b");
    expect(rig.controller.state().holder).toBe("agent");
  });

  it("treats a host that throws while naming the target as an unknown target, and does nothing", async () => {
    const rig = makeRig({
      target: () => {
        throw new Error("the deck is gone");
      },
    });
    rig.controller.grant({ scenes: SCENES });
    expect(code(await rig.controller.submit(rig.command()))).toBe("unknown-target");
    expect(rig.runs).toEqual([]);
    expect(rig.controller.state().holder).toBe("agent");
  });

  it("refuses a sequence number it has seen, and one below it, but allows a gap", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const invokeBody = { action: "invoke", args: { block: "x", command: "play" } };
    const codes = [
      await rig.controller.submit(rig.command({ ...invokeBody, sequence: 5 })),
      await rig.controller.submit(rig.command({ ...invokeBody, sequence: 5 })),
      await rig.controller.submit(rig.command({ ...invokeBody, sequence: 4 })),
      await rig.controller.submit(rig.command({ ...invokeBody, sequence: 9 })),
      await rig.controller.submit(rig.command({ ...invokeBody, sequence: 8 })),
    ].map(code);
    expect(codes).toEqual(["ok", "duplicate", "duplicate", "ok", "duplicate"]);
    expect(rig.runs).toHaveLength(2);
  });

  it("allows sequence 0 as the first command", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    expect(code(await rig.controller.submit(rig.command({ sequence: 0 })))).toBe("ok");
  });

  it("calls a replay a duplicate even while the first copy is still running", async () => {
    const gate = deferred<boolean>();
    const rig = makeRig({ run: () => gate.promise });
    rig.controller.grant({ scenes: SCENES });
    const one = rig.command({ action: "invoke", args: { block: "x", command: "play" }, sequence: 3 });
    const first = rig.controller.submit(one);
    expect(code(await rig.controller.submit(one))).toBe("duplicate");
    gate.resolve(true);
    expect(code(await first)).toBe("ok");
    expect(rig.runs).toHaveLength(1);
  });

  it("refuses a command written against a position that has since moved", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const stale = rig.command({ action: "next" });
    rig.move(1);
    const result = await rig.controller.submit(stale);
    expect(result).toMatchObject({ ok: false, code: "stale-state", rev: 1 });
    expect(rig.scene).toBe("b");
    expect(rig.runs).toEqual([]);
    expect(rig.controller.state().holder).toBe("agent");
  });

  it("refuses the second of two commands sent without waiting for the first to land", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const rev = rig.controller.state().rev;
    const first = await rig.controller.submit(rig.command({ expectedRev: rev, action: "next" }));
    const second = await rig.controller.submit(rig.command({ expectedRev: rev, action: "next" }));
    expect([first, second].map(code)).toEqual(["ok", "stale-state"]);
    expect(rig.scene).toBe("b");
  });

  it("checks the position when a queued command comes up, not when it was sent", async () => {
    const gate = deferred<boolean>();
    let first = true;
    const rig = makeRig({
      run: (action, args) => {
        if (first) {
          first = false;
          return gate.promise.then(() => rig.perform(action, args));
        }
        return rig.perform(action, args);
      },
    });
    rig.controller.grant({ scenes: SCENES });
    const rev = rig.controller.state().rev;
    const one = rig.controller.submit(rig.command({ expectedRev: rev, action: "next" }));
    const two = rig.controller.submit(rig.command({ expectedRev: rev, action: "next" }));
    gate.resolve(true);
    expect((await Promise.all([one, two])).map(code)).toEqual(["ok", "stale-state"]);
    expect(rig.scene).toBe("b");
  });
});

describe("running out", () => {
  it("lasts until three seconds after the last renewal, to the millisecond", () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.clock.advance(LEASE_EXPIRE_MS - 1);
    expect(rig.controller.state().holder).toBe("agent");
    rig.clock.advance(1);
    expect(rig.controller.state()).toMatchObject({ holder: "human", epoch: 1, last: { reason: "expired" } });
  });

  it("is extended by a renewal each second, however long that goes on", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: SCENES });
    for (let second = 0; second < 600; second += 1) {
      rig.clock.advance(LEASE_RENEW_MS);
      const renewed = rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch });
      expect(renewed.ok).toBe(true);
    }
    expect(rig.controller.state().holder).toBe("agent");
    expect(rig.clock.pending).toBe(1);
  });

  it("is extended from the moment of the renewal, not from the old expiry", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: SCENES });
    rig.clock.advance(2999);
    const renewed = rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch });
    expect(renewed).toMatchObject({ ok: true, expiresAt: rig.clock.now() + LEASE_EXPIRE_MS });
    rig.clock.advance(2999);
    expect(rig.controller.state().holder).toBe("agent");
    rig.clock.advance(1);
    expect(rig.controller.state().holder).toBe("human");
  });

  it("is not extended by commands: only a renewal keeps it alive", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    for (let n = 0; n < 5; n += 1) {
      rig.clock.advance(500);
      await rig.controller.submit(rig.command({ action: "invoke", args: { block: "x", command: "play" } }));
    }
    rig.clock.advance(500);
    expect(rig.controller.state().holder).toBe("human");
  });

  it("leaves the deck where it was", () => {
    const rig = makeRig();
    rig.move(2);
    rig.controller.grant({ scenes: SCENES });
    rig.clock.advance(60_000);
    expect(rig.controller.state().holder).toBe("human");
    expect(rig.scene).toBe("c");
    expect(rig.controller.state().rev).toBe(1);
  });

  it("is noticed on the next call even when the timer never ran", async () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: SCENES });
    const sent = rig.command();
    rig.clock.jump(10_000);
    expect(code(await rig.controller.submit(sent))).toBe("expired");
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "expired" } });
    expect(rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch })).toMatchObject({
      ok: false,
      code: "expired",
    });
    expect(rig.runs).toEqual([]);
  });

  it("is noticed by a plain look at the state, with no timer to say so", () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.clock.jump(LEASE_EXPIRE_MS);
    expect(rig.controller.state()).toMatchObject({ holder: "human", epoch: 1, last: { reason: "expired" } });
  });

  it("is noticed by a renewal that arrives late", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: SCENES });
    rig.clock.jump(LEASE_EXPIRE_MS);
    expect(rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch })).toMatchObject({
      ok: false,
      code: "expired",
      holder: "human",
    });
  });

  it("refuses a delayed command that arrives after the expiry, even when it was well formed", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const delayed = rig.command({ action: "next" });
    rig.clock.advance(LEASE_EXPIRE_MS + 1);
    expect(code(await rig.controller.submit(delayed))).toBe("expired");
    expect(rig.scene).toBe("a");
  });

  it("does not let a delayed command from the old lease through once a new one is out", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const delayed = rig.command({ action: "next" });
    rig.clock.advance(LEASE_EXPIRE_MS);
    rig.controller.grant({ scenes: SCENES });
    expect(code(await rig.controller.submit(delayed))).toBe("unknown-lease");
    expect(rig.scene).toBe("a");
  });
});

describe("the expiry timer", () => {
  it("sets itself again when it fires before the expiry, and ends the lease when it fires after", () => {
    let time = 0;
    const callbacks: (() => void)[] = [];
    const delays: number[] = [];
    const controller = createLeaseController({
      host: { scene: () => "a", target: () => "a", run: () => true },
      now: () => time,
      timers: {
        set: (callback, ms) => {
          callbacks.push(callback);
          delays.push(ms);
          return callbacks.length;
        },
        clear: () => {},
      },
    });
    const seen: string[] = [];
    controller.subscribe((event) => seen.push(event.type));
    controller.grant({ scenes: ["a"] });
    expect(delays).toEqual([LEASE_EXPIRE_MS]);
    time = LEASE_EXPIRE_MS - 100;
    callbacks[0]?.();
    expect(delays).toEqual([LEASE_EXPIRE_MS, 100]);
    expect(seen).toEqual(["granted"]);
    time = LEASE_EXPIRE_MS;
    callbacks[1]?.();
    expect(seen).toEqual(["granted", "revoked"]);
  });

  it("leaves a newer lease alone when the timer of an earlier one fires anyway", () => {
    let time = 0;
    const callbacks: (() => void)[] = [];
    const controller = createLeaseController({
      host: { scene: () => "a", target: () => "a", run: () => true },
      now: () => time,
      timers: {
        set: (callback) => callbacks.push(callback),
        clear: () => {},
      },
    });
    controller.grant({ scenes: ["a"] });
    controller.takeover();
    time = 1000;
    const second = controller.grant({ scenes: ["a"] });
    time = LEASE_EXPIRE_MS + 500;
    callbacks[0]?.();
    expect(controller.state()).toMatchObject({ holder: "agent", lease: { id: second.id } });
  });

  it("has a clock and timers of its own when it is given none", () => {
    const controller = createLeaseController({
      host: { scene: () => "a", target: () => "a", run: () => true },
    });
    // Bytes below 16 are the ones that need a leading zero, so make them all of that kind.
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(1);
      return array;
    });
    const lease = controller.grant({ scenes: ["a"] });
    random.mockRestore();
    expect(lease.id).toBe("01".repeat(16));
    expect(controller.grant({ scenes: ["a"] }).id).not.toBe(lease.id);
    const left = controller.state().holder === "agent" ? lease.expiresAt - Date.now() : 0;
    expect(left).toBeGreaterThan(LEASE_EXPIRE_MS - 1000);
    expect(left).toBeLessThanOrEqual(LEASE_EXPIRE_MS);
    controller.destroy();
  });
});

describe("renewing", () => {
  it("refuses a renewal for a lease that is not the one out, or from another epoch", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: SCENES });
    const codes = [
      rig.controller.renew({ leaseId: "lease-9", epoch: 0 }),
      rig.controller.renew({ leaseId: lease.id, epoch: 7 }),
      rig.controller.renew({}),
      rig.controller.renew(null),
      rig.controller.renew("lease-1"),
    ].map((result) => (result.ok ? "ok" : result.code));
    expect(codes).toEqual([
      "unknown-lease",
      "stale-epoch",
      "unknown-lease",
      "unknown-lease",
      "unknown-lease",
    ]);
    expect(rig.controller.state().holder).toBe("agent");
  });

  it("tells an agent nobody has granted anything", () => {
    const rig = makeRig();
    expect(rig.controller.renew({ leaseId: "lease-1", epoch: 0 })).toMatchObject({
      ok: false,
      code: "no-lease",
    });
  });

  it("tells an agent that control changed hands when the presenter took it back", () => {
    const rig = makeRig();
    const lease = rig.controller.grant({ scenes: SCENES });
    rig.controller.takeover();
    expect(rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch })).toMatchObject({
      ok: false,
      code: "stale-epoch",
      holder: "human",
    });
  });
});

describe("taking control back", () => {
  it("returns control at once, bumps the epoch and leaves the deck where it is", () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.move(2);
    expect(rig.controller.takeover()).toBe(true);
    expect(rig.controller.state()).toMatchObject({
      holder: "human",
      epoch: 1,
      rev: 1,
      last: { reason: "takeover" },
    });
    expect(rig.scene).toBe("c");
    expect(rig.controller.takeover()).toBe(false);
    expect(rig.controller.state().epoch).toBe(1);
  });

  it("cancels what is queued and aborts what is running, and a late finish changes nothing", async () => {
    const gate = deferred<boolean>();
    const signals: AbortSignal[] = [];
    const rig = makeRig({
      run: (_action, _args, signal) => {
        signals.push(signal);
        return gate.promise;
      },
    });
    let answers = 0;
    rig.controller.subscribe((event) => {
      if (event.type === "command") answers += 1;
    });
    rig.controller.grant({ scenes: SCENES });
    const body = { action: "invoke", args: { block: "x", command: "play" } };
    const running = rig.controller.submit(rig.command(body));
    const queuedOne = rig.controller.submit(rig.command(body));
    const queuedTwo = rig.controller.submit(rig.command(body));
    rig.controller.takeover();
    const results = await Promise.all([running, queuedOne, queuedTwo]);
    expect(results.map(code)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(results.every((result) => result.holder === "human")).toBe(true);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    gate.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(answers).toBe(3);
    expect(rig.runs).toHaveLength(1);
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "takeover" } });
  });

  it("treats a failure caused by the abort as a cancel, not an agent error", async () => {
    const rig = makeRig({
      run: (_action, _args, signal) =>
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    rig.controller.grant({ scenes: SCENES });
    const pending = rig.controller.submit(
      rig.command({ action: "invoke", args: { block: "x", command: "play" } }),
    );
    rig.controller.takeover();
    expect(code(await pending)).toBe("cancelled");
    expect(rig.controller.state()).toMatchObject({ last: { reason: "takeover" } });
  });

  it("refuses everything the old lease sends afterwards", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const sent = rig.command();
    rig.controller.takeover();
    expect(code(await rig.controller.submit(sent))).toBe("stale-epoch");
    expect(code(await rig.controller.submit({ ...sent, sequence: 99 }))).toBe("stale-epoch");
    expect(code(await rig.controller.submit({ ...sent, leaseId: "lease-0" }))).toBe("no-lease");
    expect(rig.runs).toEqual([]);
  });

  it("needs a new grant to hand control back", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.controller.takeover();
    const lease = rig.controller.grant({ scenes: SCENES });
    expect(lease.epoch).toBe(1);
    expect(code(await rig.controller.submit(rig.command()))).toBe("ok");
  });
});

describe("a command that goes wrong", () => {
  it("returns control to the human when the host throws, and says so", async () => {
    const rig = makeRig({
      run: () => {
        throw new Error("the page broke");
      },
    });
    rig.controller.grant({ scenes: SCENES });
    const result = await rig.controller.submit(rig.command());
    expect(result).toMatchObject({ ok: false, code: "failed", holder: "human", epoch: 1 });
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "agent-error" } });
    expect(rig.scene).toBe("a");
  });

  it("does the same when the host's promise rejects, and cancels what was queued behind it", async () => {
    const gate = deferred<boolean>();
    const rig = makeRig({ run: () => gate.promise });
    rig.controller.grant({ scenes: SCENES });
    const body = { action: "invoke", args: { block: "x", command: "play" } };
    const first = rig.controller.submit(rig.command(body));
    const second = rig.controller.submit(rig.command(body));
    gate.reject(new Error("no"));
    expect([await first, await second].map(code)).toEqual(["failed", "cancelled"]);
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "agent-error" } });
    expect(rig.runs).toHaveLength(1);
  });

  it("gives control back when a command hangs past the limit, and then runs the next lease's commands", async () => {
    let hang = true;
    let hungSignal: AbortSignal | undefined;
    const rig = makeRig({
      run: (action, args, signal) => {
        if (!hang) return rig.perform(action, args);
        hungSignal = signal;
        return new Promise<boolean>(() => {});
      },
      runLimitMs: 2000,
    });
    const lease = rig.controller.grant({ scenes: SCENES });
    let answered: CommandResult | undefined;
    const body = { action: "invoke", args: { block: "x", command: "play" } };
    const hung = rig.controller.submit(rig.command(body)).then((result) => {
      answered = result;
    });
    rig.clock.advance(1000);
    rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch });
    rig.clock.advance(999);
    await Promise.resolve();
    expect(answered).toBeUndefined();
    rig.clock.advance(1);
    await hung;
    expect(answered).toMatchObject({ ok: false, code: "failed", holder: "human" });
    expect(hungSignal?.aborted).toBe(true);
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "agent-error" } });

    hang = false;
    rig.controller.grant({ scenes: SCENES });
    expect(code(await rig.controller.submit(rig.command({ action: "next" })))).toBe("ok");
    expect(rig.scene).toBe("b");
  });

  it("leaves a newer lease alone when a command from an ended lease fails late", async () => {
    const gate = deferred<boolean>();
    let first = true;
    const rig = makeRig({
      run: (action, args) => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return rig.perform(action, args);
      },
    });
    rig.controller.grant({ scenes: SCENES });
    const old = rig.controller.submit(
      rig.command({ action: "invoke", args: { block: "x", command: "play" } }),
    );
    rig.controller.takeover();
    expect(code(await old)).toBe("cancelled");
    const second = rig.controller.grant({ scenes: SCENES });
    gate.reject(new Error("a late failure"));
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(rig.controller.state()).toMatchObject({ holder: "agent", lease: { id: second.id } });
    expect(code(await rig.controller.submit(rig.command()))).toBe("ok");
  });

  it("leaves a newer lease alone when the time limit of a command from an ended lease runs out", async () => {
    const rig = makeRig({ run: () => new Promise<boolean>(() => {}), runLimitMs: 2000 });
    rig.controller.grant({ scenes: SCENES });
    const old = rig.controller.submit(
      rig.command({ action: "invoke", args: { block: "x", command: "play" } }),
    );
    rig.controller.takeover();
    expect(code(await old)).toBe("cancelled");
    const second = rig.controller.grant({ scenes: SCENES });
    rig.clock.advance(2000);
    expect(rig.controller.state()).toMatchObject({ holder: "agent", lease: { id: second.id } });
  });

  it("waits five seconds for a command by default", async () => {
    const rig = makeRig({ run: () => new Promise<boolean>(() => {}) });
    const lease = rig.controller.grant({ scenes: SCENES });
    let answered: CommandResult | undefined;
    void rig.controller
      .submit(rig.command({ action: "invoke", args: { block: "x", command: "play" } }))
      .then((result) => {
        answered = result;
      });
    for (let second = 0; second < 4; second += 1) {
      rig.clock.advance(1000);
      rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch });
    }
    rig.clock.advance(999);
    await Promise.resolve();
    expect(answered).toBeUndefined();
    rig.clock.advance(1);
    await Promise.resolve();
    expect(answered).toMatchObject({ ok: false, code: "failed" });
  });

  it("does not start a queued command under a lease that has run out, even when the timer was late", async () => {
    const gate = deferred<boolean>();
    let first = true;
    const rig = makeRig({
      run: (action, args) => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return rig.perform(action, args);
      },
    });
    rig.controller.grant({ scenes: SCENES });
    const body = { action: "invoke", args: { block: "x", command: "play" } };
    const slow = rig.controller.submit(rig.command(body));
    const queued = rig.controller.submit(rig.command(body));
    rig.clock.jump(LEASE_EXPIRE_MS + 1);
    gate.resolve(true);
    expect(code(await slow)).toBe("ok");
    expect(code(await queued)).toBe("cancelled");
    expect(rig.runs).toHaveLength(1);
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "expired" } });
  });

  it("stops the clock on a command that finishes in time", async () => {
    const rig = makeRig({ runLimitMs: 2000 });
    rig.controller.grant({ scenes: SCENES });
    await rig.controller.submit(rig.command());
    expect(rig.clock.pending).toBe(1);
  });
});

describe("leaving the section", () => {
  it("returns control when the deck moves out of the section by hand", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: ["a", "b"] });
    const sent = rig.command();
    rig.move(3);
    expect(rig.controller.state()).toMatchObject({
      holder: "human",
      epoch: 1,
      last: { reason: "section-exit" },
    });
    expect(code(await rig.controller.submit(sent))).toBe("stale-epoch");
    expect(rig.scene).toBe("d");
  });

  it("keeps the lease while the deck moves inside the section, and counts each move", () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: ["a", "b", "c"] });
    rig.move(1);
    rig.move(2);
    rig.move(0);
    expect(rig.controller.state()).toMatchObject({ holder: "agent", rev: 3, epoch: 0 });
  });

  it("answers a command as cancelled when running it took the deck out of the section", async () => {
    const rig = makeRig({
      run: () => {
        rig.move(4);
        return true;
      },
    });
    rig.controller.grant({ scenes: ["a", "b"] });
    const result = await rig.controller.submit(
      rig.command({ action: "invoke", args: { block: "x", command: "go" } }),
    );
    expect(result).toMatchObject({ ok: false, code: "cancelled", holder: "human" });
    expect(rig.controller.state()).toMatchObject({ holder: "human", last: { reason: "section-exit" } });
  });

  it("checks the target again when a queued command comes up, because the deck can have moved", async () => {
    const gate = deferred<boolean>();
    let first = true;
    const rig = makeRig({
      run: (action, args) => {
        if (first) {
          first = false;
          return gate.promise;
        }
        return rig.perform(action, args);
      },
    });
    rig.controller.grant({ scenes: ["a", "b"] });
    const slow = rig.controller.submit(
      rig.command({ action: "invoke", args: { block: "x", command: "go" } }),
    );
    // Written for a deck at rev 0 on scene a, where next goes to b. By the time it runs the human has moved
    // to b and the rev is back where this command expects it, so next would now leave the section.
    const forged = rig.controller.submit(rig.command({ action: "next", expectedRev: 1 }));
    rig.move(1);
    gate.resolve(true);
    expect(code(await slow)).toBe("ok");
    expect(code(await forged)).toBe("out-of-scope");
    expect(rig.scene).toBe("b");
    expect(rig.controller.state().holder).toBe("agent");
  });

  it("needs a fresh grant after coming back into the section", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: ["a", "b"] });
    rig.move(3);
    rig.move(0);
    expect(rig.controller.state().holder).toBe("human");
    expect(
      code(
        await rig.controller.submit({
          leaseId: "lease-1",
          epoch: 0,
          sequence: 1,
          expectedRev: 2,
          action: "next",
        }),
      ),
    ).toBe("stale-epoch");
  });
});

describe("other ways it ends", () => {
  it.each<[string, "disconnect" | "agentError", RevokeReason]>([
    ["the agent's link drops", "disconnect", "disconnect"],
    ["the agent reports an error", "agentError", "agent-error"],
  ])("returns control when %s", (_label, method, reason) => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    rig.move(1);
    expect(rig.controller[method]()).toBe(true);
    expect(rig.controller.state()).toMatchObject({ holder: "human", epoch: 1, rev: 1, last: { reason } });
    expect(rig.scene).toBe("b");
    expect(rig.controller[method]()).toBe(false);
  });

  it("stops everything when destroyed", async () => {
    const rig = makeRig();
    rig.controller.grant({ scenes: SCENES });
    const seen: LeaseEvent[] = [];
    rig.controller.subscribe((event) => seen.push(event));
    rig.controller.destroy();
    expect(rig.controller.state().holder).toBe("human");
    expect(rig.clock.pending).toBe(0);
    expect(seen.map((event) => event.type)).toEqual(["revoked"]);
    rig.controller.grant({ scenes: SCENES });
    expect(seen).toHaveLength(1);
  });

  it("has words for the presenter for every way a lease can end", () => {
    const reasons: RevokeReason[] = [
      "takeover",
      "expired",
      "disconnect",
      "agent-error",
      "section-exit",
      "replaced",
    ];
    for (const reason of reasons) expect(REVOKE_TEXT[reason].length).toBeGreaterThan(10);
    expect(Object.keys(REVOKE_TEXT).sort()).toEqual([...reasons].sort());
  });
});

describe("events", () => {
  it("reports a grant, a renewal, a command and the end, in order", async () => {
    const rig = makeRig();
    const seen: string[] = [];
    rig.controller.subscribe((event) => {
      seen.push(event.type === "revoked" ? `revoked:${event.reason}` : event.type);
    });
    const lease = rig.controller.grant({ scenes: SCENES });
    rig.controller.renew({ leaseId: lease.id, epoch: lease.epoch });
    await rig.controller.submit(rig.command());
    await rig.controller.submit(rig.command({ action: "bogus" }));
    rig.controller.takeover();
    expect(seen).toEqual(["granted", "renewed", "command", "command", "revoked:takeover"]);
  });

  it("carries the command and its result, refused or not", async () => {
    const rig = makeRig();
    const results: CommandResult[] = [];
    rig.controller.subscribe((event) => {
      if (event.type === "command") results.push(event.result);
    });
    rig.controller.grant({ scenes: SCENES });
    await rig.controller.submit(rig.command());
    await rig.controller.submit(rig.command({ action: "bogus" }));
    expect(results.map(code)).toEqual(["ok", "unknown-action"]);
  });

  it("goes on working when a listener throws, and stops telling one that unsubscribed", () => {
    const rig = makeRig();
    const seen: string[] = [];
    rig.controller.subscribe(() => {
      throw new Error("a bad listener");
    });
    const off = rig.controller.subscribe((event) => seen.push(event.type));
    rig.controller.grant({ scenes: SCENES });
    off();
    rig.controller.takeover();
    expect(seen).toEqual(["granted"]);
    expect(rig.controller.state().holder).toBe("human");
  });
});

describe("the protocol's shape", () => {
  it("names presentation moves only, so a lease cannot edit the deck", () => {
    expect([...LEASE_ACTIONS]).toEqual(["next", "previous", "goto", "invoke"]);
  });

  it("asks for a renewal three times as often as it expires", () => {
    expect(LEASE_RENEW_MS).toBe(1000);
    expect(LEASE_EXPIRE_MS).toBe(3 * LEASE_RENEW_MS);
  });
});
