# Trial: Depthcue against Slidev and Stagecraft

This is the v0.1 trial from docs/PLAN.md: the same job done in Depthcue, Slidev and Stagecraft, and the speed
budgets read off a browser on named hardware. The tables are generated from `docs/trial/*.json` by
`tools/trial/report.mjs`, and a test fails when a table and its data disagree. The text around them is written by hand.

## Result in brief

<!-- trial:begin summary -->

- Cold open to the first scene, p95: Depthcue 210 ms, Slidev 615 ms, Stagecraft 225 ms (to a welcome screen that then needs a key).
- Scene change, p95: Depthcue 66 ms, Slidev 49 ms, Stagecraft 361 ms. Depthcue with reduced motion: 49 ms.
- Bytes on the wire at the first scene: Depthcue 13.8 KB, Slidev 203.7 KB, Stagecraft 74.7 KB.
- Agent runs, calls and seconds (one run each): Depthcue 38 and 266, Slidev 48 and 466, Stagecraft 61 and 573.
- A save from a stale copy was refused by: Depthcue.

<!-- trial:end summary -->

Depthcue opened fastest in the browser, sent the fewest bytes, and was the only one of the three to refuse a stale
save or to check a deck itself. It is not ahead on everything. Its default scene change is over the 50 ms budget, the
brief's 138-character heading would not pass its own check, and after the revision the old numbers survived in the
reading text with nothing flagging them. Each is under its own heading below, and the limits of the trial are at the end.

## How it was run

Three Sonnet 5.5 agents each got the same brief (`tools/trial/brief.md`) and one tool. The brief has five tasks: build a
six-scene deck from exact words, revise a claim, find and fix what does not fit, deliver a folder that opens offline with
speaker notes, and say how they would find out their copy is stale. The agents ran in parallel on one machine, once each,
and logged their own tool calls and times. A fourth agent saw only the MCP tool definitions and real `deck_get` replies,
and wrote twelve edits twice: as `deck_apply` operations and as whole-file rewrites.

Scripts then did the parts an agent should not grade for itself: `tools/trial/verify.mjs` opened each delivered folder,
`tools/trial/bench.mjs` measured speed on a 50-scene fixture, `tools/trial/stale.mjs` ran the stale-copy case, and
`tools/trial/edit-tasks.mjs` scored the edit answers against the real CLI.

<!-- trial:begin machine -->

Measured on 2026-10-31, on the build at commit 5d4408e: Intel(R) Core(TM) Ultra 7 265 (20 logical cores), 63.4 GB of memory, USB Mobile Monitor Virtual Display; NVIDIA GeForce RTX 5060 Ti; Intel(R) Graphics, win32 10.0.26300, Chrome 156.0.8078.48, Node v24.11.0. Headless Chrome, a 1280 by 720 window, 50 scenes, the reference network (10 Mbps, 50 ms latency) for cold opens, 20 cold opens and 3 traversals per tool.

<!-- trial:end machine -->

## What the agents did

<!-- trial:begin agents -->

| Task                                 | Depthcue               | Slidev                      | Stagecraft              |
| ------------------------------------ | ---------------------- | --------------------------- | ----------------------- |
| Create the six-scene deck            | partly, 14 calls, 82 s | done, 17 calls, 101 s       | done, 31 calls, 186 s   |
| Revise the claim to 45 and 55        | done, 4 calls, 12 s    | done, 4 calls, 22 s         | done, 4 calls, 13 s     |
| Find and fix what does not fit       | done, 11 calls, 28 s   | no check, 9 calls, 95 s     | partly, 13 calls, 211 s |
| Deliver an offline folder with notes | done, 7 calls, 51 s    | workaround, 17 calls, 227 s | done, 7 calls, 43 s     |
| Say whether the copy is stale        | done, 2 calls, 0 s     | answered, 1 call, 16 s      | answered, 6 calls, 71 s |
| Whole run                            | 38 calls, 266 s        | 48 calls, 466 s             | 61 calls, 573 s         |

<!-- trial:end agents -->

Calls are the agents' own counts. Seconds are from their timestamps, and the whole-run figure includes the gaps
between tasks. All three ran at once, so a slow model response in one run is not separated from a slow tool.

<!-- trial:begin agent-notes -->

