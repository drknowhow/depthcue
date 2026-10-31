# Control lease

The human drives a presentation by default. An agent drives only while it holds a lease: a short, scoped
permission the human grants and the agent has to keep renewing. When anything goes wrong the lease ends and the
human has control again, with the deck exactly where it was.

`createLeaseController` in `@depthcue/core` is the whole protocol as plain logic. It takes a host (what scene is
on screen, what a command would touch, how to run it) and a clock, so the page, the tests and a replayed fault
all run the same rules. The page and the agent link are built on it in the next changes. This page describes the
controller.

## What a lease covers

The human grants a section: a list of scene ids, which has to include the scene on screen, and optionally a
subset of the four actions. A grant that cannot work throws and leaves the lease already out untouched.

| Action     | Arguments                                     |
| ---------- | --------------------------------------------- |
| `next`     | none                                          |
| `previous` | none                                          |
| `goto`     | `{ scene, step? }`                            |
| `invoke`   | `{ block, command, args? }`, a module command |

That is the whole list. A lease cannot edit the deck because no action says how: a command named `apply`,
`edit` or anything else is refused as `unknown-action`.

## What a command carries

```json
{ "leaseId": "…", "epoch": 0, "sequence": 7, "expectedRev": 12, "action": "next" }
```

`epoch` counts revoked leases. `sequence` rises with each command; a number already used is a duplicate, and a
gap is fine. `rev` counts position changes, whoever made them, and `expectedRev` is the one the agent last saw.
Every result carries the current `rev`, `epoch` and `holder`, so the agent always learns where things stand.

A command is refused, and nothing runs, when it is not a lease command at all (`malformed`) or when it fails one
of these checks, in this order:

1. No lease is out (`no-lease`), the lease ran out (`expired`), or control changed hands since it was issued
   (`stale-epoch`).
2. It names a different lease than the one out (`unknown-lease`), or a different epoch (`stale-epoch`).
3. Its sequence number was already used (`duplicate`).
4. The action is not one of the four (`unknown-action`) or not one this lease allows (`out-of-scope`).
5. Its arguments do not fit the action (`malformed`).
6. It names a scene or block that does not exist (`unknown-target`) or one outside the section (`out-of-scope`).

An accepted command waits in a queue and runs one at a time. When its turn comes it is checked twice more, against
the deck as it is by then: the `rev` must still be the one it expected (`stale-state`) and its target must still be
inside the section. Then it runs. It answers `not-run` when there was nothing to do, such as `next` on the last
scene; the lease stays. It answers `failed` when the host threw or took longer than five seconds, and that ends the
lease.

## How a lease ends

| Reason         | What happened                                                            |
| -------------- | ------------------------------------------------------------------------ |
| `takeover`     | The human took control back. Navigation, Escape or a click will do this. |
| `expired`      | No renewal for three seconds. An agent renews every second.              |
| `disconnect`   | The agent's link dropped.                                                |
| `agent-error`  | The agent reported an error, or a command threw or hung.                 |
| `section-exit` | The deck moved to a scene outside the section.                           |
| `replaced`     | The human granted a new lease while one was out.                         |

Ending a lease bumps the epoch, answers every queued command `cancelled`, and aborts the one that is running. It
never moves the deck, never goes back a scene and never resets anything. A command that arrives late from the old
lease is refused. To hand control back to the agent the human grants again; nothing resumes by itself.

Only a renewal extends a lease. Commands do not, so an agent that sends commands but forgets to renew still loses
the lease after three seconds. The controller checks the time whenever it is asked, so a timer that fires late
cannot let an expired lease through.

## Using it

```ts
import { createLeaseController } from "@depthcue/core";

const controller = createLeaseController({
  host: {
    scene: () => player.state.scene,
    target: (action, args) => sceneThisWouldTouch(action, args), // undefined if it names nothing real
    run: (action, args, signal) => runIt(action, args, signal), // true if something happened
  },
});

controller.subscribe((event) => showStatus(event)); // granted, renewed, command, revoked
const granted = controller.grant({ scenes: ["intro", "demo"], actions: ["next", "goto"] });
// the agent sends: controller.renew({ leaseId, epoch }) each second, controller.submit(command) as needed
controller.takeover(); // the human, at any time
controller.changed(); // the host calls this after every position change
```

`REVOKE_TEXT` has a sentence for each reason, written for the presenter to read.

## How it is tested

`packages/core/test/lease.test.ts` covers each rule one at a time. `lease-faults.test.ts` runs 400 seeded sessions
in which a human and an agent act in random order against hosts that throw, hang, answer late or answer at once,
with the clock sometimes stalling so timers run late, and checks after every step that the rules held. It also
simulates a 30-minute presentation with a fault every minute and checks that the lease is never lost without
cause, that control always returns to the human, and that the deck never moves without a lease or the human. A
failing session replays from its seed.

## Not yet

- The page does not use the controller yet: no status chip, no takeover keys, no hand-over button.
- There is no agent link, so no agent can reach a lease. That arrives with the MCP tools.
- The full presenter window (multi-screen, notes, timer) is v0.2 work, as the plan says; a minimal one comes with the page integration.
