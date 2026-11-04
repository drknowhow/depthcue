---
title: Deck format
description: What is in a deck folder, and every field a deck, a scene and a block can hold.
---

A deck is a folder. `deck.json` names the deck and lists its scenes in order. Each scene is a JSON file of its own
under `scenes/`, and the files a scene uses, such as images and data, go under `assets/`.

## deck.json

This is the `deck.json` of the demo deck that ships in the repository:

<!-- include: fixtures/decks/demo/deck.json -->

`scenes` lists scene ids in presentation order, and each id is the name of a file under `scenes/`: `demand` is
`scenes/demand.json`.

## A scene

This is the demo's second scene:

<!-- include: fixtures/decks/demo/scenes/demand.json -->

- `layout` is the template the scene is laid out with.
- `lead` says who drives the scene: the person, the agent, or both. The presenter view shows it.
- `summary` is the claim the scene makes, in a sentence. Its `evidenceIds` name the blocks that back it.
- `blocks` are what the scene shows. Each has an `id` and a `type`.
- `sources` say where the evidence comes from. A block names its sources in `sourceIds`, and a source can point at a
  file under `assets/`.
- `reading` is the text shown in the reading view.
- `steps` are the clicks inside a scene. Each reveals items by id, in order.
- `notes` are speaker notes for the presenter view. An export keeps them unless you pass `--no-notes`.

## Pictures

An image block names a file under `assets/` and says how it shows. This is the demo's fourth scene, with a picture
cropped to one shop:

<!-- include: fixtures/decks/demo/scenes/field.json -->

- `crop` is the part of the file that shows, `{ x, y, w, h }` in percent of the file's own width and height. `w` and
  `h` are at least 5, and the crop stays inside the picture.
- `fit` is `contain` (the whole picture shows) or `cover` (the picture fills its box and is cut to it). A picture in a
  template's picture slot covers by default; any other picture contains.
- `focus` is `{ x, y }`, in percent of the cropped picture: the point `cover` keeps in view. Left out, the center.
- `decorative: true` marks a picture that carries no information. Its `alt` may then be left out. Every other picture
  needs `alt`.

A scene can put a picture behind the whole slide with `background`: `{ asset, scrim, color, focus, decorative, alt }`. The
`scrim` is the percent of a palette `color` laid over the picture, so text on it stays readable. A scene's background
replaces its template's. Each of these needs schema 0.6, and a scene is saved as 0.6 only when it uses one.
`depthcue asset add` and the `deck_asset` tool copy an image into `assets/` and print the path to use. See [the
editor guide](../../../docs/editor.md#pictures) for the same controls by hand and an agent example.

## Ids and revisions

Every scene, block, source and step has an id, and an id never changes. An edit names what it changes by id, so a
diff shows what moved, and a claim keeps pointing at its evidence. To rename something, add the new item and remove
the old one.

`depthcue rev` prints a hash of the deck's content. `depthcue apply` takes a list of operations and the revision they
were written against, and applies all of them or none. If the deck has changed since that revision, it applies
nothing. The browser editor and the MCP `deck_apply` tool use the same operations.

## Fields

The tables below are written from the deck and scene JSON Schema files when the site is built, so they match the
schema. The files are in [packages/core/schema](../../../packages/core/schema/).

<!-- generated: schema-fields -->
