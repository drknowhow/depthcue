import type { BlockChanges, ChartBlock } from "@depthcue/core";
import { h } from "@depthcue/player";
import { CHART_LIMITS, changesOf, type DataAction, dataChange, gridOf } from "./chartwire.ts";
import { actionButton, problemOf, textField } from "./fields.ts";
import { createGrid, type Grid } from "./grid.ts";
import { form, type Panel, type PanelHost } from "./panels.ts";

const optional = (value: string) => (value === "" ? null : value);

/**
 * A chart's data: its title and unit, and the grid that edits its categories and series, the one that edits a table. The
 * first column names the rows and each column after it is a series. A cell edit, a paste, and each button is one
 * `block.set`, so one step of Undo; one the core refuses is said in the grid's own words, with the fix. The grid keeps
 * itself up to date after its own edits, and is drawn again from the deck after anything else: Undo, or an agent's change.
 */
export function dataPanel(host: PanelHost, sceneId: string, id: string): Panel {
  const chart = (): ChartBlock | undefined => {
    const block = host.scene(sceneId)?.blocks.find((candidate) => candidate.id === id);
    return block?.type === "chart" ? block : undefined;
  };
  const set = (changes: BlockChanges) => ({ op: "block.set" as const, scene: sceneId, id, set: changes });
  const key = (name: string) => `data:${name}`;

  const slot = h("div", { class: "ed-chart-grid" });
  let grid: Grid | undefined;
  /** Whether the grid was made for a scatter, whose first column holds numbers and names no rows. */
  let scatter = false;

  function mount(block: ChartBlock) {
    grid?.destroy();
    scatter = block.kind === "scatter";
    grid = createGrid({
      data: gridOf(block),
      limits: CHART_LIMITS,
      header: true,
      rowHeaders: !scatter,
      language: host.deck().language,
      name: block.title ? `Chart data: ${block.title}` : "Chart data",
      change(next) {
        const result = host.edits.act([set(changesOf(next))]);
        return result.ok ? undefined : problemOf(result);
      },
      say: (text, problem) => host.problem(problem ? text : undefined),
    });
    slot.replaceChildren(grid.element);
  }

  const top = form(
    () => chart() !== undefined,
    () => [
      textField(host.edits, {
        key: key("title"),
        label: "Title",
        read: () => chart()?.title ?? "",
        commit: (value) => set({ title: optional(value) }),
      }),
      textField(host.edits, {
        key: key("unit"),
        label: "Unit",
        hint: "Short, such as % or ms.",
        read: () => chart()?.unit ?? "",
        commit: (value) => set({ unit: optional(value) }),
      }),
    ],
  );

  const tool = (action: DataAction, label: string) =>
    actionButton(
      label,
      () => {
        const block = chart();
        if (!block || !grid) return;
        const result = dataChange(block, action, grid.active);
        if ("problem" in result) {
          host.problem(result.problem);
          return;
        }
        if (host.run([set(result.set)])) grid.focus(result.focus);
      },
      { "data-chart": action },
    );

  const first = chart();
  if (first) mount(first);

  return {
    name: "data",
    label: "Data",
    title: "Chart data",
    body: h(
      "div",
      { class: "ed-chart-data" },
      top.body,
      slot,
      h(
        "div",
        { class: "ed-row" },
        tool("row", "Add row"),
        tool("series", "Add series"),
        tool("delete-row", "Delete row"),
        tool("delete-series", "Delete series"),
      ),
    ),
    fill(scene, typing) {
      top.fill(scene, typing);
      const block = chart();
      if (!block || typing) return;
      if (!grid || scatter !== (block.kind === "scatter")) mount(block);
      else if (!grid.editing) grid.set(gridOf(block), true);
    },
  };
}
