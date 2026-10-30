# Depthcue: survey notes

Collected 2026-10-30 by three research agents (landscape, user voice, architecture) and two rounds with Cod
(`gpt-6-astra`). Star counts, licenses and release dates come from the GitHub API on that date. Items marked
(S) were seen only as search snippets. Reddit text was read through a third-party mirror, so quotes are
near-verbatim. Before this repo goes public, drop the user handles or quote only what is needed.

## 1. Landscape

| Tool                                                           | License, stars          | Agent fit                                                  | Biggest weakness                                                |
| -------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| reveal.js                                                      | MIT, 72.5k              | HTML, no schema or check                                   | hand-built layout, nothing semantic                             |
| Slidev                                                         | MIT, 49.3k              | MCP and official skill, Markdown diffs                     | Node and Vue stack; render check undocumented                   |
| Marp                                                           | MIT, 12.7k              | best diffs, ~70 community skills                           | static, no interaction                                          |
| Spectacle, impress.js                                          | MIT, 10.2k, 38.2k       | none found                                                 | hand-coded niches                                               |
| Quarto, Typst/Touying                                          | MIT                     | text sources                                               | publishing tools, not live decks                                |
| Observable Framework                                           | ISC, 3.7k               | static-site generator                                      | not for presenting                                              |
| Motion Canvas                                                  | MIT, 19.6k              | code to video                                              | last release Dec 2024, video only                               |
| Manim, manim-web, Manim Slides                                 | MIT                     | code                                                       | offline render, young web port                                  |
| Remotion                                                       | custom license, 69.1k   | official agent skills (S)                                  | free only up to 3 employees, no reselling derivatives           |
| open-slide                                                     | MIT, 9.5k               | skills, inspector comments saved as source markers         | one maintainer, about 2 months old                              |
| Stagecraft                                                     | MIT, npm 0.2.2, 2 stars | AGENT.md, 50 components, `check --shots`, presenter window | v0.2, one author; npm name taken                                |
| hands-on-deck                                                  | MIT, 223                | JSON patches, inspect, diff, render and lint               | no charts or animation                                          |
| CreatPPT                                                       | Apache-2.0, 171         | `deck.json` plus CLI `--json`                              | 9 commits; pages can be images                                  |
| Presenton                                                      | Apache-2.0, 11.5k       | REST and MCP async jobs                                    | LLM rewrites text; no verification documented                   |
| Open Design                                                    | Apache-2.0, 105k        | MCP, `od --json`, deck mode, PPTX, MP4                     | decks are one mode of a broad tool                              |
| guizang-ppt-skill, html-ppt-skill                              | AGPL 29.0k, MIT 8.9k    | validators, Playwright overflow check                      | AGPL; no PPTX                                                   |
| python-pptx, PptxGenJS                                         | MIT, 3.6k, 6.3k         | APIs, no render                                            | python-pptx stalled; off-slide coordinates unclamped            |
| Anthropic pptx skill                                           | proprietary             | `validate.py`, LibreOffice to JPEG review                  | fonts resolve in the user's PowerPoint                          |
| Gamma, Pitch, Beautiful.ai, Canva, Figma Slides, Google Slides | closed                  | APIs and MCPs of varying depth                             | you do not own a diffable source; Tome slides shut Apr 2025 (S) |
| Claude and ChatGPT for PowerPoint, Copilot                     | closed                  | chat inside PowerPoint                                     | docs advise review before any final deliverable                 |

Presenting agents are closed: Sutando (private beta, no handoff documented) and Jotform (S). A Slidev MCP can
navigate slides but has no section ownership, narration or audience Q&A.

Sources: `api.github.com/repos/{owner}/{repo}`; https://sli.dev/guide/work-with-ai;
https://github.com/dnoegel/stagecraft; https://github.com/open-slide/open-slide;
https://github.com/EveryInc/hands-on-deck; https://github.com/seekskyworld/CreatPPT;
https://raw.githubusercontent.com/anthropics/skills/main/skills/pptx/SKILL.md;
https://sutando.ag2.space/use-cases/live-presentations;
https://raw.githubusercontent.com/remotion-dev/remotion/main/LICENSE.md.

## 2. Gaps no tool fills for agents and people together

