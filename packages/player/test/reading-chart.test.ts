// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Block, Deck, Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { CHART_KIND_LABELS } from "../src/charts/draw.ts";
import { renderReading } from "../src/reading.ts";
import { sceneWith } from "./helpers.ts";

type Chart = Extract<Block, { type: "chart" }>;

const chartsDir = resolve(import.meta.dirname, "../../../fixtures/decks/charts");
const read = (path: string) => JSON.parse(readFileSync(join(chartsDir, path), "utf8"));
const deck = read("deck.json") as Deck;
const ctx = { assetBase: ".", language: "en" };

/** What the reading view shows of a scene's charts: each table's caption, column headings and rows, as text. */
function tablesOf(scene: Scene) {
  const reading = renderReading(deck, [scene], ctx);
  return [...reading.querySelectorAll("figure.dc-figure table.dc-table")].map((table) => ({
    caption: table.querySelector("caption")?.textContent,
    heads: [...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
    rows: [...table.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
    ),
  }));
}

describe("a chart in the reading view", () => {
  it("reads every chart of the charts deck as its data: title, a column per series and a row per point", () => {
    const files = readdirSync(join(chartsDir, "scenes")).filter((name) => name.endsWith(".json"));
    let seen = 0;
    for (const file of files) {
      const scene = read(`scenes/${file}`) as Scene;
      const charts = scene.blocks.filter((block): block is Chart => block.type === "chart");
      if (charts.length === 0) continue;
      const tables = tablesOf(scene);
      expect(tables, file).toHaveLength(charts.length);
      charts.forEach((chart, at) => {
        const table = tables[at];
        expect(table?.caption, file).toBe(chart.title);
        expect(
          table?.heads.map((head) => head?.replace(/ \(.*\)$/, "")),
          file,
        ).toEqual(chart.columns.map((column) => column.label));
        expect(table?.rows, file).toHaveLength(chart.rows.length);
        expect(table?.rows[0]?.[0], file).toBe(String(chart.rows[0]?.[0] ?? ""));
      });
      seen += charts.length;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("has a reading form for every kind of chart", () => {
    for (const kind of Object.keys(CHART_KIND_LABELS) as Array<Chart["kind"]>) {
      const chart = {
        id: "c",
        type: "chart",
        kind,
        title: `A ${kind} chart`,
        columns: [{ label: "Month" }, { label: "Ships", unit: "ships" }, { label: "Barges" }],
        rows: [
          [1, 4, 2],
          [2, 6, 3],
        ],
      } as Chart;
      const tables = tablesOf(sceneWith({ schemaVersion: "0.3", blocks: [chart] }));
      expect(tables, kind).toEqual([
        {
          caption: `A ${kind} chart`,
          heads: ["Month", "Ships (ships)", "Barges"],
          rows: [
            ["1", "4", "2"],
            ["2", "6", "3"],
          ],
        },
      ]);
    }
  });
});
