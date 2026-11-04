import type { Block, Deck, PageLook, PageSlot, PageStyle, PageTemplate, Scene } from "@depthcue/core";
import { renderChart } from "./charts/draw.ts";
import { h } from "./dom.ts";
import { type Followed, followLink, linkElement } from "./links.ts";
import { gatedIds } from "./model.ts";
import { assetUrl, brandUrl, safeUrl } from "./safe.ts";
import { renderTable, unitText } from "./table.ts";
import { renderText } from "./text.ts";

export interface RenderContext {
  /** Where `assets/...` and `brand/...` paths resolve from, for example "." or "/decks/q3". */
  assetBase: string;
  /** The deck's language, so a table writes its numbers with the decimal sign the deck's readers use. */
  language?: string;
  /**
   * How the deck looks: its templates, styles and chrome. Without it a scene is drawn from its layout alone, and a
   * template scene as a plain stack, so a deck read from plain files still shows everything it says.
   */
  look?: PageLook;
  /** The scene's place in the deck, from 1, for the slide number the brand draws. */
  number?: number;
  /** The deck's link library, which a block's or a source's `link` names. */
  links?: Deck["links"];
  /** The deck's scenes, which a link to a scene lands on. */
  scenes?: readonly Scene[];
}

type Source = NonNullable<Scene["sources"]>[number];
type BarChart = Extract<Block, { type: "bar-chart" }>;
type TextBlock = Extract<Block, { type: "text" }>;

/** A property of a table that came from JSON, only if it is the table's own: a key like `__proto__` finds nothing. */
export const ownOf = <T>(
  table: Readonly<Record<string, T>> | undefined,
  key: string | undefined,
): T | undefined =>
  table !== undefined && key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

/** A color that text on it is reversed for: every one but the slide's own two, as core's `textOn` has it. */
const isStrong = (color?: string): boolean =>
  !!color && color !== "none" && color !== "bg" && color !== "surface";

/** The template a scene names, from the look. */
export const templateOf = (
  scene: Pick<Scene, "template">,
  look: PageLook | undefined,
): PageTemplate | undefined =>
  scene.template === undefined ? undefined : ownOf(look?.templates, scene.template);

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
  const followed = source.link === undefined ? undefined : followLink(ctx, source.link);
  if (followed) {
    const node = linkElement({ ...followed, title: source.title }, "dc-source-link");
    return node;
  }
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
        src && h("img", { src, alt: block.decorative ? "" : block.alt, decoding: "async" }),
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
  const followed: Followed | undefined = block.link === undefined ? undefined : followLink(ctx, block.link);
  if (followed) node.append(h("p", { class: "dc-link-row" }, linkElement(followed)));
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

interface Entry {
  block: Block;
  /** What stands in the flow: the block, or the room a pinned one keeps. */
  slot: HTMLElement;
}

/**
 * What a style says about a node, as attributes player.css answers: its font, weight and case, its fill, border, accent
 * edge, radius and padding, and for text its tone, size and alignment. The block's own tone, size and align win. A fill
 * that is not one of the slide's own colors reverses the text on it, as a template's strong background does.
 */
function dress(node: HTMLElement, style: PageStyle, mine?: Partial<TextBlock>): void {
  const strong = isStrong(style.fill);
  if (mine) {
    const tone = mine.tone ?? style.tone ?? (strong ? "bg" : undefined);
    const size = mine.size ?? style.size;
    const align = mine.align ?? style.align;
    if (tone) node.dataset.tone = tone;
    if (size) node.dataset.size = size;
    if (align) node.dataset.align = align;
  }
  for (const name of ["font", "weight", "case", "fill", "border", "edge", "radius", "pad"] as const) {
    const value = style[name];
    if (value && value !== "none") node.setAttribute(`data-${name}`, value);
  }
  if (strong) node.dataset.on = "strong";
}

/** The box a slot is, at its frame on the 16 by 9 slide, holding the nodes its blocks drew in block order. */
function slotBox(slot: PageSlot, nodes: HTMLElement[]): HTMLElement {
  return h(
    "div",
    {
      class: "dc-region dc-slot",
      "data-slot": slot.id,
      "data-role": slot.role,
      "data-valign": slot.valign,
      "--x": slot.frame.x,
      "--y": slot.frame.y,
      "--w": slot.frame.w,
      "--h": slot.frame.h,
    },
    ...nodes,
  );
}

/**
 * A template scene: a box for each slot that has something in it, in the template's order, placed at the slot's frame.
 * The claim goes in the claim slot. A pinned block keeps its place in its slot (the room it takes) and is drawn at its
 * own frame; one pinned with no slot floats over the template and is in no slot. A slot with nothing in it draws
 * nothing. What has no slot to go to, because the deck is not valid, follows in a plain stack rather than vanish.
 */
function slotted(
  template: PageTemplate,
  entries: readonly Entry[],
  claim: HTMLElement | null,
): HTMLElement[] {
  // What no slot takes is held under "", which no slot is called, and follows in a plain stack.
  const held = new Map<string, HTMLElement[]>();
  const put = (id: string, node: HTMLElement | null) => node && held.set(id, [...(held.get(id) ?? []), node]);
  put(template.slots.find((slot) => slot.role === "claim")?.id ?? "", claim);
  for (const { block, slot } of entries) {
    if (block.slot !== undefined || !block.frame) {
      put(template.slots.some(({ id }) => id === block.slot) ? (block.slot as string) : "", slot);
    }
  }
  const boxes = template.slots.flatMap((slot) => {
    const nodes = held.get(slot.id);
    return nodes ? [slotBox(slot, nodes)] : [];
  });
  const loose = held.get("");
  return loose ? [...boxes, h("div", { class: "dc-region dc-stack" }, ...loose)] : boxes;
}

