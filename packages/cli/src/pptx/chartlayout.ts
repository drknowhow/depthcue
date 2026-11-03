/**
 * Where a native chart's title, legend and plot go in its frame. The writer places the title by a sum of the chart's
 * place on the slide and the legend wherever PowerPoint puts it, so a caption could sit on the legend. Each one is
 * placed where the page draws it instead, as a fraction of the chart's frame, and none of them over another: the
 * plot gives way to the title and the legend, and the legend to the title.
 */
import type { Box } from "./measure.ts";

/** A rectangle as fractions of the chart's frame, from its top left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The title's place and the legend's (PowerPoint sizes each to its words, so only their corners are written), and the
 * plot area's with its axis labels.
 */
export interface ChartPlaces {
  title?: Rect;
  legend?: Rect;
  plot: Rect;
}

/** What the page drew, in pixels: the frame, and the caption, legend and plot in it. */
export interface ChartParts {
  frame: Box;
  title?: Box;
  legend?: Box;
  plot: Box;
  /** Room the native chart needs beside the plot for an axis title the page writes elsewhere, in pixels. */
  axisRoom?: { left: number; bottom: number };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
/** Four decimals: a tenth of a pixel on a slide, and the same digits every time. */
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function within(box: Box, frame: Box): Rect {
  const x = clamp((box.x - frame.x) / frame.w);
  const y = clamp((box.y - frame.y) / frame.h);
  return {
    x,
    y,
    w: clamp((box.x + box.w - frame.x) / frame.w) - x,
    h: clamp((box.y + box.h - frame.y) / frame.h) - y,
  };
}

const area = (rect: Rect) => Math.max(0, rect.w) * Math.max(0, rect.h);

/** Whether two rectangles share any area. Touching edges do not. */
export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The largest part of `rect` clear of `fixed`: above it, below it, or beside it. */
function clear(rect: Rect, fixed: Rect): Rect {
  if (!overlaps(rect, fixed)) return rect;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const options: Rect[] = [
    { ...rect, h: fixed.y - rect.y },
    { ...rect, y: fixed.y + fixed.h, h: bottom - (fixed.y + fixed.h) },
    { ...rect, w: fixed.x - rect.x },
    { ...rect, x: fixed.x + fixed.w, w: right - (fixed.x + fixed.w) },
  ];
  return options.reduce((best, option) => (area(option) > area(best) ? option : best));
}

/** Rounded at its edges, so two parts that meet still meet. */
function rounded(rect: Rect): Rect {
  const x = round(rect.x);
  const y = round(rect.y);
  return {
    x,
    y,
    w: round(Math.max(0, round(rect.x + rect.w) - x)),
    h: round(Math.max(0, round(rect.y + rect.h) - y)),
  };
}

/** The places of a chart's parts in its frame, none over another. */
export function chartPlaces(parts: ChartParts): ChartPlaces {
  const { frame } = parts;
  const title = parts.title && within(parts.title, frame);
  let legend = parts.legend && within(parts.legend, frame);
  let plot = within(parts.plot, frame);
  if (parts.axisRoom) {
    const left = parts.axisRoom.left / frame.w;
    const bottom = parts.axisRoom.bottom / frame.h;
    plot = { x: plot.x + left, y: plot.y, w: plot.w - left, h: plot.h - bottom };
  }
  if (title && legend) legend = clear(legend, title);
  if (title) plot = clear(plot, title);
  if (legend) plot = clear(plot, legend);
  return {
    ...(title ? { title: rounded(title) } : {}),
    ...(legend ? { legend: rounded(legend) } : {}),
    plot: rounded(plot),
  };
}

const manual = (rect: Rect, size: boolean, target?: "inner" | "outer") =>
  `<c:layout><c:manualLayout>${target ? `<c:layoutTarget val="${target}"/>` : ""}<c:xMode val="edge"/><c:yMode val="edge"/><c:x val="${rect.x}"/><c:y val="${rect.y}"/>${size ? `<c:w val="${rect.w}"/><c:h val="${rect.h}"/>` : ""}</c:manualLayout></c:layout>`;

const LAYOUT = /<c:layout(?:\/>|>[\s\S]*?<\/c:layout>)/;

/**
 * A chart part with its title, legend and plot area laid out by hand at `places`: the title and the legend by their
 * corners, sized by PowerPoint to their words in the band left for them, and the plot area (with its axis labels,
 * `outer`) by its box.
 */
export function layChart(xml: string, places: ChartPlaces): string {
  let out = xml;
  const title = places.title;
  if (title) {
    out = out.replace(
      /(<c:chart>\s*<c:title>[\s\S]*?)(<c:layout(?:\/>|>[\s\S]*?<\/c:layout>))/,
      (_w, head: string) => `${head}${manual(title, false)}`,
    );
  }
  out = out.replace(
    new RegExp(`(<c:plotArea>\\s*)${LAYOUT.source}`),
    (_w, head: string) => `${head}${manual(places.plot, true, "outer")}`,
  );
  const legend = places.legend;
  if (legend) {
    out = out.replace(
      /(<c:legend>\s*<c:legendPos [^>]*\/>(?:\s*<c:legendEntry>[\s\S]*?<\/c:legendEntry>)*)(?:\s*<c:layout(?:\/>|>[\s\S]*?<\/c:layout>))?/,
      (_w, head: string) => `${head}${manual(legend, false)}`,
    );
  }
  return out;
}
