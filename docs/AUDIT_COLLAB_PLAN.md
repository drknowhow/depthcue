# Plan: controller session and slide-linked audit

Status: proposal. Nothing here is built.

## Goal

When Depthcue runs from a Claude session, that session is the **controller**. The person points at parts of a slide,
leaves comments for the agent to act on, and the agent answers. Every change and every message goes into an audit log
that can be filtered by slide, and each entry links to the slide it concerns.

## What exists

- `comments.json` (docs/comments-and-review.md): pins anchored to a scene and block, threads, an `ask` flag, and the
  `deck_comment` MCP tool. The editor hears about changes through `/_depthcue/events?comments=1`.
- `review.json`: `deck_apply` and `depthcue apply` record agent changes. `listChanges` marks each `agent` or
  `outside` and gives `scene`, `block` and `field` (packages/cli/src/review-api.ts, packages/core/src/review.ts).
- Neither file is part of the deck revision, the export, the player or the presenter. This must stay true.

## What is missing

1. The session does not hear about editor activity until it calls `deck_get`.
2. A comment can only be anchored to a block; there is no "point at this region or step" action.
3. There is no single log of who did what and why. Review shows the current diff, comments show threads, and
   nothing joins an agent's reply to the ops it caused.
4. Comments and review cannot be filtered by slide, and entries do not navigate to the slide.

## Design

### 1. Audit log (`audit.jsonl`, beside `deck.json`)

Append-only, one JSON object per line: `id`, `time`, `by` (`you`, `agent`, `outside`), `kind` (`apply`, `comment`,
`reply`, `resolve`, `accept`, `revert`, `point`), `scene`, `block`, `field`, `rev` before and after, `commentId`,
and a short `summary`. No full values; `review.json` already holds those.

- Writers: `applyCommentsToFolder`, `applyInFolder`, `acceptInFolder`, `revertInFolder`, the new point action.
- An agent reply that follows ops carries the ids of the audit entries those ops wrote.
- Own revision, like `comments.json`. Corrupt lines are skipped and reported, never fatal.
- `depthcue log <deck-folder> [--scene <id>] [--by agent|you|outside] [--json]`.

### 2. Slide filter and navigation

- Scene filter in the Comments pane, the Review drawer and a new Log view; default is the current slide.
- Each entry has "Go to slide" that selects the scene and, when it names a block, selects the block.
- Scene strip thumbnails already show open comment counts and a Changed mark; add the audit count to the tooltip.

### 3. Pointing

- A Point tool beside Comment: click a block, drag a region, or pick a step. It records `scene`, `block`, `region`
  (fractions, as pins are) and `step`.
- A point can be sent alone ("look at this") or saved as a comment anchor. It is an `ask` only when the person says so.

### 4. Controller link

- `depthcue edit` started by a session registers that session. The MCP server forwards editor events (new ask,
  point, reply from the person) to it.
- Preferred transport: Claude Code channel notifications, as the yep-federation plugin does. Unverified: whether our
  MCP server can declare the channel capability in the supported Claude Code version. Check this first.
- Fallback: `deck_get` already reports open tasks. Add a `since` audit cursor so the agent can ask "what is new".
- Events are data, not instructions to the agent beyond the person's own comment text.

## Order of work (one PR each)

1. Audit file, writers, `depthcue log`, tests.
2. Editor Log view, scene filter, Go to slide.
3. Point tool and `point` audit kind.
4. Controller link: polling cursor first, channel push when verified.

## Tests

- Audit file changes no deck revision, no `export` output, no player or presenter request, and is a 404 on the
  read-only server (as comments are).
- Every writer appends exactly one entry per accepted op, none on a refused one.
- A stale or corrupt audit file does not block apply, comment or review.
- Scene filter returns only that scene's entries; Go to slide selects the right scene and block.

## Risks and open questions

- Entry volume: cap the file (rotate past a limit) so it cannot grow without bound.
- Two writers appending at once: use an atomic append and a per-line id, not a rewritten file.
- Channel support (see above) decides whether push ships in step 4 or only the polling cursor.
- Should `outside` changes (hand edits) be logged by watching the folder, or only at the next review?
