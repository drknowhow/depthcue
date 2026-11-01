import type { Block, Scene } from "@depthcue/core";
import { renderChart } from "./charts/draw.ts";
import { h } from "./dom.ts";
import { gatedIds } from "./model.ts";
import { assetUrl, safeUrl } from "./safe.ts";
import { renderTable, unitText } from "./table.ts";
import { renderText } from "./text.ts";

export interface RenderContext {
  /** Where `assets/...` paths resolve from, for example "." or "/decks/q3". */
  assetBase: string;
  /** The deck's language, so a table writes its numbers with the decimal sign the deck's readers use. */
  language?: string;
}

type Source = NonNullable<Scene["sources"]>[number];
type BarChart = Extract<Block, { type: "bar-chart" }>;

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
      node = renderText(scene, block);
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
    case "table":
      node = h("figure", { class: "dc-figure dc-table-figure" }, renderTable(block, ctx.language));
      break;
    case "chart":
      node = renderChart(block, ctx.language);
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

/** Puts a pinned block at its frame: the stylesheet turns these four numbers into a box on the slide. */
function pin(node: HTMLElement, frame: NonNullable<Block["frame"]>): HTMLElement {
  node.classList.add("dc-pinned");
  for (const key of ["x", "y", "w", "h"] as const) node.style.setProperty(`--${key}`, String(frame[key]));
  return node;
}

/**
 * What a pinned block leaves in its region: a copy that takes the same room and has nothing to see, hear, reach or
 * find. It has no id, so nothing that looks a block up by id meets it.
 */
function ghost(node: HTMLElement): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.classList.replace("dc-block", "dc-ghost");
  for (const name of ["data-id", "data-gated", "data-revealed"]) copy.removeAttribute(name);
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  return copy;
}

/**
 * A template scene, for now: one labeled region per slot its blocks name, in the order the slots first appear, each
 * holding its blocks in order, after the claim's. The player has not yet the template itself, so the slots are
 * stacked, not placed. A block pinned with no slot is in none: it sits only at its frame.
 */
function slotRegions(
  entries: ReadonlyArray<{ block: Block; slot: HTMLElement }>,
  claim: HTMLElement | null,
): HTMLElement[] {
  const slots = new Map<string, HTMLElement[]>(claim ? [["claim", [claim]]] : []);
  for (const { block, slot } of entries) {
    if (block.slot === undefined && block.frame) continue;
    const id = block.slot ?? "";
    slots.set(id, [...(slots.get(id) ?? []), slot]);
  }
  return [...slots].map(([id, nodes]) =>
    h(
      "div",
      { class: "dc-region dc-slot", "data-slot": id },
      h("span", { class: "dc-slot-label", "aria-hidden": "true" }, id),
      ...nodes,
    ),
  );
}

/**
 * One scene as DOM. Every block is present; the player shows and hides gated ones as steps advance. A pinned block
 * (one with a `frame`) sits at its frame, in a layer over a 16 by 9 slide, in block order. Its place in the template
 * stays reserved, so pinning one block moves nothing else.
 */
export function renderScene(scene: Scene, ctx: RenderContext): HTMLElement {
  const gated = gatedIds(scene);
  const blocks = scene.blocks.map((block) => {
    const node = renderBlock(scene, block, ctx, gated);
    return { block, node, slot: block.frame ? ghost(node) : node };
  });
  const nodes = (pick: (block: Block) => boolean) =>
    blocks.filter((entry) => pick(entry.block)).map((entry) => entry.slot);
  const pinned = blocks.flatMap(({ block, node }) => (block.frame ? [pin(node, block.frame)] : []));

  const claim = scene.summary
    ? h(
        "h2",
        { class: "dc-claim", "data-id": scene.summary.id, ...gateAttributes(scene.summary.id, gated) },
        scene.summary.text,
      )
    : null;
  let body: HTMLElement[];
  if (scene.template !== undefined) {
    body = slotRegions(blocks, claim);
  } else if (scene.layout === "claim-evidence") {
    const evidenceIds = new Set(scene.summary?.evidenceIds ?? []);
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
    body = [h("div", { class: "dc-region dc-stack" }, ...nodes(() => true))];
  }

  return h(
    "section",
    {
      class: "dc-scene",
      "data-layout": scene.layout,
      "data-template": scene.template,
      "data-lead": scene.lead ?? "human",
      "data-framed": pinned.length > 0,
      "data-scene": scene.id,
      "aria-label": scene.title,
      tabindex: -1,
    },
    ...body,
    pinned.length > 0 && h("div", { class: "dc-pins" }, ...pinned),
    renderSources(scene, ctx),
  );
}

function gateAttributes(id: string, gated: ReadonlySet<string>) {
  return gated.has(id) ? { "data-gated": true, "data-revealed": "false" } : {};
}
