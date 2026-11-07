# Control lease

The human drives a presentation by default. An agent drives only while it holds a lease: a short, scoped
permission the human grants and the agent has to keep renewing. When anything goes wrong the lease ends and the
human has control again, with the deck exactly where it was.

`createLeaseController` in `@depthcue/core` is the whole protocol as plain logic. It takes a host (what scene is
on screen, what a command would touch, how to run it) and a clock, so the page, the tests and a replayed fault
all run the same rules. The page uses it, as described below; the agent link is built on it in the next change.

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

## On the page

A deck that `depthcue serve` shows loads the lease; an exported deck does not, because the script is fetched only
when the page's root element has `data-lease`. The controls get a chip, labelled Live, that says who is presenting, a
**Hand to agent** button, and, while an agent holds control, **Take over** with the Escape key. When control comes
back the chip says why for six seconds (You took over, Agent timed out, Agent left, Agent error, Section ended),
and a screen reader hears the full sentence from `REVOKE_TEXT`.

**Hand-over.** The agent gets every action over the run of neighbouring scenes that share the lead of the scene on
screen. A scene with no lead counts as human-led. Only a real click or key press hands over: the page ignores a
click that a script made with `element.click()`, so a script cannot give itself control. A browser driver that
sends real input events can still press the button, so this stops accidents and not a hostile page.

**Takeover.** Escape, the arrow, Page Up and Page Down keys, Space and Enter (unless focus is on a control or a
video), Home, End and `r` take control back before the key moves the deck. So does a click on the previous or next
button, or on Reading view in the More menu. The notes key does not. Any other move that the lease did not make, such as the back button or an
edited address, takes control back as soon as the player has followed it; Chrome runs the player's own listener
for those first, so they cannot be caught earlier. Moves the agent makes itself never count.

**What the agent can call.** `window.depthcue.lease` has `state()`, `renew()`, `submit()` and `release()`, and
nothing that grants, plus `position()`, which names the scene on screen, the step shown and the scene's step
count. The player writes a history entry only when the scene changes, so the back button steps through scenes, not
the agent's steps.

## The agent link

An agent is not in the browser, so the server carries its calls to the page. `depthcue serve` writes a link file
with the server's address and a secret, and the agent posts to `/_depthcue/lease/<call>` where `<call>` is `state`,
`renew`, `submit` or `release`:

```
POST /_depthcue/lease/submit
X-Depthcue-Token: <secret from the link file>
Content-Type: application/json

{"leaseId": "...", "epoch": 1, "sequence": 1, "expectedRev": 0, "action": "next"}
```

The server sends the call to the open page as a `lease` event on the page's event stream, the page runs it against
its lease, and the server returns what the page answered. The server decides nothing. A refusal, an expiry or a
takeover reaches the agent as the page's own answer, with status 200 and the usual `ok`, `code` and `message`.
Every answer also carries `position`, so an agent need not ask where the deck is after each move.

**Finding the server.** The link file is `depthcue-links/<hash>.json` in the operating system's temporary directory,
named by a hash of the deck folder's real path, so an agent that knows the folder finds the server without being
told a port. It holds `url`, `token` and `pid`, is readable only by its owner where the system supports that, and is
deleted when the server stops, unless a newer server has replaced it. Nothing secret is written into the deck
folder, where it could be committed. `@depthcue/cli/link` exports `readLink(folder)`.

**What the link refuses.** A call without the secret gets 401. A call that a web page on another origin sent gets
403 even with the secret, because the server checks `Origin` and `Sec-Fetch-Site`. Only POST with a JSON body of up
to 64 KB is accepted (405, 415, 413, 400). The page's own answers go to `/_depthcue/lease/reply` and need a custom
header that a web page on another origin cannot send without a preflight, which the server never answers; the page
never holds the secret.

**When the link cannot reach the page.** 503 `no-page` means no page with the lease is open, or the page closed
while the call waited. 504 `page-timeout` means the page did not answer within 3 s (8 s for `submit`, since a
command can run for 5 s). These errors come from the link, not the lease: the lease is unchanged, and if the page
is gone the lease expires on its own after three seconds without a renewal.

