import {
  type Block,
  type Flow,
  isLinkTarget,
  readsMarkup,
  type Scene,
  type Span,
  textFlow,
} from "@depthcue/core";
import { h } from "./dom.ts";

type TextBlock = Extract<Block, { type: "text" }>;

/** Text as it is written, a line at a time: a line break in a text is a `br`, so nothing depends on white-space rules. */
const lines = (text: string): Array<Node | string> =>
  text.split("\n").flatMap((part, at) => [...(at > 0 ? [h("br")] : []), ...(part === "" ? [] : [part])]);

/**
 * The spans of a text as DOM nodes. Every node is made with `h` and every string is a text node, so nothing in a deck's
 * text can become markup. A link gets its address only when `isLinkTarget` accepts it, opens in a new tab, and carries
 * `noopener noreferrer`; one the check refuses is drawn as its words.
 */
export function renderSpans(spans: readonly Span[]): Array<Node | string> {
  return spans.flatMap((span): Array<Node | string> => {
    if (span.type === "text") return lines(span.text);
    const inside = renderSpans(span.children);
    switch (span.type) {
      case "strong":
        return [h("strong", {}, ...inside)];
      case "em":
        return [h("em", {}, ...inside)];
      case "link":
        return isLinkTarget(span.href)
          ? [
              h(
                "a",
                { class: "dc-link", href: span.href, target: "_blank", rel: "noopener noreferrer" },
                ...inside,
              ),
            ]
          : inside;
      default:
        return [h("span", { class: "dc-tone", "data-tone": span.tone }, ...inside)];
    }
  });
}

/** One paragraph or list as DOM: `p`, `ul` or `ol`. A numbered list that does not start at 1 says where it does. */
export function renderFlow(flow: readonly Flow[]): HTMLElement[] {
  return flow.map((part) =>
    part.type === "paragraph"
      ? h("p", {}, ...renderSpans(part.children))
      : h(
          part.type === "bullets" ? "ul" : "ol",
          { start: part.type === "numbers" && part.start !== 1 ? part.start : undefined },
          ...part.items.map((item) => h("li", {}, ...renderSpans(item))),
        ),
  );
}

/** What a text block says about how it looks, as attributes the stylesheet answers: tone, size and alignment. */
const looks = (block: TextBlock) => ({
  "data-tone": block.tone,
  "data-size": block.size,
  "data-align": block.align,
});

/**
 * A text block's element. A scene below 0.3 shows the text exactly as written, in the element it always had. From 0.3
 * the text is markup: a heading, caption or quote holds its spans, and body text is a `div` of paragraphs and lists.
 */
export function renderText(scene: Pick<Scene, "schemaVersion">, block: TextBlock): HTMLElement {
  if (!readsMarkup(scene)) {
    return block.role === "heading"
      ? h("h2", { class: "dc-heading" }, block.text)
      : block.role === "quote"
        ? h("blockquote", { class: "dc-quote" }, h("p", {}, block.text))
        : h("p", { class: block.role === "caption" ? "dc-caption" : "dc-body" }, block.text);
  }
  const flow = textFlow(scene, block);
  const only = flow[0];
  const spans = only?.type === "paragraph" ? renderSpans(only.children) : [];
  switch (block.role) {
    case "heading":
      return h("h2", { class: "dc-heading", ...looks(block) }, ...spans);
    case "quote":
      return h("blockquote", { class: "dc-quote", ...looks(block) }, h("p", {}, ...spans));
    case "caption":
      return h("p", { class: "dc-caption", ...looks(block) }, ...spans);
    default:
      return h("div", { class: "dc-body", ...looks(block) }, ...renderFlow(flow));
  }
}
