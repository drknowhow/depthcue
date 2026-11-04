# Depthcue: plan

Status: v0.1 is built and trialed, the editor was rebuilt on 2026-11-01, and the same day the content range grew to
tables, six kinds of chart, rich text and a deck style (see below). The rest of this plan is as written on 2026-10-30. "Depthcue" is a working name. Name, license and repo visibility are Yep's proposals
and wait for Dimitri's approval. Evidence for every claim here is in `RESEARCH.md`.

**Editor rebuild, 2026-11-01.** After testing v0.1 the owner found the editor too complicated and asked for direct
editing on the slide with PowerPoint-style freedom. The editor now works on the slide itself, and a person can pin
a block anywhere on it, comment on blocks and review an agent's changes. This changes the plan in one place: free
placement is in, as a human override on top of the automatic layouts, so the lines below that rule out "a freeform
canvas" mean a canvas without layouts. Agents still place blocks in areas. The user guides are [the
editor](editor.md), [placing blocks](placement.md) and [comments and review](comments-and-review.md); the build
record is [EDITOR_REMAKE.md](EDITOR_REMAKE.md).

**Content range, 2026-11-01.** A deck can now look like a real one. Text takes bold, italic, links, lists and colored
words, and a tone, size and alignment. A deck has a palette of seven colors and one of four font pairs, and a color
that would make text hard to read is refused. Tables and six kinds of chart (bar, stacked bar, line, area, scatter,
donut) are blocks that a person can type or paste into. The schema is 0.3, and older decks load unchanged. This
moves tables and theme editing, listed for 0.2 in the roadmap, and the first half of 0.4's "mature charts and
tables", into v0.1. Data binding to CSV or JSON, provenance for cells and a lint that checks a chart against its
claim stay in 0.4. The user guides are [tables and charts](tables-and-charts.md) and [style](style.md); the build
record is [CONTENT_RANGE.md](CONTENT_RANGE.md).