**Create the six-scene deck**

- Depthcue (partly): The brief's 138-character heading fails check (headings stop at 90), so nothing could render until it was shortened.
- Slidev (done): No chart element, so a Vue and SVG component was written by hand. The Google Fonts default was switched off in the config.
- Stagecraft (done): No component gives a heading with bullets or a labelled chart, so three slide builders were written by hand.

**Revise the claim to 45 and 55**

- Depthcue (done): rev and apply refuse a deck with a check error, so the heading was fixed by hand outside apply first.
- Slidev (done): A speaker note still said sixty to forty; the agent left it because the brief said to change nothing else.
- Stagecraft (done): One edit to one slide file.

**Find and fix what does not fit**

- Depthcue (done): The tool's measurements found nothing. Looking at the images found the source line printed three times; one op removed the extra.
- Slidev (no check): Slidev has no overflow check. The agent wrote its own measuring script; nothing overflowed.
- Stagecraft (partly): No check command. The agent's own render scripts found the presenter window cropping slides, and fixed it in CSS.

**Deliver an offline folder with notes**

- Depthcue (done): export made a three-file folder that opens from file:// with no network. Notes show in the same window, no presenter view.
- Slidev (workaround): The documented build is blank from file://. It opened after a Vite config plugin and a post-build script, neither in the docs.
- Stagecraft (done): No export-to-folder command; a script the agent wrote assembled the folder. The deck opens on a welcome screen that waits for a key.

**Say whether the copy is stale**

- Depthcue (done): A stale base revision was refused with exit 3 and nothing was written.
- Slidev (answered): No revision or conflict signal; the agent proposed hashing the file.
- Stagecraft (answered): No revision; last write wins. The agent proposed hashing the file.

<!-- trial:end agent-notes -->

## The delivered folders

<!-- trial:begin deliverables -->

| Check on the delivered folder                    | Depthcue            | Slidev              | Stagecraft          |
| ------------------------------------------------ | ------------------- | ------------------- | ------------------- |
| Opens from file:// with the network blocked      | yes                 | yes                 | yes                 |
| Requests blocked or failed                       | 0 blocked, 0 failed | 0 blocked, 0 failed | 0 blocked, 0 failed |
| Console errors on load                           | 0                   | 1                   | 1                   |
| Revised heading present                          | yes                 | yes                 | yes                 |
| Old numbers still anywhere in the folder         | yes                 | no                  | no                  |
| Scene 4 heading exactly as the brief wrote it    | no                  | yes                 | yes                 |
| Speaker notes in the folder, shown on the slides | 6 of 6, 0           | 6 of 6, 0           | 6 of 6, 0           |
| Text outside the viewport                        | no                  | no                  | no                  |

<!-- trial:end deliverables -->

Two rows count against Depthcue. The old numbers are still in the folder because the agent left the reading text of the
revised scene alone, as the brief said to change nothing else, and nothing checks that text against the chart. The scene 4 heading was shortened
because a heading stops at 90 characters and the brief's has 138; that is a check doing its job, and it cost the agent
the exact words. Slidev and Stagecraft kept the exact words, and the long heading fit on three lines in both.

The console error in the Slidev folder is a library warning at load. The one in the Stagecraft folder is a refused
WebSocket to a development server that is not running. Neither stopped the deck from working.

## Speed

<!-- trial:begin speed -->

| Measure                                             | Depthcue             | Slidev               | Stagecraft                           |
| --------------------------------------------------- | -------------------- | -------------------- | ------------------------------------ |
| Cold open to the first scene, p50 / p95             | 195 / 210 ms         | 607 / 615 ms         | 221 / 225 ms (to its welcome screen) |
| Key press that starts the deck, p50                 | none needed          | none needed          | 358 ms                               |
| Scene change, key to painted heading, p50 / p95     | 58 / 66 ms           | 40 / 49 ms           | 353 / 361 ms                         |
| Scene change with reduced motion, p50 / p95         | 41 / 49 ms           | 41 / 50 ms           | 337 / 344 ms                         |
| Frame interval after a key press, p95 (over 20 ms)  | 16.8 ms (4 of 3,380) | 16.8 ms (2 of 3,380) | 16.8 ms (0 of 3,380)                 |
| JS heap after 50 scenes                             | 1.5 MB               | 5.3 MB               | 1.5 MB                               |
| Renderer memory after 50 scenes                     | 203 MB               | 221 MB               | 205 MB                               |
| Renderer memory after a round trip                  | 200 MB               | 220 MB               | 208 MB                               |
| Bytes on the wire at first scene (Brotli), requests | 13.8 KB, 3           | 203.7 KB, 22         | 74.7 KB, 29                          |

