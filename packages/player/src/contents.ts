import { contentsOf, type Scene } from "@depthcue/core";
import { h } from "./dom.ts";
import type { RenderContext } from "./scene.ts";

type ContentsBlock = Extract<Scene["blocks"][number], { type: "contents" }>;

/**
 * A table of contents, built from the deck's outline each time it is drawn, so it is right after any slide moves.
 * Every entry is a link to its slide, with the number that slide has. It is a real list for a screen reader.
 */
export function renderContents(scene: Scene, block: ContentsBlock, ctx: RenderContext): HTMLElement {
  const outline = ctx.look?.outline;
  const entries = outline ? contentsOf(outline, block.of ?? "sections", scene.id) : [];
  return h(
    "nav",
    { class: "dc-contents", "aria-label": "Contents" },
    entries.length > 0 &&
      h(
        "ol",
        { class: "dc-contents-list" },
        ...entries.map((entry) =>
          h(
            "li",
            { class: "dc-contents-item", "data-level": String(entry.level) },
            h(
              "a",
              { class: "dc-contents-link", href: `#/${entry.id}` },
              h("span", { class: "dc-contents-title" }, entry.title),
              h("span", { class: "dc-contents-number" }, String(entry.number)),
            ),
          ),
        ),
      ),
  );
}
