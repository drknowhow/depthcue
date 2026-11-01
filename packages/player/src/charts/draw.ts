import { type Block, columnKinds } from "@depthcue/core";
import { h } from "../dom.ts";
import { numberText, renderTable, unitText } from "../table.ts";
import { fit, linear, niceTicks } from "./scale.ts";
import { d, s } from "./svg.ts";

type Chart = Extract<Block, { type: "chart" }>;
type Kind = Chart["kind"];
type Table = Extract<Block, { type: "table" }>;
type Point = { x: number; y: number };

/** What each kind of chart is called, for its label to a screen reader and for the editor's menus. */
export const CHART_KIND_LABELS: Readonly<Record<Kind, string>> = {
  bar: "Bar",
  "stacked-bar": "Stacked bar",
  line: "Line",
  area: "Area",
  scatter: "Scatter",
  donut: "Donut",
};

interface Series {
  label: string;
  unit: string | undefined;
  values: Array<number | null>;
}

/** What is drawn: the chart's data as numbers, and the size of the drawing's own coordinates. */
interface Plot {
  kind: Kind;
  W: number;
  H: number;
  language: string | undefined;
  /** What a scatter's x axis measures: its first column's label, with its unit. */
  xLabel: string;
  names: string[];
  xs: number[];
  series: Series[];
}

/** The width of one character of the 12-unit data font, which is how a label's width is known before it is drawn. */
const CHAR = 7.2;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const num = (cell: unknown): number | null =>
  typeof cell === "number" && Number.isFinite(cell) ? cell : null;
/** A series' place in the palette, 1 to 6: the stylesheet turns it into a color, so no color is stored anywhere. */
const slot = (at: number) => String((at % 6) + 1);

/** The corners of each mark after the circle, as offsets from its center in radii: square, two triangles, diamond, cross. */
const CORNERS: number[][] = [
  [-1, -1, 1, -1, 1, 1, -1, 1],
  [0, -1.15, 1.1, 0.85, -1.1, 0.85],
  [0, -1.3, 1.3, 0, 0, 1.3, -1.3, 0],
  [0, 1.15, 1.1, -0.85, -1.1, -0.85],
  [
    -0.5, -1.3, 0.5, -1.3, 0.5, -0.5, 1.3, -0.5, 1.3, 0.5, 0.5, 0.5, 0.5, 1.3, -0.5, 1.3, -0.5, 0.5, -1.3,
    0.5, -1.3, -0.5, -0.5, -0.5,
  ],
];

/** The mark that tells series number `at` from the others without its color: a circle, square, triangle, and so on. */
const mark = (at: number, x: number, y: number, r: number): string =>
  at % 6
    ? d("M", ...(CORNERS[(at % 6) - 1] ?? []).map((offset, i) => (i % 2 ? y : x) + offset * r), "Z")
    : d("M", x - r, y, "a", r, r, 0, 1, 0, 2 * r, 0, "a", r, r, 0, 1, 0, -2 * r, 0, "Z");

/** A bar from `base` to `end` (their y values), square where it stands on the baseline and rounded at its end. */
function barPath(x: number, base: number, end: number, width: number, round: boolean): string {
  const way = Math.sign(end - base);
  const r = round ? Math.min(4, width / 2, Math.abs(end - base)) : 0;
  const sweep = way < 0 ? 1 : 0;
  return d(
    ...["M", x, base, "V", end - way * r, "A", r, r, 0, 0, sweep, x + r, end, "H", x + width - r],
    ...["A", r, r, 0, 0, sweep, x + width, end - way * r, "V", base, "Z"],
  );
}

const text = (x: number, y: number, content: string, anchor: "start" | "middle" | "end", name?: string) =>
  s(
    "text",
    { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, "text-anchor": anchor, class: name },
    content,
  );

/** A path that goes through the points and lifts its pen at a missing one. */
const through = (points: Array<Point | null>): string =>
  points.map((point, i) => (point ? d(points[i - 1] ? "L" : "M", point.x, point.y) : "")).join("");

