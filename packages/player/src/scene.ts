import type { Block, Scene } from "@depthcue/core";
import { h } from "./dom.ts";
import { gatedIds } from "./model.ts";
import { assetUrl, safeUrl } from "./safe.ts";

export interface RenderContext {
  /** Where `assets/...` paths resolve from, for example "." or "/decks/q3". */
  assetBase: string;
}

type Source = NonNullable<Scene["sources"]>[number];
type BarChart = Extract<Block, { type: "bar-chart" }>;

const unitText = (unit: string | undefined) => (unit === undefined ? "" : unit === "%" ? "%" : ` ${unit}`);

/**
 * The chart as a table with a bar in each row. This is the chart's static form: it reads correctly with no
 * script, to a screen reader, and in print. A chart module can replace it, never remove it.
 */
export function renderChartTable(block: BarChart): HTMLTableElement {
  const largest = Math.max(0, ...block.data.map((row) => row.value));
  const unit = unitText(block.unit);
  return h(
    "table",
    { class: "dc-chart" },
    block.title && h("caption", {}, block.title),
    h(
      "thead",
      { class: "dc-sr-only" },
      h("tr", {}, h("th", { scope: "col" }, "Label"), h("th", { scope: "col" }, "Value")),
    ),
    h(
      "tbody",
      {},
      ...block.data.map((row) =>
        h(
          "tr",
          {},
          h("th", { scope: "row" }, row.label),
          h(
            "td",
            {},
            h("span", {
              class: "dc-bar",
              "aria-hidden": "true",
              "--w": largest > 0 ? Math.max(0, row.value) / largest : 0,
            }),
            h("span", { class: "dc-value" }, `${row.value}${unit}`),
          ),
        ),
      ),
    ),
  );
}

function sourceLink(source: Source, ctx: RenderContext): HTMLElement {
  const href =
    (source.url && safeUrl(source.url)) || (source.asset ? assetUrl(ctx.assetBase, source.asset) : undefined);
  return href
    ? h("a", { href, rel: "noopener noreferrer", target: source.url ? "_blank" : undefined }, source.title)
    : h("span", {}, source.title);
}

export function renderSources(scene: Scene, ctx: RenderContext): HTMLElement | null {
  if (!scene.sources?.length) return null;
  return h(
    "footer",
    { class: "dc-sources" },
    h("p", { class: "dc-label" }, "Sources"),
    h("ol", {}, ...scene.sources.map((source) => h("li", { "data-id": source.id }, sourceLink(source, ctx)))),
  );
}

function cite(scene: Scene, block: Block): HTMLElement | null {
  const titles = (block.sourceIds ?? [])
    .map((id) => scene.sources?.find((source) => source.id === id)?.title)
    .filter((title): title is string => title !== undefined);
  return titles.length ? h("p", { class: "dc-cite" }, `Source: ${titles.join("; ")}`) : null;
}

function renderBlock(
  scene: Scene,
  block: Block,
  ctx: RenderContext,
  gated: ReadonlySet<string>,
): HTMLElement {
  let node: HTMLElement;
  switch (block.type) {
    case "text":
      node =
        block.role === "heading"
          ? h("h2", { class: "dc-heading" }, block.text)
          : block.role === "quote"
            ? h("blockquote", { class: "dc-quote" }, h("p", {}, block.text))
            : h("p", { class: block.role === "caption" ? "dc-caption" : "dc-body" }, block.text);
      break;
    case "image": {
      const src = assetUrl(ctx.assetBase, block.asset);
      node = h(
        "figure",
        { class: "dc-figure" },
        src && h("img", { src, alt: block.alt, decoding: "async" }),
        block.caption && h("figcaption", {}, block.caption),
      );
      break;
    }
    case "clip": {
      const src = assetUrl(ctx.assetBase, block.source);
      const poster = block.poster && assetUrl(ctx.assetBase, block.poster);
      node = h(
        "figure",
        { class: "dc-figure dc-clip" },
        src &&
          h(
            "video",
            {
              controls: true,
              preload: "none",
              playsinline: true,
              "aria-label": block.alt,
              poster: poster || undefined,
            },
            h("source", { src }),
          ),
      );
      break;
    }
    case "bar-chart":
      node = h("figure", { class: "dc-figure dc-chart-figure" }, renderChartTable(block));
      break;
  }
  node.dataset.id = block.id;
  node.classList.add("dc-block");
  if (gated.has(block.id)) {
    node.dataset.gated = "";
    node.dataset.revealed = "false";
  }
  const citation = cite(scene, block);
  if (citation) node.append(citation);
  return node;
}

const isMedia = (block: Block) => block.type !== "text";

/** One scene as DOM. Every block is present; the player shows and hides gated ones as steps advance. */
export function renderScene(scene: Scene, ctx: RenderContext): HTMLElement {
  const gated = gatedIds(scene);
  const blocks = scene.blocks.map((block) => ({ block, node: renderBlock(scene, block, ctx, gated) }));
  const nodes = (pick: (block: Block) => boolean) =>
    blocks.filter((entry) => pick(entry.block)).map((e) => e.node);

  let body: HTMLElement[];
  if (scene.layout === "claim-evidence") {
    const evidenceIds = new Set(scene.summary?.evidenceIds ?? []);
    const claim = scene.summary
      ? h(
          "h2",
          { class: "dc-claim", "data-id": scene.summary.id, ...gateAttributes(scene.summary.id, gated) },
          scene.summary.text,
        )
      : null;
    const headings = nodes((block) => !claim && block.type === "text" && block.role === "heading");
    const evidence = nodes((block) => evidenceIds.has(block.id));
    const support = nodes(
      (block) => !evidenceIds.has(block.id) && !(!claim && block.type === "text" && block.role === "heading"),
    );
    body = [
      h("p", { class: "dc-eyebrow" }, scene.title),
      h("div", { class: "dc-region dc-claim-region" }, claim, ...headings),
      h("div", { class: "dc-region dc-evidence-region" }, ...evidence),
      h("div", { class: "dc-region dc-support-region" }, ...support),
    ];
  } else if (scene.layout === "text-media") {
    const text = nodes((block) => !isMedia(block));
    const media = nodes(isMedia);
    body = [h("div", { class: "dc-region dc-text-region" }, ...text)];
    if (media.length > 0) body.push(h("div", { class: "dc-region dc-media-region" }, ...media));
  } else {
    body = [h("div", { class: "dc-region dc-stack" }, ...blocks.map((entry) => entry.node))];
  }

  return h(
    "section",
    {
      class: "dc-scene",
      "data-layout": scene.layout,
      "data-lead": scene.lead ?? "human",
      "data-scene": scene.id,
      "aria-label": scene.title,
      tabindex: -1,
    },
    ...body,
    renderSources(scene, ctx),
  );
}

function gateAttributes(id: string, gated: ReadonlySet<string>) {
  return gated.has(id) ? { "data-gated": true, "data-revealed": "false" } : {};
}
