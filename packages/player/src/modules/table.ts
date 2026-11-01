import type { HydrateContext, ModuleInstance } from "../modules.ts";

function asRow(args: unknown, count: number): number {
  const row = (args as { row?: unknown } | null)?.row;
  if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row >= count) {
    throw new Error(`highlight needs {"row": a whole number from 0 to ${count - 1}}.`);
  }
  return row;
}

/**
 * Lets a presenter, or an agent holding the lease, point at one row of the table: the row under the pointer is marked,
 * and the highlight command marks one and reads it out. The table stays the source of truth, so a failure here leaves a
 * table that reads correctly.
 */
export function hydrate({ block, node, announce }: HydrateContext): ModuleInstance {
  if (block.type !== "table") throw new Error("The table module only takes table blocks.");
  const body = node.querySelector<HTMLTableSectionElement>("table.dc-table tbody");
  // `children` rather than `rows`: a table section's rows are its element children, and every DOM has them.
  const rows = body ? ([...body.children] as HTMLElement[]) : [];
  if (!body || rows.length !== block.rows.length) throw new Error("The table does not match its data.");
  const controller = new AbortController();
  const on = { signal: controller.signal };

  function mark(index: number | undefined) {
    for (const [at, row] of rows.entries()) {
      row.toggleAttribute("data-active", at === index);
      if (at === index) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
    node.toggleAttribute("data-table-active", index !== undefined);
  }

  const rowOf = (target: EventTarget | null) => {
    const at = target instanceof Element ? rows.indexOf(target.closest("tr") as HTMLElement) : -1;
    return at >= 0 ? at : undefined;
  };
  body.addEventListener("pointerover", (event) => mark(rowOf(event.target)), on);
  body.addEventListener("pointerleave", () => mark(undefined), on);

  return {
    commands: {
      highlight(args) {
        const at = asRow(args, rows.length);
        mark(at);
        announce(
          `Row ${at + 1}: ${[...(rows[at]?.children ?? [])].map((cell) => cell.textContent).join(", ")}`,
        );
      },
      clear: () => mark(undefined),
    },
    dispose() {
      controller.abort();
      mark(undefined);
    },
  };
}