function cartesian(plot: Plot): SVGElement[] {
  const { W, H, kind, series, language } = plot;
  const n = plot.names.length;
  const count = series.length;
  const scatter = kind === "scatter";
  const stacked = kind === "stacked-bar";
  const bars = kind === "bar" || stacked;

  // The vertical extent: every value, or for a stack the sum of the parts above the baseline and of those below it.
  const sum = (i: number, pick: (value: number) => number) =>
    series.reduce((total, x) => total + pick(x.values[i] ?? 0), 0);
  const rows = plot.names.map((_, i) => i);
  const values = series.flatMap((x) => x.values).filter((value): value is number => value !== null);
  const min = stacked
    ? Math.min(0, ...rows.map((i) => sum(i, (v) => Math.min(0, v))))
    : Math.min(...values, ...(values.length ? [] : [0]));
  const max = stacked
    ? Math.max(0, ...rows.map((i) => sum(i, (v) => Math.max(0, v))))
    : Math.max(...values, ...(values.length ? [] : [1]));
  // A bar and an area start from 0, so they cannot lie about size. A line may start higher, unless that would hide
  // most of its rise.
  const zero = bars || kind === "area" || (kind === "line" && min >= 0 && min <= max / 2);

  const top = 30;
  const bottom = H - (scatter ? 40 : 26);
  const yTicks = niceTicks(min, max, clamp(Math.round((bottom - top) / 46), 2, 6), zero);
  const Y = linear(yTicks.lo, yTicks.hi, bottom, top);
  const yLabels = yTicks.ticks.map((tick) => numberText(tick, language));
  const left = Math.max(...yLabels.map((label) => label.length)) * CHAR + 14;
  const right = W - (scatter ? 24 : 12);
  const slotWidth = (right - left) / Math.max(1, n);
  const xTicks = scatter
    ? niceTicks(Math.min(...plot.xs), Math.max(...plot.xs), clamp(Math.round((right - left) / 64), 2, 6))
    : undefined;
  const sx = xTicks ? linear(xTicks.lo, xTicks.hi, left, right) : undefined;
  const at = (i: number) => (sx ? sx(plot.xs[i] as number) : left + (i + 0.5) * slotWidth);

  const baseValue = Math.min(Math.max(0, yTicks.lo), yTicks.hi);
  const base = Y(baseValue);
  const first = series[0];
  const unit = series.every((x) => x.unit === first?.unit) ? first?.unit : undefined;
  const title = unit
    ? count === 1
      ? `${first?.label} (${unit})`
      : unit
    : count === 1
      ? (first?.label ?? "")
      : "";

  const out: SVGElement[] = [];
  if (title) out.push(text(0, 12, fit(title, Math.floor(W / CHAR) - 2), "start"));
  out.push(
    s("path", {
      class: "dc-grid",
      d: yTicks.ticks
        .filter((tick) => tick !== baseValue)
        .map((tick) => d("M", left, Y(tick), "H", right))
        .join(""),
    }),
    s("path", { class: "dc-axis", d: d("M", left, base, "H", right) }),
  );
  yTicks.ticks.forEach((tick, i) => {
    out.push(text(left - 8, Y(tick) + 4, yLabels[i] as string, "end"));
  });
  if (xTicks && sx) {
    for (const tick of xTicks.ticks)
      out.push(text(sx(tick), bottom + 17, numberText(tick, language), "middle"));
    if (plot.xLabel) out.push(text(right, H - 4, fit(plot.xLabel, Math.floor(W / CHAR) - 2), "end"));
  } else {
    // The category labels, every few slots and cut short when the slots are too narrow for them all.
    const stride = Math.max(1, Math.ceil(36 / slotWidth));
    const room = Math.floor((slotWidth * stride - 6) / CHAR);
    plot.names.forEach((name, i) => {
      if (i % stride === 0) out.push(text(at(i), bottom + 17, fit(name, room), "middle"));
    });
  }

  const glyphs: SVGElement[] = [];
  const labels: SVGElement[] = [];
  if (bars) {
    const gap = 2;
    const width = Math.min(
      28,
      (slotWidth * 0.72 - (stacked ? 0 : gap * (count - 1))) / (stacked ? 1 : count),
    );
    const shapes = series.map(() => "");
    const keys = series.map(() => "");
    rows.forEach((i) => {
      const heap = [0, 0];
      series.forEach((x, j) => {
        const value = x.values[i];
        if (!value) return;
        const side = value > 0 ? 0 : 1;
        const from = stacked ? (heap[side] as number) : 0;
        heap[side] = from + value;
        // Only the end of a bar, or of the last part of a stack, is rounded, and parts of a stack are 2 units apart.
        const last = !stacked || series.slice(j + 1).every((y) => (y.values[i] ?? 0) * value <= 0);
        const [a, b] = [Y(from), Y(from + value)];
        const way = Math.sign(b - a);
        const start = a + (from ? way : 0);
        const end = b - (last ? 0 : way);
        if (Math.abs(end - start) < 1) return;
        const x0 =
          at(i) -
          (stacked ? width : count * width + (count - 1) * gap) / 2 +
          (stacked ? 0 : j * (width + gap));
        shapes[j] += barPath(x0, start, end, width, last);
        // With two series or more, each bar carries its series' mark, so the series are told without their colors.
        if (count > 1 && width >= 12 && Math.abs(end - start) >= 16)
          keys[j] += mark(j, x0 + width / 2, (start + end) / 2, 3.2);
        const label = numberText(value, language);
        if (count === 1 && n <= 8 && label.length * CHAR <= slotWidth - 4) {
          labels.push(text(at(i), way < 0 ? end - 5 : end + 15, label, "middle", "dc-v"));
        }
      });
    });
    series.forEach((_, j) => {
      if (shapes[j]) out.push(s("path", { class: "dc-mark", "data-s": slot(j), d: shapes[j] }));
      if (keys[j]) glyphs.push(s("path", { class: "dc-glyph", d: keys[j] }));
    });
  } else {
    const lines = series.map((x) =>
      x.values.map((value, i) => (value === null ? null : { x: at(i), y: Y(value) })),
    );
    if (kind === "area") {
      lines.forEach((points, j) => {
        const runs: Point[][] = [];
        let run: Point[] | undefined;
        for (const point of points) {
          if (!point) run = undefined;
          else {
            if (!run) {
              run = [];
              runs.push(run);
            }
            run.push(point);
          }
        }
        const wash = runs.map(
          (r) =>
            `${d("M", (r[0] as Point).x, base)}${through(r).replace("M", "L")}${d("L", (r.at(-1) as Point).x, base, "Z")}`,
        );
        out.push(s("path", { class: "dc-wash", "data-s": slot(j), d: wash.join("") }));
      });
    }
    if (!scatter)
      lines.forEach((points, j) => {
        out.push(s("path", { class: "dc-line", "data-s": slot(j), d: through(points) }));
      });
    // A mark on each point while there are few of them; otherwise only on the end of each line, so it can be told.
    const every = scatter || n * count <= 24;
    lines.forEach((points, j) => {
      const end = points.reduce<number>((last, point, i) => (point ? i : last), -1);
      const shapes = points.map((point, i) =>
        point && (every || i === end) ? mark(j, point.x, point.y, 4) : "",
      );
      if (shapes.join(""))
        out.push(s("path", { class: "dc-mark dc-ring", "data-s": slot(j), d: shapes.join("") }));
    });
  }
  return [...out, ...glyphs, ...labels];
}

