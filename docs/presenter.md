# Presenter view

A second window for the person presenting. It shows the notes for the scene on screen, a timer, what the next
move will show, and Previous and Next buttons, while the first window shows the room only the deck.

This is the small version that ships with 0.1. Multi-screen placement, rehearsal mode and a handout page are
v0.2 work, as the [plan](PLAN.md) says.

## Using it

Run `depthcue serve <folder>` and open the address it prints. The controls bar has a **Presenter view** button.
It opens the same address with `?presenter` in a small window. Drag that window to the screen you look at and
put the deck window on the one the room sees. Typing `?presenter` onto the address by hand does the same.

The window shows:

- the scene's number, the step shown out of the steps it has, and whether the scene is human-led, agent-led or
  shared;
- the scene's title and its `notes`, as plain text with the line breaks kept;
- what the next move does. Inside a scene it says "Next click: step 2 of 3" and how many blocks that step
  reveals. At the end of a scene it gives the title and summary of the scene that follows, so you can lead into it.
  After the last scene it says the deck ends;
- who is presenting, as "You present" or "Agent presenting", with the same circle and diamond that the deck
  window's chip uses;
- a timer that starts when the window opens. **Reset** puts it back to 0:00.

**Previous** and **Next**, the arrow keys and Page Up and Page Down ask the deck window to move. It moves, and
the presenter view follows it, so the two windows cannot disagree about where the deck is. A move you make in
the deck window shows up in the presenter view the same way.

If an agent has been handed control, a **Take over** button appears, and Escape does the same. A move from the
presenter view while the agent holds control is a move by the person: control comes back first, as it does when
you press an arrow key in the deck window. See [the control lease](lease.md).

If you edit the deck while presenting, the notes and titles update. If the scene on screen is removed, the
window says it is waiting until the deck window tells it where the deck is.

## How it works

The two windows talk over a `BroadcastChannel` named `depthcue-presenter`. It reaches pages of one origin and
nothing else, so it works for one `depthcue serve` at a time and needs no server code.

The deck window sends `{type: "state", scene, step, holder}`, with the scene named by id. It sends one when
something changes and never twice in a row for the same state. The presenter view sends `hello`, `next`,
`previous` or `takeover`. It asks `hello` when it opens and every two seconds until the deck window answers, so
it works whichever window opened first. Both sides drop any message that is not one of those, so a stray tab on
the same origin cannot move the deck by posting something odd.

The presenter view has no place of its own and no lease. It does not open the server's event stream as a page
an agent can call, so opening it never changes which page the agent link reaches. Only the deck window does.

## What it costs

A page loads this code only when its shell asks for it with `data-presenter`, which `depthcue serve` adds. The
two scripts are separate files, loaded after the deck is on screen:

| File           | Loaded by          | Brotli size | Budget |
| -------------- | ------------------ | ----------- | ------ |
| `broadcast.js` | the deck window    | 0.8 KB      | 1.0 KB |
| `presenter.js` | the presenter view | 1.8 KB      | 2.3 KB |

The styles are part of `player.css`, which grew by 0.4 KB. A page without the attribute, such as an exported
deck, loads neither script. An exported deck has no presenter view yet: a `BroadcastChannel` between `file://`
pages is not reliable, so exports need their own way to connect the two windows.

## How it is tested

`packages/player/test/presenter.test.ts` (happy-dom) runs both sides over a fake channel pair: the messages and
what is dropped, each state the window can show, the next-move preview for every case, the timer on a fake
clock, keys and buttons, taking over, live reload, teardown, and the two sides together with a real lease.
`packages/cli/test/presenter-e2e.test.ts` opens two real pages in headless Chrome against `depthcue serve`: moves
in both directions, a real click that hands over, an agent move through the link that shows in both windows,
Escape in the presenter window, the popup opened from the button, the timer, a live file change, and a page whose
shell lacks the attribute loading none of the code. It also fails on any console error, which catches a script or
style that the page's content policy refuses.

## Not yet

- Exported decks have no presenter view.
- No multi-screen placement, rehearsal mode, per-scene timings or speaker script.
- The timer is for the whole talk. It does not warn when a scene runs long.
