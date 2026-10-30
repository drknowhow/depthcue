import type { Deck, Scene } from "@depthcue/core";
import { h } from "./dom.ts";
import { assetUrl } from "./safe.ts";
import { type RenderContext, renderChartTable, renderSources } from "./scene.ts";

/** The words of a scene when its author wrote no reading text: headings and body text, in order. */
function fallbackText(scene: Scene): string[] {
  const lines: string[] = [];
  if (scene.summary) lines.push(scene.summary.text);
  for (const block of scene.blocks) {
    if (block.type === "text" && block.role !== "caption") lines.push(block.text);
  }
  return lines;
}

function evidence(scene: Scene, ctx: RenderContext): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const block of scene.blocks) {
    if (block.type === "bar-chart") {
      out.push(h("figure", { class: "dc-figure" }, renderChartTable(block)));
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
        ...(scene.reading ? [scene.reading.text] : fallbackText(scene)).map((text) => h("p", {}, text)),
        ...evidence(scene, ctx),
        renderSources(scene, ctx),
      ),
    ),
  );
}