function donut(plot: Plot): SVGElement[] {
  const { W, H, language } = plot;
  const series = plot.series[0];
  const parts = plot.names
    .map((name, at) => ({ name, at, value: series?.values[at] ?? 0 }))
    .filter((part) => part.value > 0);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!(total > 0)) return [];

  const outer = Math.min(H / 2 - 8, W * 0.25);
  const inner = outer * 0.58;
  const [cx, cy] = [outer + 6, H / 2];
  const at = (angle: number, radius: number) =>
    [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  const out: SVGElement[] = [];
  const share: SVGElement[] = [];
  let angle = -Math.PI / 2;
  for (const part of parts) {
    // A part whole circle is drawn as nearly one, so that its arc has two ends. Parts are 2 units apart.
    const span = Math.min(6.28, (part.value / total) * 2 * Math.PI);
    const gap = span > 0.3 && span < 6.28 ? 1 / ((outer + inner) / 2) : 0;
    const [from, to] = [angle + gap, angle + span - gap];
    const large = to - from > Math.PI ? 1 : 0;
    const shape = d(
      ...["M", ...at(from, outer), "A", outer, outer, 0, large, 1, ...at(to, outer)],
      ...["L", ...at(to, inner), "A", inner, inner, 0, large, 0, ...at(from, inner), "Z"],
    );
    out.push(s("path", { class: "dc-mark", "data-s": slot(part.at), d: shape }));
    if (part.value / total >= 0.07) {
      const [x, y] = at(angle + span / 2, (outer + inner) / 2);
      share.push(
        text(
          x,
          y + 4,
          `${numberText(Math.round((part.value / total) * 100), language)}%`,
          "middle",
          "dc-halo",
        ),
      );
    }
    angle += span;
  }

  // The names, in the order of the parts, each with its value, so no part is told by its color alone.
  const listX = outer * 2 + 24;
  parts.forEach((part, row) => {
    const y = cy + (row - (parts.length - 1) / 2) * 20;
    const value = `${numberText(part.value, language)}${unitText(series?.unit)}`;
    out.push(
      s("rect", {
        x: listX,
        y: y - 5,
        width: 10,
        height: 10,
        rx: 2,
        class: "dc-mark",
        "data-s": slot(part.at),
      }),
      text(
        listX + 16,
        y + 4,
        fit(part.name, Math.floor((W - 14 - listX - 16 - value.length * CHAR) / CHAR)),
        "start",
      ),
      text(W - 6, y + 4, value, "end", "dc-v"),
    );
  });
  return [...out, ...share];
}

