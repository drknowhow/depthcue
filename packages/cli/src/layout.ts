import { type Diagnostic, type Scene, scenePath } from "@depthcue/core";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TextSample {
  /** The block this text belongs to; empty for text the scene owns, such as the eyebrow. */
  id: string;
  text: string;
  fontPx: number;
  weight: number;
  fg: Rgba;
  /** Background the text sits on, every translucent layer already composited. Always opaque. */
  bg: Rgba;
}

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which edge of the visible stage the box crosses, if any. */
  beyond: "top" | "right" | "bottom" | "left" | null;
}

/** Raw measurements of one rendered scene. Gathered in the page, judged by `layoutDiagnostics`. */
export interface LayoutMeasure {
  viewport: { width: number; height: number };
  view: { width: number; height: number; scrollWidth: number; scrollHeight: number };
  boxes: Box[];
  clipped: Array<{ id: string; axis: "x" | "y"; by: number }>;
  /** `pinned` names those of the two that sit at a frame; it is empty when both are in the template. */
  overlaps: Array<{ a: string; b: string; width: number; height: number; pinned: string[] }>;
  /** Pinned blocks whose content is larger than their frame, by how many pixels. */
  spills: Array<{ id: string; x: number; y: number }>;
  text: TextSample[];
  images: Array<{ id: string; src: string; ok: boolean }>;
  words: number;
}

/**
 * Runs inside the page, so it cannot use anything from this module: every helper lives in its body.
 * Measures the stage at full reveal after fonts and images are ready.
 */
