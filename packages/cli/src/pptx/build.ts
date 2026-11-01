/**
 * Draws the measured slides into a PowerPoint file. Each scene becomes one slide, with everything on it shown at once.
 * The words, numbers and data come from the deck; where things go and how they look come from the page's measurements
 * (`measure.ts`). What cannot be drawn is written down as it happens and goes into the report.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Block,
  type Cell,
  type ChartBlock,
  chartFromBarChart,
  type Deck,
  type DeckStyle,
  type Scene,
  type TableBlock,
  textFlow,
} from "@depthcue/core";
import PptxGenJS from "pptxgenjs";
import type {
  Box,
  ColumnPlace,
  Ink,
  Item,
  Picture,
  Rule,
  Shape,
  SlideMeasure,
  TextPlace,
} from "./measure.ts";
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
  left: string[];
}

export interface BuildInput {
  deck: Deck;
  /** The deck's resolved colors, whose `bg` is the slide's background. */
  style: DeckStyle;
  scenes: readonly Scene[];
  measures: readonly SlideMeasure[];
  /** The deck folder, which the pictures are read from and the links to files point into. */
  folder: string;
  notes: boolean;
  /** How the player writes a number in the deck's language, so a table and a chart's labels read alike. */
  numberText: (value: number, language?: string) => string;
}

export interface Built {
  /** The file as the writer made it, before it is tidied and marked. */
  raw: Uint8Array;
  slides: SlideReport[];
  /** For each slide, the ids of its tables that have a header row. */
  headers: string[][];
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
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** How much of a box stays on the slide when the page drew it past an edge, in pixels, so it never vanishes. */
const SLIVER = 12;

/**
 * A box on the slide in inches, held inside the slide when the page drew it past an edge: cut at the edge, as it is in
 * the player. A picture or chart keeps its proportions instead.
 */
function frameOf(page: Page, box: Box, keepShape = false): { x: number; y: number; w: number; h: number } {
  const { w: width, h: height } = page.measure.slide;
  let { x, y, w, h } = box;
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

function addText(page: Page, name: string, place: TextPlace, runs: Run[], heading = false) {
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
    wrap: true,
    objectName: name,
  });
}

/** The line under a block that names its sources, in the words the page wrote it. */
function addCite(page: Page, block: Block, cite: TextPlace | undefined) {
  if (cite?.text) addText(page, `${block.id} source`, cite, plainRuns(cite.text, cite.ink, page.context));
}