An empty page in the same Chrome used 171 MB of renderer memory and 0.5 MB of JS heap.

<!-- trial:end speed -->

Cold open and bytes favor Depthcue. Slidev has the fastest scene change at p95 by a few milliseconds. Depthcue matches
it only with reduced motion; with default motion its p50 is about one 60 Hz frame slower, which points at the
browser's view transition capturing the old frame before the new scene is drawn. That cause is likely, not confirmed.
Stagecraft's scene change includes its own line animation, so that row measures its design, not its speed.

Memory is within a few megabytes across the tools and is mostly Chrome itself. Frame intervals are 60 Hz in every
tool; the counts over 20 ms are a handful out of thousands.

## Budgets

<!-- trial:begin budgets -->

Measured in a browser on this machine (Depthcue only):

| Budget                                      | Target | Measured                                  | Verdict      |
| ------------------------------------------- | ------ | ----------------------------------------- | ------------ |
| Cold open to usable first scene, p95        | 1.5 s  | 210 ms                                    | within       |
| Scene change to first visible response, p95 | 50 ms  | 66 ms                                     | over         |
| Scene change with reduced motion, p95       | 50 ms  | 49 ms                                     | within       |
| Tab memory after 50 scenes                  | 200 MB | 203 MB renderer, 171 MB for an empty page | over         |
| Animation frame work in core, p95           | 10 ms  | not measured; frame interval p95 16.8 ms  | not measured |

Size gates that CI enforces on every change, as built for this run:

| File                    | Measured       | Limit    | Verdict |
| ----------------------- | -------------- | -------- | ------- |
| core runtime            | 21.0 KB gzip   | 60.0 KB  | within  |
| player script           | 5.5 KB brotli  | 120.0 KB | within  |
| player styles           | 3.5 KB brotli  | 30.0 KB  | within  |
| module chart            | 1.4 KB brotli  | 3.0 KB   | within  |
| module clip             | 0.9 KB brotli  | 3.0 KB   | within  |
| lease script            | 2.1 KB brotli  | 3.0 KB   | within  |
| broadcast script        | 0.8 KB brotli  | 1.0 KB   | within  |
| presenter script        | 1.8 KB brotli  | 2.3 KB   | within  |
| exported page script    | 8.1 KB brotli  | 10.0 KB  | within  |
| core code in the player | 3.6 KB brotli  | 5.0 KB   | within  |
| editor script           | 25.8 KB brotli | 90.0 KB  | within  |
| editor styles           | 4.9 KB brotli  | 30.0 KB  | within  |

<!-- trial:end budgets -->

Two of the four browser budgets are over for Depthcue on this machine: the default scene change, and tab memory by a
few megabytes. The memory figure is the Windows working set of the renderer processes, which counts Chrome's shared code,
so the amount above an empty page is the better number. Frame work in core was not measured; the tables show whole-frame
intervals, which are a different quantity.

CI gates the sizes only. No timing or memory budget is enforced in CI yet, although docs/PLAN.md says CI fails on a miss.

## Editing through operations

<!-- trial:begin edit -->

| Way of answering      | Edits that worked | Characters written |
| --------------------- | ----------------- | ------------------ |
| deck_apply operations | 12 of 12          | 1,633              |
| Whole-file rewrites   | 12 of 12          | 7,224              |

The operations are 4.4 times smaller than the rewrites for the same twelve edits.

<!-- trial:end edit -->

Both ways got twelve of twelve, so the operations did not make an edit harder to get right. The agent listed six places
where it had to guess from the first wording of the tools: `set` replaces a key whole, there are no bar or step
operations, `scene.add` needs a complete scene, what `after: null` means, which `deck.set` keys exist, and whether
`scene.remove` also removes unused assets. The `deck_apply` description now answers the first five within its 700-character
limit, and a test ties the key lists in that text to the schemas. The asset question is still open. The trial was
not re-run with the new wording.