export async function measureLayout(): Promise<LayoutMeasure> {
  // A font file is not requested until a layout uses it, and `fonts.ready` only waits for requests that are under way.
  // Laying the page out first starts the downloads for the deck's font pair, so the widths measured below are the
  // widths of the real fonts and not of the fallbacks.
  void document.body.offsetWidth;
  await document.fonts.ready;
  const images = [...document.querySelectorAll<HTMLImageElement>(".dc-scene img:not(.dc-ghost img)")];
  await Promise.all(images.map((image) => image.decode().catch(() => undefined)));

  const view = document.querySelector<HTMLElement>(".dc-view");
  const scene = document.querySelector<HTMLElement>(".dc-scene");
  if (!view || !scene) throw new Error("The player did not render a scene.");

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  // The canvas turns any CSS color (hex, oklch, color-mix) into plain sRGB bytes.
  const parse = (value: string): { r: number; g: number; b: number; a: number } => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (
    top: { r: number; g: number; b: number; a: number },
    under: { r: number; g: number; b: number },
  ) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });

  const visible = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (node.classList.contains("dc-sr-only")) return false;
    }
    return element.getClientRects().length > 0;
  };
  const owner = (element: Element): string =>
    (element.closest("[data-id]") as HTMLElement | null)?.dataset.id ?? "";

  const background = (element: Element) => {
    const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer.a > 0) layers.push(layer);
      if (layer.a === 1) break;
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i] as (typeof layers)[0], result);
    return result;
  };
  const opacityOf = (element: Element): number => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity;
  };

  const viewBox = view.getBoundingClientRect();
  const round = (value: number) => Math.round(value * 10) / 10;

  const blocks = [...scene.querySelectorAll<HTMLElement>(".dc-block, .dc-claim")].filter(visible);
  const boxes = blocks.map((block) => {
    const box = block.getBoundingClientRect();
    let beyond: "top" | "right" | "bottom" | "left" | null = null;
    if (box.bottom > viewBox.bottom + 1) beyond = "bottom";
    else if (box.right > viewBox.right + 1) beyond = "right";
    else if (box.top < viewBox.top - 1) beyond = "top";
    else if (box.left < viewBox.left - 1) beyond = "left";
    return {
      id: block.dataset.id ?? "",
      x: round(box.x),
      y: round(box.y),
      width: round(box.width),
      height: round(box.height),
      beyond,
    };
  });

  const overlaps: LayoutMeasure["overlaps"] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i] as HTMLElement;
      const b = blocks[j] as HTMLElement;
      if (a.contains(b) || b.contains(a)) continue;
      const first = a.getBoundingClientRect();
      const second = b.getBoundingClientRect();
      const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
      const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      if (width > 2 && height > 2) {
        overlaps.push({
          a: a.dataset.id ?? "",
          b: b.dataset.id ?? "",
          width: round(width),
          height: round(height),
          pinned: [a, b]
            .filter((node) => node.classList.contains("dc-pinned"))
            .map((node) => node.dataset.id ?? ""),
        });
      }
    }
  }

  // A pinned block is as big as its frame, so text that does not fit runs out of it over its neighbors.
  const spills: LayoutMeasure["spills"] = [];
  for (const pin of scene.querySelectorAll<HTMLElement>(".dc-pinned")) {
    if (!visible(pin)) continue;
    const x = pin.scrollWidth - pin.clientWidth;
    const y = pin.scrollHeight - pin.clientHeight;
    if (x > 1 || y > 1) spills.push({ id: pin.dataset.id ?? "", x: Math.max(0, x), y: Math.max(0, y) });
  }

  const clipped: LayoutMeasure["clipped"] = [];
  for (const element of scene.querySelectorAll<HTMLElement>("*")) {
    if (!visible(element)) continue;
    const style = getComputedStyle(element);
    if (style.overflowX !== "visible" && element.scrollWidth > element.clientWidth + 1) {
      clipped.push({ id: owner(element), axis: "x", by: element.scrollWidth - element.clientWidth });
    }
    if (style.overflowY !== "visible" && element.scrollHeight > element.clientHeight + 1) {
      clipped.push({ id: owner(element), axis: "y", by: element.scrollHeight - element.clientHeight });
    }
  }

  const text: TextSample[] = [];
  let words = 0;
  for (const element of scene.querySelectorAll<HTMLElement>("*")) {
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .trim();
    if (own === "" || !visible(element)) continue;
    words += own.split(/\s+/).length;
    const style = getComputedStyle(element);
    const fg = parse(style.color);
    text.push({
      id: owner(element),
      text: own.slice(0, 60),
      fontPx: round(Number.parseFloat(style.fontSize)),
      weight: Number(style.fontWeight),
      fg: { ...fg, a: fg.a * opacityOf(element) },
      bg: background(element),
    });
  }

  return {
    viewport: { width: innerWidth, height: innerHeight },
    view: {
      width: view.clientWidth,
      height: view.clientHeight,
      scrollWidth: view.scrollWidth,
      scrollHeight: view.scrollHeight,
    },
    boxes,
    clipped,
    overlaps,
    spills,
    text,
    images: images.map((image) => ({
      id: owner(image),
      src: image.getAttribute("src") ?? "",
      ok: image.complete && image.naturalWidth > 0,
    })),
    words,
  };
}

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of text over its background, with the text's own transparency applied. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const shown = {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
  const [light, dark] = [luminance(shown), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG 2.2 AA: 3 for large text (24 px, or 18.66 px bold), 4.5 for the rest. */
export const requiredContrast = (fontPx: number, weight: number): number =>
  fontPx >= 24 || (fontPx >= 18.66 && weight >= 700) ? 3 : 4.5;

export interface LayoutOptions {
  /** Smallest readable text in CSS pixels at the rendered viewport. Default 12. */
  minFontPx?: number;
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

function pointerFor(scene: Scene, id: string): string {
  if (id === "") return "";
  if (scene.summary?.id === id) return "/summary";
  const block = scene.blocks.findIndex((candidate) => candidate.id === id);
  if (block >= 0) return `/blocks/${block}`;
  const source = scene.sources?.findIndex((candidate) => candidate.id === id) ?? -1;
  return source >= 0 ? `/sources/${source}` : "";
}

/** The text block the author can shorten most, for the first step of the repair order. */
function longestText(scene: Scene): { id: string; words: number } | undefined {
  const candidates = scene.blocks.flatMap((block) =>
    block.type === "text" ? [{ id: block.id, words: words(block.text) }] : [],
  );
  if (scene.summary) candidates.push({ id: scene.summary.id, words: words(scene.summary.text) });
  return candidates.sort((a, b) => b.words - a.words)[0];
}

const REPAIR = (scene: Scene): string => {
  const longest = longestText(scene);
  const shorten = longest
    ? `Shorten the text first; "${longest.id}" is the longest at ${longest.words} words`
    : "Shorten the text first";
  return `${shorten}. If it still does not fit, pick a roomier template, then split the scene in two. Nothing is scaled down to fit.`;
};

/** Turns measurements into diagnostics. Every one is an error: the render is what the audience would see. */
export function layoutDiagnostics(
  scene: Scene,
  measure: LayoutMeasure,
  options: LayoutOptions = {},
): Diagnostic[] {
  const file = scenePath(scene.id);
  const minFontPx = options.minFontPx ?? 12;
  const { width, height } = measure.viewport;
  const out: Diagnostic[] = [];
  const report = (severity: Diagnostic["severity"], code: string, id: string, message: string, fix: string) =>
    out.push({ severity, code, file, path: pointerFor(scene, id), message, fix });
  const error = (code: string, id: string, message: string, fix: string) =>
    report("error", code, id, message, fix);

  const tall = measure.view.scrollHeight - measure.view.height;
  const wide = measure.view.scrollWidth - measure.view.width;
  if (tall > 1) {
    const cut = measure.boxes.filter((box) => box.beyond === "bottom").map((box) => box.id);
    error(
      "overflow",
      cut[0] ?? "",
      `The scene is ${tall}px taller than the ${width}x${height} stage, so the audience would have to scroll.${cut.length > 0 ? ` Below the visible area: ${cut.join(", ")}.` : " Every block is visible, but there is no room left for the margins."}`,
      REPAIR(scene),
    );
  }
  if (wide > 1) {
    const cut = measure.boxes.filter((box) => box.beyond === "right").map((box) => box.id);
    error(
      "overflow-x",
      cut[0] ?? "",
      `The scene is ${wide}px wider than the ${width}x${height} stage.${cut.length > 0 ? ` Past the right edge: ${cut.join(", ")}.` : ""}`,
      "A long unbroken word or an oversized block is the usual cause. Shorten it, or split the scene.",
    );
  }

  const seen = new Set<string>();
  for (const clip of measure.clipped) {
    const key = `${clip.id}:${clip.axis}`;
    if (seen.has(key)) continue;
    seen.add(key);
    error(
      "clipped",
      clip.id,
      `Part of ${clip.id ? `"${clip.id}"` : "the scene"} is cut off ${clip.axis === "x" ? "sideways" : "at the bottom"} by ${clip.by}px.`,
      REPAIR(scene),
    );
  }

  for (const overlap of measure.overlaps) {
    const message = `"${overlap.a}" and "${overlap.b}" overlap by ${overlap.width}x${overlap.height}px.`;
    if (overlap.pinned.length === 0) {
      error(
        "overlap",
        overlap.a,
        message,
        "Templates own the geometry, so an overlap means the content does not fit the template. Shorten the text or split the scene.",
      );
      continue;
    }
    // Someone put a block there, so it may be on purpose, such as a label on a picture: a warning, not an error.
    const names = overlap.pinned.map((id) => `"${id}"`).join(" or ");
    report(
      "warning",
      "frame-overlap",
      overlap.pinned[0] ?? overlap.a,
      message,
      `Move or resize the frame of ${names}${overlap.pinned.length === 1 ? ", or unpin it to put it back in the template" : ""}. Leave it if the overlap is on purpose.`,
    );
  }

  for (const spill of measure.spills) {
    const by = spill.y > 1 ? `${spill.y}px taller` : `${spill.x}px wider`;
    error(
      "frame-overflow",
      spill.id,
      `The content of "${spill.id}" is ${by} than its frame, so it runs out of the frame over whatever is next to it.`,
      "Make the frame bigger, shorten the text, or unpin the block so the template lays it out.",
    );
  }

  const small = new Map<string, TextSample>();
  const faint = new Map<string, { sample: TextSample; ratio: number }>();
  for (const sample of measure.text) {
    if (sample.fontPx < minFontPx) {
      const worst = small.get(sample.id);
      if (!worst || sample.fontPx < worst.fontPx) small.set(sample.id, sample);
    }
    const ratio = contrastRatio(sample.fg, sample.bg);
    if (ratio < requiredContrast(sample.fontPx, sample.weight)) {
      const worst = faint.get(sample.id);
      if (!worst || ratio < worst.ratio) faint.set(sample.id, { sample, ratio });
    }
  }
  for (const [id, sample] of small) {
    error(
      "text-too-small",
      id,
      `Text in ${id ? `"${id}"` : "the scene"} renders at ${sample.fontPx}px, under the ${minFontPx}px minimum: "${sample.text}".`,
      "The template sets text size from the stage. Use a larger viewport or a roomier template; text size is not set per block.",
    );
  }
  for (const [id, { sample, ratio }] of faint) {
    error(
      "low-contrast",
      id,
      `Text in ${id ? `"${id}"` : "the scene"} has a contrast ratio of ${ratio.toFixed(2)}:1; WCAG AA needs ${requiredContrast(sample.fontPx, sample.weight)}:1: "${sample.text}".`,
      'Colors come from the theme and the deck palette. Try the other theme with deck.set { theme: "ink" } or { theme: "paper" }, or change the palette\'s colors with deck.set { palette: { ... } }.',
    );
  }

  for (const image of measure.images) {
    if (!image.ok) {
      error(
        "image-failed",
        image.id,
        `The image "${image.src}" did not load.`,
        "Check that the file exists in assets/ and is a valid image.",
      );
    }
  }
  return out;
}
