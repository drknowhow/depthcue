import { readLink } from "@depthcue/cli/link";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

/** How often a held lease is renewed. The lease lasts three seconds, so this leaves two missed beats of slack. */
export const RENEW_EVERY_MS = 1000;

/** How long the tool keeps renewing when the agent has stopped calling it. Control then goes back to the presenter. */
export const IDLE_LET_GO_MS = 120_000;

/** How long one call to the deck server may take. The server waits up to 8 s for the page, and this allows for that. */
const CALL_TIMEOUT_MS = 10_000;

export const presentArgs = z.strictObject({
  action: z
    .enum(["status", "next", "previous", "goto", "invoke", "release"])
    .default("status")
    .describe("status shows who holds control and where the deck is. The others need control."),
  scene: z.string().optional().describe("Scene id. For goto."),
  step: z.number().int().min(0).max(100).optional().describe("Steps to show. For goto. Default 0."),
  block: z.string().optional().describe("Block id on the scene on screen. For invoke."),
  command: z.string().optional().describe("The block's command, such as play. For invoke."),
  args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the command. For invoke."),
});

type Args = z.infer<typeof presentArgs>;

/** What the page answers. The server adds nothing but the status line. */
interface Answer {
  ok?: boolean;
  code?: string;
  message?: string;
  holder?: "human" | "agent";
  rev?: number;
  epoch?: number;
  released?: boolean;
  lease?: { id: string; epoch: number; scenes: string[]; actions: string[] };
  last?: { reason: string };
  position?: { scene: string; step: number; steps: number };
}

type Reached = { reached: true; answer: Answer } | { reached: false; message: string };

/** The lease this process holds for the agent, as far as it knows. The page decides whether it is still good. */
interface Held {
  id: string;
  epoch: number;
  rev: number;
  sequence: number;
}

export interface PresentOptions {
  /** Replaces fetch. For tests. */
  fetch?: typeof fetch;
  renewMs?: number;
  idleMs?: number;
  now?: () => number;
}

export interface Present {
  run(raw: unknown): Promise<CallToolResult>;
  /** Stops renewing. The lease then runs out by itself within three seconds. */
  close(): void;
}

const text = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const failure = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

function complaint(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
  return `Invalid arguments: ${issues}. Fix them and call again.`;
}

const WAIT_FOR_HAND_OVER =
  "The presenter holds control, so nothing moved. Do not retry. Ask them to press Hand to agent on the page.";

/**
 * The agent's side of the control lease. It reaches the open page through the deck server's link, keeps the lease
 * renewed while the agent is working, and reports each answer as the page gave it. It never retries a command,
 * and it never asks for control: the presenter hands it over on the page.
 */
