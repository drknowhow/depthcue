/**
 * Draws the measured slides into a PowerPoint file. Each scene becomes one slide, with everything on it shown at once.
 * The words, numbers and data come from the deck; where things go and how they look come from the page's measurements
 * (`measure.ts`). What cannot be drawn is written down as it happens and goes into the report.
 */
import { existsSync, readFileSync } from "node:fs";
import path, { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import {
  type Block,
  type Cell,
  type ChartBlock,
  chartFromBarChart,
  type Deck,
  type DeckStyle,
  parseTarget,
  type Scene,
  type TableBlock,
  textFlow,
} from "@depthcue/core";
import PptxGenJS from "pptxgenjs";
import { type ChartPlaces, chartPlaces } from "./chartlayout.ts";
import type {
  Box,
  ColumnPlace,
  Edge,
  Ink,
  Item,
  Picture,
  Rule,
  Shape,
  SlideMeasure,
  TextPlace,
} from "./measure.ts";
import { cannotEmbed, mp4Tracks } from "./media.ts";
import { flowRuns, inch, plainRuns, pt, type Run, type RunContext, textFrame } from "./text.ts";

/** What a viewer needs to see the file as drawn: the families it names, and for what. */
export interface FontUse {
  family: string;
  roles: string[];
}

/** What one slide could not carry over, in plain words. */
export interface SlideReport {
  scene: string;
  title: string;
  /** The step the slide shows, when each step is a slide of its own (`--steps`). */
  step?: number;
  left: string[];
}

/** The name of the text box a picture slide carries its title in, which the package step makes a hidden title. */
export const PICTURE_TITLE = "Depthcue scene title";

export interface BuildInput {
  deck: Deck;
  /** The deck's resolved colors, whose `bg` is the slide's background. */
  style: DeckStyle;
  scenes: readonly Scene[];
  measures: readonly SlideMeasure[];
  /** The deck folder, which the pictures are read from and the links to files point into. */
  folder: string;
  /** The file the presentation will be written to: a link to a file in the deck is written relative to its folder. */
  out: string;
  notes: boolean;
  /** How the player writes a number in the deck's language, so a table and a chart's labels read alike. */
  numberText: (value: number, language?: string) => string;
  /** For each slide, the page as one picture (PNG), which is then all the slide shows (`--pictures`). */
  pictures?: readonly (Uint8Array | undefined)[];
  /** For each slide, the step it shows and how many the scene has, when each step is a slide of its own (`--steps`). */
  steps?: readonly ({ at: number; of: number } | undefined)[];
  /** Every clip as its poster and a link, never embedded (`--posters`). */
  posters?: boolean;
  /** The slide master and layouts draw the background, so the slides leave it out. */
  master?: boolean;
}

export interface Built {
  /** The file as the writer made it, before it is tidied and marked. */
  raw: Uint8Array;
  slides: SlideReport[];
  /** For each slide, the ids of its tables that have a header row. */
  headers: string[][];
  /** For each slide, the description of each embedded video by its name, which the writer has no option for. */
  alts: Array<Record<string, string>>;
  /** Where each chart puts its title, legend and plot, in the order the charts are made, which is how they are numbered. */
  charts: ChartPlaces[];
  fonts: FontUse[];
}

type TableCell = PptxGenJS.TableCell;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/** Everything one slide's drawing needs to know. */
interface Page {
  pptx: PptxGenJS;
  slide: PptxGenJS.Slide;
  scene: Scene;
  measure: SlideMeasure;
  input: BuildInput;
  context: RunContext;
  left: string[];
  fonts: Map<string, Set<string>>;
  blocks: Map<string, Block>;
  placed: Set<string>;
  /** The tables on this slide whose first row is a header, which the package step marks so PowerPoint knows. */
  headers: string[];
  alts: Record<string, string>;
  /** Where each chart of the file puts its parts, in the order the charts are made: the deck's, not the slide's. */
  charts: ChartPlaces[];
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** How much of a box stays on the slide when the page drew it past an edge, in pixels, so it never vanishes. */
const SLIVER = 12;

/**
 * A box on the slide in inches, held inside the slide when the page drew it past an edge: cut at the edge, as it is in
 * the player. Past the left or top edge the part that hangs over is dropped and the rest stays where the page put it;
 * past the right or bottom edge the box is cut by the slide itself, with a sliver kept so it never vanishes. A video
 * keeps its proportions instead, because cutting its box would stretch it: it is made to fit, whole. (A picture is
 * cropped at the edge instead, in `addPicture`.) The report says, per slide, how far the content runs past each edge.
 */
function frameOf(page: Page, box: Box, keepShape = false): { x: number; y: number; w: number; h: number } {
  const { w: width, h: height } = page.measure.slide;
  let { x, y, w, h } = box;
  if (!keepShape) {
    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    w = Math.max(0, w);
    h = Math.max(0, h);
  }
  if (keepShape && w > 0 && h > 0) {
    const scale = Math.min(
      1,
      width / w,
      height / h,
      (width - clamp(x, 0, width)) / w,
      (height - clamp(y, 0, height)) / h,
    );
    if (scale > 0 && scale < 1) {
      w *= scale;
      h *= scale;
    }
  }
  w = Math.min(w, width);
  h = Math.min(h, height);
  x = clamp(x, 0, width - Math.min(w, SLIVER));
  y = clamp(y, 0, height - Math.min(h, SLIVER));
  return {
    x: inch(x),
    y: inch(y),
    w: inch(Math.max(0, Math.min(w, width - x))),
    h: inch(Math.max(0, Math.min(h, height - y))),
  };
}

/** What each face is used for, in the words the report gives a viewer who must install it. */
const ROLE_NAMES = { headings: "headings", text: "text", data: "data and labels" } as const;
type FontRole = keyof typeof ROLE_NAMES;

/** The role a face plays, by comparing it with the page's headings, text and data faces. */
function roleOf(page: Page, family: string, heading: boolean): FontRole {
  const { fonts } = page.measure;
  if (family === fonts.mono) return "data";
  if (family === fonts.display && (family !== fonts.body || heading)) return "headings";
  return "text";
}

function note(page: Page, family: string, role: FontRole) {
  const roles = page.fonts.get(family) ?? new Set<string>();
  roles.add(ROLE_NAMES[role]);
  page.fonts.set(family, roles);
}

function useInk(page: Page, ink: Ink, heading = false) {
  note(page, ink.family, roleOf(page, ink.family, heading));
}

function addShape(page: Page, shape: Shape) {
  const { x, y, w, h } = frameOf(page, shape.box);
  if (w <= 0 || h <= 0) return;
  const radius = Math.min(shape.radius, shape.box.w / 2, shape.box.h / 2);
  const kind = shape.ellipse
    ? page.pptx.ShapeType.ellipse
    : radius > 0
      ? page.pptx.ShapeType.roundRect
      : page.pptx.ShapeType.rect;
  page.slide.addShape(kind, {
    x,
    y,
    w,
    h,
    objectName: shape.name,
    ...(shape.fill ? { fill: { color: shape.fill } } : { fill: { type: "none" as const } }),
    ...(shape.line ? { line: { color: shape.line, width: pt(shape.lineWidth) } } : {}),
    ...(radius > 0 && !shape.ellipse ? { rectRadius: inch(radius) } : {}),
  });
}

function addText(page: Page, name: string, place: TextPlace, runs: Run[], heading = false, wrap = true) {
  const frame = textFrame(place);
  const { x, y, w, h } = frameOf(page, frame);
  if (w <= 0 || h <= 0 || runs.length === 0) return;
  useInk(page, place.ink, heading);
  page.slide.addText(runs, {
    x,
    y,
    w,
    h,
    margin: 0,
    valign: "top",
    fit: "none",
    wrap,
    objectName: name,
  });
}

/** The line under a block that names its sources, in the words the page wrote it. */
function addCite(page: Page, block: Block, cite: TextPlace | undefined) {
  if (cite?.text) addText(page, `${block.id} source`, cite, plainRuns(cite.text, cite.ink, page.context));
}

/**
 * Where a link to a file goes, written the way the file is found from the folder the PowerPoint file sits in: a
 * relative address, each part percent-encoded, so an `&` in a folder's name is `%26` and no character in it can end the
 * attribute it is written in. It names no user and no drive, so the same deck gives the same bytes wherever it lies, and
 * the deck folder and the PowerPoint file keep working when they are moved together. Only a file on another drive has
 * no relative address, and gets a file address with the same encoding.
 */
export function linkTo(from: string, target: string, flavor: typeof path = path): string {
  const way = flavor.relative(from, target);
  if (flavor.isAbsolute(way)) {
    return pathToFileURL(target, { windows: flavor.sep === "\\" })
      .href.replaceAll("&", "%26")
      .replaceAll("<", "%3C")
      .replaceAll(">", "%3E")
      .replaceAll('"', "%22");
  }
  return way
    .split(flavor.sep)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** A file in the deck, as a link that works from where the PowerPoint file is written. */
const fileLink = (page: Page, asset: string) =>
  linkTo(dirname(page.input.out), resolve(page.input.folder, asset));

/** Where a hyperlink goes: an address, or a slide of this presentation. */
type Hyper = { url?: string; slide?: number; tooltip?: string };

/**
 * A library link as a hyperlink: an address as it is, a deck file as `fileLink` writes it, a place on a disk the same
 * way (relative to the deck folder when it is not absolute), and a scene as the first slide of that scene.
 */
function linkFor(page: Page, id: string): Hyper | undefined {
  const entry = page.input.deck.links?.find((candidate) => candidate.id === id);
  const target = entry && parseTarget(entry.target);
  if (!entry || !target) return undefined;
  const tooltip = entry.title;
  switch (target.kind) {
    case "address":
      return { url: target.href, tooltip };
    case "asset":
      return { url: fileLink(page, target.asset), tooltip };
    case "path":
      return { url: linkTo(dirname(page.input.out), resolve(page.input.folder, target.path)), tooltip };
    case "scene": {
      const slide = page.input.scenes.findIndex((scene) => scene.id === target.scene) + 1;
      return slide > 0 ? { slide, tooltip } : undefined;
    }
  }
}

/** A source's hyperlink: its library link when it has one that works, else its address or its file. */
function sourceHyperlink(page: Page, source: NonNullable<Scene["sources"]>[number]): Hyper | undefined {
  const linked = source.link === undefined ? undefined : linkFor(page, source.link);
  if (linked) return linked;
  const url = source.url ?? (source.asset ? fileLink(page, source.asset) : undefined);
  return url === undefined ? undefined : { url };
}

/** A picture's bytes as the writer takes them: the file when PowerPoint can show it, else what the page drew. */
function pictureData(page: Page, asset: string, picture: Picture): string | undefined {
  const mime = MIME[extname(asset).toLowerCase()];
  const file = join(page.input.folder, asset);
  if (mime && existsSync(file)) return `${mime};base64,${readFileSync(file).toString("base64")}`;
  if (picture.png) return `image/png;base64,${picture.png.slice(picture.png.indexOf(",") + 1)}`;
  return undefined;
}

function addPicture(
  page: Page,
  block: Block,
  asset: string,
  picture: Picture,
  alt: string,
  link?: Hyper,
): boolean {
  const data = pictureData(page, asset, picture);
  const { w: width, h: height } = page.measure.slide;
  const whole = picture.picture;
  // What the page shows of it: all of it, or the frame it fills and is cut to.
  const shown = picture.clip ?? whole;
  // The part of the picture that is on the slide; the rest is cropped away with the picture's source rectangle, so the
  // slide shows what the player shows and the picture keeps its proportions.
  const seen = {
    x: clamp(Math.max(whole.x, shown.x), 0, width),
    y: clamp(Math.max(whole.y, shown.y), 0, height),
    r: clamp(Math.min(whole.x + whole.w, shown.x + shown.w), 0, width),
    b: clamp(Math.min(whole.y + whole.h, shown.y + shown.h), 0, height),
  };
  if (!data || whole.w <= 0 || whole.h <= 0) {
    page.left.push(`"${block.id}": the picture ${asset} could not be read, so it is not on the slide.`);
    return false;
  }
  if (seen.r - seen.x < 1 || seen.b - seen.y < 1) {
    page.left.push(`"${block.id}": the picture is drawn wholly off the slide, so it is not on it.`);
    return false;
  }
  if (!MIME[extname(asset).toLowerCase()]) {
    page.left.push(
      `"${block.id}": ${asset} is drawn as a PNG, because PowerPoint does not show every picture type.`,
    );
  }
  const cut =
    seen.x > whole.x || seen.y > whole.y || seen.r < whole.x + whole.w || seen.b < whole.y + whole.h;
  // Cut by the slide's edge, not only by its own frame, which the page cuts it to as well.
  const past =
    seen.x > Math.max(whole.x, shown.x) ||
    seen.y > Math.max(whole.y, shown.y) ||
    seen.r < Math.min(whole.x + whole.w, shown.x + shown.w) ||
    seen.b < Math.min(whole.y + whole.h, shown.y + shown.h);
  if (past) {
    page.left.push(
      `"${block.id}": the picture runs past the slide's edge; it is cropped there, as the slide shows it, and PowerPoint's Crop gives the rest back.`,
    );
  }
  page.slide.addImage({
    data,
    x: inch(seen.x),
    y: inch(seen.y),
    w: inch(whole.w),
    h: inch(whole.h),
    ...(cut
      ? {
          sizing: {
            type: "crop" as const,
            x: inch(seen.x - whole.x),
            y: inch(seen.y - whole.y),
            w: inch(seen.r - seen.x),
            h: inch(seen.b - seen.y),
          },
        }
      : {}),
    altText: alt,
    objectName: block.id,
    ...(link ? { hyperlink: { tooltip: asset, ...link } } : {}),
  });
  return true;
}

function textBlock(page: Page, block: Extract<Block, { type: "text" }>, place: TextPlace) {
  addText(
    page,
    block.id,
    place,
    flowRuns(textFlow(page.scene, block), place.ink, page.context),
    block.role === "heading",
  );
}

/** The cell's words, as the player writes them. */
function cellText(page: Page, cell: Cell | undefined): string {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "number" ? page.input.numberText(cell, page.input.deck.language) : cell;
}

function ruleBorder(rule: Rule | null): PptxGenJS.BorderProps {
  return rule ? { type: "solid", pt: pt(rule.width), color: rule.color } : { type: "none" };
}

/**
 * A cell's margins as the writer reads them. It reads all four as points when the top one is at least 1, and all four as
 * inches when it is less, so a cell with no top padding would have every margin read as a fraction of what it is. Below
 * a point at the top, all four are given in inches.
 */
export function cellMargin(padding: Edge): [number, number, number, number] {
  const { t, r, b, l } = padding;
  return pt(t) >= 1 ? [pt(t), pt(r), pt(b), pt(l)] : [inch(t), inch(r), inch(b), inch(l)];
}

function tableBlock(page: Page, block: TableBlock, item: Extract<Item, { kind: "table" }>) {
  const none: PptxGenJS.BorderProps = { type: "none" };
  const cellOptions = (column: ColumnPlace, ink: Ink, rule: Rule | null) => ({
    align: column.align,
    valign: "top" as const,
    fontFace: ink.family,
    fontSize: pt(ink.px),
    color: ink.color,
    lang: page.context.language,
    margin: cellMargin(column.padding),
    border: [none, none, ruleBorder(rule), none] as [
      PptxGenJS.BorderProps,
      PptxGenJS.BorderProps,
      PptxGenJS.BorderProps,
      PptxGenJS.BorderProps,
    ],
  });
  const rows: TableCell[][] = [];
  if (block.header !== false) {
    rows.push(
      block.columns.map((column, at): TableCell => {
        const place = item.columns[at] as ColumnPlace;
        const options = cellOptions(place, item.head, item.headRule);
        // Weight is set on the runs: a cell's own bold would hold for the unit beside the label as well.
        const label: Run = { text: column.label, options: item.head.weight >= 600 ? { bold: true } : {} };
        const unit: Run[] = column.unit
          ? [
              {
                text: ` (${column.unit})`,
                options: {
                  color: item.unit.color,
                  fontFace: item.unit.family,
                  fontSize: pt(item.unit.px),
                  ...(item.unit.weight >= 600 ? { bold: true } : {}),
                },
              },
            ]
          : [];
        return { text: [label, ...unit], options };
      }),
    );
  }
  for (const row of block.rows) {
    rows.push(
      row.map((cell, at): TableCell => {
        const place = item.columns[at] as ColumnPlace;
        const options = cellOptions(place, item.body, item.bodyRule);
        return {
          text: cellText(page, cell),
          options: item.body.weight >= 600 ? { ...options, bold: true } : options,
        };
      }),
    );
  }
  useInk(page, item.head);
  useInk(page, item.body);
  useInk(page, item.unit);
  const { x, y } = frameOf(page, item.grid);
  const widths = item.columns.map((column) => inch(column.w));
  page.slide.addTable(rows, {
    x,
    y,
    w: widths.reduce((sum, width) => sum + width, 0),
    colW: widths,
    rowH: item.rows.map((row) => inch(row.h)),
    autoPage: false,
    objectName: block.id,
  });
  if (block.header !== false) page.headers.push(block.id);
  if (item.caption && block.title)
    addText(page, `${block.id} title`, item.caption, plainRuns(block.title, item.caption.ink, page.context));
}

/** Excel's number format for a value with a unit after it: the value as it is, then the unit in quotes. */
function formatCode(unit: string | undefined): string {
  if (!unit) return "General";
  const text = unit === "%" ? "%" : ` ${unit}`;
  return `General"${text.replaceAll('"', "")}"`;
}

/**
 * A series' numbers for the writer, which types them as numbers. A cell the deck leaves empty goes through as null: the
 * writer gives it a point with no value, and the package step drops the point and empties the workbook's cell, so the
 * chart leaves a gap there as the player does, and not a zero.
 */
const withGaps = (values: readonly (number | null)[]): number[] => values as unknown as number[];

const CHART_KIND = {
  bar: { type: "bar", grouping: "clustered" },
  "stacked-bar": { type: "bar", grouping: "stacked" },
  line: { type: "line" },
  area: { type: "area" },
  scatter: { type: "scatter" },
  donut: { type: "doughnut" },
} as const;

function chartBlock(
  page: Page,
  block: ChartBlock,
  item: Extract<Item, { kind: "chart" }>,
  horizontal = false,
) {
  const { pptx } = page;
  const kind = block.kind;
  const numeric = (cell: Cell | undefined) =>
    typeof cell === "number" && Number.isFinite(cell) ? cell : null;
  const scatter = kind === "scatter";
  const rows = block.rows.filter((row) => !scatter || numeric(row[0]) !== null);
  const names = rows.map((row) => String(row[0] ?? ""));
  const series = block.columns.slice(1).map((column, at) => ({
    name: column.label,
    unit: column.unit ?? block.unit,
    values: rows.map((row) => numeric(row[at + 1])),
  }));
  const colors = item.colors;
  let data: PptxGenJS.OptsChartData[];
  let seriesColors: string[];
  if (kind === "donut") {
    const parts = names
      .map((name, at) => ({ name, at, value: series[0]?.values[at] ?? 0 }))
      .filter((part) => (part.value ?? 0) > 0);
    data = [
      {
        name: series[0]?.name ?? "",
        labels: parts.map((part) => part.name),
        values: parts.map((part) => part.value ?? 0),
      },
    ];
    seriesColors = parts.map((part) => colors[part.at % 6] as string);
  } else if (scatter) {
    data = [
      { name: block.columns[0]?.label ?? "x", values: rows.map((row) => numeric(row[0]) ?? 0) },
      ...series.map((entry) => ({ name: entry.name, values: withGaps(entry.values) })),
    ];
    seriesColors = series.map((_, at) => colors[at % 6] as string);
  } else {
    data = series.map((entry) => ({
      name: entry.name,
      labels: names,
      values: withGaps(entry.values),
    }));
    seriesColors = series.map((_, at) => colors[at % 6] as string);
  }
  const unit = series.every((entry) => entry.unit === series[0]?.unit) ? series[0]?.unit : undefined;
  // The page names the unit once, in a title above the axis, and writes plain numbers; the bars of the old bar chart
  // have no axis, so their values carry the unit as the page's do.
  const valueCode = horizontal ? formatCode(unit) : "General";
  const first = series[0];
  const axisTitle = unit
    ? series.length === 1
      ? `${first?.name} (${unit})`
      : unit
    : series.length === 1
      ? (first?.name ?? "")
      : "";
  const { x, y, w, h } = frameOf(page, item.box);
  if (w <= 0 || h <= 0) return;
  const axisSize = pt(item.axis.px);
  const mono = item.axis.family;
  useInk(page, item.axis);
  if (item.title) useInk(page, item.title.ink);
  if (item.legend) useInk(page, item.legend.ink);
  const labels = series.length === 1 && names.length <= 8 && kind !== "donut" && !scatter;
  const legend = kind === "donut" || series.length > 1;
  const valueTitle = kind !== "donut" && axisTitle !== "" && !horizontal;
  // The title, legend and plot go where the page draws them, each in its own room (`layChart` in the package step).
  // PowerPoint sets an axis title beside the plot, where the page writes it above, so the plot leaves it that room.
  const room = item.axis.px * 1.8;
  page.charts.push(
    chartPlaces({
      frame: { x: x * 96, y: y * 96, w: w * 96, h: h * 96 },
      ...(block.title && item.title ? { title: item.title.box } : {}),
      ...(legend && item.legendBox ? { legend: item.legendBox } : {}),
      plot: item.plot,
      axisRoom: { left: valueTitle ? room : 0, bottom: scatter ? room : 0 },
    }),
  );
  const options: PptxGenJS.IChartOpts = {
    x,
    y,
    w,
    h,
    objectName: block.id,
    altText: block.title ?? `${kind} chart`,
    chartColors: seriesColors,
    // An empty cell is a gap, as the player leaves it: a line breaks there, and the writer's own default joins across.
    displayBlanksAs: "gap",
    ...(block.title
      ? {
          showTitle: true,
          title: block.title,
          titleFontFace: item.title?.ink.family ?? mono,
          titleFontSize: pt(item.title?.ink.px ?? item.axis.px),
          titleColor: item.title?.ink.color ?? item.axis.color,
          titleBold: false,
        }
      : { showTitle: false }),
    showLegend: legend,
    legendPos: kind === "donut" ? "r" : "t",
    legendFontFace: item.legend?.ink.family ?? mono,
    legendFontSize: pt(item.legend?.ink.px ?? item.axis.px),
    legendColor: item.legend?.ink.color ?? item.axis.color,
    catAxisLabelFontFace: mono,
    catAxisLabelFontSize: axisSize,
    catAxisLabelColor: item.axis.color,
    valAxisLabelFontFace: mono,
    valAxisLabelFontSize: axisSize,
    valAxisLabelColor: item.axis.color,
    valAxisLabelFormatCode: "General",
    valGridLine: { color: item.grid, size: 0.75 },
    catGridLine: { style: "none" },
    dataLabelFontFace: mono,
    dataLabelFontSize: axisSize,
    dataLabelColor: item.value.color,
    dataLabelFormatCode: valueCode,
    ...(valueTitle
      ? {
          showValAxisTitle: true,
          valAxisTitle: axisTitle,
          valAxisTitleFontFace: mono,
          valAxisTitleFontSize: axisSize,
          valAxisTitleColor: item.axis.color,
        }
      : {}),
  };
  // The axes span and step as the page's do, so PowerPoint does not pick another scale for the same numbers.
  const span = (ticks: number[]) =>
    ticks.length >= 2
      ? {
          min: ticks[0] as number,
          max: ticks[ticks.length - 1] as number,
          step: (ticks[1] as number) - (ticks[0] as number),
        }
      : undefined;
  const yScale = kind === "donut" ? undefined : span(item.ticks.y);
  if (yScale && yScale.step > 0) {
    Object.assign(options, {
      valAxisMinVal: yScale.min,
      valAxisMaxVal: yScale.max,
      valAxisMajorUnit: yScale.step,
    });
  }
  const xScale = scatter ? span(item.ticks.x) : undefined;
  if (xScale && xScale.step > 0) {
    Object.assign(options, {
      catAxisMinVal: xScale.min,
      catAxisMaxVal: xScale.max,
      catAxisMajorUnit: xScale.step,
    });
  }
  switch (kind) {
    case "bar":
    case "stacked-bar":
      Object.assign(options, {
        barDir: horizontal ? "bar" : "col",
        barGrouping: kind === "stacked-bar" ? "stacked" : "clustered",
        barGapWidthPct: horizontal ? 60 : 100,
        showValue: labels,
        // PowerPoint refuses to open a file whose stacked bars put labels outside the bar end.
        dataLabelPosition: kind === "stacked-bar" ? "inEnd" : "outEnd",
        // The page lists the bars of a horizontal chart from the top; PowerPoint lists them from the bottom, and the
        // values sit at the bar ends, so that axis has nothing more to say.
        ...(horizontal
          ? {
              catAxisOrientation: "maxMin",
              valAxisHidden: true,
              valGridLine: { style: "none" },
              valAxisLineShow: false,
            }
          : {}),
      });
      break;
    case "line":
      Object.assign(options, {
        lineSize: 1.5,
        lineDataSymbol: "circle",
        lineDataSymbolSize: 6,
        showValue: false,
      });
      break;
    case "area":
      Object.assign(options, { chartColorsOpacity: 30 });
      break;
    case "scatter":
      Object.assign(options, {
        lineSize: 0,
        lineDataSymbol: "circle",
        lineDataSymbolSize: 8,
        showCatAxisTitle: true,
        catAxisTitle: `${block.columns[0]?.label ?? ""}${block.columns[0]?.unit ? ` (${block.columns[0].unit})` : ""}`,
        catAxisTitleFontFace: mono,
        catAxisTitleFontSize: axisSize,
        catAxisTitleColor: item.axis.color,
      });
      break;
    case "donut":
      // The page writes each part's share on the ring and its value in the legend; the ring carries the share.
      Object.assign(options, {
        holeSize: 58,
        showPercent: true,
        showValue: false,
        dataLabelFormatCode: "0%",
        dataLabelColor: "FFFFFF",
        dataLabelFontBold: true,
        dataBorder: { pt: 2, color: bare(page.input.style.colors.bg) },
      });
      break;
  }
  page.slide.addChart(pptx.ChartType[CHART_KIND[kind].type], data, options);
  if (series.length > 1) {
    page.left.push(
      `"${block.id}": the series are told apart by color only; the player's marker shapes are not carried.`,
    );
  }
}

/** The old bar chart as the native chart that shows the same bars. */
function barsBlock(
  page: Page,
  block: Extract<Block, { type: "bar-chart" }>,
  item: Extract<Item, { kind: "bars" }>,
) {
  const chart = chartFromBarChart(block);
  const synthetic: Extract<Item, { kind: "chart" }> = {
    kind: "chart",
    id: block.id,
    box: item.box,
    plot: item.box,
    ...(item.title ? { title: item.title } : {}),
    colors: Array.from({ length: 6 }, () => item.color),
    ticks: { y: [], x: [] },
    axis: item.label,
    value: item.value,
    grid: item.value.color,
  };
  chartBlock(page, chart, synthetic, true);
  if (item.explorer)
    page.left.push(`"${block.id}": the chart explorer (sort and read-out buttons) has no PowerPoint form.`);
}

function clipBlock(
  page: Page,
  block: Extract<Block, { type: "clip" }>,
  item: Extract<Item, { kind: "clip" }>,
) {
  const remote = /^[a-z][a-z0-9+.-]*:/i.test(block.source);
  const link = remote ? block.source : fileLink(page, block.source);
  const poster = item.poster && block.poster ? block.poster : undefined;
  const drawn = poster !== undefined;
  const why = page.input.posters
    ? "--posters asks for posters and links"
    : cannotEmbed(page.input.folder, block.source);
  if (why === undefined && embedClip(page, block, item, poster)) return;
  const because = why === undefined ? "" : `, because ${why}`;
  if (poster !== undefined && addPicture(page, block, poster, item.video, block.alt, { url: link })) {
    page.left.push(
      `"${block.id}": the video is shown as its poster and linked to ${block.source}; it is not embedded${because}.`,
    );
    return;
  }
  const { x, y, w, h } = frameOf(page, item.video.box);
  const body = page.measure.fonts.body;
  note(page, body, "text");
  page.slide.addText(
    [{ text: `Video: ${block.alt}`, options: { hyperlink: { url: link, tooltip: block.source } } }],
    {
      x,
      y,
      w,
      h,
      align: "center",
      valign: "middle",
      fontFace: body,
      fontSize: 14,
      color: page.measure.link,
      lang: page.context.language,
      objectName: block.id,
    },
  );
  // The picture's own line has said it could not be read; this one says what stands in for it.
  page.left.push(
    drawn
      ? `"${block.id}": a labeled box links to ${block.source} in its place; the video is not embedded${because}.`
      : `"${block.id}": the video has no poster, so a labeled box links to ${block.source}; it is not embedded${because}.`,
  );
}

/**
 * A clip PowerPoint can play, embedded: the file itself, in the box the page draws the video in, with its poster (as
 * the page drew it) as the picture shown until it plays. False when the file cannot be read after all.
 */
function embedClip(
  page: Page,
  block: Extract<Block, { type: "clip" }>,
  item: Extract<Item, { kind: "clip" }>,
  poster: string | undefined,
): boolean {
  let video: Buffer;
  try {
    video = readFileSync(join(page.input.folder, block.source));
  } catch {
    return false;
  }
  // The page fits a poster or first frame in the box; with neither it draws an empty box, and the video, in its own
  // shape (the MP4's track header), is fitted in that box as the player fits it when it plays. A video the page cuts
  // to fill its frame is fitted inside the frame instead: a video on a slide cannot be cropped here.
  const shape = mp4Tracks(new Uint8Array(video))?.size;
  const clip = item.video.clip;
  const drawn = clip
    ? fitted(clip, item.video.natural.w > 0 ? item.video.natural : shape)
    : item.video.natural.w > 0
      ? item.video.picture
      : fitted(item.video.picture, shape);
  const { x, y, w, h } = frameOf(page, drawn, true);
  if (w <= 0 || h <= 0) return false;
  const posterFile = poster === undefined ? undefined : join(page.input.folder, poster);
  const plain =
    !item.video.png &&
    !(posterFile && extname(posterFile).toLowerCase() === ".png" && existsSync(posterFile));
  const cover = item.video.png
    ? `image/png;base64,${item.video.png.slice(item.video.png.indexOf(",") + 1)}`
    : !plain && posterFile
      ? `image/png;base64,${readFileSync(posterFile).toString("base64")}`
      : `image/png;base64,${plainCover(drawn.w, drawn.h).toString("base64")}`;
  page.slide.addMedia({
    type: "video",
    data: `video/mp4;base64,${video.toString("base64")}`,
    extn: "mp4",
    cover,
    x,
    y,
    w,
    h,
    objectName: block.id,
  } as PptxGenJS.MediaProps);
  page.alts[block.id] = block.alt;
  if (clip) {
    page.left.push(
      `"${block.id}": the page crops the video to fill its frame; the slide shows all of it, fitted inside the frame.`,
    );
  }
  if (item.firstFrame) {
    page.left.push(`"${block.id}": the video has no poster, so its first frame shows until it plays.`);
  } else if (plain) {
    page.left.push(
      `"${block.id}": the video has no poster, so a plain picture in its shape shows until it plays.`,
    );
  }
  return true;
}

/** A box of the given shape, as large as fits in `box` and centred in it; the box itself when the shape is unknown. */
function fitted(box: Box, shape: { w: number; h: number } | undefined): Box {
  if (!shape || !(shape.w > 0 && shape.h > 0) || !(box.w > 0 && box.h > 0)) return box;
  const scale = Math.min(box.w / shape.w, box.h / shape.h);
  const w = shape.w * scale;
  const h = shape.h * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** A plain dark picture in a video's shape, the picture PowerPoint shows until a clip with no poster plays. */
function plainCover(width: number, height: number): Buffer {
  const scale = 160 / Math.max(width, height, 1);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let row = 0; row < h; row++) raw.fill(0x2b, row * stride + 1, (row + 1) * stride);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The page set the text on one line, so the slide keeps it on one: a face a hair wider must not break it. */
const oneLine = (place: TextPlace) =>
  place.box.h - place.inset.t - place.inset.b <= place.ink.lineHeight * 1.5;

/**
 * The sources: the label, then the list as one paragraph. The list is numbered as the page numbers it; a template
 * scene's foot line is not, and its label and list each stay on the one line the page drew.
 */
function sourcesText(page: Page, label: TextPlace, list: TextPlace, numbered: boolean) {
  const sources = page.scene.sources ?? [];
  const labelRuns = plainRuns(label.text, label.ink, page.context);
  addText(page, "Sources label", label, labelRuns, false, numbered || !oneLine(label));
  const runs: Run[] = [];
  const base = plainRuns("x", list.ink, page.context)[0] as Run;
  sources.forEach((source, at) => {
    const target = sourceHyperlink(page, source);
    const options = { ...(base.options ?? {}) };
    delete options.lineSpacing;
    if (numbered) runs.push({ text: `${at + 1}. `, options: { ...options, align: list.ink.align } });
    runs.push({
      text: source.title,
      options: {
        ...options,
        align: list.ink.align,
        ...(target ? { hyperlink: target, color: page.measure.link } : {}),
      },
    });
    if (at < sources.length - 1) runs.push({ text: "   ", options: { ...options, align: list.ink.align } });
  });
  if (runs.length === 0) return;
  const first = runs[0]?.options as NonNullable<Run["options"]>;
  first.lineSpacing = pt(list.ink.lineHeight);
  // The list's numbers hang in its left padding, so the text starts at the box and carries its own numbers.
  const { x, y, w, h } = frameOf(page, textFrame({ ...list, inset: { ...list.inset, l: 0 } }));
  useInk(page, list.ink);
  page.slide.addText(runs, {
    x,
    y,
    w,
    h,
    margin: 0,
    valign: "top",
    fit: "none",
    wrap: numbered || !oneLine(list),
    objectName: "Sources",
  });
}

/**
 * A template scene's foot line, as the page sets it: the label, then each source after a middle dot, as one paragraph
 * in the box the line takes. It wraps where its width ends and is anchored at its foot, so a line PowerPoint adds in a
 * slightly wider face grows upward, as the page's does, and not into the footer.
 */
function footText(page: Page, label: TextPlace, list: TextPlace, flow: TextPlace) {
  const sources = page.scene.sources ?? [];
  if (sources.length === 0) return;
  const optionsOf = (ink: Ink) => {
    const options = {
      ...((plainRuns("x", ink, page.context)[0] as Run).options ?? {}),
      align: flow.ink.align,
    };
    delete options.lineSpacing;
    return options;
  };
  const listOptions = optionsOf(list.ink);
  const runs: Run[] = plainRuns(label.text, label.ink, page.context).map((run) => {
    const options = { ...(run.options ?? {}), align: flow.ink.align };
    delete options.lineSpacing;
    return { ...run, options };
  });
  sources.forEach((source, at) => {
    const target = sourceHyperlink(page, source);
    runs.push({ text: at === 0 ? " " : " · ", options: { ...listOptions } });
    runs.push({
      text: source.title,
      options: {
        ...listOptions,
        ...(target ? { hyperlink: target, color: page.measure.link } : {}),
      },
    });
  });
  (runs[0]?.options as NonNullable<Run["options"]>).lineSpacing = pt(flow.ink.lineHeight);
  const { x, y, w, h } = frameOf(page, textFrame(flow));
  if (w <= 0 || h <= 0) return;
  useInk(page, label.ink);
  useInk(page, list.ink);
  page.slide.addText(runs, {
    x,
    y,
    w,
    h,
    margin: 0,
    valign: "bottom",
    fit: "none",
    wrap: true,
    objectName: "Sources",
  });
}

function item(page: Page, entry: Item) {
  switch (entry.kind) {
    case "shape":
      addShape(page, entry);
      return;
    case "eyebrow":
      addText(page, "Eyebrow", entry.text, plainRuns(page.scene.title, entry.text.ink, page.context));
      return;
    case "claim":
      if (page.scene.summary) {
        addText(
          page,
          page.scene.summary.id,
          entry.text,
          plainRuns(page.scene.summary.text, entry.text.ink, page.context),
          true,
        );
        page.placed.add(page.scene.summary.id);
      }
      return;
    case "sources":
      if (entry.flow) footText(page, entry.label, entry.list, entry.flow);
      else sourcesText(page, entry.label, entry.list, entry.numbered !== false);
      return;
    default:
      break;
  }
  const block = page.blocks.get(entry.id);
  if (!block) return;
  page.placed.add(block.id);
  if ("link" in block && block.link !== undefined && block.type !== "image") {
    page.left.push(
      `"${block.id}": its link is not carried to PowerPoint; only a picture and the sources keep theirs.`,
    );
  }
  switch (entry.kind) {
    case "text":
      if (block.type === "text") textBlock(page, block, entry.text);
      addCite(page, block, entry.cite);
      return;
    case "image":
      if (block.type === "image") {
        addPicture(
          page,
          block,
          block.asset,
          entry.picture,
          block.decorative ? "" : (block.alt ?? ""),
          block.link === undefined ? undefined : linkFor(page, block.link),
        );
        // pptxgenjs writes the file's name for an empty alt text; an empty entry here empties it again.
        if (block.decorative) page.alts[block.id] = "";
        if (block.caption && entry.caption) {
          addText(
            page,
            `${block.id} caption`,
            entry.caption,
            plainRuns(block.caption, entry.caption.ink, page.context),
          );
        }
      }
      addCite(page, block, entry.cite);
      return;
    case "clip":
      if (block.type === "clip") clipBlock(page, block, entry);
      addCite(page, block, entry.cite);
      return;
    case "table":
      if (block.type === "table") tableBlock(page, block, entry);
      addCite(page, block, entry.cite);
      return;
    case "chart":
      if (block.type === "chart") chartBlock(page, block, entry);
      addCite(page, block, entry.cite);
      return;
    case "bars":
      if (block.type === "bar-chart") barsBlock(page, block, entry);
      addCite(page, block, entry.cite);
      return;
  }
}

/** Draws every scene as a slide and returns the file as the writer made it, with what each slide could not carry. */
export async function buildPresentation(input: BuildInput): Promise<Built> {
  const { deck, scenes, measures } = input;
  const first = measures[0];
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.subject = `Depthcue deck ${deck.id}`;
  pptx.author = "Depthcue";
  pptx.company = "Depthcue";
  pptx.revision = "1";
  if (first) pptx.theme = { headFontFace: first.fonts.display, bodyFontFace: first.fonts.body };

  const fonts = new Map<string, Set<string>>();
  const slides: SlideReport[] = [];
  const headers: string[][] = [];
  const alts: Array<Record<string, string>> = [];
  const charts: ChartPlaces[] = [];
  scenes.forEach((scene, at) => {
    const measure = measures[at] as SlideMeasure;
    const step = input.steps?.[at];
    const picture = input.pictures?.[at];
    const slide = pptx.addSlide();
    if (!input.master) slide.background = { color: bare(input.style.colors.bg) };
    const page: Page = {
      pptx,
      slide,
      scene,
      measure,
      input,
      context: { tones: measure.tones, link: measure.link, language: deck.language },
      left: [],
      fonts,
      blocks: new Map(scene.blocks.map((block) => [block.id, block])),
      placed: new Set(),
      headers: [],
      alts: {},
      charts,
    };
    const report: SlideReport = { scene: scene.id, title: scene.title, left: page.left };
    if (step) report.step = step.at;
    if (picture) {
      pictureSlide(page, picture);
    } else {
      for (const entry of measure.items) item(page, entry);
      const held = new Set(measure.hidden ?? []);
      for (const block of scene.blocks) {
        if (!page.placed.has(block.id) && !held.has(block.id))
          page.left.push(`"${block.id}" is not on the slide: the player did not draw it.`);
      }
      for (const lost of measure.lost ?? []) {
        const split = lost.indexOf(": ");
        page.left.push(
          `"${lost.slice(0, split)}" has what a PowerPoint shape here does not draw: ${lost.slice(split + 2)}.`,
        );
      }
    }
    const steps = scene.steps?.length ?? 0;
    // A slide per step shows what that step shows; the report says which step it is (`report.step`).
    if (!step && steps > 0) {
      page.left.push(
        `build steps: ${steps} step${steps === 1 ? "" : "s"} flattened, so every block shows at once.`,
      );
    }
    const past = overflow(measure);
    if (past) {
      page.left.push(
        `the content runs ${past}, where it scrolls or is cut off; ${picture ? "the picture shows what the slide shows" : "boxes are cut at the slide's edge here, pictures are cropped there, and a table keeps every row"}.`,
      );
    }
    if (input.notes && scene.notes) slide.addNotes(scene.notes);
    slides.push(report);
    headers.push(page.headers);
    alts.push(page.alts);
  });

  const raw = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Uint8Array;
  return {
    raw,
    slides,
    headers,
    alts,
    charts,
    fonts: [...fonts.entries()]
      .map(([family, roles]) => ({ family, roles: [...roles].sort() }))
      .sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0)),
  };
}

/** A `#rrggbb` color as the writer takes it. */
const bare = (color: string): string => color.replace("#", "").toUpperCase();

/** How far the content runs past each edge, in words, or nothing when it stays on the slide. */
export function overflow(measure: SlideMeasure): string | undefined {
  const { left = 0, top = 0, right, bottom } = measure.beyond;
  const edges = [
    ["bottom", bottom],
    ["right", right],
    ["left", left],
    ["top", top],
  ] as const;
  const [first, ...rest] = edges.filter(([, by]) => by > 1);
  if (!first) return undefined;
  const more = rest.map(([edge, by]) => `, and ${Math.round(by)}px at the ${edge}`).join("");
  return `${Math.round(first[1])}px past the slide in the player too, at the ${first[0]}${more}`;
}

/**
 * The page as one picture filling the slide, with the scene's title as its description and in a text box the package
 * step makes the slide's hidden title, so PowerPoint's outline and a screen reader list the scene.
 */
function pictureSlide(page: Page, png: Uint8Array) {
  const { w, h } = page.measure.slide;
  // The title goes first, under the picture, so even an app that shows hidden shapes shows the picture alone.
  page.slide.addText(page.scene.title, {
    x: inch(w * 0.05),
    y: inch(h * 0.04),
    w: inch(w * 0.9),
    h: inch(h * 0.14),
    objectName: PICTURE_TITLE,
  });
  page.slide.addImage({
    data: `image/png;base64,${Buffer.from(png).toString("base64")}`,
    x: 0,
    y: 0,
    w: inch(w),
    h: inch(h),
    altText: page.scene.title,
    objectName: "Scene picture",
  });
  for (const block of page.scene.blocks) page.placed.add(block.id);
}
