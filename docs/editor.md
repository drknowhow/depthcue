# The editor

`depthcue edit <deck-folder>` starts an editor on your own machine and prints its address. It listens on the loopback
address only, so nothing else on your network can reach it. Open the address in your browser.

The slide fills the window. The scene strip (the filmstrip) runs down the left and a bar sits above the slide. In a
window 1440 pixels wide or more an inspector runs down the right. The quick bar and the script drawer are at the foot of
the stage, and a footer runs along the bottom of the window. Every other control is on the slide or in a popover. There
is no form panel. You edit a block where it is.

The bar has three groups. On the left are the deck's title and a chevron that opens the Deck menu, which has the deck's
title, language, modules and look, and the entries Brand…, Download PowerPoint… and Settings…. Next are Undo and Redo as
icons, with the save state. On the right are the checks chip (see
[Problems the checks found](#problems-the-checks-found)), Review, Comments, Export… and Present. The scene's lead and
layout buttons and its Scene chip sit between the groups.

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

- **Text.** Click it and type. A claim is typed the same way. Bold, italic, links, lists and colored words are in
  [Formatting text](#formatting-text).
- **Choosing a block.** Click it. A toolbar floats beside the block with what that kind of block has: a role menu and
  a Style chip for text, a cite chip for sources, a Data chip for a chart, a Table chip for a table, Add bar and Sort
  for an old bar chart, and Edit for an image or a video. Every block's toolbar also has Move earlier and Move later
  arrows, and Free and Layout buttons for pinning.
- **Tables.** Click a cell and type. Right-click a cell for its menu, and paste cells from a spreadsheet. See
  [Tables and charts](tables-and-charts.md).
- **Video markers.** A video's Cues popover adds a marker at the playhead, renames, retimes or removes one. Markers
  live in a file beside the video, are written as soon as you make them, and are not part of Undo; the popover has
  its own Undo marker change button.
- **Charts.** The Data chip opens the chart's rows and series in a grid, and the right-click menu changes the kind.
  See [Tables and charts](tables-and-charts.md). On an old bar chart, drag a bar to change its value, or choose a bar
  and use the arrow keys (Shift moves five steps). Labels are typed in place.
- **Images.** Drop or paste a file on the image, or open the library from Image in the Insert menu. Alt text is
  flagged until you write it, or mark the picture Decorative. Crop, fit and focus are in [Pictures](#pictures).
- **Adding.** The quick bar at the foot of the stage has an Insert menu that lists Text, Chart, Table, Image, Clip and
  Claim. The rest of the bar is Script, Build order, Comment, Everything and `?`. `T`, `C` and `I` add a text, a chart
  or an image from the keyboard without opening the menu. An area of the slide that holds nothing shows a dashed place;
  click it to add there.
- **Moving and zooming.** `[` and `]` change slide, and so does a press on a scene in the strip. The footer shows
  "Slide 3 of 12" with the scene's title, and at its right end zoom out, the zoom level and zoom in. Press the level to
  return to Fit. `+` and `-` zoom, `0` fits, and Ctrl with the wheel zooms. A zoomed slide scrolls. The zoom is only how
  you see the slide; it is not saved and is not an undo step.
- **Scenes.** Each scene in the strip has a More button that opens the scene's menu, the one a right-click opens, with
  Duplicate, Delete, Move earlier and Move later among its entries. The Add slide tile after the last scene adds a
  scene after the one on show. The layout choice and From a template… are below it. Drag a scene to move it.
- **Moving between areas.** Drag a block by the grip beside it. See [Placing blocks](placement.md).
- **Build order.** The Build order button puts a badge on each block. Press a badge to choose the step that reveals
  that block, or to start a new step.
- **Layout, lead and style.** The top bar sets a scene's layout and who leads it (human, agent or shared). The Deck
  menu sets the title, language, modules and the deck's look (see [Deck style](#deck-style)), and the Scene popover
  the scene's title, steps and sources.
- **Script.** The speaker notes, the reveal order, the reading version and the voice-over are in the script drawer. See
  [The script drawer](#the-script-drawer).

Every property in the deck's schema can be edited here, and a test fails when one has no control.

## Pictures

A chosen image's toolbar has Crop, Fill and Reset picture, and its Edit popover has the file, the alt text, the caption
and a Decorative checkbox. A scene's picture behind the whole slide is in the Scene popover.

- **Library.** Image in the Insert menu, the `I` key and "Add an image here" open a popover of the pictures in
  the deck's `assets/` folder, when it has any; a deck with none goes straight to the file chooser. Each picture shows
  a thumbnail, its name, its size in pixels, its file size and "Used on 2 slides" or "Not used". Press one to add it as
  a new block, or, from Edit's "Choose from library", to replace the chosen image's file. Delete appears on a picture
  that no slide names, asks inside the popover, and deletes the file from the folder. The library is loaded the
  first time it is opened.
- **Several files.** Dropping or pasting several pictures adds one image block each, up to the scene's limit of 12
  blocks, as one step of Undo. One picture dropped on an image replaces its file.
- **Fit and Fill.** Fill is pressed when the picture fills its box and is cut to it, which is the default in a
  picture slot. Otherwise the whole picture shows. See [Placing blocks](placement.md#pictures-in-a-frame).
- **Crop and focus.** Crop, or a double click, shows the whole file dimmed around the crop with a handle on each edge
  and corner. Drag a handle to resize, drag inside to move the picture, and on a filled picture drag the Focus point.
  Enter or a click outside applies, as one step of Undo, and `Esc` cancels. With the keyboard, Tab moves between the
  handles and the arrow keys move 1 percent (Shift 10); each handle has a spoken name, such as "Top edge of the crop".
- **Reset picture** takes off the crop, the focus and the fit.
- **Pinned pictures.** A corner drag keeps the picture's shape; hold Shift to change it. Fit box to picture sizes the
  frame to the cropped picture.
- **Decorative.** Tick it ("No alt text needed") for a picture that carries no information, such as a texture. The alt text may then be empty,
  the reading version leaves the picture out, and a screen reader skips it. Clearing the tick on a picture with no alt
  text puts the file's name there as a placeholder, and the checks flag it until you write a real one.
- **Slide background.** Use as slide background in a picture's right-click menu moves it behind the whole slide: it
  becomes the scene's `background` with a 40 percent scrim, and its alt text, decorative mark and focus come along. Its
  crop and fit are dropped, because a background has neither. The Scene popover's Background section has the file, the
  scrim, the scrim color, the focus, the Decorative checkbox, the alt text and Remove. Remove background is in the
  right-click menu of any block on a slide that has one.

## Formatting text

Click into a text block. While the cursor is in it, a second row appears under the block's toolbar:

- **Bold and Italic**, also `Ctrl+B` and `Ctrl+I`.
- **Link**, also `Ctrl+K` while the cursor is in text. Select the words first. A box asks for the address, which has to
  start with `https://` or `mailto:` and has no spaces. A link opens in a new tab.
- **Four color dots** for the selected words: Text, Muted, Action and Evidence, each drawn in the deck's own color. Press
  the dot again to take the color off.
- **Bulleted list and Numbered list**, for body text only. Pasted lines that start with `- ` or `1. ` become a list too.

In a body, `Enter` is a line break, or a new item inside a list. In a heading, a caption or a quote it ends the edit.
Paste brings in the words and leaves the formatting behind, and asterisks you paste stay asterisks. The count on the
toolbar counts what the audience sees, so `**bold**` counts four characters.

The Style chip on the toolbar sets the whole block: Size (Small, Medium, Large, Extra large), Align (Start, Center,
End) and Color (Default, Text, Muted, Action, Evidence). The right-click menu of a text has the same three as submenus.
See [Style](style.md).

A scene saved before schema 0.3 has no format bar, and what you type stays as typed. Right-click the scene in the
strip and choose Use text styles, and it gets one. Setting a size, alignment or color on a block does the same. The
words look the same afterward: a star that was typed before stays a star.

## Deck style

The Deck menu has a Style section for the preset (Paper or Ink), seven colors and four font pairs. A color that
would leave text hard to read is refused, with the reason. [Style](style.md) lists each color, the font pairs and the
contrast rules.

## Problems the checks found

A chip in the top bar says "All clear" or how many things there are to check. It is disabled while nothing needs
checking. Press it and a list opens under it that shows the problems one at a time, with Previous and Next. Pressing a
problem's text goes to its slide and chooses its block. `Esc` or a press elsewhere closes the list. The list shows the
same problems `depthcue check` and `depthcue render` report: alt text that is still a file name, a chart with no
source, text that does not fit, a pinned block that overlaps another or sits in the margin.
Fix appears only where one change settles the problem the same way every time.

The problems that need a laid-out page come from a real render of the files on disk, so they arrive a moment after a
save, and they need Chrome or Edge on the machine. Without one, the list shows only what the files alone can tell.

## The inspector

In a window 1440 pixels wide or more, a column on the right shows the properties of what is chosen. Its title is
"Slide" when nothing on the slide is chosen, and the block's name when one is. With nothing chosen it holds the Scene
popover, and with a block chosen it holds the popover of the block's toolbar chip that is open. The popovers keep their
chips and their order for the keyboard and a screen reader. `\`, or the button in the column's heading, folds the column
to a narrow rail and opens it again, and the editor remembers the choice in this browser. In a window narrower than
1440 pixels there is no column, and each popover opens under its chip.

## The script drawer

Script on the quick bar opens a drawer along the foot of the stage, with the slide still in view above it. It has four
tabs: Speaker notes, Reveal order, Reading version and Voice-over. The Left and Right arrow keys move between the tabs,
and Home and End go to the first and last. `Esc` or the close button puts the drawer away and returns the keyboard to
the Script button.

- **Speaker notes** and **Reading version** hold the scene's notes and its reading version.
- **Reveal order** lists each step with the blocks it reveals, or says that the slide shows everything at once. Edit
  the steps opens the Scene popover at the slide's steps. Build order, on the quick bar, puts a badge on each block.
- **Voice-over** has the voice-over text, the step marks that move the slide on, and the button that makes the audio.

The footer's left end says which slide is on show and how many steps it has, and has Notes, Reading and Voice entries
that show whether each is written. The steps entry opens the Reveal order tab, and the other three open their own tabs.

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

## Right-click menu

Right-click a block, a cell of a table, the claim, an empty part of the slide or a scene in the strip, and a menu lists
what you can do there. It is built from the same commands as the palette, so the two cannot disagree. A command that
cannot be done is left out and not greyed, and each command shows its key. A chart kind the data cannot take is shown
greyed, with the reason.

- **A block.** Cut, Copy, Paste (after this block), Duplicate and Delete; Pin where it is, or Put back in layout; Comment;
  Move earlier and Move later. The claim has Paste, Delete and Comment.
- **A text.** Size, Align and Color as submenus, with the choice the text has now ticked.
- **An image.** Crop, Fit, Fill, Reset picture, Fit box to picture (a pinned image) and Use as slide background. Remove
  background is in the menu of any block on a slide that has one.
- **A chart.** Edit data, and a Chart type submenu of the six kinds with the current one ticked. A kind the data cannot
  take is greyed, with the reason.
- **A cell of a table.** Insert row above and below, Insert column left and right, Delete row, Delete column, Show or
  Hide header row, and Make column numbers or text. Right-click the table's border or title for the block's own menu.
- **An empty part of the slide.** Paste here; Add a text, a chart, a table or an image here; Layout and Lead, each a
  submenu; Put every pinned block back, when one is pinned; Deck style; and Show or hide the comments.
- **A scene in the strip.** Duplicate, Delete, Move earlier, Move later, Use text styles (for a scene saved before
  schema 0.3) and Present from here.

Right-clicking chooses what you pointed at first, so the menu acts on it. `Shift+F10` or the Menu key opens the same
menu under the chosen block, or under the scene the keyboard is on. On a touch screen or with a pen, press and hold for
half a second without moving. The arrow keys move over the items, Home and End go to the first and last, `Enter` or
`Space` runs one, Right opens a submenu and Left closes it, and `Esc` closes the menu and puts the keyboard back on the
block or scene. In text you are typing in, or in a field, a right-click and `Shift+F10` are the browser's own menu, which
has the spelling suggestions. Use the palette to reach a command on a block you are typing in.

Copy puts the block on the clipboard as its words, which any other program can paste, and as the block itself, which
the editor of another deck can paste. Paste adds a new block with an id of its own: after the chosen block, or into the
first area that takes its kind when none is chosen. Paste here on empty space that no area takes pins the block at the
pointer. Duplicate keeps a pinned block pinned, a little down and to the right of the original. A pasted image or video
whose file is not in this deck is refused with a message that names the file, since the deck cannot show a file it does
not have. Cut, paste and duplicate are each one step of Undo.

A menu cannot always read the clipboard. Where the browser says no, Paste uses the last block you copied in this editor,
or asks you to press `Ctrl+V`, which always works.

## Finding things and keys

`Ctrl+K` (`Command+K` on a Mac) or the Everything button opens a palette: type a few letters of anything you can do now,
such as Go to a scene, Pin, Present from this scene or Undo. `?` or the `?` button opens the list of every key.

| Key         | What it does                                     |
| ----------- | ------------------------------------------------ |
| `T` `C` `I` | Add a text, a chart or an image                  |
| `M`         | Comment on a block                               |
| `P`         | Pin the chosen block where it is, or put it back |
| `Ctrl+X`    | Cut the chosen block                             |
| `Ctrl+C`    | Copy it, also into another deck                  |
| `Ctrl+V`    | Paste a copied block after it                    |
| `Ctrl+D`    | Duplicate it                                     |
| `Ctrl+B`    | Bold the selected words in a text                |
| `Ctrl+I`    | Italic the selected words in a text              |
| `[` `]`     | Go to the previous or the next slide             |
| `\`         | Hide or show the inspector                       |
| `+` `-` `0` | Zoom in, zoom out, fit the slide to the window   |
| `G`         | Open the storyboard                              |
| `Ctrl+K`    | Open the palette, or link the words in a text    |
| `Ctrl+Z`    | Undo                                             |
| `Alt+F10`   | Move the keyboard to the chosen block's toolbar  |
| `Shift+F10` | Open its right-click menu; the Menu key does too |
| `?`         | List every key                                   |

A letter key is a letter while you are typing in a field or in text on the slide, and `Ctrl+X`, `Ctrl+C`, `Ctrl+V` and
`Ctrl+D` leave a field and text on the slide to the browser the same way. Delete removes the chosen block, and `Esc`
lets go of it. Inside a table's cells the keys are the grid's: see [Tables and charts](tables-and-charts.md).

## For an agent

Everything above is also an operation, so an agent can do it in the same deck while you work. Text in a scene of schema
0.3 reads markup: `**bold**`, `*italic*`, `[words](https://example.com)`, `[words]{action}` for a tone, `- ` and `1. `
lines for lists in a body, and a backslash to write a character as itself. Text in an older scene is drawn as typed, so
a star stays a star. `scene.upgrade` brings the scene to 0.3 and escapes what it holds, so its words keep their
meaning. This turns the demo's demand scene to 0.3 and adds a body with a list, bold, a link and a colored phrase:

```json
[
  { "op": "scene.upgrade", "id": "demand" },
  {
    "op": "block.add",
    "scene": "demand",
    "block": {
      "id": "demand-note",
      "type": "text",
      "role": "body",
      "text": "- B leads **by 20 points**.\n- The [order snapshot](https://example.com/orders) has the counts.\n- [Check the returns]{action} before acting."
    }
  }
]
```

```sh
depthcue apply my-deck ops.json --base-rev "$(depthcue rev my-deck)"
depthcue check my-deck
```

`apply` prints `Applied.` and the new revision, and `check` prints `0 errors, 0 warnings`. Run `scene.upgrade` before
writing markup into a scene that is older than 0.3. Otherwise the markup is kept, but it shows as typed, and the
`deck_apply` tool warns `text-is-literal` where `depthcue apply` says nothing. Setting a `tone`, `size` or `align`
on a block upgrades its scene by itself. Table and chart blocks are in
[Tables and charts](tables-and-charts.md#for-an-agent), and the palette, fonts and block styles are in
[Style](style.md#for-an-agent).

Pictures are in a scene of schema 0.6. `fit`, `crop`, `focus` and `decorative` on an image block, and `background` on a
scene, move the scene to 0.6 when they are first set. The file comes first: `deck_asset` (or `depthcue asset add`) copies
a PNG, JPEG, GIF, WebP or plain SVG file into `assets/` under a name made from its own name and its content, and prints
the path to put in the block. This was run on a copy of the demo deck:

```sh
depthcue asset add my-deck street.jpg
```

```
assets/street-5a6b7ae8.jpg  1600x1000  103 KB
```

A crop that leaves the picture is refused, with the number to change:

```
scenes/method.json/blocks/3/crop/w  error  The crop runs to 110% across the picture; the picture ends at 100%.
  fix: Make w at most 40, or make x smaller. The crop is in percent of the picture's own width and height.
Rejected (invalid-deck); nothing was written. 1 error, 0 warnings
```

This adds a scene with a cropped picture and puts a picture behind the first scene, under a 72 percent scrim:

```json
[
  {
    "op": "scene.add",
    "after": "trend",
    "scene": {
      "schemaVersion": "0.6",
      "id": "street",
      "title": "The street",
      "layout": "text-media",
      "blocks": [
        {
          "id": "street-heading",
          "type": "text",
          "role": "heading",
          "text": "Where the orders are picked up"
        },
        {
          "id": "street-photo",
          "type": "image",
          "asset": "assets/street-5a6b7ae8.jpg",
          "alt": "A shop with a striped awning and a lit window, at dusk.",
          "crop": { "x": 55, "y": 32, "w": 36, "h": 58 }
        }
      ]
    }
  },
  {
    "op": "scene.set",
    "id": "opening",
    "set": {
      "background": {
        "asset": "assets/street-5a6b7ae8.jpg",
        "scrim": 72,
        "alt": "A street of shops at dusk, with one shop lit."
      }
    }
  }
]
```

`apply` printed `Applied. Revision a1c3904f80c25491 -> 07388600f5c75750` and the three files it wrote, and `check`
printed `0 errors, 0 warnings`. `depthcue asset remove` refuses a file that anything names, and says how many times it
is used; `depthcue asset unused` lists the files nothing names. A picture with `"decorative": true` needs no `alt`.
`depthcue render` adds two checks that need a drawn page: `image-low-resolution` when a picture would be drawn at more
than 1.5 times its own pixels, and, for text over a scene background, `background-low-contrast`, whose fix names the
scene's scrim.

## Related guides

- [Tables and charts](tables-and-charts.md): data, the cell menu, paste and the six chart kinds.
- [Style](style.md): the palette, fonts, tone, size and alignment.
- [Placing blocks](placement.md): pinning, moving, resizing and the layout's areas.
- [Comments and review](comments-and-review.md): notes for people and agents, and the agent's changes.
- [Presenter view](presenter.md): present from any scene.
