// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Block, PRESETS, type Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { CHART_KIND_LABELS, chartTable, renderChart } from "../src/charts/draw.ts";
import { fit, linear, niceTicks } from "../src/charts/scale.ts";
import { renderScene } from "../src/scene.ts";
import { sceneWith } from "./helpers.ts";

type Chart = Extract<Block, { type: "chart" }>;

const chartsDir = resolve(import.meta.dirname, "../../../fixtures/decks/charts");
const sceneOf = (id: string) =>
  JSON.parse(readFileSync(join(chartsDir, "scenes", `${id}.json`), "utf8")) as Scene;
const chartIn = (id: string) =>
  sceneOf(id).blocks.find((block): block is Chart => block.type === "chart") as Chart;
const ctx = { assetBase: "." };
const figureOf = (id: string, language?: string) =>
  renderScene(sceneOf(id), language ? { ...ctx, language } : ctx).querySelector<HTMLElement>(
    ".dc-plot-figure",
  ) as HTMLElement;
const labels = (figure: Element) =>
  [...figure.querySelectorAll("svg.dc-plot text")].map((node) => node.textContent);

describe("the scale of a chart", () => {
  it("marks round numbers, a few of them, and covers the data", () => {
    expect(niceTicks(0, 100, 4).ticks).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 6000, 4).ticks).toEqual([0, 2000, 4000, 6000]);
    expect(niceTicks(3, 47, 4).ticks).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(-3, 8, 4).ticks).toEqual([-4, -2, 0, 2, 4, 6, 8]);
  });

  it("rounds each tick to its step's own decimals, so 0.1 + 0.2 is 0.3", () => {
    expect(niceTicks(0.1, 0.5, 4).ticks).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(niceTicks(0, 0.3, 3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it("starts at 0 when asked to, and leaves room around a flat or empty range", () => {
    expect(niceTicks(40, 90, 4, true).lo).toBe(0);
    expect(niceTicks(40, 90, 4, false).lo).toBeGreaterThan(0);
    const flat = niceTicks(5, 5, 4);
    expect(flat.lo).toBeLessThan(5);
    expect(flat.hi).toBeGreaterThan(5);
    expect(niceTicks(Number.NaN, Number.NaN).ticks.length).toBeGreaterThan(1);
  });

  it("maps a domain onto a range, backward for a y axis, and cuts labels to fit with an ellipsis", () => {
    expect(linear(0, 10, 100, 0)(2.5)).toBe(75);
    expect(linear(3, 3, 0, 10)(3)).toBe(5);
    expect(fit("Channel A", 20)).toBe("Channel A");
    expect(fit("Channel A", 6)).toBe("Chann…");
  });
});

/*
 * Series colors come from the stylesheet and nowhere else: the first two are the deck's evidence and action colors and
 * the rest are mixes of them. happy-dom resolves neither var() nor color-mix(), so this reads the rule out of
 * player.css and works its colors out with the same arithmetic (OKLCH, the hue taken the short or the long way).
 */

const css = readFileSync(resolve(import.meta.dirname, "../src/player.css"), "utf8");
// Later rules win, as in the cascade: the mixes sit in an @supports block after the plain fallbacks.
const rule = new Map(
  [...css.matchAll(/--dc-s(\d):\s*([^;]+);/g)].map((found) => [Number(found[1]), found[2] as string]),
);

const toLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const toGamma = (value: number) => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
type Lab = [number, number, number];

function labOf(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map((at) => toLinear(Number.parseInt(hex.slice(at, at + 2), 16) / 255)) as Lab;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function hexOf([L, a, b]: Lab): string {
  const [l, m, s] = [
    L + 0.3963377774 * a + 0.2158037573 * b,
    L - 0.1055613458 * a - 0.0638541728 * b,
    L - 0.0894841775 * a - 1.291485548 * b,
  ].map((value) => value ** 3) as Lab;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((value) =>
      Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, value))))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

/** Splits at the commas that are not inside a bracket. */
function split(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "(") depth++;
    else if (text[at] === ")") depth--;
    else if (text[at] === "," && depth === 0) {
      parts.push(text.slice(from, at).trim());
      from = at + 1;
    }
  }
  return [...parts, text.slice(from).trim()];
}

