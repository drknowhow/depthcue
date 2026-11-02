/**
 * What the player draws, measured in the page. The PowerPoint export takes its words, marks, links and numbers from the
 * deck, and everything about where and how they sit from here: the box of each block, the size, face, color, line height
 * and alignment the page computed, the panels it draws, and the colors it gives a chart's series. All sizes are CSS
 * pixels on the 1280 by 720 stage, which is the slide: 1280 pixels are 13.333 inches, PowerPoint's 16:9 width.
 */

/** A rectangle on the slide. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Space inside a box that text does not use: padding and borders. */
export interface Edge {
  t: number;
  r: number;
  b: number;
  l: number;
}

/** How a run of text is drawn. */
export interface Ink {
  /** The first family of the computed font stack, which is the face the page loaded for it. */
  family: string;
  px: number;
  weight: number;
  italic: boolean;
  /** `RRGGBB`, with any transparency already laid over the color behind it. */
  color: string;
  align: "left" | "center" | "right" | "justify";
  /** The line height the page uses, and the height of one line at "single" spacing in the same face. */
  lineHeight: number;
  natural: number;
  /** Extra space between letters. */
  spacing: number;
  /** Drawn in capitals by the stylesheet, so the words keep their case in the file. */
  caps: boolean;
}

/** The place of a piece of text: its box as the page lays it out, what the box keeps clear, and how it is drawn. */
export interface TextPlace {
  /** The words the element holds, as the page has them: what the player writes itself, such as "Sources". */
  text: string;
  box: Box;
  inset: Edge;
  ink: Ink;
  /** Where the page balances a heading over several lines: the width of its widest line, so PowerPoint breaks it alike. */
  widest?: number;
}

/** A panel, rule or dot the page draws behind or beside content. */
export interface Shape {
  kind: "shape";
  /** Says what it is, for the file's selection pane. */
  name: string;
  box: Box;
  fill: string | null;
  line: string | null;
  lineWidth: number;
  radius: number;
  ellipse: boolean;
}

/** A picture as the page draws it: inside its frame, scaled to fit without cropping. */
export interface Picture {
  /** The element's box, border included. */
  box: Box;
  /** Where the picture itself is, after the border and the fit. */
  picture: Box;
  natural: { w: number; h: number };
  /** The address the page asked for it by. */
  src: string;
  /** A PNG data URL of the picture, for a kind PowerPoint cannot show (SVG, WebP): drawn by the page at twice its size. */
  png?: string;
}

export interface ColumnPlace {
  w: number;
  align: "left" | "center" | "right";
  padding: Edge;
}

export interface Rule {
  color: string;
  width: number;
}

export type Item =
  | Shape
  | { kind: "eyebrow"; text: TextPlace }
  | { kind: "claim"; text: TextPlace }
  /** `numbered` is false when the page does not number the list, as on a template scene's foot line. */
  | { kind: "sources"; label: TextPlace; list: TextPlace; numbered?: boolean }
  | { kind: "text"; id: string; text: TextPlace; cite?: TextPlace }
  | { kind: "image"; id: string; picture: Picture; caption?: TextPlace; cite?: TextPlace }
  | { kind: "clip"; id: string; video: Picture; poster: boolean; cite?: TextPlace }
  | {
      kind: "table";
      id: string;
      caption?: TextPlace;
      grid: Box;
      columns: ColumnPlace[];
      rows: Array<{ h: number; head: boolean }>;
      head: Ink;
      body: Ink;
      unit: Ink;
      headRule: Rule | null;
      bodyRule: Rule | null;
      cite?: TextPlace;
    }
  | {
      kind: "chart";
      id: string;
      box: Box;
      plot: Box;
      title?: TextPlace;
      legend?: TextPlace;
      /** Series colors for positions 1 to 6, as the page draws them. */
      colors: string[];
      /** The numbers the page marks on its axes, so the native chart spans and steps alike. Empty when none was read. */
      ticks: { y: number[]; x: number[] };
      axis: Ink;
      value: Ink;
      grid: string;
      cite?: TextPlace;
    }
  | {
      kind: "bars";
      id: string;
      box: Box;
      title?: TextPlace;
      color: string;
      label: Ink;
      value: Ink;
      /** The page adds a toolbar to this chart, which has no PowerPoint form. */
      explorer: boolean;
      cite?: TextPlace;
    };

/**
 * The brand's chrome as the page draws it on this scene (`.dc-chrome`): the logo, drawn to a PNG, the footer line and
 * the slide number, and the accent bar. It is not content: the slide master carries it.
 */
