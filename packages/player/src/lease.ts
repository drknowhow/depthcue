import {
  type CommandResult,
  createLeaseController,
  type LeaseAction,
  type LeaseController,
  type LeaseEvent,
  type LeaseHost,
  type LeaseState,
  REVOKE_TEXT,
  type RenewResult,
  type RevokeReason,
} from "@depthcue/core";
import { h } from "./dom.ts";
import type { PlayerSource } from "./load.ts";
import { nextPosition, previousPosition, samePosition, stepCount } from "./model.ts";
import type { Player, PlayerState } from "./player.ts";

/** What an agent may call on the page. There is no grant here: only a person hands over control. */
export interface AgentApi {
  state(): LeaseState;
  renew(input: unknown): RenewResult;
  submit(input: unknown): Promise<CommandResult>;
  /** The agent is finished or leaving. */
  release(): boolean;
  /** Where the deck is: the scene on screen, the step shown and how many steps the scene has. */
  position(): { scene: string; step: number; steps: number };
}

export interface LeaseOptions {
  player: Player;
  source: () => PlayerSource;
  /** Accept hand-over clicks that a script made. Default false: only a real click or key press can hand over. */
  allowScriptedGrant?: boolean;
  /** How long a reason for losing control stays on screen. Default 6000. */
  noticeMs?: number;
}

export interface LeaseMount {
  controller: LeaseController;
  agent: AgentApi;
  /** The page calls this whenever the player's state changes, whoever changed it. */
  changed(state: PlayerState): void;
  /** Answers the calls that the server relays from an agent, which arrive as `lease` events on `events`. */
  link(events: EventSource): void;
  destroy(): void;
}

const SHORT: Record<RevokeReason, string> = {
  takeover: "You took over",
  expired: "Agent timed out",
  disconnect: "Agent left",
  "agent-error": "Agent error",
  "section-exit": "Section ended",
  replaced: "New hand-over",
};

/**
 * Puts the control lease on the page. The host maps the lease's four actions onto the player and a small chip
 * in the controls bar says who is presenting. A key or a click on the deck's controls takes control back before
 * it does its work. Any other move the lease did not make, such as the back button or a new address, takes it
 * back as soon as the player has moved: the browser runs the player's own listener for those first.
 */
