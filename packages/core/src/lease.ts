import { systemTimers, type Timers } from "./draft.ts";

/**
 * The control lease: who is driving the presentation. The human holds control by default. A human GRANT hands an
 * agent a scoped, short lease that it has to renew. Everything here is plain logic with injected time and an
 * injected host, so the page, the tests and a replayed fault all run the same rules.
 *
 * The actions a lease can carry are a closed list that names presentation moves only, so a lease cannot edit the
 * deck: there is no word for it.
 */

export const LEASE_ACTIONS = ["next", "previous", "goto", "invoke"] as const;
export type LeaseAction = (typeof LEASE_ACTIONS)[number];

/** How often an agent should renew, and how long a lease lasts without a renewal. */
export const LEASE_RENEW_MS = 1000;
export const LEASE_EXPIRE_MS = 3000;
/** The longest one command may run before control goes back to the human. */
export const LEASE_RUN_LIMIT_MS = 5000;

const MAX_SCENES = 1000;
const MAX_TEXT = 128;

export type RevokeReason =
  | "takeover"
  | "expired"
  | "disconnect"
  | "agent-error"
  | "section-exit"
  | "replaced";

export type Rejection =
  | "no-lease"
  | "unknown-lease"
  | "stale-epoch"
  | "expired"
  | "duplicate"
  | "malformed"
  | "unknown-action"
  | "unknown-target"
  | "out-of-scope"
  | "stale-state"
  | "cancelled"
  | "not-run"
  | "failed";

export interface LeaseHost {
  /** The scene the audience is looking at. */
  scene(): string;
  /** The scene an action would touch, or undefined when it names nothing that exists. */
  target(action: LeaseAction, args: unknown): string | undefined;
  /**
   * Does the action. True when something happened, false when there was nothing to do, such as `next` on the
   * last scene. A throw counts as an agent error and returns control to the human. The signal aborts when the
   * lease is revoked while this runs.
   */
  run(action: LeaseAction, args: unknown, signal: AbortSignal): boolean | Promise<boolean>;
}

export interface LeaseScope {
  /** The section: the scenes the agent may touch. The scene on screen has to be one of them. */
  scenes: readonly string[];
  /** Default: every action. */
  actions?: readonly LeaseAction[];
}

export interface Lease {
  id: string;
  epoch: number;
  expiresAt: number;
  scenes: readonly string[];
  actions: readonly LeaseAction[];
}

/** What an agent sends. `sequence` rises with each command; `expectedRev` is the `rev` it last saw. */
export interface LeaseCommand {
  leaseId: string;
  epoch: number;
  sequence: number;
  expectedRev: number;
  action: string;
  args?: unknown;
}

export interface Standing {
  /** Counts position changes, so a command can say which state it was written against. */
  rev: number;
  /** Counts revoked leases, so a command from an earlier one is recognisable. */
  epoch: number;
  holder: "human" | "agent";
}

export type CommandResult =
  | (Standing & { ok: true })
  | (Standing & { ok: false; code: Rejection; message: string });
export type RenewResult =
  | (Standing & { ok: true; expiresAt: number })
  | (Standing & { ok: false; code: Rejection; message: string });

export type LeaseState =
  | (Standing & { holder: "human"; last?: { reason: RevokeReason; at: number } })
  | (Standing & { holder: "agent"; lease: Lease });

export type LeaseEvent =
  | { type: "granted"; lease: Lease }
  | { type: "renewed"; leaseId: string; expiresAt: number }
  | { type: "revoked"; leaseId: string; reason: RevokeReason; epoch: number }
  | { type: "command"; command: LeaseCommand; result: CommandResult };

export interface LeaseOptions {
  host: LeaseHost;
  now?: () => number;
  timers?: Timers;
  newId?: () => string;
  /** Default `LEASE_RUN_LIMIT_MS`. */
  runLimitMs?: number;
}