export interface ChromeMeasure {
  logo?: {
    box: Box;
    /** The logo drawn at three times its size on the slide, as a PNG data URL. */
    png?: string;
    alt: string;
    /** The plate the page puts behind it on a strong background. */
    plate?: { box: Box; color: string; radius: number };
  };
  footer?: TextPlace;
  number?: TextPlace;
  accent?: { box: Box; color: string };
}

/** Raw measurements of one scene at full reveal. */
export interface SlideMeasure {
  /** The slide, 1280 by 720 unless the caller asked for another stage. */
  slide: { w: number; h: number };
  /** How far the scene's content runs past each edge of the slide, when it does. */
  beyond: { left?: number; top?: number; right: number; bottom: number };
  /** The slide's own background color, and its picture with the scrim laid over it when it has one. */
  ground?: string;
  backdrop?: string;
  chrome?: ChromeMeasure;
  /** What the page draws on a panel that a PowerPoint shape here does not: a gradient, a shadow, a dashed border. */
  lost?: string[];
  /** Blocks the scene holds back at this step. */
  hidden?: string[];
  /** The face the page uses for headings, for text and for data, which is what a viewer needs installed. */
  fonts: { display: string; body: string; mono: string };
  /** The color of each tone, and of a link, as the page draws them. */
  tones: Record<string, string>;
  link: string;
  items: Item[];
}

/**
 * Runs inside the page, so it cannot use anything from this module: every helper lives in its body. Measures the scene
 * at full reveal once fonts and pictures are ready.
 */