export function mountLease(options: LeaseOptions): LeaseMount {
  const { player } = options;
  const noticeMs = options.noticeMs ?? 6000;
  const scenes = () => options.source().scenes;
  const root = document.querySelector<HTMLElement>(".dc-player");
  const bar = root?.querySelector<HTMLElement>(".dc-controls");
  if (!root || !bar) throw new Error("The lease needs a mounted player.");

  /** True while the lease itself is moving the deck, so its own moves are not taken for the person's. */
  let acting = false;
  const act = <T>(move: () => T): T => {
    acting = true;
    try {
      return move();
    } finally {
      acting = false;
    }
  };

  const host: LeaseHost = {
    scene: () => scenes()[player.state.position.scene]?.id ?? "",
    target(action, args) {
      const position = player.state.position;
      const here = scenes()[position.scene]?.id;
      if (action === "next") return scenes()[(nextPosition(scenes(), position) ?? position).scene]?.id;
      if (action === "previous")
        return scenes()[(previousPosition(scenes(), position) ?? position).scene]?.id;
      if (action === "goto")
        return scenes().find((scene) => scene.id === (args as { scene: string }).scene)?.id;
      const block = (args as { block: string }).block;
      return scenes()[position.scene]?.blocks.some((one) => one.id === block) ? here : undefined;
    },
    run(action: LeaseAction, args, signal) {
      if (action === "next") return act(() => player.next());
      if (action === "previous") return act(() => player.previous());
      if (action === "goto") {
        const { scene, step } = args as { scene: string; step?: number };
        const before = player.state.position;
        act(() => player.go({ scene: scenes().findIndex((one) => one.id === scene), step: step ?? 0 }));
        return !samePosition(player.state.position, before);
      }
      const { block, command, args: given } = args as { block: string; command: string; args?: unknown };
      // A block's module may still be loading; give it its turn, then do the command unless control moved on.
      return player.settled().then(() => !signal.aborted && act(() => player.invoke(block, command, given)));
    },
  };

  const controller = createLeaseController({ host });

  const text = h("span", { class: "dc-lease-text", "aria-hidden": "true" });
  const status = h("span", { class: "dc-sr-only", role: "status" });
  const grant = h(
    "button",
    { type: "button", class: "dc-btn dc-lease-button", "data-lease-action": "grant" },
    "Hand to agent",
  );
  const take = h(
    "button",
    { type: "button", class: "dc-btn dc-lease-button", "data-lease-action": "takeover", hidden: true },
    "Take over",
    h("kbd", { class: "dc-lease-key" }, "Esc"),
  );
  // "Live" says who has control now, beside the "Planned" lead the scene was written for.
  const kicker = h("span", { class: "dc-k", "aria-hidden": "true" }, "Live");
  const chip = h("div", { class: "dc-lease", "data-holder": "human" }, kicker, text, status, grant, take);
  bar.insertBefore(chip, bar.querySelector(".dc-voice"));

  let notice: ReturnType<typeof setTimeout> | undefined;
  let message = "";

  function say(short: string, long: string) {
    text.textContent = short;
    chip.title = long;
    // The same words twice would be read twice, so the live region only changes when the sentence does.
    if (long !== message) status.textContent = long;
    message = long;
  }

  function paint(state: LeaseState = controller.state()) {
    chip.dataset.holder = state.holder;
    take.hidden = state.holder !== "agent";
    grant.hidden = state.holder === "agent" || player.state.mode !== "present";
    if (state.holder === "agent") {
      const count = state.lease.scenes.length;
      say(
        "Agent presenting",
        `The agent is presenting ${count === 1 ? "this scene" : `${count} scenes`}. Press Escape to take over.`,
      );
    } else if (notice === undefined) {
      say("You present", "You are presenting.");
    }
  }

  const clearNotice = () => {
    if (notice !== undefined) clearTimeout(notice);
    notice = undefined;
  };

  /** Shows a message in place of "You present" for a few seconds. */
  function flash(short: string, long: string) {
    clearNotice();
    say(short, long);
    notice = setTimeout(() => {
      notice = undefined;
      paint();
    }, noticeMs);
  }

  const unsubscribe = controller.subscribe((event: LeaseEvent) => {
    if (event.type === "revoked") flash(SHORT[event.reason], REVOKE_TEXT[event.reason]);
    if (event.type === "granted" || event.type === "revoked") paint();
  });

  const leadOf = (index: number) => scenes()[index]?.lead ?? "human";

  /** The run of neighbouring scenes that share the lead of the one on screen. */
  function section(): string[] {
    const at = player.state.position.scene;
    const lead = leadOf(at);
    let from = at;
    let to = at;
    while (from > 0 && leadOf(from - 1) === lead) from -= 1;
    while (to + 1 < scenes().length && leadOf(to + 1) === lead) to += 1;
    return scenes()
      .slice(from, to + 1)
      .map((scene) => scene.id);
  }

  const onChipClick = (event: MouseEvent) => {
    const control =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-lease-action]") : null;
    if (!control) return;
    if (control.dataset.leaseAction === "takeover") {
      controller.takeover();
    } else if (event.isTrusted || options.allowScriptedGrant) {
      try {
        controller.grant({ scenes: section() });
      } catch (error) {
        flash("Could not hand over", (error as Error).message);
      }
    }
  };

  // Input from the person comes first: control is back with them before the deck moves.
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    const onVideo = target?.tagName === "VIDEO";
    const onControl = Boolean(target?.closest("button, a, summary"));
    const moves =
      event.key === "Escape" ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key === "r" ||
      ((event.key === "ArrowRight" ||
        event.key === "ArrowLeft" ||
        event.key === "PageDown" ||
        event.key === "PageUp") &&
        !onVideo) ||
      ((event.key === " " || event.key === "Enter") && !onControl && !onVideo);
    if (moves) controller.takeover();
  };

  const onBarClick = (event: MouseEvent) => {
    const action =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (action && ["next", "previous", "read"].includes(action.dataset.action ?? "")) controller.takeover();
  };

  // Compared by scene id, so a deck edit that moves the scene on screen to another index is not a move.
  const where = (state: PlayerState) => ({
    mode: state.mode,
    scene: scenes()[state.position.scene]?.id,
    step: state.position.step,
  });
  let seen = where(player.state);
  const changed = (state: PlayerState) => {
    const now = where(state);
    const moved = now.mode !== seen.mode || now.scene !== seen.scene || now.step !== seen.step;
    seen = now;
    if (moved) {
      // A move the lease did not make is the person's, whatever route it took: the back button, a new address.
      if (!acting) controller.takeover();
      controller.changed();
    }
    paint();
  };

  chip.addEventListener("click", onChipClick);
  root.addEventListener("click", onBarClick, true);
  document.addEventListener("keydown", onKey, true);
  paint();

  const position = () => {
    const at = player.state.position;
    const scene = scenes()[at.scene];
    return { scene: scene?.id ?? "", step: at.step, steps: scene ? stepCount(scene) : 0 };
  };

  const agent: AgentApi = {
    state: () => controller.state(),
    renew: (input) => controller.renew(input),
    submit: (input) => controller.submit(input),
    release: () => controller.disconnect(),
    position,
  };

  /** Runs one relayed call against the lease. Every answer says where the deck is, so the agent need not ask. */
  async function perform(op: unknown, input: unknown): Promise<unknown> {
    if (op === "state") return { ...controller.state(), position: position() };
    if (op === "renew") return { ...controller.renew(input), position: position() };
    if (op === "submit") return { ...(await controller.submit(input)), position: position() };
    if (op === "release") {
      const released = controller.disconnect();
      return { released, ...controller.state(), position: position() };
    }
    return { ok: false, code: "unknown-call", message: "That call is not one the page knows." };
  }

  async function onCall(event: Event) {
    let call: { id?: unknown; op?: unknown; input?: unknown } | null = null;
    try {
      call = JSON.parse(String((event as MessageEvent).data));
    } catch {
      // Not JSON, so not a call; the id check below drops it.
    }
    if (typeof call?.id !== "string") return;
    const result = await perform(call.op, call.input);
    await fetch("/_depthcue/lease/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Depthcue-Reply": "1" },
      body: JSON.stringify({ id: call.id, result }),
    }).catch(() => undefined);
  }

  let linked: EventSource | undefined;

  return {
    controller,
    agent,
    changed,
    link(events) {
      linked?.removeEventListener("lease", onCall);
      linked = events;
      events.addEventListener("lease", onCall);
    },
    destroy() {
      linked?.removeEventListener("lease", onCall);
      clearNotice();
      unsubscribe();
      controller.destroy();
      root.removeEventListener("click", onBarClick, true);
      document.removeEventListener("keydown", onKey, true);
      chip.remove();
    },
  };
}
