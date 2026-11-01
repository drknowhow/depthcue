<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/logo-on-dark.svg">
  <img src="brand/logo.svg" alt="Depthcue" height="64">
</picture>

Depthcue is an open-source format and player for explanations that an agent can write, a person can repair, and
both can present. A deck is typed JSON with stable ids, so it can be generated, reviewed in a pull request, edited
by hand, and read afterwards as a document.

**Status: 0.1, before release.** Nothing is published to npm yet, so you run it from a clone. The deck schema is
0.2 (decks written for 0.1 still load) and can still change. [The plan](docs/PLAN.md) has the thesis, the architecture and the roadmap to 1.0.

## What works today

- **Write and check.** `depthcue check` validates every scene, reference and asset and says where each problem is.
  `depthcue render` draws each scene in a headless browser and reports overflow, clipping, overlap, small text and
  low contrast, with a PNG per scene if you ask.
- **Edit by hand.** `depthcue edit` opens a browser editor. Its changes go through the same operations an agent
  uses, save only when you ask, and a draft survives a closed tab.
- **Edit by agent.** `depthcue-mcp` is an MCP server with five tools: `deck_get`, `deck_apply`, `deck_comment`,
  `deck_render` and `deck_present`. An edit is one transaction against a revision. A stale revision is rejected,
  never merged. A person's comments sit beside the deck, never in it, and an agent can answer them with `deck_comment`.
- **Present.** Keyboard navigation, a reading view for the audience, and a [presenter window](docs/presenter.md)
  with notes, a timer and a preview of the next move. A person can [hand control to an agent](docs/lease.md) and
  take it back at once.
- **Blocks.** Text, images, bar charts, and [Kinescript clips](docs/clips.md) with cue chips that jump to a moment.
- **Deliver offline.** `depthcue export` writes a folder that opens by double-click, with [no server and no
  network](docs/export.md).

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
  scenes/opening.json  demand.json  method.json
  assets/method.svg  report.csv
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

Speed is a requirement. The player and the editor are separate builds, and the chart and clip modules load when a
scene needs them. `budgets.json` holds a size limit for each piece, and CI fails a build that goes over one.

## Brand

The mark, the logo, the social card and the type are in [`brand/`](brand/README.md), drawn from the design tokens
by `pnpm brand`.

## Research and plan

- [Plan](docs/PLAN.md): thesis, architecture, v0.1 scope, speed budgets, brand direction, and the roadmap to 1.0.
- [Research](docs/RESEARCH.md): a survey of existing tools, user complaints and architecture findings, with sources.

## License

MIT. See [LICENSE](LICENSE).
