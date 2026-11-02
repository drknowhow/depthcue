import { type Block, type Deck, readsMarkup, type Scene, textFlow } from "@depthcue/core";
import { h } from "./dom.ts";
import { assetUrl } from "./safe.ts";
import { type RenderContext, renderChartTable, renderSources, templateOf } from "./scene.ts";
import { renderTable } from "./table.ts";
import { renderFlow } from "./text.ts";

/**
 * The blocks of a scene in the order a reader meets them, with the claim, if there is one, among them as `"claim"`. A
 * template scene reads in its template's slot order, whatever order its blocks are written in, with the claim where the
 * claim slot is; a block without a slot (or in a slot the template lacks) follows. Any other scene reads claim first,
 * then its blocks as written, as it always has.
 */
function readingOrder(scene: Scene, ctx: RenderContext): Array<Block | "claim"> {
  const template = templateOf(scene, ctx.look);
  const items: Array<Block | "claim"> = scene.summary ? ["claim", ...scene.blocks] : [...scene.blocks];
  if (!template) return items;
  const rank = (item: Block | "claim"): number => {
    const slots = template.slots;
    const at =
      item === "claim"
        ? slots.findIndex((slot) => slot.role === "claim")
        : slots.findIndex((slot) => slot.id === item.slot);
    return at < 0 ? (item === "claim" ? -1 : slots.length) : at;
  };
  return items
    .map((item, at) => ({ item, at, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ item }) => item);
}

/**
 * The words of a scene when its author wrote no reading text: headings and body text, in order, with the formatting
 * and lists of a scene that reads markup. A scene below 0.3 gives its text as written.
 */
function fallbackText(scene: Scene, ctx: RenderContext): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const block of readingOrder(scene, ctx)) {
    if (block === "claim") {
      if (scene.summary) out.push(h("p", {}, scene.summary.text));
      continue;
    }
    if (block.type !== "text" || block.role === "caption") continue;
    out.push(...(readsMarkup(scene) ? renderFlow(textFlow(scene, block)) : [h("p", {}, block.text)]));
  }
  return out;
}

function evidence(scene: Scene, ctx: RenderContext): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const block of readingOrder(scene, ctx)) {
    if (block === "claim") continue;
    if (block.type === "bar-chart") {
      out.push(h("figure", { class: "dc-figure" }, renderChartTable(block)));
    } else if (block.type === "table") {
      out.push(h("figure", { class: "dc-figure" }, renderTable(block, ctx.language)));
    } else if (block.type === "image") {
      const src = assetUrl(ctx.assetBase, block.asset);
      out.push(
        h(
          "figure",
          { class: "dc-figure" },
          src && h("img", { src, alt: block.alt, loading: "lazy", decoding: "async" }),
          block.caption && h("figcaption", {}, block.caption),
        ),
      );
    }
  }
  return out;
}

/**
 * Reading view: the whole deck as one document, with no steps and no hidden content. Each scene gives its
 * reading text (or its own words when there is none), its charts as data tables, its images and its sources.
 */
export function renderReading(deck: Deck, scenes: readonly Scene[], ctx: RenderContext): HTMLElement {
  return h(
    "main",
    { class: "dc-reading", "aria-label": `${deck.title}, reading view` },
    h("h1", { class: "dc-reading-title" }, deck.title),
    ...scenes.map((scene) =>
      h(
        "article",
        { class: "dc-reading-scene", "data-scene": scene.id },
        h("h2", {}, scene.title),
        ...(scene.reading ? [h("p", {}, scene.reading.text)] : fallbackText(scene, ctx)),
        ...evidence(scene, ctx),
        renderSources(scene, ctx),
      ),
    ),
  );
}
