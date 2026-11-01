import type { BlockChanges } from "@depthcue/core";
import { h } from "@depthcue/player";
import { checkField, textField } from "./fields.ts";
import { form, type Panel, type PanelHost } from "./panels.ts";
import { cellChange, changesOf, gridOf, type TableBlock } from "./tablecells.ts";

const optional = (value: string) => (value === "" ? null : value);

/**
 * A table's title, its header row, and what each column holds: words or numbers, and the unit of a number column. The
 * cells are typed into on the slide, and the rows and columns are added and taken away from the menu of a cell, so
 * this is for what the slide does not show: a title, and a unit that sits in the header.
 */
export function tablePanel(host: PanelHost, sceneId: string, id: string): Panel {
  const table = (): TableBlock | undefined => {
    const block = host.scene(sceneId)?.blocks.find((candidate) => candidate.id === id);
    return block?.type === "table" ? block : undefined;
  };
  const set = (changes: BlockChanges) => ({ op: "block.set" as const, scene: sceneId, id, set: changes });
  const key = (name: string) => `table:${name}`;

  const panel = form(
    () => table() !== undefined,
    () => {
      const current = table();
      const columns = h("div", { class: "ed-rows ed-table-cols", role: "group", "aria-label": "Columns" });
      current?.columns.forEach((column, index) => {
        const name = `Column ${index + 1}`;
        const kind = h(
          "select",
          { "aria-label": `${name} holds`, "data-field": key(`col${index}:kind`) },
          h("option", { value: "text" }, "Words"),
          h("option", { value: "number" }, "Numbers"),
        );
        kind.value = column.kind === "number" ? "number" : "text";
        kind.addEventListener("change", () => {
          const live = table();
          if (!live) return;
          const result = cellChange(live, "kind", { row: 0, column: index }, host.deck().language);
          // A column that holds words that are not numbers cannot be made one, and the cells say which.
          if ("problem" in result) {
            host.problem(result.problem);
            kind.value = live.columns[index]?.kind === "number" ? "number" : "text";
            return;
          }
          host.run([set(result.set)]);
        });
        columns.append(
          h(
            "div",
            { class: "ed-table-col" },
            h("span", { class: "ed-table-name" }, column.label),
            kind,
            column.kind === "number"
              ? textField(host.edits, {
                  key: key(`col${index}:unit`),
                  label: `${name} unit`,
                  bare: true,
                  placeholder: "Unit",
                  read: () => table()?.columns[index]?.unit ?? "",
                  commit(value) {
                    const live = table();
                    if (!live) return "This table is gone.";
                    const data = gridOf(live);
                    return set(
                      changesOf({
                        ...data,
                        columns: data.columns.map((one, at) =>
                          at === index
                            ? { ...one, unit: value.trim() === "" ? undefined : value.trim() }
                            : one,
                        ),
                      }),
                    );
                  },
                })
              : h("span", { class: "ed-table-nounit" }),
          ),
        );
      });
      return [
        textField(host.edits, {
          key: key("title"),
          label: "Title",
          hint: "Shown above the table, and read first by a screen reader.",
          read: () => table()?.title ?? "",
          commit: (value) => set({ title: optional(value) }),
        }),
        checkField(host.edits, {
          key: key("header"),
          label: "Header row",
          items: [{ id: "header", label: "Show the column labels as a header row" }],
          read: () => (table()?.header === false ? [] : ["header"]),
          commit: (ids) => set({ header: ids.length > 0 ? null : false }),
        }),
        columns,
      ];
    },
  );

  return {
    name: "table",
    label: "Table",
    title: "Table title and columns",
    body: panel.body,
    fill: panel.fill,
  };
}
