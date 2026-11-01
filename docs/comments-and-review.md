# Comments and review

Two features let a person and an agent work on one deck without stepping on each other. Comments are notes pinned to
a block, and the agent can read and answer them. Review lists what an agent changed, so you can accept each change or
put it back.

Both live in files beside the deck, and neither is part of the deck. They do not change the deck's revision, an export
leaves them out, and the player and presenter view never load them.

## Comments

### Making one

Press the Comment button in the quick bar under the slide, or press `M`. The next press on a block starts a comment
at the spot you pressed, marked by a dashed pin. Type the note and choose:

- Comment, which saves it.
- Ask the agent, which saves it as a request for the agent to act on. This is the only way to ask the agent
  something. A later reply never turns a comment into a request.

The pin sits at a spot on the block, as a fraction of the block, so it follows the block when you move, resize or pin
it. `Esc` closes the box and gives the keyboard back to the pin.

### Reading and answering

Each pin has a number, which counts the scene's comments in the order they were made. Resolved comments keep their
numbers. A pin shows its state by color and by its label: open, waiting for the agent, answered by the agent, or
resolved. Press a pin to open its thread. The thread has a reply box, Resolve or Reopen, and Delete, which asks twice.

The top bar has a Comments button with the number of open comments, in the action color while any is waiting on the
agent, and a Resolved button that shows or hides resolved pins (dimmed). Each scene on the strip shows its open count,
and the storyboard shows it too. A pin whose block was later deleted moves to the slide's top left with a dashed edge,
and its thread says the block is gone. It can still be answered, resolved or deleted.

Comments are not part of Undo, because an agent may already have read a reply. If the agent writes a comment while you
are saving one, the editor reads the file again and tries once more, so neither is lost.

### What the agent can do

The agent reads comments through `deck_get`. The outline shows the comments file's revision, the count of open
comments, and the tasks: open comments you marked "Ask the agent" whose last message is yours. A task stops being a
task when the agent replies and becomes one again when you write next. `deck_get` with `view: "comments"` returns whole
threads.

The agent writes through a separate tool, `deck_comment`, which can add, reply, resolve and reopen. It cannot delete a
comment or mark one as a request, and it cannot sign as you. Only a person asks the agent to act, and only the person
who wrote a comment removes it. A comment the agent writes shows up in an open editor without a reload.

From a terminal, `depthcue comments list <deck-folder> [--all] [--json]` prints the comments and the revision to pass
back, and `depthcue comments apply <deck-folder> <ops.json> --base-rev <rev>` changes them all-or-nothing, with exit
code 3 for a stale revision. The operations file names the author, because the command cannot know who is typing.

The file is `comments.json`, with 1 to 50 messages per comment, 2000 characters per message and 500 comments per deck.

## Review

### What gets recorded

When an agent changes the deck through `deck_apply` or `depthcue apply`, the review starts from the deck as it was
before that first change and marks what the agent touched. Your own edits in the editor are never listed, because
saving folds them into the reviewed copy. A change made some other way, such as editing a file by hand, is listed
with an Outside tag. The record is `review.json`; it holds a copy of the reviewed deck and works out the list of
changes fresh each time, so the list cannot go stale.

A change is one property of the deck, a scene or a block, such as a block's text, the order of the scenes, or a scene
that was added or removed.

### In the editor

The Review button in the top bar says "Agent changed 3" while the agent has changes nobody answered, "Changed 1" when
only hand edits are waiting, and "Reviewed" when nothing is. Under 1280 px wide the button is hidden while there is
nothing to review. It opens a drawer over the right of the stage with a row for each change: where it is, the old value
struck out and the new one marked, and Accept and Revert. Accept all is at the top, and `Esc` closes the drawer.
A scene with changes shows a Changed mark on its strip thumbnail, and its storyboard card says how many.

- Accept keeps the change and drops it from the list. The deck stays as it is.
- Revert puts the change back as it was. This is an ordinary edit, so Undo takes it back and autosave saves it. If you
  undo a revert, the change returns to the list as the agent's.
- Undo also takes back an accept, unless the review file changed since. Then Undo says so and leaves it alone.

Accept and Revert are refused while the files on disk changed under your unsaved edits, because the list would then
describe a deck that is not the one on disk. A revert that would bring back a block that names an image file since
deleted from `assets/` is refused too, because the deck would not be valid.

### From a terminal

```
depthcue diff <deck-folder> [--json]
depthcue diff <deck-folder> accept <change-id...> | --all
depthcue diff <deck-folder> revert <change-id...> | --all
```

`diff` lists the changes, each marked `agent` or `outside`. `accept` marks changes as reviewed, and `revert` writes
them back as a new revision, so the history is not rewritten. `accept --all` also starts a review from the deck as it
is. A refusal exits with 1, and a deck that changed on disk while the command ran exits with 3.

## Related guides

- [The editor](editor.md): the drawer, the storyboard and the rest of the editor.
- [Placing blocks](placement.md): what a block's position is.
