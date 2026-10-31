import { h } from "../dom.ts";
import type { HydrateContext, ModuleInstance } from "../modules.ts";
import { unitText } from "../scene.ts";

const SUFFIXES = ["th", "st", "nd", "rd"] as const;

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 21st. */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : (SUFFIXES[n % 10 > 3 ? 0 : n % 10] ?? "th")}`;
}

function asRow(args: unknown, count: number): number {
  const row = (args as { row?: unknown } | null)?.row;
  if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row >= count) {
    throw new Error(`highlight needs {"row": a whole number from 0 to ${count - 1}}.`);
  }
  return row;
}

/**
 * Makes the static bar-chart table explorable: hover, focus or a command marks a row and reads out its value
 * and rank, the up and down arrows move between rows, and a button orders the rows by value. The table stays
 * the source of truth, so a failure here leaves a chart that reads correctly.
 */
export function hydrate({ block, node }: HydrateContext): ModuleInstance {
  if (block.type !== "bar-chart") throw new Error("The chart module only takes bar-chart blocks.");
  const data = block.data;
  const table = node.querySelector<HTMLTableElement>("table.dc-chart");
  const found = table?.tBodies[0];
  if (!table || !found || found.children.length !== data.length) {
    throw new Error("The chart's table does not match its data.");
  }
  const body: HTMLTableSectionElement = found;

  // `children` rather than `rows`: a table section's rows are its element children, and every DOM has them.
  const rows = [...body.children] as HTMLTableRowElement[];
  const unit = unitText(block.unit);
  const rank = (index: number) => 1 + data.filter((row) => row.value > (data[index]?.value ?? 0)).length;
  const controller = new AbortController();
  const on = { signal: controller.signal };

  let active: number | undefined;
  let sorted = false;
  let fromPointer = false;

  const readout = h("p", { class: "dc-chart-readout", "aria-live": "polite" });
  const sortButton = h(
    "button",
    { type: "button", class: "dc-chip", "aria-pressed": "false", "data-chart": "sort" },
    "Sort by value",
  );
  const tools = h("div", { class: "dc-chart-tools" }, sortButton, readout);
  node.append(tools);

  /** One row is a tab stop, the rest are reached with the arrow keys. */
  function roving() {
    for (const [at, row] of ([...body.children] as HTMLElement[]).entries()) row.tabIndex = at === 0 ? 0 : -1;
  }

  function mark(index: number | undefined) {
    active = index;
    for (const [at, row] of rows.entries()) {
      if (at === index) {
        row.dataset.active = "";
        row.setAttribute("aria-current", "true");
      } else {
        delete row.dataset.active;
        row.removeAttribute("aria-current");
      }
    }
    if (index === undefined) {
      delete node.dataset.chartActive;
      readout.textContent = "";
      return;
    }
    node.dataset.chartActive = "";
    readout.textContent = describe(index);
  }

  function describe(index: number): string {
    const row = data[index];
    return `${row?.label}: ${row?.value}${unit}. ${ordinal(rank(index))} of ${data.length}.`;
  }

  function sortBy(by: "value" | "original") {
    sorted = by === "value";
    // Moving a focused row in the DOM blurs it, which would drop the keyboard out of the chart.
    const focused = body.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const next = sorted
      ? rows
          .map((row, index) => ({ row, index }))
          .sort((a, b) => (data[b.index]?.value ?? 0) - (data[a.index]?.value ?? 0) || a.index - b.index)
          .map((entry) => entry.row)
      : rows;
    body.append(...next);
    focused?.focus({ preventScroll: true });
    sortButton.setAttribute("aria-pressed", String(sorted));
    roving();
    const note = sorted ? "Largest first." : "In the order given.";
    readout.textContent = active === undefined ? note : `${note} ${describe(active)}`;
  }

  const indexOf = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest("tr") : null;
    const at = row ? rows.indexOf(row) : -1;
    return at >= 0 ? at : undefined;
  };

  table.addEventListener(
    "pointerover",
    (event) => {
      const at = indexOf(event.target);
      if (at === undefined) return;
      fromPointer = true;
      mark(at);
    },
    on,
  );
  table.addEventListener(
    "pointerleave",
    () => {
      if (fromPointer) mark(undefined);
      fromPointer = false;
    },
    on,
  );
  table.addEventListener(
    "focusin",
    (event) => {
      const at = indexOf(event.target);
      if (at === undefined) return;
      fromPointer = false;
      mark(at);
    },
    on,
  );
  table.addEventListener(
    "focusout",
    (event) => {
      if (!(event.relatedTarget instanceof Node) || !table.contains(event.relatedTarget)) mark(undefined);
    },
    on,
  );
  table.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const shown = [...body.children] as HTMLElement[];
        const at = Math.max(0, shown.indexOf(event.target as HTMLTableRowElement));
        const step = event.key === "ArrowDown" ? 1 : -1;
        // Past either end there is no row, and focus stays where it is.
        shown[at + step]?.focus();
      } else if (event.key === "s") {
        sortBy(sorted ? "original" : "value");
      } else if (event.key === "Escape" && active !== undefined) {
        mark(undefined);
      } else {
        // Anything else is the player's: Left and Right change scenes, for one.
        return;
      }
      event.preventDefault();
    },
    on,
  );
  sortButton.addEventListener("click", () => sortBy(sorted ? "original" : "value"), on);

  roving();

  return {
    commands: {
      highlight: (args) => mark(asRow(args, data.length)),
      sort: (args) => {
        const by = (args as { by?: unknown } | null)?.by;
        if (by !== "value" && by !== "original") {
          throw new Error('sort needs {"by": "value"} or {"by": "original"}.');
        }
        sortBy(by);
      },
      clear: () => mark(undefined),
    },
    dispose() {
      controller.abort();
      body.append(...rows);
      for (const row of rows) {
        row.removeAttribute("tabindex");
        row.removeAttribute("aria-current");
        delete row.dataset.active;
      }
      delete node.dataset.chartActive;
      tools.remove();
    },
  };
}
