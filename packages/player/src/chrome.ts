import {
  type Bands,
  type ChromeDeck,
  fillChrome,
  type PageLook,
  type PageTemplate,
  resolveChrome,
  type Scene,
  type SlideChrome,
} from "@depthcue/core";
import { h } from "./dom.ts";
import type { RenderContext } from "./scene.ts";

type Chrome = NonNullable<PageLook["chrome"]>;

export interface Shown {
  /** How much of the chrome the slide shows. */
  mode: SlideChrome["mode"];
  /** The slide's resolved chrome: the words of each zone, and the number and fields they were filled from. */
  slide: SlideChrome;
  /** The zones as the brand wrote them, with their fields in braces, for drawing a number apart from the words. */
  bands: Bands;
}

/**
 * What a slide's header and footer say. A page made with schema 0.7 or later carries the deck's facts in its look, and
 * the answer is `resolveChrome`'s, the same one the export and the agent read. A look made before that has a footer
 * line and a number only, and the slide's number is what the context was given.
 */
export function shown(
  chrome: Chrome,
  outline: ChromeDeck | undefined,
  scene: Scene,
  template: PageTemplate | undefined,
  ctx: RenderContext,
): Shown {
  if (chrome.bands && outline) {
    const index = outline.slides.findIndex((slide) => slide.id === scene.id);
    return { mode: "full", slide: resolveChrome(chrome.bands, outline, index), bands: chrome.bands };
  }
  const footer: Bands["footer"] = {};
  if (chrome.footer) footer[chrome.footer.place] = chrome.footer.text;
  if (chrome.number && ctx.number) {
    const old = footer[chrome.number.place];
    footer[chrome.number.place] = old === undefined ? "{number}" : `${old}  {number}`;
  }
  const bands: Bands = { header: {}, footer };
  const slides: ChromeDeck["slides"] = [
    { id: scene.id, title: scene.title, template: undefined, chrome: template?.chrome },
  ];
  const deck: ChromeDeck = { title: "", numbering: { start: ctx.number ?? 1 }, slides };
  const slide = resolveChrome(bands, deck, 0);
  return { mode: slide.mode, slide, bands };
}

/**
 * One zone as spans: the words, and the slide number apart from them with a class of its own, so a stylesheet and a
 * measurement can tell them apart.
 */
export function zoneNodes(text: string, band: "header" | "footer", slide: SlideChrome): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const piece of text.split(/(\{number\})/)) {
    if (piece === "{number}") {
      if (slide.number !== undefined)
        out.push(h("span", { class: "dc-number", "data-part": "number" }, String(slide.number)));
      continue;
    }
    // The spaces between the pieces are kept, so "3" and " / 4" read as one line; the zone's ends are trimmed below.
    const words = fillChrome(piece, slide.values, false);
    if (words !== "") out.push(h("span", { class: `dc-${band}`, "data-part": band }, words));
  }
  const first = out[0];
  const last = out.at(-1);
  if (first?.className !== "dc-number" && first) first.textContent = (first.textContent ?? "").trimStart();
  if (last?.className !== "dc-number" && last) last.textContent = (last.textContent ?? "").trimEnd();
  return out.filter((node) => node.className === "dc-number" || node.textContent !== "");
}