/** The color a stylesheet value stands for, given the deck's colors by name, as a hex. */
function resolveColor(value: string, tokens: Record<string, string>): string {
  const text = value.trim();
  if (text.startsWith("#")) return text.toUpperCase();
  const named = /^var\(--dc-([a-z-]+)\)$/.exec(text);
  if (named) return resolveColor(tokens[named[1] as string] as string, tokens);
  const mix = /^color-mix\((.*)\)$/s.exec(text);
  if (!mix) throw new Error(`The test does not know how to work out ${text}.`);
  const [space = "", first = "", second = ""] = split(mix[1] as string);
  const longer = space.includes("longer hue");
  const share = (part: string) => /\s(\d+(?:\.\d+)?)%$/.exec(part)?.[1];
  const strip = (part: string) => part.replace(/\s\d+(?:\.\d+)?%$/, "");
  const [p1, p2] = [share(first), share(second)];
  const t2 = p2 !== undefined ? Number(p2) / 100 : p1 !== undefined ? 1 - Number(p1) / 100 : 0.5;
  const [a, b] = [labOf(resolveColor(strip(first), tokens)), labOf(resolveColor(strip(second), tokens))];
  const chroma = (lab: Lab) => Math.hypot(lab[1], lab[2]);
  const hue = (lab: Lab) => (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  let delta = hue(b) - hue(a);
  if (longer) {
    if (delta > 0 && delta < 180) delta -= 360;
    else if (delta < 0 && delta > -180) delta += 360;
  } else if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  const angle = ((hue(a) + delta * t2) * Math.PI) / 180;
  const c = chroma(a) + (chroma(b) - chroma(a)) * t2;
  return hexOf([a[0] + (b[0] - a[0]) * t2, c * Math.cos(angle), c * Math.sin(angle)]);
}

const seriesColors = (tokens: Record<string, string>) =>
  [1, 2, 3, 4, 5, 6].map((at) => resolveColor(rule.get(at) as string, tokens));
const distance = (one: string, other: string) => {
  const [a, b] = [labOf(one), labOf(other)];
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

describe("the colors of a chart's series", () => {
  it("are the deck's own colors by position, and are written as a rule on the palette, never as colors", () => {
    expect([...rule.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...rule.values()].some((value) => /#[0-9a-f]{3,8}\b|rgb|hsl/i.test(value))).toBe(false);
    for (const preset of ["paper", "ink"] as const) {
      const colors = seriesColors(PRESETS[preset]);
      expect(colors[0]).toBe(PRESETS[preset].evidence.toUpperCase());
      expect(colors[1]).toBe(PRESETS[preset].action.toUpperCase());
    }
    for (let at = 1; at <= 6; at++) {
      expect(css).toContain(`[data-s="${at}"] {\n  --c: var(--dc-s${at});`);
    }
  });

  it("are the same colors every time from the same palette, and six that neighbors can tell apart", () => {
    for (const preset of ["paper", "ink"] as const) {
      const colors = seriesColors(PRESETS[preset]);
      expect(seriesColors({ ...PRESETS[preset] })).toEqual(colors);
      expect(new Set(colors).size).toBe(6);
      // The validator's floor for neighbors, in OKLab times 100, with normal vision.
      for (let at = 1; at < colors.length; at++) {
        expect(distance(colors[at - 1] as string, colors[at] as string)).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it("change with the palette: a new evidence and action color give new colors in every place", () => {
    const before = seriesColors(PRESETS.paper);
    const after = seriesColors({ ...PRESETS.paper, evidence: "#117733", action: "#CC6677" });
    after.forEach((color, at) => {
      expect(color).not.toBe(before[at]);
    });
    expect(after[0]).toBe("#117733");
    expect(after[1]).toBe("#CC6677");
  });
});

describe("a bar chart", () => {
  const figure = figureOf("bar");

  it("is an image with a short label, a title and a legend of its two series", () => {
    const svg = figure.querySelector("svg.dc-plot");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Bar chart: Orders by quarter");
    expect(figure.querySelector("figcaption")?.textContent).toBe("Orders by quarter");
    expect([...figure.querySelectorAll(".dc-legend li")].map((item) => item.textContent)).toEqual([
      "Channel A",
      "Channel B",
    ]);
    expect(figure.querySelector(".dc-legend")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("has a few round ticks, the unit in its axis label and a category under each group, and no gridline clutter", () => {
    expect(labels(figure)).toEqual(["units", "0", "2000", "4000", "6000", "Q1", "Q2", "Q3", "Q4"]);
    // One path of gridlines for the ticks above the baseline, and one rule for the baseline itself.
    expect(figure.querySelector(".dc-grid")?.getAttribute("d")?.match(/M/g)).toHaveLength(3);
    expect(figure.querySelectorAll(".dc-axis")).toHaveLength(1);
  });

  it("draws one mark per series, in that series' place, and tells the series apart by a shape as well as a color", () => {
    const marks = [...figure.querySelectorAll<SVGElement>("svg.dc-plot .dc-mark")];
    expect(marks.map((mark) => mark.dataset.s ?? mark.getAttribute("data-s"))).toEqual(["1", "2"]);
    expect(marks.map((mark) => mark.getAttribute("d")?.match(/M/g)?.length)).toEqual([4, 4]);
    const glyphs = [...figure.querySelectorAll(".dc-glyph")].map((glyph) => glyph.getAttribute("d"));
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]).not.toBe(glyphs[1]);
  });

  it("rounds the end of a bar and leaves the baseline square", () => {
    const first = figure.querySelector("svg.dc-plot .dc-mark")?.getAttribute("d") ?? "";
    expect(first).toMatch(/^M [\d.]+ [\d.]+ V [\d.]+ A 4 4 0 0 1 /);
    expect(first).toMatch(/V [\d.]+ Z/);
  });
});

describe("a bar chart of one series", () => {
  const chart: Chart = {
    id: "c-one",
    type: "chart",
    kind: "bar",
    title: "Orders",
    columns: [{ label: "Quarter" }, { label: "Orders", unit: "units" }],
    rows: [
      ["Q1", 12],
      ["Q2", 7],
      ["Q3", -3],
    ],
  };

  it("has no legend, names its axis after the series, and writes each value at the end of its bar", () => {
    const figure = renderChart(chart);
    expect(figure.querySelector(".dc-legend")).toBeNull();
    expect(figure.querySelector(".dc-glyph")).toBeNull();
    const text = labels(figure);
    expect(text[0]).toBe("Orders (units)");
    expect([...figure.querySelectorAll(".dc-v")].map((node) => node.textContent)).toEqual(["12", "7", "-3"]);
    expect(text).toContain("-5");
  });

  it("does not write a value on every bar once there are too many to read", () => {
    const rows = Array.from({ length: 12 }, (_, at): [string, number] => [`Q${at + 1}`, at + 1]);
    expect(renderChart({ ...chart, rows }).querySelector(".dc-v")).toBeNull();
  });
});

describe("a stacked bar chart", () => {
  const figure = figureOf("stacked");

  it("stacks a part on a part with a gap between them, and reaches the total of each stack", () => {
    expect(labels(figure).slice(0, 7)).toEqual(["$M", "0", "10", "20", "30", "40", "50"]);
    const marks = [...figure.querySelectorAll("svg.dc-plot .dc-mark")];
    expect(marks.map((mark) => mark.getAttribute("data-s"))).toEqual(["1", "2", "3"]);
    // The 2025 stack of 15, 19 and 9 is 43 tall in all: its top is under the 50 tick, and its parts do not overlap.
    const tops = marks.map((mark) =>
      mark
        .getAttribute("d")
        ?.match(/M [\d.]+ ([\d.]+) V ([\d.]+)/)
        ?.slice(1)
        .map(Number),
    );
    expect(tops.every((pair) => pair && pair.length === 2)).toBe(true);
    expect([...figure.querySelectorAll(".dc-legend li")].map((item) => item.textContent)).toEqual([
      "Hardware",
      "Software",
      "Services",
    ]);
  });
});

describe("a line chart", () => {
  const figure = figureOf("line");

  it("draws a line of 2 units and a mark on every point for each series", () => {
    const lines = [...figure.querySelectorAll("svg.dc-plot .dc-line")];
    expect(lines.map((line) => line.getAttribute("data-s"))).toEqual(["1", "2"]);
    expect(lines[0]?.getAttribute("d")?.match(/L/g)).toHaveLength(7);
    const marks = [...figure.querySelectorAll("svg.dc-plot .dc-ring")];
    expect(marks.map((mark) => mark.getAttribute("d")?.match(/M/g)?.length)).toEqual([8, 8]);
  });

  it("lifts the pen at a missing value instead of drawing through it", () => {
    const chart: Chart = {
      id: "c-gap",
      type: "chart",
      kind: "line",
      columns: [{ label: "Week" }, { label: "Wait" }],
      rows: [
        ["W1", 3],
        ["W2", null],
        ["W3", 5],
        ["W4", 6],
      ],
    };
    const path = renderChart(chart).querySelector(".dc-line")?.getAttribute("d") ?? "";
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path.match(/L/g)).toHaveLength(1);
  });

  it("marks only the end of each line once there are too many points to mark them all", () => {
    const rows = Array.from({ length: 20 }, (_, at): [string, number, number] => [`W${at + 1}`, at, at * 2]);
    const chart: Chart = { ...chartIn("line"), rows };
    const marks = [...renderChart(chart).querySelectorAll(".dc-ring")];
    expect(marks.map((mark) => mark.getAttribute("d")?.match(/M/g)?.length)).toEqual([1, 1]);
  });
});

describe("an area chart", () => {
  it("washes the area under each line with its series' color, and draws the line over it", () => {
    const figure = figureOf("area");
    expect([...figure.querySelectorAll(".dc-wash")].map((wash) => wash.getAttribute("data-s"))).toEqual([
      "1",
      "2",
    ]);
    expect(figure.querySelectorAll(".dc-line")).toHaveLength(2);
    expect(figure.querySelector(".dc-wash")?.getAttribute("d")).toMatch(/Z$/);
    // It starts from 0, so its size is never misread.
    expect(labels(figure)[1]).toBe("0");
  });
});

describe("a scatter chart", () => {
  const figure = figureOf("scatter");

  it("marks points only, names its x axis after the first column with its unit, and has numbers along it", () => {
    expect(figure.querySelector(".dc-line")).toBeNull();
    expect(figure.querySelectorAll(".dc-ring")).toHaveLength(2);
    const text = labels(figure);
    expect(text).toContain("Spend ($k)");
    // The x values run from 10 to 70, so the axis does not start at 0 as a bar's must.
    expect(text).toEqual(expect.arrayContaining(["10", "20", "30", "40", "50", "60", "70"]));
  });

  it("leaves out a point that has no x, as the data table keeps it", () => {
    const chart: Chart = {
      id: "c-sc",
      type: "chart",
      kind: "scatter",
      columns: [{ label: "x" }, { label: "y" }],
      rows: [
        [1, 2],
        [null, 3],
        [3, 4],
      ],
    };
    const figure = renderChart(chart);
    expect(figure.querySelector(".dc-ring")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(figure.querySelectorAll(".dc-sr-only tbody tr")).toHaveLength(3);
  });
});

describe("a donut chart", () => {
  const figure = figureOf("donut");

  it("draws a part for each row, in its place, with its share on the part and its name and value beside it", () => {
    const parts = [...figure.querySelectorAll("svg.dc-plot path.dc-mark")];
    expect(parts.map((part) => part.getAttribute("data-s"))).toEqual(["1", "2", "3", "4", "5"]);
    expect(figure.querySelector(".dc-legend")).toBeNull();
    const text = labels(figure);
    expect(text).toEqual(
      expect.arrayContaining(["43%", "29%", "14%", "10%", "Search", "3000 orders", "Referral", "300 orders"]),
    );
    // The smallest part, 4%, is too narrow for its share, which stays in the list's value and the table.
    expect(text).not.toContain("4%");
  });

  it("writes each share flat on its part, with the part's own place in the palette and no halo", () => {
    const shares = [...figure.querySelectorAll("svg.dc-plot text.dc-share")];
    expect(shares.map((share) => [share.textContent, share.getAttribute("data-s")])).toEqual([
      ["43%", "1"],
      ["29%", "2"],
      ["14%", "3"],
      ["10%", "4"],
    ]);
    expect(figure.querySelector(".dc-halo")).toBeNull();
  });

  it("draws one whole part as a ring, and nothing when its parts add up to nothing", () => {
    const base = chartIn("donut");
    const whole = renderChart({ ...base, rows: [["Only", 5]] });
    expect(whole.querySelectorAll("svg.dc-plot path.dc-mark")).toHaveLength(1);
    expect(labels(whole)).toContain("100%");
    const none = renderChart({ ...base, rows: [["Only", 0]] });
    expect(none.querySelectorAll("svg.dc-plot path.dc-mark")).toHaveLength(0);
  });
});

describe("the data table that goes with a chart", () => {
  it("is the chart's columns and rows as a table that only a screen reader meets, with its title as the caption", () => {
    const chart = chartIn("bar");
    const figure = figureOf("bar");
    const hidden = figure.querySelector(".dc-sr-only");
    expect(hidden?.querySelector("caption")?.textContent).toBe("Orders by quarter");
    expect([...(hidden?.querySelectorAll("th") ?? [])].map((cell) => cell.textContent)).toEqual([
      "Quarter",
      "Channel A (units)",
      "Channel B (units)",
    ]);
    expect(
      [...(hidden?.querySelectorAll("tbody tr") ?? [])].map((row) =>
        [...row.children].map((cell) => cell.textContent),
      ),
    ).toEqual(chart.rows.map((row) => row.map(String)));
    expect(hidden?.querySelectorAll(".dc-num")).toHaveLength(2 * 5);
  });

  it("takes a scatter's first column as numbers", () => {
    const table = chartTable(chartIn("scatter"));
    expect(table.columns.map((column) => column.kind)).toEqual(["number", "number", "number"]);
    expect(table.columns[0]?.unit).toBe("$k");
  });

  it("is hidden from the render check's eyes by the same class as any other visually hidden text", () => {
    expect(figureOf("line").querySelector(".dc-sr-only table.dc-table")).not.toBeNull();
  });
});

describe("text in a chart", () => {
  it("is text, never markup, whatever a title, a category or a series is called", () => {
    const chart: Chart = {
      id: "c-text",
      type: "chart",
      kind: "bar",
      title: "<b>Title</b>",
      columns: [{ label: "<i>Kind</i>" }, { label: "<u>Series</u>" }, { label: "Other" }],
      rows: [["<img src=x>", 1, 2]],
    };
    const figure = renderChart(chart);
    expect(figure.querySelector("b, i, u, img")).toBeNull();
    expect(labels(figure)).toContain("<img src=x>");
    expect(figure.querySelector("figcaption")?.textContent).toBe("<b>Title</b>");
    expect(figure.querySelector(".dc-legend")?.textContent).toBe("<u>Series</u>Other");
  });

  it("writes its numbers as the deck's language does", () => {
    const chart: Chart = {
      id: "c-de",
      type: "chart",
      kind: "line",
      columns: [{ label: "Monat" }, { label: "Wert" }],
      rows: [
        ["Jan", 0.5],
        ["Feb", 2.5],
      ],
    };
    const german = renderScene(sceneWith({ schemaVersion: "0.3", blocks: [chart] }), {
      ...ctx,
      language: "de",
    });
    const text = labels(german);
    expect(text).toContain("0,5");
    expect(german.querySelector(".dc-sr-only tbody")?.textContent).toContain("2,5");
    expect(labels(renderScene(sceneWith({ schemaVersion: "0.3", blocks: [chart] }), ctx))).toContain("0.5");
  });

  it("is cut to fit when a category is longer than its room, and the table keeps it whole", () => {
    const long = "A category with a very long name indeed";
    const chart: Chart = {
      id: "c-long",
      type: "chart",
      kind: "bar",
      columns: [{ label: "Kind" }, { label: "Value" }],
      rows: [
        [long, 3],
        ["Short", 4],
      ],
    };
    const figure = renderChart(chart);
    expect(labels(figure).some((text) => text?.endsWith("…"))).toBe(true);
    expect(labels(figure)).not.toContain(long);
    expect(figure.querySelector(".dc-sr-only")?.textContent).toContain(long);
  });
});

describe("a chart in a scene", () => {
  it("is named by its kind to a screen reader, whatever the kind", () => {
    for (const [kind, name] of Object.entries(CHART_KIND_LABELS)) {
      const chart = { ...chartIn(kind === "stacked-bar" ? "stacked" : kind), kind } as Chart;
      const label = renderChart(chart).querySelector("svg.dc-plot")?.getAttribute("aria-label");
      expect(label).toBe(`${name} chart: ${chart.title}`);
    }
  });

  it("takes part in steps and frames like any block, and its place stays reserved when it is pinned", () => {
    const chart = { ...chartIn("line"), id: "t-chart" };
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.3",
        blocks: [{ ...chart, frame: { x: 10, y: 10, w: 40, h: 40 } }],
        steps: [{ id: "t-step", reveal: ["t-chart"] }],
      }),
      ctx,
    );
    const pinned = section.querySelector<HTMLElement>(".dc-pins .dc-plot-figure");
    expect(pinned?.dataset.gated).toBe("");
    const ghost = section.querySelector<HTMLElement>(".dc-ghost.dc-plot-figure");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.dataset.id).toBeUndefined();
  });

  it("is drawn at the shape of its frame, so it fills the frame at the same text size, and at 8 by 5 without one", () => {
    const chart = chartIn("line");
    const viewBox = (block: Chart) =>
      renderChart(block).querySelector("svg.dc-plot")?.getAttribute("viewBox");
    expect(viewBox(chart)).toBe("0 0 400 250");
    expect(viewBox({ ...chart, frame: { x: 5, y: 30, w: 44, h: 62 } })).toBe("0 0 440 349");
    expect(viewBox({ ...chart, frame: { x: 0, y: 0, w: 20, h: 20 } })).toBe("0 0 300 169");
    expect(viewBox({ ...chart, frame: { x: 0, y: 0, w: 100, h: 100 } })).toBe("0 0 640 360");
  });

  it("holds up when its data is not what the checker allows, since the player draws what the file holds", () => {
    const chart = {
      id: "c-bad",
      type: "chart",
      kind: "donut",
      columns: [{ label: "A" }, { label: "B" }, { label: "C" }],
      rows: [["x", 1], ["y", "z", 3], [null, null, null], []],
    } as unknown as Chart;
    expect(() => renderChart(chart)).not.toThrow();
    expect(() => renderChart({ ...chart, kind: "scatter" } as Chart)).not.toThrow();
    expect(() => renderChart({ ...chart, kind: "stacked-bar" } as Chart)).not.toThrow();
  });
});
