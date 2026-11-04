# Placing blocks

A scene's layout decides where its blocks go. Each layout has areas, such as a claim, text, media and evidence, and a
block sits in one of them. You can move a block between areas, or pin it so it sits exactly where you put it.

## Moving a block between areas

Point at a block and a grip appears beside it. Drag the grip, and drop the block:

- on another block in the same area, to put it before or after that block;
- on a block in a different area, to swap the two;
- on an empty part of an area, to move it there.

Text and media keep to their own areas, and the claim area takes no blocks. A drop that is refused says why while the
pointer is over it. Moving a block into Evidence makes the claim cite it, and moving it out removes the citation. One
drop is one step of Undo.

A narrow window or a phone has no room beside a block for a grip. Use the Move earlier and Move later arrows in the
block's toolbar instead.

## Pinning a block

Choose a block and press Free in its toolbar, or press `P`. The block stays where it stands and now belongs to the
slide instead of an area. Press Layout in the toolbar, or `P` again, to put it back in its slot.

A pinned block can go anywhere on the slide:

- Drag it, or drag its grip. A press on a pinned video moves nothing, because the video's own controls take it, so use
  the grip there.
- Choose it, and a handle appears on each corner. Drag a handle to resize from the opposite corner.
- Press the arrow keys to move it 1% of the slide, or 5% with Shift.
- Open the Pinned popover to type its left, top, width and height in percent of the slide, or to align it left,
  center or right inside the safe margin.

While you drag, an edge or the middle of the block snaps to the slide's margin, the slide's middle, or an edge or
middle of another block, and a line shows where it caught. Hold Alt to turn snapping off. `Esc` during a drag puts the
block back. A press that moves less than 3 pixels counts as a click. A whole drag, resize or run of arrow presses is
one step of Undo.

On a pinned text block, a press starts a move. Press Enter or double-click to type in it, and Enter or `Esc` to hand the
keyboard back to the block.

Auto layout in the top bar appears while the slide has a pinned block. It puts every pinned block of the slide back in
its slot, as one step of Undo.

## Pictures in a frame

A picture shows in its box in one of two ways. **Fit** (`contain`) shows the whole picture, with empty room at the sides
if its shape differs from the box. **Fill** (`cover`) fills the box and cuts the picture to it. A picture in a template's
picture slot fills by default; any other picture fits. The Fill button in a picture's toolbar switches between the two,
and is pressed when the picture fills.

- **Crop.** The Crop button, a double click on the picture, or Crop in the right-click menu shows the whole file dimmed
  around the part that shows. Drag a handle on an edge or a corner to change the part, or drag inside it to move the
  picture under it. Enter or a click outside keeps the crop as one step of Undo, and `Esc` drops it. With the keyboard,
  Tab goes from handle to handle and the arrow keys move one percent (Shift ten). A crop is `{ x, y, w, h }` in percent of
  the file, at least 5 on a side, and never leaves the picture. Reset picture takes off the crop, the focus and the
  fit. PowerPoint's own Crop is the same rectangle.
- **Focus.** When a picture fills its box and the box is not the picture's shape, some of the picture is cut. Crop mode
  then shows a Focus point you can drag: the spot that stays in view, as a percent of the cropped picture. It is the
  center when you have not moved it, and it does nothing to a picture that fits.
- **Fit box to picture.** On a pinned picture, this command in the right-click menu and the palette keeps the frame's
  width and changes its height to the cropped picture's shape, and shrinks both if the box would leave the slide. It is
  one `block.frame`, so one step of Undo. It appears once the picture's file has loaded.
- **Shape lock.** A pinned picture keeps its shape when you drag a corner. Hold Shift to change the shape; the
  picture is then cut or letterboxed as its Fit or Fill says. Other blocks resize freely, as before.

On a picture that fills its box, crop mode draws the crop window at the crop's own proportions, so it can run past the
box. For a very tall or very wide crop its handles can then lie outside the slide, where only the keyboard reaches them.

## What pinning changes

A frame is the block's position and size as percentages of a 16 by 9 slide: `x` and `y` from 0 to 100, `w` and `h`
from 5 to 100, and the box stays on the slide. The frame belongs to the block. Editing the block's text, moving it in
the block order or changing the scene's layout leaves the frame alone. Deleting the block removes its frame, and Undo
brings both back.

Pinning one block moves nothing else. The layout leaves a gap where the block was, and the gap closes when the block
goes back to its slot or is deleted. Block order still decides reading order, whatever the frames say.

A slide with a pinned block is drawn as a 16 by 9 slide centered in the window, and its type scales with the slide's
width, so a frame holds the same text on a laptop and on a projector. In a window narrower than 640 pixels the slide
would be too small to read. There, pinned blocks follow the layout in the flow, the grips and handles are hidden, and
nothing moves. The reading view ignores frames.

## Checks on pinned blocks

- `frame-outside-safe-area` (warning): a text or chart frame reaches into the 4% margin at an edge. A picture or a clip
  may run to the edge. `depthcue check` reports it.
- `frame-overlap` (warning): a pinned block overlaps another block. A label over a picture can be on purpose, so this
  is advice.
- `frame-overflow` (error): a pinned block's content is larger than its frame.

The last two need a laid-out page, so `depthcue render` and the editor's problem ribbon report them. For a block in the
margin or one too small for its content, the ribbon's Fix button sends it back to its slot.

## Agents and old decks

An agent places blocks in areas by default. To pin or unpin one, it uses the `block.frame` and `block.unframe`
operations through `deck_apply` or `depthcue apply`; `deck_get` shows each pinned block's frame. A pinned block that
an agent edits keeps its frame. An image block takes `fit`, `crop` and `focus` through `block.set`; see
[the editor](editor.md#pictures).

Frames came with schema version 0.2, and `fit`, `crop` and `focus` with 0.6. A 0.1 deck loads unchanged, and a scene is rewritten as 0.2 only when it gets a
frame. Slides are 16 by 9 only; other shapes would need their own frames.

## Related guides

- [The editor](editor.md): the rest of the editor.
- [Comments and review](comments-and-review.md): notes on a block, and the agent's changes.
