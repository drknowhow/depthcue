import {
  createLeaseController,
  type LeaseAction,
  type LeaseCommand,
  type LeaseController,
  type LeaseHost,
  type Timers,
} from "../src/index.ts";

export const SCENES = ["a", "b", "c", "d", "e"];

/** A clock that fires timers in order as it advances, and can also stall: `jump` moves time without firing. */
export function virtualClock(start = 1_000_000) {
  let time = start;
  let next = 0;
  const jobs = new Map<number, { due: number; run: () => void }>();
  const timers: Timers = {
    set(callback, ms) {
      jobs.set(++next, { due: time + ms, run: callback });
      return next;
    },
    clear(handle) {
      jobs.delete(handle as number);
    },
  };
  return {
    timers,
    now: () => time,
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        let id = 0;
        let due = Number.POSITIVE_INFINITY;
        for (const [key, job] of jobs) {
          if (job.due < due || (job.due === due && key < id)) {
            id = key;
            due = job.due;
          }
        }
        if (due > end) break;
        const job = jobs.get(id);
        jobs.delete(id);
        time = Math.max(time, due);
        job?.run();
      }
      time = end;
    },
    /** Time passes and no timer runs: a stalled event loop. */
    jump(ms: number) {
      time += ms;
    },
    get pending() {
      return jobs.size;
    },
  };
}

export interface Run {
  action: LeaseAction;
  args: unknown;
  scene: string;
  leaseId: string | undefined;
  epoch: number;
}

export interface RigOptions {
  /** Replaces what the host does. Default: move through SCENES. */
  run?: (action: LeaseAction, args: unknown, signal: AbortSignal) => boolean | Promise<boolean>;
  runLimitMs?: number;
  /** Replaces how the host names what a command touches. */
  target?: LeaseHost["target"];
}

/** A deck of five scenes, a virtual clock and a lease controller wired to them. */
export function makeRig(options: RigOptions = {}) {
  const clock = virtualClock();
  const runs: Run[] = [];
  let index = 0;
  let ids = 0;
  let sequence = -1;

  function move(to: number) {
    if (to === index) return;
    index = to;
    controller.changed();
  }

  function perform(action: LeaseAction, args: unknown): boolean {
    if (action === "next") {
      if (index === SCENES.length - 1) return false;
      move(index + 1);
      return true;
    }
    if (action === "previous") {
      if (index === 0) return false;
      move(index - 1);
      return true;
    }
    if (action === "goto") {
      const to = SCENES.indexOf((args as { scene: string }).scene);
      if (to === index) return false;
      move(to);
      return true;
    }
    return true;
  }

  const host: LeaseHost = {
    scene: () => SCENES[index] as string,
    target(action, args) {
      if (options.target) return options.target(action, args);
      if (action === "next") return SCENES[Math.min(index + 1, SCENES.length - 1)];
      if (action === "previous") return SCENES[Math.max(index - 1, 0)];
      if (action === "goto") {
        const scene = (args as { scene: string }).scene;
        return SCENES.includes(scene) ? scene : undefined;
      }
      return SCENES[index];
    },
    run(action, args, signal) {
      const state = controller.state();
      runs.push({
        action,
        args,
        scene: SCENES[index] as string,
        leaseId: state.holder === "agent" ? state.lease.id : undefined,
        epoch: state.epoch,
      });
      return options.run ? options.run(action, args, signal) : perform(action, args);
    },
  };

  const controller: LeaseController = createLeaseController({
    host,
    now: clock.now,
    timers: clock.timers,
    newId: () => `lease-${++ids}`,
    ...(options.runLimitMs === undefined ? {} : { runLimitMs: options.runLimitMs }),
  });

  return {
    clock,
    controller,
    runs,
    perform,
    /** The human moves the deck by hand. */
    move,
    get index() {
      return index;
    },
    get scene() {
      return SCENES[index] as string;
    },
    /** A well-formed command for the lease that is out now, with a fresh sequence number. */
    command(overrides: Partial<LeaseCommand> = {}): LeaseCommand {
      const state = controller.state();
      if (state.holder !== "agent") throw new Error("No lease is out.");
      return {
        leaseId: state.lease.id,
        epoch: state.lease.epoch,
        sequence: ++sequence,
        expectedRev: state.rev,
        action: "next",
        ...overrides,
      };
    },
  };
}

/** A promise that settles when the test says so. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Seeded generator, so a failing run can be replayed from its seed. */
export function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (below: number) => Math.floor(next() * below),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}
