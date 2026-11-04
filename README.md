<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-on-dark.svg">
  <img src="brand/logo.svg" alt="Depthcue" height="64">
</picture>

Depthcue is an open-source format and player for explanations that an agent can write, a person can repair, and
both can present. A deck is typed JSON with stable ids, so it can be generated, reviewed in a pull request, edited
by hand, and read afterwards as a document.

**Status: 0.1, before release.** Nothing is published to npm yet, so you run it from a clone. The deck schema is
0.6 (decks written for 0.1 to 0.5 still load) and can still change. [The plan](docs/PLAN.md) has the thesis, the architecture and the roadmap to 1.0.

## What works today

- **Write and check.** `depthcue check` validates every scene, reference and asset and says where each problem is.
  `depthcue render` draws each scene in a headless browser and reports overflow, clipping, overlap, small text and
  low contrast, with a PNG per scene if you ask.
- **Edit by hand.** `depthcue edit` opens a browser editor where you click a block to change it, right-click for a
  menu of what you can do there, pin a block anywhere on the slide, comment on a block, and accept or revert what an
  agent changed. Its changes go through the same operations an agent uses and save by themselves. See
  [the editor](docs/editor.md), [placing blocks](docs/placement.md), and
  [comments and review](docs/comments-and-review.md).
- **Edit by agent.** `depthcue-mcp` is an MCP server with seven tools: `deck_get`, `deck_apply`, `deck_comment`,
  `deck_render`, `deck_present`, `deck_asset` and `deck_export`. An edit is one transaction against a revision. A stale
  revision is rejected, never merged. A person's comments sit beside the deck, never in it, and an agent can answer them with `deck_comment`.
- **Present.** Keyboard navigation, a reading view for the audience, and a [presenter window](docs/presenter.md)
  with notes, a timer and a preview of the next move. A person can [hand control to an agent](docs/lease.md) and
  take it back at once.
- **Blocks.** Text with bold, italic, links, lists and colored words, tables you can type or paste into, six kinds of
  chart (bar, stacked bar, line, area, scatter and donut), images you can crop, fit and focus, a picture behind a whole
  slide, and [Kinescript clips](docs/clips.md) with cue
  chips that jump to a moment. See [tables and charts](docs/tables-and-charts.md) and
  [pictures in the editor](docs/editor.md#pictures).
- **Style.** Two presets (Paper and Ink), seven palette colors and four font pairs, set for the whole deck, and a
  tone, size and alignment for each text. A color that would make text hard to read is refused. See
  [style](docs/style.md).
- **Deliver offline.** `depthcue export` writes a folder that opens by double-click, with [no server and no
  network](docs/export.md).

## Install

```sh
npm install -g depthcue
depthcue --help
```

This gives the `depthcue` command and the `depthcue-mcp` server. It needs Node 22.12 or later, and Chrome or Edge for
`render`, PDF and PowerPoint export. Each [GitHub Release](https://github.com/drknowhow/depthcue/releases) also
carries the same package as a `.tgz` that `npm install -g` accepts.

## Try it

You need Node 22.12 or later and pnpm 10. `render` also needs Chrome or Edge; set `DEPTHCUE_BROWSER` to use another
Chromium.

```sh
pnpm install
pnpm build
alias depthcue="node $PWD/packages/cli/dist/main.js"

depthcue check fixtures/decks/demo
depthcue serve fixtures/decks/demo    # http://127.0.0.1:4173/
depthcue export fixtures/decks/demo   # writes demo-export/, open its index.html

cp -r fixtures/decks/demo my-deck     # the editor saves into the folder, so work on a copy
depthcue edit my-deck                 # prints the address of the editor
```

On Windows, run `node packages/cli/dist/main.js` in place of `depthcue`.

## Connect an agent

To let an agent edit and render a deck, add the server to your MCP client with the deck folder as its argument:

```json
{
  "mcpServers": {
    "depthcue": {
      "command": "node",
      "args": ["/path/to/depthcue/packages/mcp/dist/main.js", "/path/to/your/deck"]
    }
  }
}
```

## What a deck is

A folder: `deck.json` lists the scenes in order, and each scene is its own JSON file. This is a scene from the
bundled demo, trimmed:

```
fixtures/decks/demo/
  deck.json
  scenes/opening.json  demand.json  trend.json  field.json  shopfront.json  method.json  next.json
  assets/method.svg  report.csv  quarters.csv  shopfront-photo-5a6b7ae8.jpg
```

```json
{
  "id": "demand",
  "title": "Demand is shifting",
  "layout": "claim-evidence",
  "lead": "agent",
  "summary": {
    "id": "claim-shift",
    "text": "Channel B now leads, 60 to 40.",
    "evidenceIds": ["chart-demand"]
  },
  "blocks": [
    {
      "id": "chart-demand",
      "type": "bar-chart",
      "data": [{ "label": "Channel A", "value": 40 }, { "label": "Channel B", "value": 60 }],
      "sourceIds": ["source-report"]
    }
  ],
  "steps": [
    { "id": "show-claim", "reveal": ["claim-shift"] },
    { "id": "show-evidence", "reveal": ["chart-demand"] }
  ]
}
```

Every item has an id that never changes, so an edit names what it changes, a diff shows what moved, and a claim
points at the evidence and the source that back it. `lead` says who drives the scene: the person, the agent, or
both.

## Speed

Speed is a requirement. The player and the editor are separate builds, and the bar chart, table and clip modules
load when a scene needs them. `budgets.json` holds a size limit for each piece, and CI fails a build that goes over one.

## Brand

The mark, the logo, the social card and the type are in [`brand/`](brand/README.md), drawn from the design tokens
by `pnpm brand`.

## Research and plan

- [Plan](docs/PLAN.md): thesis, architecture, v0.1 scope, speed budgets, brand direction, and the roadmap to 1.0.
- [Research](docs/RESEARCH.md): a survey of existing tools, user complaints and architecture findings, with sources.

## License

MIT. See [LICENSE](LICENSE).
