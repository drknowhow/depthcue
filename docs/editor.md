# The editor

`depthcue edit <deck-folder>` starts an editor on your own machine and prints its address. It listens on the loopback
address only, so nothing else on your network can reach it. Open the address in your browser.

The slide fills the window. The scene strip runs down the left, a bar sits above the slide, and every other control is
on the slide or in a popover from the bar. There is no form panel. You edit a block where it is.

The editor changes the deck through the same operations an agent uses (`depthcue apply` and the `deck_apply` tool), so
a person and an agent can work on one deck. When an agent writes to the folder and you have nothing unsaved, the slide
updates and a note says it was updated from the files on disk.

## Saving and undo

Changes save to the folder by themselves, 0.8 seconds after you stop editing and at least every 4 seconds while you
keep going. There is no Save button; `Ctrl+S` saves at once. A draft is also kept in the browser, so a closed tab
loses nothing. `Ctrl+Z` undoes and `Ctrl+Shift+Z` (or `Ctrl+Y`) redoes. One drag, one drop or one run of arrow-key
presses is one step.

Saving never overwrites newer files. If something else (an agent, the command line, a text editor) changed the folder
while you had unsaved edits, saving stops and a notice offers two choices. Reload drops your unsaved edits and loads
the files as they are. Keep mine as copy hands you your version as a file first and then loads the files.

## Working on the slide

- **Text.** Click it and type. A claim is typed the same way.
- **Choosing a block.** Click it. A toolbar floats beside the block with what that kind of block has: a role menu for
  text, a cite chip for sources, Add bar and Sort for a chart, and Edit for an image or a video. Every block's toolbar
  also has Move earlier and Move later arrows, and Free and Layout buttons for pinning.
- **Video markers.** A video's Cues popover adds a marker at the playhead, renames, retimes or removes one. Markers
  live in a file beside the video, are written as soon as you make them, and are not part of Undo; the popover has
  its own Undo marker change button.
- **Charts.** Drag a bar to change its value, or choose a bar and use the arrow keys (Shift moves five steps). Labels
  are typed in place.
- **Images.** Drop or paste a file on the image. Alt text is flagged until you write it.
- **Adding.** The quick bar at the foot of the stage has Text, Chart, Image, Clip and Claim, a Notes popover for the
  speaker notes and the reading version, and Build order. `T`, `C` and `I` do the first three from the keyboard. An
  area of the slide that holds nothing shows a dashed place; click it to add there.
- **Scenes.** The strip adds a scene, and each scene has buttons to duplicate or delete it. Drag a scene to move it.
- **Moving between areas.** Drag a block by the grip beside it. See [Placing blocks](placement.md).
- **Build order.** The Build order button puts a badge on each block. Press a badge to choose the step that reveals
  that block, or to start a new step.
- **Layout, lead and theme.** The top bar sets a scene's layout and who leads it (human, agent or shared). The Deck
  popover sets the title, language, theme and modules, and the Scene popover the scene's title, steps and sources.

Every property in the deck's schema can be edited here, and a test fails when one has no control.

## Problems the checks found

A ribbon between the bar and the slide says "All clear" or how many things there are to check, one at a time, with
Previous and Next. It shows the same problems `depthcue check` and `depthcue render` report: alt text that is still a
file name, a chart with no source, text that does not fit, a pinned block that overlaps another or sits in the margin.
Fix appears only where one change settles the problem the same way every time.

The problems that need a laid-out page come from a real render of the files on disk, so they arrive a moment after a
save, and they need Chrome or Edge on the machine. Without one, the ribbon shows only what the files alone can tell.

## The storyboard

The Storyboard button at the top of the scene strip, the `G` key, or the palette command "Open the storyboard" shows
every scene on one screen. Each card is the slide as it is drawn, with its number and title and a row of pills:

- who leads it: Human, Agent or Shared
- how many changes have not been reviewed
- how many things there are to check
- how many comments are open (outlined when the agent has been asked about one)
- how many blocks are pinned

Press a card or Enter to open that scene on the slide. The arrow keys move over the cards, Home and End go to the first
and last, and `Esc` goes back to where you were. While the storyboard is open no key reaches the slide behind it.

## Finding things and keys

`Ctrl+K` (`Command+K` on a Mac) or the Everything button opens a palette: type a few letters of anything you can do now,
such as Go to a scene, Pin, Present from this scene or Undo. `?` or the `?` button opens the list of every key.

| Key         | What it does                                     |
| ----------- | ------------------------------------------------ |
| `T` `C` `I` | Add a text, a chart or an image                  |
| `M`         | Comment on a block                               |
| `P`         | Pin the chosen block where it is, or put it back |
| `G`         | Open the storyboard                              |
| `Ctrl+K`    | Open the palette                                 |
| `Ctrl+Z`    | Undo                                             |
| `Alt+F10`   | Move the keyboard to the chosen block's toolbar  |
| `?`         | List every key                                   |

A letter key is a letter while you are typing in a field or in text on the slide. Delete removes the chosen block, and
`Esc` lets go of it.

## Related guides

- [Placing blocks](placement.md): pinning, moving, resizing and the layout's areas.
- [Comments and review](comments-and-review.md): notes for people and agents, and the agent's changes.
- [Presenter view](presenter.md): present from any scene.