/** A file in the deck as a file address, which a link can point at on the machine that made the file. */
const fileLink = (page: Page, asset: string) => pathToFileURL(join(page.input.folder, asset)).href;

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
  link?: string,
): boolean {
  const data = pictureData(page, asset, picture);
  const { x, y, w, h } = frameOf(page, picture.picture, true);
  if (!data || w <= 0 || h <= 0) {
    page.left.push(`"${block.id}": the picture ${asset} could not be read, so it is not on the slide.`);
    return false;
  }
  if (!MIME[extname(asset).toLowerCase()]) {
    page.left.push(
      `"${block.id}": ${asset} is drawn as a PNG, because PowerPoint does not show every picture type.`,
    );
  }
  page.slide.addImage({
    data,
    x,
    y,
    w,
    h,
    altText: alt,
    objectName: block.id,
    ...(link ? { hyperlink: { url: link, tooltip: asset } } : {}),
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

function tableBlock(page: Page, block: TableBlock, item: Extract<Item, { kind: "table" }>) {
  const none: PptxGenJS.BorderProps = { type: "none" };
  const cellOptions = (column: ColumnPlace, ink: Ink, rule: Rule | null) => ({
    align: column.align,
    valign: "top" as const,
    fontFace: ink.family,
    fontSize: pt(ink.px),
    color: ink.color,
    lang: page.context.language,
    margin: [pt(column.padding.t), pt(column.padding.r), pt(column.padding.b), pt(column.padding.l)] as [
      number,
      number,
      number,
      number,
    ],
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
      ...series.map((entry) => ({ name: entry.name, values: entry.values.map((value) => value ?? 0) })),
    ];
    seriesColors = series.map((_, at) => colors[at % 6] as string);
  } else {
    data = series.map((entry) => ({
      name: entry.name,
      labels: names,
      values: entry.values.map((value) => value ?? 0),
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
  const axisSize = pt(item.axis.px);
  const mono = item.axis.family;
  useInk(page, item.axis);
  if (item.title) useInk(page, item.title.ink);
  if (item.legend) useInk(page, item.legend.ink);
  const labels = series.length === 1 && names.length <= 8 && kind !== "donut" && !scatter;
  const options: PptxGenJS.IChartOpts = {
    x,
    y,
    w,
    h,
    objectName: block.id,
    altText: block.title ?? `${kind} chart`,
    chartColors: seriesColors,
    ...(block.title
      ? {
          showTitle: true,
          title: block.title,
          titleFontFace: item.title?.ink.family ?? mono,
          titleFontSize: pt(item.title?.ink.px ?? item.axis.px),
          titleColor: item.title?.ink.color ?? item.axis.color,
          titleBold: false,
          titlePos: { x: 0, y: 0 },
        }
      : { showTitle: false }),
    showLegend: kind === "donut" || series.length > 1,
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
    ...(kind !== "donut" && axisTitle && !horizontal
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
        dataLabelPosition: "outEnd",
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
  const link = fileLink(page, block.source);
  if (item.poster && block.poster) {
    addPicture(page, block, block.poster, item.video, block.alt, link);
    page.left.push(
      `"${block.id}": the video is shown as its poster and linked to ${block.source}; it is not embedded.`,
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
  page.left.push(
    `"${block.id}": the video has no poster, so a labeled box links to ${block.source}; it is not embedded.`,
  );
}

function sourcesText(page: Page, label: TextPlace, list: TextPlace) {
  const sources = page.scene.sources ?? [];
  addText(page, "Sources label", label, plainRuns(label.text, label.ink, page.context));
  const runs: Run[] = [];
  const base = plainRuns("x", list.ink, page.context)[0] as Run;
  sources.forEach((source, at) => {
    const target = source.url ?? (source.asset ? fileLink(page, source.asset) : undefined);
    const options = { ...(base.options ?? {}) };
    delete options.lineSpacing;
    runs.push({ text: `${at + 1}. `, options: { ...options, align: list.ink.align } });
    runs.push({
      text: source.title,
      options: {
        ...options,
        align: list.ink.align,
        ...(target ? { hyperlink: { url: target }, color: page.measure.link } : {}),
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
      sourcesText(page, entry.label, entry.list);
      return;
    default:
      break;
  }
  const block = page.blocks.get(entry.id);
  if (!block) return;
  page.placed.add(block.id);
  switch (entry.kind) {
    case "text":
      if (block.type === "text") textBlock(page, block, entry.text);
      addCite(page, block, entry.cite);
      return;
    case "image":
      if (block.type === "image") {
        addPicture(page, block, block.asset, entry.picture, block.alt);
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
  scenes.forEach((scene, at) => {
    const measure = measures[at] as SlideMeasure;
    const slide = pptx.addSlide();
    slide.background = { color: bare(input.style.colors.bg) };
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
    };
    for (const entry of measure.items) item(page, entry);
    for (const block of scene.blocks) {
      if (!page.placed.has(block.id))
        page.left.push(`"${block.id}" is not on the slide: the player did not draw it.`);
    }
    const steps = scene.steps?.length ?? 0;
    if (steps > 0) {
      page.left.push(
        `build steps: ${steps} step${steps === 1 ? "" : "s"} flattened, so every block shows at once.`,
      );
    }
    if (measure.beyond.bottom > 1 || measure.beyond.right > 1) {
      page.left.push(
        `the content runs ${Math.round(Math.max(measure.beyond.bottom, measure.beyond.right))}px past the slide in the player too, where it scrolls or is cut off; boxes are cut at the slide's edge here, and a table keeps every row.`,
      );
    }
    if (input.notes && scene.notes) slide.addNotes(scene.notes);
    slides.push({ scene: scene.id, title: scene.title, left: page.left });
    headers.push(page.headers);
  });

  const raw = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Uint8Array;
  return {
    raw,
    slides,
    headers,
    fonts: [...fonts.entries()]
      .map(([family, roles]) => ({ family, roles: [...roles].sort() }))
      .sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0)),
  };
}

/** A `#rrggbb` color as the writer takes it. */
const bare = (color: string): string => color.replace("#", "").toUpperCase();
