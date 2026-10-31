# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing. Plain TypeScript with a small `h()` DOM helper, Vite 8, no UI framework. The editor is `packages/editor` and the player is `packages/player`; both are bound by byte budgets in `budgets.json` (editor 90 KB brotli, currently 25.1 KB).

## Users

People who present and explain: an analyst, founder or teacher. Two situations, confirmed as equally important: repairing a deck an agent wrote (fix words, numbers and order fast, then present), and building a deck from a blank page. They know PowerPoint or Keynote. They are not developers and never see JSON.

## Product Purpose

Depthcue is an open-source format and player for explanations that an agent can write, a person can repair, and both can present. The editor is the person's side of that loop. Success is that a person can open an agent's deck, fix what is wrong without a model, and present it in minutes.

## Positioning

The deck is typed JSON with stable ids, so an agent edits it through atomic operations against a revision and a person edits the same source through the same operations. A neighboring slide tool does not offer that shared, revision-guarded source.

## Operating Context

Runs at a loopback address (`depthcue edit <folder>`), saves to the deck folder only on request, and keeps a draft in the browser if the tab closes. A deck's scenes use automatic layouts (title, claim-evidence, text-media) with deterministic overflow checks. Scenes carry a lead (human, agent, shared), speaker notes, a plain-text reading version, build steps, sources, and blocks of type text, image, bar-chart or clip.

## Capabilities and Constraints

- Every shipped property must stay editable by a person with no model, through the core commands (undo, redo, atomic ops, stale-revision refusal).
- Text length limits are enforced (heading 90, claim 280, reading 2000).
- Layout is deterministic today. Free placement of blocks would need a schema change and weakens agent-written layouts; this is an open decision, to be shown as options.
- Speed is a headline requirement: editor budget 90 KB brotli, scene change under 50 ms.
- Undecided: whether blocks get free placement.

## Brand Commitments

Existing brand system in `brand/`: Instrument Serif for headlines, Space Grotesk for interface text, IBM Plex Mono for ids and data, a vermilion `#FF633F` reserved for the cue, the three-plane mark. The visual world is settled; this work changes structure and interaction.

## Evidence on Hand

Screenshots and a measured inventory of the current editor (2026-10-31): the slide fills about half of a 1440 by 900 window, the inspector is about 1,250 px tall with six collapsible sections, and only text blocks are editable on the slide. No user research exists yet; pilot users are not recruited.

## Product Principles

1. The slide is the surface: what can be seen can be changed where it is seen.
2. Show a property only when its object is selected; nothing a person is not using stays on screen.
3. Every action has one quick path and one complete path, and both go through the same operations an agent uses.
4. Layout stays trustworthy: a person cannot make a slide that overflows without being told where.
5. First edit in seconds, with no instructions.

## Accessibility & Inclusion

Keyboard operable throughout, visible focus, screen-reader names for every control, and a reduced-motion path. The deck itself already ships a reading version.