**Images, 2026-11-04.** A picture can be cropped, shown whole or made to fill its box around a point you choose, marked
decorative, and put behind a whole slide with a scrim. An agent adds the image file with `deck_asset` or
`depthcue asset` and sets the same properties with the same operations. The editor has an image library and a crop mode,
and the PowerPoint export keeps each of these. The schema is 0.6, and older decks load unchanged. The user guide is
the Pictures section of [the editor](editor.md#pictures), with [placing blocks](placement.md#pictures-in-a-frame) and
[the export](export.md#pictures); the build record is [IMAGES.md](IMAGES.md).

## Thesis

Depthcue is an open-source format and player for explanations that an agent can write, a human can repair, and both
can present together. A deck is a typed JSON source with stable ids, not a pile of pixels.

The claim to prove: **a human can immediately repair an agent-authored explanation, present it safely with the
agent, and leave behind a readable artifact, all from one source.** Each half exists somewhere. No tool does the
whole loop.

The unit is a **scene**: one explanatory purpose with content blocks, evidence, steps and optional narration. The
everyday UI still says "slide". A deck is a guided route through scenes.

## Why this is not a fourth Stagecraft

Agent-authored HTML decks are crowded (Slidev, open-slide, Stagecraft, hands-on-deck, CreatPPT, Presenton). A
feature list will not separate us. These five gaps stay open in the survey:

| Gap                                                     | What exists                                                              | What Depthcue does                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| One typed schema that is also the human editing surface | Schema-less HTML, React code, lossy PPTX                                 | JSON Schema, stable ids, every shipped property editable by hand with no model                    |
| One render, lint and fix contract                       | Each tool verifies in its own way, none spans static, animated and video | `deck_render` returns screenshots plus overflow, contrast and reference diagnostics for any scene |
| Control per section with handback                       | Closed presenter agents, no documented takeover                          | Lease protocol: human grants, human takes over instantly, agent failure returns control           |
| Interactive, data-bearing scenes                        | Humans hand-code Vue or React                                            | Component contracts an agent can fill: chart, evidence, sources addressable per claim             |
| Renderer as a plugin                                    | Remotion license limits, Motion Canvas stale, Manim offline              | Kinescript as module 1: live HTML and faithful video from one scene source                        |

## Principles

1. **The source is the product.** Diffable JSON, stable ids, one pretty-printed block per scene.
2. **The model emits a spec, an engine lays it out.** Layout is deterministic. Agents choose templates and supply bounded content.
3. **Verify before show.** An agent cannot see overflow, so the tool renders, measures and returns the failures.
4. **Human repair needs no model.** Text, chart values and order are editable directly.
5. **Control is explicit.** Who is driving is always one state, never inferred.
6. **Fast is a feature.** Budgets are enforced in CI from the first commit.
7. **Degrade honestly.** Video, PDF and PPTX cannot match interactive HTML. Each states what it drops.
8. **Reading mode is first class.** The same source flows as a document for people who were not in the room.

## Content model

Summary, evidence and source are a pattern, not a required hierarchy. Evidence and sources are addressable
objects, so a source supports a claim instead of sitting in the deepest panel.

```json
{
  "schemaVersion": "0.1",
  "id": "scene-demand",
  "title": "Demand is shifting",
  "layout": "claim-evidence",
  "lead": "human",
  "summary": { "id": "claim-shift", "text": "Channel B now leads.", "evidenceIds": ["chart-demand"] },
  "blocks": [
    {
      "id": "chart-demand",
      "type": "bar-chart",
      "data": [{ "label": "A", "value": 40 }, { "label": "B", "value": 60 }],
      "sourceIds": ["source-report"]
    }
  ],
  "sources": [{ "id": "source-report", "asset": "assets/report.csv" }],
  "reading": { "text": "The supplied snapshot compares the two channels." },
  "steps": [{ "id": "show-evidence", "reveal": ["chart-demand"] }]
}
```

Speaker notes live apart from `reading` and stay private.

## Architecture

- **Runtime.** Browser, TypeScript. Core is DOM, CSS and SVG. Canvas, WebGL and WebGPU live in lazy modules. Slide changes use same-document View Transitions. Web Animations and CSS are the only motion timeline, so screenshots are repeatable.
- **Format.** Directory form for git: `deck.json` manifest, one file per scene, `assets/`, theme tokens. Zip form for sharing. No arbitrary JavaScript in the base format. Markdown is an import and export view only.
- **One command layer.** The editor UI, the CLI and the MCP tools call the same typed commands. Edits are atomic transactions against a document revision, with undo. A stale revision is rejected, never auto-merged.
- **MCP tools (five).** `deck_get(view: outline | scene | comments)`, `deck_apply(ops[], base_rev)`, `deck_comment(ops[], base_rev)` for the comments kept beside the deck, `deck_render(scene)` returning a PNG and diagnostics, and `deck_present(action)` for driving the deck while the presenter has handed over control. Few tools, concise and detailed response modes, errors that say how to fix the call.
- **Layout.** Three flow templates in v0.1. Templates own geometry and the agent never sets coordinates. Render at the target viewport with fonts loaded, measure real boxes, reject clipping, overlap and minimum-size violations. Repair order: shorten the text, pick a roomier template, split the scene. Nothing silently shrinks to fit. Constraint solving and freeform canvas wait for evidence that templates fail.
- **Modules.** A custom element plus a manifest: block types, props schema, activation, size budget, static fallback, export behavior. Hydrate on `visible` or `idle`. A module that throws leaves the deck intact. Every module has a static fallback.
- **Kinescript module.** Pre-rendered clips, cached by a hash of the scene JSON and toolchain, with a poster and lazy `<video>`. Kinescript's cue map drives a browser overlay for hotspots and steps. Needs: a versioned output manifest, stable cue ids, progress and cancel. Check which already exist before changing Kinescript. A live browser renderer is a later experiment with golden-frame tests.
- **Exports.** v0.1: offline folder. Later: single-file HTML, PDF with one page per click step, PPTX as image per step plus notes (editable PPTX best effort).

### Control lease

```text
States: HUMAN, AGENT(leaseId, epoch, expiresAt). Default HUMAN.
Section "lead" is a preference. "shared" means explicit alternating turns.
Human GRANT issues a lease scoped to a section and a set of allowed actions.
Agent commands carry leaseId, epoch, sequence and expected state revision.
The session controller rejects stale, duplicate, expired or out-of-scope commands.
Human TAKEOVER revokes the lease, bumps the epoch and cancels queued agent actions.
Navigation, pause or an explicit key can trigger TAKEOVER.
Renew every 1 s. Expire after 3 s without renewal.
Expiry, disconnect or agent error returns HUMAN without advancing or resetting.
Section exit revokes the lease. Handback needs a fresh human GRANT.
Presentation leases never authorize document edits.
```

## Speed budgets

Proposed targets, not measurements. Reference: a named mid-range laptop, current Chromium, 1080p, a 50-scene
fixture, 10 Mbps and 50 ms network. CI fails the build on a miss.

| Budget                                                  | Target                |
| ------------------------------------------------------- | --------------------- |
| Core runtime (schema, commands, player kernel)          | 60 KB gzip or less    |
| Player initial JavaScript, excluding editor and modules | 150 KB Brotli or less |
| Cold open to usable first scene                         | p95 1.5 s or less     |
| Preloaded scene change to first visible response        | p95 50 ms or less     |
| Animation frame work in core                            | p95 10 ms or less     |
| Tab memory after traversing 50 scenes                   | 200 MB or less        |

Three decisions protect them: separate player and editor builds; keep only the current and adjacent scenes live;
keep compilation, inference and rendering off the presentation path. A heavy module publishes its own budget and
never takes a silent exemption.

## v0.1 scope (about two weeks of agent work)

**In.** One local browser editor and player. Versioned JSON. Three flow templates. Text, image, one interactive
chart and Kinescript clip blocks. Fixed theme tokens. Notes. Keyboard presentation. Reading view. Offline folder
export with its assets. Human editing for every shipped property, reordering and chart values. Revision checks,
undo and redo, autosave with crash recovery, screenshot capture, overflow diagnostics and the lease protocol.
Accessibility foundations, because they shape the architecture: keyboard navigation, focus order, semantic
markup, reduced motion, alt text required by the validator. One bundled fixture deck that shows all of it.

**Out.** Live multi-user editing, a server op log, a marketplace, user code, a freeform canvas (pinning a block
came later, see the status note), a constraint
solver, a browser Kinescript renderer, voice conversation, live external data, PPTX and PDF export, single-file
packaging.

**The 60-second demo.** An agent writes an explanation. A deliberately long heading fails validation and the agent
repairs it. A human edits a chart value and wording by hand and the chart and evidence still agree. A Kinescript
clip explains a transition. The agent advances scenes. The human interrupts and takes control at once. The
audience opens the same artifact in reading mode and sees the sources. The demo video is itself a Kinescript scene.

## Roadmap to v1.0

Every version has a gate that someone can observe. Sizes are guesses until v0.1 gives a measured velocity;
nothing here is a date.

**Who v1.0 is for.** Explainers: engineers, analysts, researchers and teachers who present evidence-heavy
material and whose audience can open a link or a PDF, or accept a basic editable PPTX. The promise is narrow on
purpose: a user can **create, revise, present offline, recover from mistakes, and deliver the required artifact
without reopening PowerPoint.** Replacing PowerPoint for everyone is not a v1.0 claim.

| Version                | Theme               | What ships                                                                                                                                                                                                              | Gate                                                                                                                                |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 Proof (2 weeks)    | The thesis works    | Everything in the v0.1 scope above                                                                                                                                                                                      | 60-second demo; side-by-side trial against Slidev and Stagecraft; speed budgets pass in CI; the first three pilot users have a deck |
| 0.2 Finish a real deck | Everyday authoring  | 8 to 10 flow templates, theme editing, tables, image and asset handling, presenter window (notes, timer, next-scene preview, multi-screen), rehearsal mode, static hosting, handout page                                | A pilot user finishes their own 15-scene deck. A fixture corpus of 10 real PPTX decks shows what the schema cannot represent        |
| 0.3 Share and survive  | Public alpha        | Single-file HTML, offline bundle, hosted static build, PDF with one page per click step, lease hardening, bounded PPTX import (unsupported slides kept as marked image fallbacks, with a report of what stays editable) | Clean-machine test; 30-minute fault-injection rehearsal (agent disconnect, stale commands, media failure, display reconnect)        |
| 0.4 Data               | The evidence module | Mature charts and tables, data binding to CSV and JSON with provenance, evidence explorer (claim to source), lint that checks a chart against the claim it supports                                                     | Chart, claim and source cannot disagree silently                                                                                    |
| 0.5 Motion             | Kinescript, deeper  | Scene-authored clips, voice-over through `kinescript-kokoro`, captions from reading text, agent narration, video export of a chosen route, interaction state and narration track                                        | One deck exports to a narrated video that matches the live run                                                                      |
| 0.6 Modules            | Open to others      | Public module SDK (manifest, hydration, fallback, budgets, `module init`), second interactive module (diagram explorer), theme and template authoring guide                                                             | A third party ships a module without touching core; the heavy-module budget test passes                                             |
| 0.7 Interop            | Honest PPTX         | Editable PPTX export for text, images, tables and notes; published supported-subset document and fixture corpus; Markdown import (Slidev, Marp)                                                                         | Every fixture keeps supported content editable; unsupported content gets a diagnostic and a fallback                                |
| 0.8 Hardening          | Trust               | WCAG 2.2 AA audit, security review of the module sandbox and MCP App iframe, measured performance report on named hardware, schema migration tool, crash-recovery corpus                                                | No open critical or high findings                                                                                                   |
| 0.9 Release candidate  | Polish              | Docs and brand site complete, 10 example decks, theme gallery of 6, install docs, schema freeze, bug bash                                                                                                               | Release-candidate pilots pass the v1.0 criteria below                                                                               |
| 1.0 Stable             | Promise kept        | Schema 1.0 with migrations, compatibility policy for modules, support policy                                                                                                                                            | The six criteria below                                                                                                              |

**v1.0 exit criteria.**

1. Real workflow: at least 8 of 10 target pilot users finish their own 15 to 30 scene presentation, make a
   last-minute edit and deliver it with no developer help and no other slide editor.
2. Editing integrity: every shipped content property is human-editable, and the editor and the agent tools use the
   same commands. A published corpus passes save and reopen, undo and redo, crash recovery, stale-revision
   rejection and reference validation with no silent loss.
3. Offline reliability: a clean machine presents a bundled deck with no network and no install, with notes and
   presenter controls. A 30-minute fault-injection rehearsal passes takeover, agent disconnect, media failure and
   display reconnection.
4. Honest interoperability: the supported PPTX subset and its fixture corpus are published. Unsupported content
   gets an explicit diagnostic and a usable fallback. PDF and reading exports contain no clipped content and no
   leaked speaker notes.
5. Measured speed: on named hardware and fixtures the first-scene, navigation, input, bundle and memory budgets
   pass in CI, with heavy-module costs reported separately.
6. Accessible and supportable: the core authoring, presenting and reading journeys pass the accessibility audit;
   no critical or high security finding is open; the versioned schema, migration tests, module compatibility
   policy and install documentation ship together.

**Public alpha at v0.3**, only if the basic workflows hold. Outside pilot users start at v0.1, so feedback does not
wait for the alpha. Private development protects against leaked private assets, exposed credentials, unsafe module
execution and premature compatibility promises. It does not protect the idea from criticism, and known limits are
documented from day one. Rough branding and missing collaboration are acceptable in the alpha. Silent data loss is
not.

**Not in v1.0, planned for 1.x.** Live multi-user editing with a server op log and conflict UI; audience
follow-along, scene questions and agent answers grounded in the deck with citations; scenario calculator; code
walkthrough; Google Slides and Keynote import; native wrapper; live voice co-presenter. **Not planned:** freeform
canvas, 3D, a marketplace, VR.

**Video semantics.** A branching deck has no single movie. Video export takes a chosen route, an interaction
state and a narration track.

## Module order after Kinescript

1. Charts and inspectable tables (promote the v0.1 chart).
2. Evidence explorer: citations, excerpts, claim to source.
3. Diagram explorer: progressive architecture and process diagrams.
4. Scenario calculator: bounded inputs, deterministic maths.
5. Code walkthrough: highlighted code, diffs, recorded traces.
6. Audience questions: attached to scenes, disclosed by the presenter.

Reading mode, accessibility and presenter control stay in core.

## Brand direction

Sibling of Kinescript, not tied to it.

- Personality: an editorial instrument. Precise, curious, quietly expressive.
- Palette: warm paper and ink. Vermilion (Kinescript's cue `#FF633F`) for action, cobalt for evidence, lime for meaningful state. Color always carries meaning.
- Type: a readable grotesk for UI, an expressive serif for headlines, restrained mono for ids, cues and data. Final fonts picked in the brand step; all must be OFL or equivalent.
- Motion: reveal relationships, keep spatial continuity, stop once the meaning is conveyed. No ambient sparkle.
- Voice: plain and exact, numbers over adjectives, no named-competitor comparisons in marketing copy.
- Deliverables: logo, tokens in DTCG form, docs theme, README art, social card, the demo video. Cod generates plates as for Kinescript; the mark is drawn in code.

## Repository and hygiene

MIT, to match Kinescript and keep adoption simple (Apache-2.0 was the alternative, for its patent grant).
TypeScript monorepo, Vite and Vitest, Playwright for screenshots. Docs on Starlight, published from GitHub Pages.
CONTRIBUTING, code of conduct, issue forms, CI with budget gates. Private first, public on Dimitri's OK, as with
Kinescript. The repo would be `drknowhow/depthcue`.

## Name

**Depthcue**, working name, replacing Tavra on 2026-10-30. Tavra is taken in software: `tavra.ai` is an active AI
assistant company, Tavra Labs does AI product engineering, TAVRA Biosciences holds live USPTO filings, and the
crates.io, Docker Hub, GitHub and Bluesky names exist.

Why Depthcue: a depth cue is what makes a flat image read as layered, which is what the Summary, Evidence and
Source layers do for an explanation. "Cue" also links to Kinescript's cue timing and the cue dot in its brand.
Cod ranked it first of five clean finalists. The pitfall it named: the term is descriptive in graphics, which
weakens how distinctive it is as a mark and how well it searches. The cue dot becomes a functional marker for
disclosure and presenter position, and the wordmark and composition stay distinct.

Checked 2026-10-30 across about 250 candidates (npm, PyPI, crates.io, GitHub user, Docker Hub, `.com`, `.dev`,
`.app`, `.io` through RDAP) and a web search of the finalists. `depthcue` is free on all but `.com`, where a parked
lander holds it (registered 2013, expires 2026-11-30). No software product named Depthcue turned up; the closest
are a 15-star Unity effect repository and academic vision benchmarks. **A trademark search was not possible**
(the Justia search returned 403), so legal clearance is unresolved for every candidate. Domains and package names
do not settle it.

## Spending note

Nothing has been bought. The `.dev`, `.app` and `.io` names are free to register, and `depthcue.com` may free up
after 2026-11-30. Any purchase goes through the spending gate and Dimitri's approval.

## Early tests (run before building on the assumption)

| Risk                                        | Test                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| We are a fourth Stagecraft                  | Same five tasks in Depthcue, Slidev and Stagecraft, side by side, by an agent and by a person; record time and failures |
| Human repair is hostile                     | Five non-technical people repair an agent deck: fix layout, change a chart, reorder a section, no prompting             |
| Modules erode speed                         | Three deliberately heavy dummy modules; check load, disposal, memory recovery and scene-change budgets                  |
| Live handoff embarrasses us                 | Inject delays, disconnects and stale commands during rehearsal; takeover stays immediate and keeps state                |
| Sharing fails off our machine               | Send the offline folder to a clean machine with no account, Python or key; it must present and read                     |
| Screenshots are not repeatable              | 20 screenshots of one deck per engine with animations disabled and zero pixel diff                                      |
| Transitions jank outside Chromium           | 100-element scene with a View Transition at 60 and 120 Hz in Chromium, Firefox, WebKit; count dropped frames            |
| The op API is worse than rewriting the file | 20 edit tasks, `deck_apply` against whole-file rewrite; compare success, calls and tokens                               |

## Campaign outline for v0.1 (one PR each)

1. Scaffold: repo, schema v0.1, fixture deck, CI with budget gates, brand tokens.
2. Core: command layer, validation, revision checks, undo and redo, autosave and recovery.
3. Player: three flow templates, reading view, keyboard, notes, accessibility foundations.
4. Verification: `deck_render`, overflow and contrast diagnostics, the three MCP tools.
5. Editor: inline text, chart values, reorder, images.
6. Modules: chart, then Kinescript adapter with cue-map overlay.
7. Control lease, presenter window, takeover.
8. Offline export, docs site, brand assets, README, the 60-second demo.
9. Side-by-side trial and budget report. First pilot users. Go or no-go for v0.2.

Later versions get their own campaigns, declared when the previous gate passes.

## Open decisions for Dimitri

1. Name: Depthcue (Tavra is out). Alternatives with a clean footprint: Sceneloom, Plainscene, Loomcue, Weavecue.
2. MIT or Apache-2.0.
3. Private repo now, public alpha at v0.3 (recommended), or public from the first push.
4. The v1.0 promise: "create, revise, present offline, recover, deliver" for explainers, with basic editable PPTX export at 0.7. Or aim wider.
5. Go to start the v0.1 campaign.