export async function measureSlide(): Promise<SlideMeasure> {
  void document.body.offsetWidth;
  await document.fonts.ready;
  // The chrome's logo is waited for too: it is drawn for the slide master, not as a picture on the slide.
  const pictures = [...document.querySelectorAll<HTMLImageElement>(".dc-scene img:not(.dc-ghost img)")];
  await Promise.all(pictures.map((picture) => picture.decode().catch(() => undefined)));
  const posters = [...document.querySelectorAll<HTMLVideoElement>(".dc-scene video:not(.dc-ghost video)")];
  const posterImages = new Map<HTMLVideoElement, HTMLImageElement | null>();
  await Promise.all(
    posters.map(async (video) => {
      if (!video.poster) {
        posterImages.set(video, null);
        return;
      }
      const image = new Image();
      image.src = video.poster;
      await image.decode().catch(() => undefined);
      posterImages.set(video, image.naturalWidth > 0 ? image : null);
    }),
  );
  // The video element takes the poster's shape once its own copy of the poster has loaded.
  await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

  const view = document.querySelector<HTMLElement>(".dc-view");
  const scene = document.querySelector<HTMLElement>(".dc-scene");
  if (!view || !scene) throw new Error("The player did not render a scene.");

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const parse = (value: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const hex = (c: { r: number; g: number; b: number }) =>
    [c.r, c.g, c.b]
      .map((n) =>
        Math.max(0, Math.min(255, Math.round(n)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase();
  const over = (
    top: { r: number; g: number; b: number; a: number },
    under: { r: number; g: number; b: number },
  ) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
  });
  const backdrop = (element: Element) => {
    const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer.a > 0) layers.push(layer);
      if (layer.a === 1) break;
    }
    let result = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i] as (typeof layers)[0], result);
    return result;
  };
  const round = (value: number) => Math.round(value * 100) / 100;
  const px = (value: string) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };

  const visible = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (node.classList.contains("dc-sr-only")) return false;
    }
    return element.getClientRects().length > 0;
  };

  const origin = view.getBoundingClientRect();
  const boxOf = (rect: DOMRect | { left: number; top: number; width: number; height: number }): Box => ({
    x: round(rect.left - origin.left),
    y: round(rect.top - origin.top),
    w: round(rect.width),
    h: round(rect.height),
  });
  const edgeOf = (style: CSSStyleDeclaration): Edge => ({
    t: round(px(style.paddingTop) + px(style.borderTopWidth)),
    r: round(px(style.paddingRight) + px(style.borderRightWidth)),
    b: round(px(style.paddingBottom) + px(style.borderBottomWidth)),
    l: round(px(style.paddingLeft) + px(style.borderLeftWidth)),
  });
  const paddingOf = (style: CSSStyleDeclaration): Edge => ({
    t: round(px(style.paddingTop)),
    r: round(px(style.paddingRight)),
    b: round(px(style.paddingBottom)),
    l: round(px(style.paddingLeft)),
  });

  const naturalCache = new Map<string, number>();
  /** The height of one line at single spacing: a line of the same face with `line-height: normal`. */
  const naturalLine = (style: CSSStyleDeclaration): number => {
    const key = `${style.fontStyle}|${style.fontWeight}|${style.fontSize}|${style.fontFamily}`;
    const known = naturalCache.get(key);
    if (known !== undefined) return known;
    const probe = document.createElement("span");
    probe.textContent = "Hg";
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;line-height:normal;font-family:${style.fontFamily};font-size:${style.fontSize};font-weight:${style.fontWeight};font-style:${style.fontStyle};letter-spacing:normal;text-transform:none`;
    scene.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    naturalCache.set(key, height);
    return height;
  };

  const inkOf = (element: Element): Ink => {
    const style = getComputedStyle(element);
    const size = px(style.fontSize);
    const family = (style.fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
    const natural = naturalLine(style);
    const fg = parse(style.color);
    const color = hex(over(fg, backdrop(element)));
    const align =
      style.textAlign === "center"
        ? "center"
        : style.textAlign === "right" || style.textAlign === "end"
          ? "right"
          : style.textAlign === "justify"
            ? "justify"
            : "left";
    return {
      family,
      px: round(size),
      weight: Number(style.fontWeight) || 400,
      italic: style.fontStyle === "italic" || style.fontStyle.startsWith("oblique"),
      color,
      align,
      lineHeight: style.lineHeight === "normal" ? round(natural) : round(px(style.lineHeight)),
      natural: round(natural),
      spacing: style.letterSpacing === "normal" ? 0 : round(px(style.letterSpacing)),
      caps: style.textTransform === "uppercase",
    };
  };

  /** The widest line of an element's text, when it fills more than one line and the page balances them. */
  const balancedWidth = (element: Element): number | undefined => {
    const style = getComputedStyle(element);
    const balanced =
      (style as CSSStyleDeclaration & { textWrapStyle?: string }).textWrapStyle === "balance" ||
      (style as CSSStyleDeclaration & { textWrap?: string }).textWrap === "balance";
    if (!balanced) return undefined;
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = new Map<number, { left: number; right: number }>();
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      const key = Math.round(rect.top / 4);
      const line = lines.get(key);
      if (line) {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
      } else lines.set(key, { left: rect.left, right: rect.right });
    }
    if (lines.size < 2) return undefined;
    return round(Math.max(...[...lines.values()].map((line) => line.right - line.left)));
  };

  const placeOf = (element: Element, fit = false): TextPlace => {
    const style = getComputedStyle(element);
    const widest = fit ? balancedWidth(element) : undefined;
    return {
      text: (element.textContent ?? "").trim(),
      box: boxOf(element.getBoundingClientRect()),
      inset: edgeOf(style),
      ink: inkOf(element),
      ...(widest === undefined ? {} : { widest }),
    };
  };

  const items: Item[] = [];
  const shape = (
    name: string,
    box: Box,
    fill: string | null,
    line: string | null,
    lineWidth: number,
    radius: number,
    ellipse = false,
  ) => items.push({ kind: "shape", name, box, fill, line, lineWidth, radius, ellipse });

  const lost: string[] = [];
  const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
  /**
   * The panel an element draws for itself: a fill, a border, rounded corners. A border the same all round is the
   * shape's outline; one that differs by side is a thin rectangle per side. What a shape here cannot be (a gradient or
   * a picture behind, a shadow, an outline outside the border, see-through, a dashed, dotted or double border, corners
   * rounded unlike each other) is written down for the report. Nothing when it draws none.
   */
  const panelOf = (name: string, element: Element, rect: DOMRect): boolean => {
    const style = getComputedStyle(element);
    const fill = parse(style.backgroundColor);
    const under = backdrop(element.parentElement ?? element);
    const sides = SIDES.map((side) => {
      const width = px(style[`border${side}Width`]);
      const color = parse(style[`border${side}Color`]);
      const kind = style[`border${side}Style`];
      return {
        side,
        width,
        color,
        kind,
        on: width > 0 && color.a > 0 && kind !== "none" && kind !== "hidden",
      };
    });
    const drawn = sides.filter((side) => side.on);
    const first = drawn[0];
    const even =
      drawn.length === 4 &&
      drawn.every(
        (side) =>
          side.width === first?.width &&
          side.kind === first?.kind &&
          hex(side.color) === hex(first.color) &&
          side.color.a === first.color.a,
      );
    const hasFill = fill.a > 0;
    const image = style.backgroundImage;
    const missing: string[] = [];
    if (image && image !== "none")
      missing.push(image.includes("gradient(") ? "a gradient" : "a background picture");
    if (style.boxShadow && style.boxShadow !== "none") missing.push("a shadow");
    if (style.outlineStyle !== "none" && px(style.outlineWidth) > 0) missing.push("an outline");
    if (Number(style.opacity) < 1) missing.push("see-through (opacity)");
    for (const kind of new Set(drawn.map((side) => side.kind))) {
      if (kind === "dashed" || kind === "dotted" || kind === "double")
        missing.push(`a ${kind} border, drawn solid`);
    }
    const radii = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ];
    if (new Set(radii).size > 1) missing.push("corners rounded unlike each other, drawn alike");
    if (!hasFill && drawn.length === 0 && missing.length === 0) return false;
    if (missing.length > 0) lost.push(`${name}: ${missing.join(", ")}`);
    if (!hasFill && drawn.length === 0) return false;
    if (hasFill || even) {
      shape(
        name,
        boxOf(rect),
        hasFill ? hex(over(fill, under)) : null,
        even && first ? hex(over(first.color, under)) : null,
        even && first ? first.width : 0,
        px(style.borderTopLeftRadius),
      );
    }
    if (!even) {
      const box = boxOf(rect);
      for (const side of drawn) {
        const w = side.width;
        const strip =
          side.side === "Top"
            ? { x: box.x, y: box.y, w: box.w, h: w }
            : side.side === "Bottom"
              ? { x: box.x, y: box.y + box.h - w, w: box.w, h: w }
              : side.side === "Left"
                ? { x: box.x, y: box.y, w, h: box.h }
                : { x: box.x + box.w - w, y: box.y, w, h: box.h };
        shape(`${name} ${side.side.toLowerCase()} edge`, strip, hex(over(side.color, under)), null, 0, 0);
      }
    }
    return true;
  };

  /** The sides of an element that carry a border on their own, such as a quote's bar, as thin filled rectangles. */
  const bordersOf = (name: string, element: Element) => {
    const style = getComputedStyle(element);
    const box = boxOf(element.getBoundingClientRect());
    const sides = [
      ["Top", "borderTopWidth", "borderTopColor", "borderTopStyle"],
      ["Right", "borderRightWidth", "borderRightColor", "borderRightStyle"],
      ["Bottom", "borderBottomWidth", "borderBottomColor", "borderBottomStyle"],
      ["Left", "borderLeftWidth", "borderLeftColor", "borderLeftStyle"],
    ] as const;
    for (const [side, width, color, kind] of sides) {
      const w = px(style[width]);
      const c = parse(style[color]);
      if (w <= 0 || c.a === 0 || style[kind] === "none") continue;
      const fill = hex(over(c, backdrop(element)));
      const strip =
        side === "Top"
          ? { x: box.x, y: box.y, w: box.w, h: w }
          : side === "Bottom"
            ? { x: box.x, y: box.y + box.h - w, w: box.w, h: w }
            : side === "Left"
              ? { x: box.x, y: box.y, w, h: box.h }
              : { x: box.x + box.w - w, y: box.y, w, h: box.h };
      shape(`${name} ${side.toLowerCase()} edge`, strip, fill, null, 0, 0);
    }
  };

  const toneColor = (tone: string): string => {
    const probe = document.createElement("span");
    probe.className = "dc-tone";
    probe.dataset.tone = tone;
    probe.textContent = "x";
    probe.style.cssText = "position:absolute;visibility:hidden";
    scene.append(probe);
    const color = hex(over(parse(getComputedStyle(probe).color), backdrop(probe)));
    probe.remove();
    return color;
  };
  const tones: Record<string, string> = {};
  for (const tone of ["text", "muted", "action", "evidence"]) tones[tone] = toneColor(tone);
  const linkProbe = document.createElement("a");
  linkProbe.className = "dc-link";
  linkProbe.textContent = "x";
  linkProbe.style.cssText = "position:absolute;visibility:hidden";
  scene.append(linkProbe);
  const link = hex(over(parse(getComputedStyle(linkProbe).color), backdrop(linkProbe)));
  linkProbe.remove();

  /** Where a picture lands inside an element that fits it without cropping (object-fit: contain), and what it measured. */
  const pictureOf = (
    element: HTMLImageElement | HTMLVideoElement,
    source: HTMLImageElement | null,
    /** Draw it as a PNG whatever its type: a video's poster is the picture PowerPoint shows until it plays. */
    asPng = false,
  ): Picture => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const border = px(style.borderTopWidth);
    const inner = {
      left: rect.left + border + px(style.paddingLeft),
      top: rect.top + border + px(style.paddingTop),
      width: rect.width - 2 * border - px(style.paddingLeft) - px(style.paddingRight),
      height: rect.height - 2 * border - px(style.paddingTop) - px(style.paddingBottom),
    };
    const natural = { w: source?.naturalWidth ?? 0, h: source?.naturalHeight ?? 0 };
    let drawn = inner;
    if (natural.w > 0 && natural.h > 0) {
      const scale = Math.min(inner.width / natural.w, inner.height / natural.h);
      const width = natural.w * scale;
      const height = natural.h * scale;
      drawn = {
        left: inner.left + (inner.width - width) / 2,
        top: inner.top + (inner.height - height) / 2,
        width,
        height,
      };
    }
    const src = element instanceof HTMLImageElement ? (element.getAttribute("src") ?? "") : element.poster;
    const place: Picture = { box: boxOf(rect), picture: boxOf(drawn), natural, src };
    // PowerPoint shows PNG, JPEG and GIF everywhere. Anything else is drawn here, at twice the size it has on the slide.
    const plain = /\.(png|jpe?g|gif)(\?.*)?$/i.test(src);
    if (source && (asPng || !plain) && natural.w > 0) {
      const scale = 2;
      const width = Math.min(4096, Math.max(1, Math.round(drawn.width * scale)));
      const height = Math.min(4096, Math.max(1, Math.round(drawn.height * scale)));
      const raster = document.createElement("canvas");
      raster.width = width;
      raster.height = height;
      const drawing = raster.getContext("2d") as CanvasRenderingContext2D;
      drawing.drawImage(source, 0, 0, width, height);
      try {
        place.png = raster.toDataURL("image/png");
      } catch {
        // A canvas the picture tainted cannot be read; the export then leaves the picture out and says so.
      }
    }
    return place;
  };

  const citeOf = (block: Element): TextPlace | undefined => {
    const cite = [...block.children].find((child) => child.classList.contains("dc-cite"));
    return cite && visible(cite) ? placeOf(cite) : undefined;
  };
  const withCite = <T extends object>(base: T, block: Element): T & { cite?: TextPlace } => {
    const cite = citeOf(block);
    return cite ? { ...base, cite } : base;
  };

  const colorsOfFigure = (figure: Element): string[] => {
    const out: string[] = [];
    for (let n = 1; n <= 6; n++) {
      const probe = document.createElement("span");
      probe.dataset.s = String(n);
      probe.style.cssText = "position:absolute;visibility:hidden;color:var(--c)";
      figure.append(probe);
      out.push(hex(over(parse(getComputedStyle(probe).color), backdrop(figure))));
      probe.remove();
    }
    return out;
  };

  const blockItem = (block: HTMLElement) => {
    const id = block.dataset.id ?? "";
    // A block a style gives a panel (a fill, a border, an accent edge) draws it behind its content, as a quote draws its bar.
    const styled = block.matches("[data-fill], [data-border], [data-edge]");
    if (styled || block.matches(".dc-quote")) {
      panelOf(styled ? `${id} panel` : "Quote bar", block, block.getBoundingClientRect());
    }
    if (block.matches(".dc-heading, .dc-quote, .dc-caption, .dc-body")) {
      let place = placeOf(block, block.matches(".dc-heading"));
      // The dot on a title slide is drawn by the heading, above its words.
      const dot = getComputedStyle(block, "::before");
      if (dot.content !== "none" && dot.display === "block" && px(dot.width) > 0) {
        const width = px(dot.width);
        const height = px(dot.height);
        const rect = block.getBoundingClientRect();
        const fill = hex(over(parse(dot.backgroundColor), backdrop(block)));
        shape(
          "Title dot",
          boxOf({ left: rect.left, top: rect.top, width, height }),
          fill,
          null,
          0,
          0,
          px(dot.borderTopLeftRadius) >= Math.min(width, height) / 2 || dot.borderTopLeftRadius.includes("%"),
        );
        place = {
          ...place,
          inset: { ...place.inset, t: round(place.inset.t + height + px(dot.marginBottom)) },
        };
      }
      items.push(withCite({ kind: "text", id, text: place }, block));
      return;
    }
    if (block.matches(".dc-clip")) {
      const video = block.querySelector<HTMLVideoElement>("video");
      if (!video || !visible(video)) return;
      const poster = posterImages.get(video) ?? null;
      panelOf("Video frame", video, video.getBoundingClientRect());
      items.push(
        withCite({ kind: "clip", id, video: pictureOf(video, poster, true), poster: poster !== null }, block),
      );
      return;
    }
    if (block.matches(".dc-table-figure")) {
      const table = block.querySelector<HTMLTableElement>("table.dc-table");
      if (!table) return;
      const caption = table.querySelector("caption");
      const rows = [...table.querySelectorAll<HTMLTableRowElement>("tr")];
      const first = rows[0];
      if (!first) return;
      const top = Math.min(...rows.map((row) => row.getBoundingClientRect().top));
      const bottom = Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
      const tableRect = table.getBoundingClientRect();
      const grid = boxOf({ left: tableRect.left, top, width: tableRect.width, height: bottom - top });
      const heads = [...first.children];
      const sample = rows.find((row) => row.parentElement?.tagName === "TBODY") ?? first;
      const columns = heads.map((cell, at): ColumnPlace => {
        const body = sample.children[at] ?? cell;
        const align = inkOf(body).align;
        return {
          w: round(cell.getBoundingClientRect().width),
          align: align === "justify" ? "left" : align,
          padding: paddingOf(getComputedStyle(body)),
        };
      });
      const headCell = table.querySelector("th");
      const bodyCell = table.querySelector("tbody td");
      const unit = table.querySelector(".dc-unit") ?? headCell;
      const ruleOf = (cell: Element | null): Rule | null => {
        if (!cell) return null;
        const style = getComputedStyle(cell);
        const width = px(style.borderBottomWidth);
        const c = parse(style.borderBottomColor);
        if (width <= 0 || c.a === 0 || style.borderBottomStyle === "none") return null;
        return { color: hex(over(c, backdrop(cell))), width };
      };
      const isHead = (row: HTMLTableRowElement) => row.parentElement?.tagName === "THEAD";
      items.push(
        withCite(
          {
            kind: "table",
            id,
            ...(caption ? { caption: placeOf(caption) } : {}),
            grid,
            columns,
            rows: rows.map((row) => ({ h: round(row.getBoundingClientRect().height), head: isHead(row) })),
            head: inkOf(headCell ?? bodyCell ?? table),
            body: inkOf(bodyCell ?? headCell ?? table),
            unit: inkOf(unit ?? table),
            headRule: ruleOf(headCell),
            bodyRule: ruleOf(bodyCell),
          },
          block,
        ),
      );
      return;
    }
    if (block.matches(".dc-plot-figure")) {
      const svg = block.querySelector<SVGSVGElement>("svg.dc-plot");
      if (!svg) return;
      const title = [...block.children].find((child) => child.tagName === "FIGCAPTION");
      const legend = block.querySelector(".dc-legend");
      const svgRect = svg.getBoundingClientRect();
      const viewBox = svg.viewBox.baseVal;
      const scale = Math.min(svgRect.width / viewBox.width, svgRect.height / viewBox.height);
      const plot = boxOf({
        left: svgRect.left,
        top: svgRect.top,
        width: viewBox.width * scale,
        height: viewBox.height * scale,
      });
      const parts = [svgRect, title?.getBoundingClientRect(), legend?.getBoundingClientRect()].filter(
        (rect): rect is DOMRect => rect !== undefined,
      );
      const left = Math.min(...parts.map((rect) => rect.left));
      const topEdge = Math.min(...parts.map((rect) => rect.top));
      const right = Math.max(svgRect.left + viewBox.width * scale, ...parts.map((rect) => rect.right));
      const bottomEdge = Math.max(svgRect.top + viewBox.height * scale, ...parts.map((rect) => rect.bottom));
      const axisText = svg.querySelector("text");
      const valueText = svg.querySelector(".dc-v");
      // The y axis marks its ticks as the right-aligned labels at the left edge, and a scatter's x axis marks its own
      // as the centered labels along the bottom. A label that does not read as a number leaves that axis to PowerPoint.
      const labelNumber = (label: SVGTextElement): number =>
        Number((label.textContent ?? "").replace(/−/g, "-").replace(",", "."));
      const labels = [...svg.querySelectorAll<SVGTextElement>("text:not(.dc-v)")];
      const ends = labels.filter((label) => label.getAttribute("text-anchor") === "end");
      const edge = Math.min(...ends.map((label) => Number(label.getAttribute("x"))));
      const yTicks = ends.filter((label) => Number(label.getAttribute("x")) === edge).map(labelNumber);
      const middles = labels.filter((label) => label.getAttribute("text-anchor") === "middle");
      const floor = Math.max(...middles.map((label) => Number(label.getAttribute("y"))));
      const xTicks =
        block.getAttribute("data-kind") === "scatter"
          ? middles.filter((label) => Number(label.getAttribute("y")) === floor).map(labelNumber)
          : [];
      const whole = (values: number[]) => (values.every((value) => Number.isFinite(value)) ? values : []);
      const gridPath = svg.querySelector(".dc-grid");
      const axis = axisText ? inkOf(axisText) : inkOf(block);
      const gridStroke = gridPath ? parse(getComputedStyle(gridPath).stroke) : parse("#888");
      items.push(
        withCite(
          {
            kind: "chart",
            id,
            box: boxOf({ left, top: topEdge, width: right - left, height: bottomEdge - topEdge }),
            plot,
            ...(title && visible(title) ? { title: placeOf(title) } : {}),
            ...(legend && visible(legend) ? { legend: placeOf(legend.querySelector("li") ?? legend) } : {}),
            colors: colorsOfFigure(block),
            ticks: { y: whole(yTicks), x: whole(xTicks) },
            axis: { ...axis, px: round(12 * scale) },
            value: valueText
              ? { ...inkOf(valueText), px: round(12 * scale) }
              : { ...axis, px: round(12 * scale) },
            grid: hex(over(gridStroke, backdrop(block))),
          },
          block,
        ),
      );
      return;
    }
    if (block.matches(".dc-chart-figure")) {
      const table = block.querySelector<HTMLTableElement>("table.dc-chart");
      if (!table) return;
      const caption = table.querySelector("caption");
      const bar = table.querySelector(".dc-bar");
      const label = table.querySelector("th[scope='row']");
      const value = table.querySelector(".dc-value");
      items.push(
        withCite(
          {
            kind: "bars",
            id,
            box: boxOf(table.getBoundingClientRect()),
            ...(caption ? { title: placeOf(caption) } : {}),
            color: bar
              ? hex(over(parse(getComputedStyle(bar).backgroundColor), backdrop(block)))
              : (tones.evidence ?? "000000"),
            label: inkOf(label ?? table),
            value: inkOf(value ?? table),
            explorer: block.querySelector(".dc-chart-tools") !== null,
          },
          block,
        ),
      );
      return;
    }
    if (block.matches(".dc-figure")) {
      const img = block.querySelector<HTMLImageElement>("img");
      if (!img || !visible(img)) return;
      const caption = block.querySelector("figcaption");
      panelOf("Picture frame", img, img.getBoundingClientRect());
      items.push(
        withCite(
          {
            kind: "image",
            id,
            picture: pictureOf(img, img.naturalWidth > 0 ? img : null),
            ...(caption ? { caption: placeOf(caption) } : {}),
          },
          block,
        ),
      );
    }
  };

  const selector = ".dc-eyebrow, .dc-claim, .dc-evidence-region, .dc-block, .dc-sources";
  for (const element of scene.querySelectorAll<HTMLElement>(selector)) {
    if (!visible(element) || element.closest(".dc-chrome")) continue;
    // A block nested in another block's subtree is part of that block; none is today, and a ghost has no `dc-block`.
    if (element.matches(".dc-eyebrow")) items.push({ kind: "eyebrow", text: placeOf(element) });
    else if (element.matches(".dc-claim")) {
      items.push({ kind: "claim", text: placeOf(element, true) });
    } else if (element.matches(".dc-evidence-region"))
      panelOf("Evidence panel", element, element.getBoundingClientRect());
    else if (element.matches(".dc-sources")) {
      const label = element.querySelector(".dc-label");
      const list = element.querySelector("ol");
      bordersOf("Sources rule", element);
      const item = list?.querySelector("li");
      const numbered = !item || getComputedStyle(item).listStyleType !== "none";
      if (label && list)
        items.push({ kind: "sources", label: placeOf(label), list: placeOf(list), numbered });
    } else blockItem(element);
  }

  // How far the content runs past the slide, which the render check reports as overflow.
  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  const slide = { w: view.clientWidth, h: view.clientHeight };
  for (const element of scene.querySelectorAll<HTMLElement>(
    ".dc-eyebrow, .dc-block, .dc-claim, .dc-sources",
  )) {
    if (!visible(element) || element.closest(".dc-chrome")) continue;
    const rect = boxOf(element.getBoundingClientRect());
    left = Math.max(left, -rect.x);
    top = Math.max(top, -rect.y);
    right = Math.max(right, rect.x + rect.w - slide.w);
    bottom = Math.max(bottom, rect.y + rect.h - slide.h);
  }

  /** A picture drawn into a canvas at `scale` times its box, as a data URL; nothing when the canvas cannot be read. */
  const raster = (
    source: CanvasImageSource,
    box: Box,
    scale: number,
    type = "image/png",
    quality?: number,
  ) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(4096, Math.max(1, Math.round(box.w * scale)));
    canvas.height = Math.min(4096, Math.max(1, Math.round(box.h * scale)));
    (canvas.getContext("2d") as CanvasRenderingContext2D).drawImage(
      source,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    try {
      return canvas.toDataURL(type, quality);
    } catch {
      return undefined;
    }
  };

  // The brand's chrome, which the slide master carries.
  const chromeNode = scene.querySelector<HTMLElement>(":scope > .dc-chrome");
  let chrome: ChromeMeasure | undefined;
  if (chromeNode) {
    chrome = {};
    const logo = chromeNode.querySelector<HTMLImageElement>(".dc-logo");
    if (logo && visible(logo) && logo.naturalWidth > 0) {
      const picture = pictureOf(logo, logo);
      const png = raster(logo, picture.picture, 3);
      const style = getComputedStyle(logo);
      const plateColor = parse(style.backgroundColor);
      const spread = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(style.boxShadow);
      const grow = spread ? px(`${spread[4]}px`) : 0;
      const box = picture.box;
      chrome.logo = {
        box: picture.picture,
        alt: logo.alt,
        ...(png ? { png } : {}),
        ...(plateColor.a > 0
          ? {
              plate: {
                box: {
                  x: round(box.x - grow),
                  y: round(box.y - grow),
                  w: round(box.w + 2 * grow),
                  h: round(box.h + 2 * grow),
                },
                color: hex(over(plateColor, backdrop(scene))),
                radius: round(px(style.borderTopLeftRadius) + grow),
              },
            }
          : {}),
      };
    }
    const footer = chromeNode.querySelector(".dc-footer");
    if (footer && visible(footer)) chrome.footer = placeOf(footer);
    const number = chromeNode.querySelector(".dc-number");
    if (number && visible(number)) chrome.number = placeOf(number);
    const accent = chromeNode.querySelector(".dc-accent");
    if (accent && visible(accent)) {
      chrome.accent = {
        box: boxOf(accent.getBoundingClientRect()),
        color: hex(over(parse(getComputedStyle(accent).backgroundColor), backdrop(scene))),
      };
    }
  }

  // The slide's ground, and its picture under the scrim, composed as the page shows them.
  const ground = hex(backdrop(scene));
  let backdropPicture: string | undefined;
  const behind = scene.querySelector<HTMLElement>(":scope > .dc-backdrop");
  if (behind) {
    const url = /url\("?(.*?)"?\)/.exec(getComputedStyle(behind).backgroundImage)?.[1];
    if (url) {
      const image = new Image();
      image.src = url;
      await image.decode().catch(() => undefined);
      if (image.naturalWidth > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = 1920;
        canvas.height = 1080;
        const drawing = canvas.getContext("2d") as CanvasRenderingContext2D;
        const fit = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const w = image.naturalWidth * fit;
        const h = image.naturalHeight * fit;
        drawing.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        const scrim = getComputedStyle(behind, "::after");
        drawing.globalAlpha = Number(scrim.opacity) || 0;
        drawing.fillStyle = scrim.backgroundColor;
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        try {
          backdropPicture = canvas.toDataURL("image/jpeg", 0.9);
        } catch {
          // A picture from elsewhere taints the canvas; the slide then has its ground color alone, and the report says so.
          lost.push("Background picture: it could not be read, so the slide has its color alone");
        }
      }
    }
  }

  const hidden = [...scene.querySelectorAll<HTMLElement>('[data-gated][data-revealed="false"]')]
    .map((element) => element.dataset.id ?? "")
    .filter((id) => id !== "");

  const sceneStyle = getComputedStyle(scene);
  const family = (name: string) =>
    (sceneStyle.getPropertyValue(name).split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
  return {
    slide,
    beyond: {
      left: round(Math.max(0, left)),
      top: round(Math.max(0, top)),
      right: round(Math.max(0, right)),
      bottom: round(Math.max(0, bottom)),
    },
    ground,
    ...(backdropPicture ? { backdrop: backdropPicture } : {}),
    ...(chrome ? { chrome } : {}),
    lost,
    hidden,
    fonts: {
      display: family("--dc-font-display"),
      body: family("--dc-font-ui"),
      mono: family("--dc-font-mono"),
    },
    tones,
    link,
    items,
  };
}