/** The chart's data as the table a screen reader reads: the same columns and rows, with the unit in each header. */
export function chartTable(block: Chart): Table {
  const kinds = columnKinds(block);
  return {
    id: block.id,
    type: "table",
    ...(block.title === undefined ? {} : { title: block.title }),
    columns: block.columns.map((column, at) => {
      const unit = column.unit ?? (at > 0 ? block.unit : undefined);
      return { label: column.label, kind: kinds[at] ?? "text", ...(unit === undefined ? {} : { unit }) };
    }),
    rows: block.rows,
  };
}

/**
 * A chart as a figure: its title, a legend when it has two series or more, the drawing, and its data as a table that
 * only a screen reader meets. The drawing is SVG built by `s`, so every label is text. A pinned chart is drawn at the
 * shape of its frame, at one text size. Its colors come from the deck's palette by each series' place, in the
 * stylesheet, so the same palette draws the same colors and a new palette redraws them. Nothing here reads the page:
 * it is the same figure in the player, the editor, a thumbnail and an export.
 */
export function renderChart(block: Chart, language?: string): HTMLElement {
  const scatter = block.kind === "scatter";
  const rows = block.rows.filter((row) => !scatter || num(row[0]) !== null);
  const series: Series[] = block.columns.slice(1).map((column, at) => ({
    label: column.label,
    unit: column.unit ?? block.unit,
    values: rows.map((row) => num(row[at + 1])),
  }));
  const { frame } = block;
  const W = frame ? clamp(Math.round(frame.w * 10), 300, 640) : 400;
  const H = frame ? clamp(Math.round((W * 9 * frame.h) / (16 * frame.w)), 150, 480) : 250;
  const plot: Plot = {
    kind: block.kind,
    W,
    H,
    language,
    xLabel: scatter
      ? `${block.columns[0]?.label}${block.columns[0]?.unit ? ` (${block.columns[0].unit})` : ""}`
      : "",
    names: rows.map((row) => String(row[0] ?? "")),
    xs: rows.map((row) => num(row[0]) ?? 0),
    series,
  };
  return h(
    "figure",
    { class: "dc-figure dc-plot-figure", "data-kind": block.kind },
    block.title && h("figcaption", { "aria-hidden": "true" }, block.title),
    series.length > 1 &&
      block.kind !== "donut" &&
      h(
        "ul",
        { class: "dc-legend", "aria-hidden": "true" },
        ...series.map((x, at) =>
          h(
            "li",
            {},
            s(
              "svg",
              { class: "dc-key", viewBox: "-6 -6 12 12", "data-s": slot(at) },
              s("path", { class: "dc-mark", d: mark(at, 0, 0, 4.5) }),
            ),
            x.label,
          ),
        ),
      ),
    s(
      "svg",
      {
        class: "dc-plot",
        viewBox: `0 0 ${W} ${H}`,
        preserveAspectRatio: "xMinYMin meet",
        role: "img",
        "aria-label": `${CHART_KIND_LABELS[block.kind]} chart${block.title ? `: ${block.title}` : ""}`,
      },
      ...(block.kind === "donut" ? donut(plot) : cartesian(plot)),
    ),
    h("div", { class: "dc-sr-only" }, renderTable(chartTable(block), language)),
  );
}