## A stale copy

<!-- trial:begin stale -->

| Tool       | Second writer's save    | First writer's edit kept | Second writer's edit kept |
| ---------- | ----------------------- | ------------------------ | ------------------------- |
| Depthcue   | refused, exit 3         | yes                      | no                        |
| Slidev     | saved without a warning | no                       | yes                       |
| Stagecraft | saved without a warning | no                       | yes                       |

<!-- trial:end stale -->

Slidev and Stagecraft keep a deck in plain files, so a stale save is ordinary file handling, and git would catch it in
either. What the table compares is what the tool itself offers: only Depthcue refuses. Its refusal is also coarse. The
two edits here touched different fields and a merge would have kept both; Depthcue rejects the second and asks the
writer to read the deck again.

## What the trial found in Depthcue

1. The default scene change is over its 50 ms budget at p95 (see Budgets). Test whether the view transition is the cause, and
   either start the new scene before the old frame is captured or decide the budget applies with reduced motion.
2. Timing and memory budgets are not gated in CI. Add a browser run to CI, with the hardware caveat below.
3. `rev` and `apply` refuse a deck that has check errors, so a repair has to happen outside `apply`. Let them run on an
   invalid deck, or make `apply` the repair path.
4. Nothing checks the reading text against the claim and the chart. A lint for numbers in the reading text that no block
   shows would have caught the stale "60 to 40". Slidev's speaker note went stale the same way.
5. A source line was printed three times (a caption block, the chart's own line, and the sources footer) with no
   warning. Warn on duplicates, or say in the docs that the chart prints its source.
6. There is no `init` command or deck-format guide. The agent got valid scenes from the README, the demo deck and the
   schemas, but each agent has to rediscover them.
7. There is no list or numbered-list block, so the agent typed numerals into text.
8. Export has no presenter view. Notes show in the audience's window, and the `n` key that toggles them is not in the
   docs.
9. A decision for the maintainer: keep the 90-character heading cap, which forced the shortening here, or allow longer headings
   with a fit check instead.

## Limits

- One run per tool, by one model. A single run says what can happen, not how often.
- The brief's tasks (a check, a stale copy, an exact long heading) were written by the Depthcue author and suit a tool
  that has checks and revisions. Slidev and Stagecraft are presentation tools that never claimed either.
- The agents had different documentation. The Depthcue agent read this repository's README and schemas, the Slidev agent
  fetched sli.dev, the Stagecraft agent read the installed package.
- Seconds include the model's own thinking time, which is most of the total.
- Speed was measured in headless Chrome on a fast desktop, not the mid-range laptop that docs/PLAN.md names as the
  reference, and without CPU throttling. These numbers are best case; a pass here does not carry to that laptop.
- The fixture is 50 scenes of plain text. No images, video or charts, so cold open, bytes and memory are best case for
  all three tools.
- Requests to any host other than the local server were blocked for every tool, because the Slidev and Stagecraft
  defaults ask Google Fonts for a font. The trial measures the tools, not that network call.
- Stagecraft opens on a welcome screen that waits for a key. Its cold open is measured to that screen.
- The delivered folders were opened in Chrome only.
- The test that the tables match their data checks the tables. It does not check the prose around them.

## Pilot users

Not started. The person-run trial and the pilot users need people, which this session cannot recruit. Proposed
protocol: three people, 45 minutes each, one deck each of them actually needs, screen recorded with their consent. Note
the time to a first valid deck, where they stopped, whether they used the editor or an agent, and whether they would use
it again. Their notes go in this section.

## Recommendation

Go for v0.2, on these conditions. First, fix or explicitly accept the scene-change budget (finding 1). Second, put a
browser timing run in CI (finding 2). Third, make `apply` usable on an invalid deck and add the reading-text lint
(findings 3 and 4). Fourth, run the pilot users before 0.3, since this trial has none.

The case for going is the stale-save refusal, the checks the other two tools lack, the offline folder that opens
without a workaround, the smaller edits, and the cold-open and byte numbers. The case for caution is one run
per tool, a fast machine, and a brief written by the tool's author. The decision is the maintainer's.