1. One typed deck schema that is also the human editing surface.
2. One render, lint and fix contract across static, animated and video content.
3. Per-section control mode (agent, human, shared) with handback.
4. Interactive, data-bearing slides with agent-authorable component contracts.
5. A renderer as a plugin on shared deck state (live HTML and faithful video from one source).

## 3. What users complain about (ranked)

1. **Editing after generation.** "you end up needing Claude for every minor tweak" (u/Famous_Lime6643, r/ClaudeAI).
2. **PPTX is hostile to agents.** "the format is terrible to work with harnesses" (starfallg, HN 49008211).
3. **Agents cannot see their output.** "writing CSS without ever opening a browser" (sirile, https://sirile.github.io/posts/2026-03-23-teaching-ai-to-see-its-own-slides).
4. **Generic look, brand ignored.** "No LLM can use that template. Not really." (https://unsol-dev.pages.dev/guides/llm-slides).
5. **Token and quota cost.**
6. **Non-reproducible output.** "the output is different every time." (u/Gronax_au).
7. **Charts, diagrams and equations are wrong or faked.**
8. **Dense slides, no takeaway, emoji as icons.**
9. **Decks die after the talk, and the format is linear.** "It forces linear flow" (bsenftner, HN 44700335).
10. **Delivery logistics:** notes, offline, motion sickness, accessibility.

## 4. What people asked for or praised

1. The deck as versioned source, content separate from layout.
2. A render, look and fix loop built in.
3. Humans editing the same artifact directly.
4. One portable offline file with PPTX and PDF export.
5. Real presenter mode: notes, timer, multi-screen, animations off.
6. An audience loop and a post-talk loop (questions grounded in the deck).
7. Live-data charts.
8. Locked templates and a brand linter.

## 5. Contrarian takes to design against

- AI-made HTML decks are disposable; give them a durable, diffable source.
- "Docs/memos are just better." Reading mode answers this.
- "cheap deterministic problem you're trying to use expensive non-deterministic systems to solve" (u/aaddrick). The model emits a spec, an engine lays out.
- PPTX persists because offline editing and version control matter to companies.
- Audience votes can be "contrived"; zoom navigation can make people dizzy. Interactivity must serve meaning.

## 6. Architecture and performance findings

- Only `transform` and `opacity` animate on the compositor; animating `top` and `left` dropped 50% of frames in web.dev's example. https://web.dev/articles/animations-guide
- WebGPU: Chrome 113, Safari 26, Firefox 141 (Windows). Keep it optional with a WebGL2 fallback. https://web.dev/blog/webgpu-supported-major-browsers
- Same-document View Transitions are Baseline Newly available since Oct 2025. https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available
- Playwright `animations: "disabled"` makes screenshots repeatable. https://playwright.dev/docs/api/class-pageassertions
- Sizes (uncompressed): reveal.js core 112 KB JS and 54 KB CSS; Rive 282 KB JS plus 1.44 MB wasm; dotLottie 524 KB JS plus 1.34 MB wasm. https://data.jsdelivr.com
- Slidev positions content by `---` separators, so everything is positional. Google Slides `batchUpdate` uses client-chosen object ids and applies requests atomically. https://sli.dev/guide/syntax, https://developers.google.com/workspace/slides/api/guides/batch
- Figma uses a server-authoritative property-level last-writer-wins model, not a CRDT. https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Anthropic's tool-writing guidance: consolidate tools, offer concise and detailed responses, actionable errors. https://www.anthropic.com/engineering/writing-tools-for-agents
- MCP Apps let a tool declare a `ui://` resource rendered in a sandboxed iframe. https://github.com/modelcontextprotocol/ext-apps
- Slidev PDF omits click states unless `--with-clicks`; its PPTX is images by default. https://sli.dev/guide/exporting
- vite-plugin-singlefile suits offline use but allows one entry, and lazy chunks fail under `file://`. https://github.com/richardtallent/vite-plugin-singlefile
- Astro islands hydrate per component with `client:visible`; VS Code activates extensions lazily. https://docs.astro.build/en/concepts/islands/
- DTCG design tokens 2025.10 is the latest published version. https://www.designtokens.org/tr/drafts/format/

## 7. Cod's critique (round 2, `gpt-6-astra`)

Weakest assumptions it named:

- The differentiation was a feature list. The defensible claim is the whole loop: repair, present with an agent, leave a readable artifact.
- "Same source" does not mean faithful output everywhere. Define degradation per export. Kinescript is a scene component first, not proof that arbitrary HTML becomes video.
- Stable ids plus property-level last-writer-wins do not make editing safe. A chart's data and its label can merge into a valid but misleading document. Start with revision-checked transactions and reject conflicts.
- The two-week scope was filling with infrastructure. Fast opening, reliable editing and offline presentation are the customer outcomes, not a 60 KB core.

Changes made to the plan after it: dropped the server op log and LWW merge from v0.1, replaced them with revision checks; cut PPTX, PDF and single-file packaging from v0.1; made reading mode core; added a lease spec with a 1 s renew and 3 s expiry; picked flow templates over a constraint solver.

Cod's first round (before it saw the survey) independently reached the same shape: scenes as the unit, JSON with stable ids,
browser-first DOM and SVG core, agent edits as atomic transactions, a control lease, and Kinescript as compiled
clips plus an overlay. Cod could not read the Kinescript repository in either round.

## 7b. Cod's roadmap critique (round 3, `gpt-6-astra`)

- The draft roadmap delayed everyday usefulness and front-loaded spectacle. Templates, theme editing, images, tables, undo, autosave and asset packaging moved into 0.1 to 0.3; accessibility foundations moved into 0.1.
- Test PPTX migration with real decks before the public alpha, because it shows what the schema cannot represent. Keep unsupported slides as marked image fallbacks.
- Decide the PPTX promise early. Image-per-slide export is a delivery fallback, not editable interoperability. Either ship basic editable text, images and tables before claiming replacement, or position 1.0 for audiences that read HTML or PDF.
- Cut from mandatory 1.0: collaboration, four importers, audience agents, three exploration modules. Whole-deck video is optional. Video needs semantics: a chosen route, interaction state and narration.
- Public alpha at 0.3 is fine if it reflects basic workflows, but pilot users should start at 0.1.
- Biggest risks and early signals: scope outgrowing adoption (first five pilot decks need bespoke components); the document contract failing to carry reading, import and video (separate content copies appear); agent leadership adding anxiety (presenters disable it after rehearsal).

Resulting changes are in the roadmap section of `PLAN.md`.

## 8. Names

Tavra, Cod's first pick, was rejected on 2026-10-30. `tavra.ai` is an active AI assistant company (Chief of Staff, an
SMS assistant), Tavra Labs (India) does AI product engineering, TAVRA Biosciences (Texas) has live USPTO filings,
and the crates.io, Docker Hub, GitHub (`Tavra`, dormant since 2023) and Bluesky names exist.

About 250 candidates were then checked on npm, PyPI, crates.io, GitHub user, Docker Hub, `.com`, `.dev`, `.app` and
`.io` (404 on the registry or RDAP endpoint counts as free), and the finalists were searched on the web. The
script was `namecheck.py` in the session scratchpad; it is not kept.

| Name                                                                    | Registries and domains                                                                   | Web and GitHub                                                        | Cod's rank |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| Depthcue                                                                | free except `.com` (parked lander, registered 2013, expires 2026-11-30)                  | no product; Unity effect repo with 15 stars; graphics and vision term | 1          |
| Sceneloom                                                               | free except `.com` (empty page, registered 2024)                                         | one repo with 0 stars; no brand found                                 | 2          |
| Plainscene                                                              | free everywhere                                                                          | no repos, no brand                                                    | 3          |
| Loomcue                                                                 | free everywhere                                                                          | no repos, no brand                                                    | 4          |
| Weavecue                                                                | free everywhere                                                                          | one repo with 0 stars; "Weave" is crowded (Figma Weave, Weave Inc)    | 5          |
| Cuethread                                                               | free except `.com`                                                                       | `.com` is a live Shopify store, so rejected                           |            |
| Tavra, Veyra, Orvio, Velto, Sceno                                       | taken on at least one of npm, PyPI, crates.io or `.com`, with active namesakes or crowds |                                                                       |            |
| Stagecraft, Podium, Lectern, Dais, Rostrum, Plinth, Deckhand, Stagehand | taken                                                                                    | crowded or in this exact space                                        |            |

No trademark search was possible: the Justia search returned 403. Legal clearance is unresolved for every name.
