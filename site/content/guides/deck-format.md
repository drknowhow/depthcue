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