/**
 * The brand's chrome on a scene: the logo in its corner, the footer line and the slide number along the bottom, and
 * the accent bar. A template says how much shows: all, the logo alone, or none. Only the logo is for a screen reader,
 * once, with the brand's words for it; the rest is decoration the reader is spared.
 */
function renderChrome(look: PageLook | undefined, template: PageTemplate | undefined, ctx: RenderContext) {
  const chrome = look?.chrome;
  const mode = template?.chrome;
  if (!chrome || mode === "none") return null;
  const { logo } = chrome;
  const src = logo && brandUrl(ctx.assetBase, logo.path);
  // The footer and the number that share a place share a cell, side by side.
  const feet = new Map<string, HTMLElement[]>();
  const foot = (part: string, place?: string, text?: string) => {
    if (mode !== "minimal" && place && text) {
      feet.set(place, [
        ...(feet.get(place) ?? []),
        h("span", { class: `dc-${part}`, "data-part": part }, text),
      ]);
    }
  };
  foot("footer", chrome.footer?.place, chrome.footer?.text);
  foot("number", chrome.number?.place, ctx.number ? String(ctx.number) : undefined);
  const parts = [
    mode !== "minimal" &&
      chrome.accent !== "none" &&
      h("span", {
        class: "dc-accent",
        "data-part": "accent",
        "data-accent": chrome.accent,
        "aria-hidden": "true",
      }),
    ...[...feet].map(([at, nodes]) =>
      h("div", { class: "dc-foot", "data-at": at, "aria-hidden": "true" }, ...nodes),
    ),
    logo &&
      src &&
      h("img", {
        class: "dc-logo",
        src,
        alt: logo.alt,
        decoding: "async",
        "data-part": "logo",
        "data-corner": logo.corner,
        "data-height": logo.size,
      }),
  ];
  return parts.some(Boolean) ? h("div", { class: "dc-chrome" }, ...parts) : null;
}

/**
 * One scene as DOM. Every block is present; the player shows and hides gated ones as steps advance. A pinned block
 * (one with a `frame`) sits at its frame, in a layer over a 16 by 9 slide, in block order. Its place in the template
 * stays reserved, so pinning one block moves nothing else.
 */
export function renderScene(scene: Scene, ctx: RenderContext): HTMLElement {
  const gated = gatedIds(scene);
  const look = ctx.look;
  const template = templateOf(scene, look);
  const slotOf = (id: string | undefined) => template?.slots.find((slot) => slot.id === id);
  const evidenceIds = new Set(scene.summary?.evidenceIds ?? []);
  const blocks = scene.blocks.map((block) => {
    const node = renderBlock(scene, block, ctx, gated);
    // A block's style is its own, or else the one its slot gives; its own tone, size and align win over the style's.
    const styleId = block.style ?? slotOf(block.slot)?.style;
    const style = ownOf(look?.styles, styleId);
    if (style) dress(node, style, block.type === "text" ? block : undefined);
    if (template && evidenceIds.has(block.id)) node.dataset.evidence = "";
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
  if (claim && template) {
    const style = ownOf(look?.styles, template.slots.find((slot) => slot.role === "claim")?.style);
    if (style) dress(claim, style, {});
  }
  let body: HTMLElement[];
  if (template) {
    body = slotted(template, blocks, claim);
  } else if (scene.layout === "claim-evidence") {
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
    // A layout with nothing special to do, or a template the page has no look for: everything the scene says, in order,
    // rather than nothing.
    body = [
      h("div", { class: "dc-region dc-stack" }, scene.template !== undefined && claim, ...nodes(() => true)),
    ];
  }

  // The template's background: one of the slide's colors, or a brand image under a scrim of it. Text on a strong one
  // is reversed, in the scene's own colors, so every block and chart on it reads without a style of its own.
  const background = template?.background;
  const image = background?.image && brandUrl(ctx.assetBase, `brand/${background.image}`);
  const chrome = renderChrome(look, template, ctx);

  return h(
    "section",
    {
      class: "dc-scene",
      "data-layout": scene.layout,
      "data-template": scene.template,
      "data-lead": scene.lead ?? "human",
      "data-framed": pinned.length > 0 || template !== undefined,
      "data-bg": background?.color,
      "data-on": background && isStrong(background.color) ? "strong" : undefined,
      "data-image": image ? "" : undefined,
      "data-scene": scene.id,
      "aria-label": scene.title,
      tabindex: -1,
    },
    image ? backdrop(image, background?.scrim ?? 0) : null,
    ...body,
    pinned.length > 0 && h("div", { class: "dc-pins" }, ...pinned),
    renderSources(scene, ctx),
    chrome,
  );
}

/** The picture behind a template's slide, with the scrim over it drawn by the stylesheet at `scrim` percent. */
function backdrop(url: string, scrim: number): HTMLElement {
  const node = h("div", { class: "dc-backdrop", "aria-hidden": "true", "--scrim": scrim });
  node.style.backgroundImage = `url("${url.replaceAll('"', "%22")}")`;
  return node;
}

function gateAttributes(id: string, gated: ReadonlySet<string>) {
  return gated.has(id) ? { "data-gated": true, "data-revealed": "false" } : {};
}