export interface LeaseController {
  state(): LeaseState;
  /** Human act. Replaces a lease that is already out. Throws when the scope cannot be granted. */
  grant(scope: LeaseScope): Lease;
  /** Human act, and always safe to call: takes control back, bumps the epoch, cancels queued agent actions. */
  takeover(): boolean;
  /** The agent's link dropped. */
  disconnect(): boolean;
  /** The agent said it failed, or sent something no honest agent sends. */
  agentError(): boolean;
  renew(input: unknown): RenewResult;
  /** Runs an agent command if it holds up against the lease, or says why not. Never throws. */
  submit(input: unknown): Promise<CommandResult>;
  /** The host calls this whenever the presentation position changes, whoever changed it. */
  changed(): void;
  subscribe(listener: (event: LeaseEvent) => void): () => void;
  /** Stops timers and returns control. */
  destroy(): void;
}

export const REVOKE_TEXT: Readonly<Record<RevokeReason, string>> = {
  takeover: "You took control back.",
  expired: "The agent stopped responding, so control is back with you.",
  disconnect: "The agent disconnected, so control is back with you.",
  "agent-error": "The agent reported an error, so control is back with you.",
  "section-exit": "The presentation left the agent's section, so control is back with you.",
  replaced: "A new hand-over replaced the earlier one.",
};