**One page.** The newest page that opens the event stream gets the calls, and an older one gets them again when the
newest closes. A second tab therefore takes the link from the first. Nothing is shared between pages.

## The MCP tool

`deck_present` is the one tool an agent needs for presenting. Its `action` is one of:

- `status` (the default) says who holds control, the position (`scene`, `step`, `steps`) and, when the agent holds
  control, the `scenes` and `actions` it was given.
- `next`, `previous`, `goto` (`scene`, optional `step`) and `invoke` (`block`, `command`, optional `args`) move the
  deck within those scenes.
- `release` hands control back.

The tool finds the server through the link file for the MCP server's folder, so it needs `depthcue serve` running on
that folder with its page open. It asks the page for the lease once, then numbers its own commands and passes back
the revision each answer carries, so the agent never handles lease ids, epochs or sequence numbers. Each reply says
where the deck is now.

**Renewing.** While the agent holds control, the tool renews the lease every second from the MCP process, so the
agent does not have to. It stops when the lease ends, when a renewal cannot be sent, when the MCP server closes,
on `release` (which also ends the lease at once) and after two minutes with no call to the tool. Apart from
`release`, stopping leaves the lease to run out three seconds later. If the MCP process dies, control is back with
the presenter in three seconds. If the agent only stops calling, it is back after two minutes. A presenter can take
it back at any moment with Escape.

**Never retried.** A command that fails is reported once, in the page's words, and not sent again. A rejection that
means the agent's view was a revision behind (`stale-state`) still updates the tool's revision, so the agent's own
next try can work. When the answer says `holder: "human"`, the presenter took over; the reply adds `next`, which
tells the agent to stop and wait to be handed control again, and nothing the agent calls can take it back.

## How it is tested

`packages/core/test/lease.test.ts` covers each rule one at a time. `lease-faults.test.ts` runs 400 seeded sessions
in which a human and an agent act in random order against hosts that throw, hang, answer late or answer at once,
with the clock sometimes stalling so timers run late, and checks after every step that the rules held. It also
simulates a 30-minute presentation with a fault every minute and checks that the lease is never lost without
cause, that control always returns to the human, and that the deck never moves without a lease or the human. A
failing session replays from its seed.

The page is tested in `packages/player/test/lease.test.ts` (happy-dom): the chip, hand-over, what each action does
to the player, every takeover key and the keys that must not take over, expiry and renewal on a fake clock, and a
deck edit under a lease. `lease-link.test.ts` there covers the page's side of the link: each relayed call, calls it
must drop, a failed reply, and letting go of the event stream. `packages/cli/test/lease-e2e.test.ts` drives the
served page in headless Chrome with real clicks and key presses, including four seconds of real renewals followed
by a real expiry, and the back button.

The link has `lease-relay.test.ts` (a stand-in page on a real server: secret, origin, size, timeouts, concurrent
calls, closing pages, shutdown, forged replies), `link.test.ts` (the link file) and `lease-link-e2e.test.ts`, where
Node makes the agent's calls over HTTP and Chrome holds the page: a real click hands over, the agent moves the
deck, four seconds of renewals through the link keep the lease, Escape takes it back, and a closed page answers 503.

The tool has `packages/mcp/test/present.test.ts`, which runs the real lease controller as a stand-in page and
checks the numbering, the renewals on a fake clock, the idle limit, takeover, release and every failure of the link.
`present-e2e.test.ts` starts `depthcue serve` as a separate process, finds it through the link file, and drives it
with the tool and a real click and key press in headless Chrome, including 4.5 s with no call from the agent.

## Not yet

- A second window has its own lease. Nothing is shared between tabs.
- The presenter window is a small first version with notes, a timer and a next-scene preview; see
  [the presenter view](presenter.md). Multi-screen placement is v0.2 work, as the plan says.
