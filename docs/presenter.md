# Presenter view

A second window for the person presenting. It shows a picture of the scene on screen with its notes, a picture of
what the next click will show, the scene after that, a clock for the talk and one for the scene, and Previous and
Next buttons, while the first window shows the room only the deck.

This is the small version that ships with 0.1. Multi-screen placement, rehearsal mode and a handout page are
v0.2 work, as the [plan](PLAN.md) says.

## The deck window

While a deck is presented, the slide fills the window and the controls float over its foot. They fade out two
seconds after the pointer stops, and the pointer hides with them. Moving the pointer brings them back. They stay
while the pointer is over them, while the keyboard is in them and while the **More** menu is open.

The controls hold Previous and Next, the count, the scene's title, who the scene was planned to be led by
("Planned · Human-led"), who has control now when the lease is loaded ("Live"), the voice-over's Play button on a
voiced scene, and **More**. The count says where you are as "3 of 7 · reveal 1 of 2", or "3 of 7" for a scene
without steps. More holds All scenes (`g`), Reading view (`r`), Speaker notes (`n`), and Captions (`c`) and Voice
leads (`a`) on a voiced scene. A choice, Escape or a press outside puts the menu away; Escape puts the keyboard back
on More.

`g` opens an overview of every scene as a card with its number, title and lead, with the scene on show marked and
the keyboard on it. The arrow keys move over the cards, Home and End go to the first and last, Enter opens a
scene, and Escape or `g` closes the overview. While it is open no other key moves the deck.

## Using the presenter view

Run `depthcue serve <folder>` and open the address it prints. The deck window's controls have a **Presenter view**
button.
It opens the same address with `?presenter` in a small window. Drag that window to the screen you look at and
put the deck window on the one the room sees. Typing `?presenter` onto the address by hand does the same.

The window shows:

- the scene's number, the reveal shown out of the reveals it has, and who the scene was planned to be led by, as
  "Scene 2 of 7 · reveal 1 of 2 · Planned: Agent-led";
- a picture of the scene as the room sees it, with the blocks the current step has revealed, beside its title, and
  its `notes` below, as plain text with the line breaks kept;
- what the next click does, as a picture and in words. Inside a scene the picture shows the scene with the next
  reveal's blocks, and the label says "Next click: reveal 2 of 3" and how many blocks it reveals. At the end of a
  scene the picture is the next scene, with its title and summary, so you can lead into it. After the last scene
  it says the deck ends;
- **After that**: a smaller picture and the title of the scene that follows the next click's scene;
- who is presenting, as "You present" or "Agent presenting", with the same circle and diamond that the deck
  window's chip uses;
- two clocks. **Talk** starts when the window opens, and **Reset** puts it back to 0:00. **This scene** starts
  again each time the deck moves to another scene, so you can see when one runs long.

The pictures are drawn by the player itself, at 1280 by 720 and scaled to fit, so they match what the room sees.
They cannot be clicked or focused, and a screen reader reads each as one image named by its label and the scene's
title. A video in a picture shows its poster and does not play.

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
| `presenter.js` | the presenter view | 2.8 KB      | 3.0 KB |

The pictures use the player's own scene drawing, which the page already has, so they add little to
`presenter.js`. The styles are part of `player.css`. A page without the attribute, such as an exported
deck, loads neither script. An exported deck has no presenter view yet: a `BroadcastChannel` between `file://`
pages is not reliable, so exports need their own way to connect the two windows.

## How it is tested

`packages/player/test/presenter.test.ts` (happy-dom) runs both sides over a fake channel pair: the messages and
what is dropped, each state the window can show, the next-move preview for every case, the three pictures and
the reveals they draw, both clocks on a fake clock, keys and buttons, taking over, live reload, teardown, and the
two sides together with a real lease.
`packages/cli/test/presenter-e2e.test.ts` opens two real pages in headless Chrome against `depthcue serve`: moves
in both directions, a real click that hands over, an agent move through the link that shows in both windows,
Escape in the presenter window, the popup opened from the button, the pictures scaled to their boxes, the timer, a
live file change, and a page whose
shell lacks the attribute loading none of the code. It also fails on any console error, which catches a script or
style that the page's content policy refuses.

## Not yet

- Exported decks have no presenter view. See [offline export](export.md).
- No multi-screen placement, rehearsal mode, planned per-scene timings or speaker script.
- The scene clock shows how long a scene has been on screen. It does not warn when a scene runs long.
- A chart or video that a module brings to life is shown as the player draws it before the module loads.