export function createPresent(folder: string, options: PresentOptions = {}): Present {
  const call = options.fetch ?? fetch;
  const renewMs = options.renewMs ?? RENEW_EVERY_MS;
  const idleMs = options.idleMs ?? IDLE_LET_GO_MS;
  const now = options.now ?? Date.now;
  let held: Held | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let beating = false;
  let lastUse = now();

  async function reach(op: string, body: unknown): Promise<Reached> {
    const link = readLink(folder);
    if (!link) {
      return {
        reached: false,
        message:
          "No deck server is running for this folder. Ask the presenter to run `depthcue serve` on it and open the page.",
      };
    }
    try {
      const response = await call(new URL(`_depthcue/lease/${op}`, link.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Depthcue-Token": link.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const answer = (await response.json()) as Answer;
      if (response.status !== 200) {
        return { reached: false, message: answer.message ?? `The deck server answered ${response.status}.` };
      }
      return { reached: true, answer };
    } catch (error) {
      return {
        reached: false,
        message: `Could not reach the deck server at ${link.url}: ${(error as Error).message}. It may have stopped.`,
      };
    }
  }

  function stopRenewing() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  async function beat() {
    if (beating) return;
    const sent = held;
    if (!sent || now() - lastUse > idleMs) {
      held = undefined;
      return stopRenewing();
    }
    beating = true;
    const outcome = await reach("renew", { leaseId: sent.id, epoch: sent.epoch });
    beating = false;
    if (held !== sent) return;
    // Anything but a clean renewal means the lease is gone or cannot be kept. The agent hears about it on its next call.
    if (!outcome.reached || outcome.answer.ok !== true) {
      held = undefined;
      stopRenewing();
    }
  }

  /** Takes in what an answer says about who holds control. */
  function learn(answer: Answer) {
    if (answer.holder !== "agent") {
      held = undefined;
      return stopRenewing();
    }
    if (answer.lease) {
      const same = held?.id === answer.lease.id;
      held = {
        id: answer.lease.id,
        epoch: answer.lease.epoch,
        rev: answer.rev ?? 0,
        sequence: same ? (held as Held).sequence : 0,
      };
    } else if (held && answer.rev !== undefined) {
      held.rev = answer.rev;
    }
    timer ??= setInterval(() => void beat(), renewMs);
    timer.unref?.();
  }

  /** The page's answer for the agent: what it said, without the lease's internals. */
  function report(answer: Answer): CallToolResult {
    const { ok, code, message, holder, rev, released, lease, last, position } = answer;
    const body = {
      ...(ok === undefined ? {} : { ok }),
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
      holder,
      rev,
      ...(released === undefined ? {} : { released }),
      position,
      ...(lease ? { scenes: lease.scenes, actions: lease.actions } : {}),
      ...(holder === "human" && last ? { lastEnded: last.reason } : {}),
      ...(holder === "human" && ok === false ? { next: WAIT_FOR_HAND_OVER } : {}),
    };
    return ok === false
      ? { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] }
      : text(body);
  }

  async function status(): Promise<CallToolResult> {
    const outcome = await reach("state", {});
    if (!outcome.reached) return failure(outcome.message);
    learn(outcome.answer);
    const answer = outcome.answer;
    return report(
      answer.holder === "human"
        ? { ...answer, message: "The presenter holds control. Ask them to press Hand to agent on the page." }
        : answer,
    );
  }

  async function release(): Promise<CallToolResult> {
    const outcome = await reach("release", {});
    if (!outcome.reached) return failure(outcome.message);
    learn(outcome.answer);
    return report(outcome.answer);
  }

  async function command(args: Args): Promise<CallToolResult> {
    const { action } = args;
    if (action === "goto" && args.scene === undefined) {
      return failure("goto needs `scene`, the scene id. Call deck_get with view 'outline' to list them.");
    }
    if (action === "invoke" && (args.block === undefined || args.command === undefined)) {
      return failure("invoke needs `block`, a block id on the scene on screen, and `command`.");
    }
    if (!held) {
      const outcome = await reach("state", {});
      if (!outcome.reached) return failure(outcome.message);
      learn(outcome.answer);
      if (outcome.answer.holder !== "agent")
        return report({ ...outcome.answer, ok: false, code: "no-lease", message: WAIT_FOR_HAND_OVER });
    }
    const lease = held as Held;
    const sent =
      action === "goto"
        ? { scene: args.scene, ...(args.step === undefined ? {} : { step: args.step }) }
        : action === "invoke"
          ? {
              block: args.block,
              command: args.command,
              ...(args.args === undefined ? {} : { args: args.args }),
            }
          : undefined;
    const outcome = await reach("submit", {
      leaseId: lease.id,
      epoch: lease.epoch,
      sequence: ++lease.sequence,
      expectedRev: lease.rev,
      action,
      ...(sent === undefined ? {} : { args: sent }),
    });
    if (!outcome.reached) return failure(outcome.message);
    learn(outcome.answer);
    return report(outcome.answer);
  }

  return {
    async run(raw) {
      const parsed = presentArgs.safeParse(raw ?? {});
      if (!parsed.success) return failure(complaint(parsed.error));
      lastUse = now();
      if (parsed.data.action === "status") return status();
      if (parsed.data.action === "release") return release();
      return command(parsed.data);
    },
    close() {
      held = undefined;
      stopRenewing();
    },
  };
}