const MESSAGES: Readonly<Record<Rejection, string>> = {
  "no-lease": "Nobody has handed you control. The presenter has to grant a section first.",
  "unknown-lease": "That lease is not the current one. Ask the presenter for a new grant.",
  "stale-epoch": "Control changed hands since this lease was issued. Ask the presenter for a new grant.",
  expired: "The lease ran out because it was not renewed in time. Ask the presenter for a new grant.",
  duplicate: "That sequence number was already used. Send each command with a higher one.",
  malformed: "The command is not in the shape the lease protocol expects.",
  "unknown-action": `The only actions are ${LEASE_ACTIONS.join(", ")}. A lease cannot edit the deck.`,
  "unknown-target": "That scene or block does not exist.",
  "out-of-scope": "That is outside the section or the actions this lease covers.",
  "stale-state": "The presentation moved since you last looked. Read the new rev and send the command again.",
  cancelled: "The lease ended before this ran, so it was not done.",
  "not-run": "There was nothing to do, such as next on the last scene.",
  failed: "The command failed, so control returned to the presenter.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Checks the shape of what an agent sent. Anything else is `malformed`. */
function parseCommand(input: unknown): LeaseCommand | undefined {
  if (!isRecord(input)) return undefined;
  const { leaseId, epoch, sequence, expectedRev, action, args } = input;
  if (!text(leaseId) || !count(epoch) || !count(sequence) || !count(expectedRev) || !text(action))
    return undefined;
  return { leaseId, epoch, sequence, expectedRev, action, args };
}

/** Checks the arguments for one action. */
function argsFit(action: LeaseAction, args: unknown): boolean {
  if (action === "next" || action === "previous") return args === undefined || isRecord(args);
  if (!isRecord(args)) return false;
  if (action === "goto") return text(args.scene) && (args.step === undefined || count(args.step));
  return text(args.block) && text(args.command);
}

interface Active {
  id: string;
  epoch: number;
  expiresAt: number;
  scenes: ReadonlySet<string>;
  sceneList: readonly string[];
  actions: ReadonlySet<LeaseAction>;
  lastSequence: number;
  timer: unknown;
}

interface Job {
  command: LeaseCommand;
  leaseId: string;
  abort: AbortController;
  done: (result: CommandResult) => void;
  settled: boolean;
  timer: unknown;
}

export function createLeaseController(options: LeaseOptions): LeaseController {
  const { host } = options;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? systemTimers;
  const newId = options.newId ?? randomId;
  const runLimitMs = options.runLimitMs ?? LEASE_RUN_LIMIT_MS;

  let epoch = 0;
  let rev = 0;
  let lease: Active | undefined;
  let last: { reason: RevokeReason; at: number; leaseId: string } | undefined;
  const queue: Job[] = [];
  let running: Job | undefined;
  const listeners = new Set<(event: LeaseEvent) => void>();

  const standing = (): Standing => ({ rev, epoch, holder: lease ? "agent" : "human" });
  const refuse = (code: Rejection): CommandResult & { ok: false } => ({
    ok: false,
    code,
    message: MESSAGES[code],
    ...standing(),
  });
  const view = (active: Active): Lease => ({
    id: active.id,
    epoch: active.epoch,
    expiresAt: active.expiresAt,
    scenes: active.sceneList,
    actions: [...active.actions],
  });

  function emit(event: LeaseEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener that throws is the listener's problem; the lease keeps working.
      }
    }
  }

  /** A renewal only moves `expiresAt`. The timer sees that when it fires and waits out the rest. */
  function arm(active: Active) {
    active.timer = timers.set(() => {
      if (lease !== active) return;
      if (now() >= active.expiresAt) revoke("expired");
      else arm(active);
    }, active.expiresAt - now());
  }

  /** Answers a job's caller once. The first answer stands. */
  function settle(job: Job, result: CommandResult) {
    if (job.settled) return;
    job.settled = true;
    job.done(result);
    emit({ type: "command", command: job.command, result });
  }

  /** Ends a lease. `keep` is a running job the caller is about to answer itself. */
  function revoke(reason: RevokeReason, keep?: Job): boolean {
    if (!lease) return false;
    const gone = lease;
    timers.clear(gone.timer);
    lease = undefined;
    epoch += 1;
    last = { reason, at: now(), leaseId: gone.id };
    for (const job of queue.splice(0)) settle(job, refuse("cancelled"));
    if (running && running !== keep) {
      running.abort.abort();
      settle(running, refuse("cancelled"));
    }
    emit({ type: "revoked", leaseId: gone.id, reason, epoch });
    return true;
  }

  /** The lease as it stands now, with expiry applied: the timer can be late. */
  function live(): Active | undefined {
    if (lease && now() >= lease.expiresAt) revoke("expired");
    return lease;
  }

  /** Why nobody holds the lease an agent names. */
  function missing(leaseId: unknown): Rejection {
    if (last && last.leaseId === leaseId) return last.reason === "expired" ? "expired" : "stale-epoch";
    return "no-lease";
  }

  /** The current lease when the command holds up against it, or the reason it does not. */
  function admit(command: LeaseCommand): Active | Rejection {
    const active = live();
    if (!active) return missing(command.leaseId);
    if (command.leaseId !== active.id) return "unknown-lease";
    if (command.epoch !== active.epoch) return "stale-epoch";
    if (command.sequence <= active.lastSequence) return "duplicate";
    const action = LEASE_ACTIONS.find((name) => name === command.action);
    if (!action) return "unknown-action";
    if (!active.actions.has(action)) return "out-of-scope";
    if (!argsFit(action, command.args)) return "malformed";
    return aimed(active, action, command.args) ?? active;
  }

  /** Why a command's target is not one the lease covers, if it is not. Asked again when the command runs. */
  function aimed(active: Active, action: LeaseAction, args: unknown): Rejection | undefined {
    let target: string | undefined;
    try {
      target = host.target(action, args);
    } catch {
      target = undefined;
    }
    if (target === undefined) return "unknown-target";
    return active.scenes.has(target) ? undefined : "out-of-scope";
  }

  function release(job: Job) {
    timers.clear(job.timer);
    if (running !== job) return;
    running = undefined;
    pump();
  }

  /** The command threw or hung: control goes back to the human and the agent is told. */
  function fail(job: Job) {
    if (job.settled) return;
    job.abort.abort();
    revoke("agent-error", job);
    settle(job, refuse("failed"));
  }

  /** A job that was cancelled or failed while it ran is already answered, so its late finish says nothing. */
  function conclude(job: Job, did: boolean) {
    settle(job, did ? { ok: true, ...standing() } : refuse("not-run"));
    release(job);
  }

  function crashed(job: Job) {
    fail(job);
    release(job);
  }

  function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    const active = live();
    if (active?.id !== job.leaseId) {
      settle(job, refuse("cancelled"));
      return pump();
    }
    if (job.command.expectedRev !== rev) {
      settle(job, refuse("stale-state"));
      return pump();
    }
    // The command was checked when it came in, against the deck as it was then. The deck may have moved since.
    const action = job.command.action as LeaseAction;
    const miss = aimed(active, action, job.command.args);
    if (miss) {
      settle(job, refuse(miss));
      return pump();
    }
    running = job;
    job.timer = timers.set(() => {
      fail(job);
      release(job);
    }, runLimitMs);
    let outcome: boolean | Promise<boolean>;
    try {
      outcome = host.run(action, job.command.args, job.abort.signal);
    } catch {
      return crashed(job);
    }
    if (typeof outcome === "boolean") return conclude(job, outcome);
    outcome.then(
      (did) => conclude(job, did),
      () => crashed(job),
    );
  }

  return {
    state() {
      const active = live();
      return active
        ? { holder: "agent", rev, epoch, lease: view(active) }
        : { holder: "human", rev, epoch, ...(last ? { last: { reason: last.reason, at: last.at } } : {}) };
    },

    grant(scope) {
      const scenes = [...new Set(scope.scenes)];
      const actions = scope.actions ?? LEASE_ACTIONS;
      if (scenes.length > MAX_SCENES || !scenes.every(text)) {
        throw new RangeError("A lease covers at most 1000 scenes, each named by its id.");
      }
      if (actions.length === 0 || !actions.every((action) => LEASE_ACTIONS.includes(action))) {
        throw new RangeError(`A lease can carry only these actions: ${LEASE_ACTIONS.join(", ")}.`);
      }
      if (!scenes.includes(host.scene())) {
        throw new RangeError("The section has to include the scene on screen.");
      }
      revoke("replaced");
      const active: Active = {
        id: newId(),
        epoch,
        expiresAt: now() + LEASE_EXPIRE_MS,
        scenes: new Set(scenes),
        sceneList: scenes,
        actions: new Set(actions),
        lastSequence: -1,
        timer: undefined,
      };
      lease = active;
      arm(active);
      emit({ type: "granted", lease: view(active) });
      return view(active);
    },

    takeover: () => revoke("takeover"),
    disconnect: () => revoke("disconnect"),
    agentError: () => revoke("agent-error"),

    renew(input) {
      const leaseId = isRecord(input) ? input.leaseId : undefined;
      const claimed = isRecord(input) ? input.epoch : undefined;
      const active = live();
      if (!active) return refuse(missing(leaseId));
      if (leaseId !== active.id) return refuse("unknown-lease");
      if (claimed !== active.epoch) return refuse("stale-epoch");
      active.expiresAt = now() + LEASE_EXPIRE_MS;
      emit({ type: "renewed", leaseId: active.id, expiresAt: active.expiresAt });
      return { ok: true, expiresAt: active.expiresAt, ...standing() };
    },

    submit(input) {
      const command = parseCommand(input);
      if (!command) return Promise.resolve(refuse("malformed"));
      const admitted = admit(command);
      if (typeof admitted === "string") {
        const result = refuse(admitted);
        emit({ type: "command", command, result });
        return Promise.resolve(result);
      }
      // Counted now, not when it runs, so a replay is a duplicate even while the first is still in flight.
      admitted.lastSequence = command.sequence;
      return new Promise<CommandResult>((done) => {
        queue.push({
          command,
          leaseId: admitted.id,
          abort: new AbortController(),
          done,
          settled: false,
          timer: undefined,
        });
        pump();
      });
    },

    changed() {
      rev += 1;
      if (lease && !lease.scenes.has(host.scene())) revoke("section-exit");
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    destroy() {
      revoke("disconnect");
      listeners.clear();
    },
  };
}
