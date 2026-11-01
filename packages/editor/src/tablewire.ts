import type { Scene, Session } from "@depthcue/core";
import { problemOf } from "./fields.ts";
import { createGrid, type Grid, type Spot } from "./grid.ts";
import { changesOf, gridOf, TABLE_LIMITS } from "./tablecells.ts";

export interface TableHooks {
  /** A cell was pressed or has the keyboard: choose its block. */
  select(id: string): void;
  /** Esc on a cell that is not being edited: the keyboard goes back to the block. */
  leave(id: string): void;
  /** Says why a change was refused or what a paste left out, or clears the message when `text` is empty. */
  hint(text: string, problem: boolean): void;
  /** Runs a change that must not redraw the slide, which would take the keyboard away from the cell. */
  quietly(change: () => void): void;
  /** A table grew or shrank, so anything placed against it should move. */
  changed(): void;
}

/**
 * Puts a grid in the place of the player's static table, for each table of the scene drawn in `root`. The caption stays,
 * so the title shows as it does to the audience. A cell edit is one `block.set` and so one step of Undo. The grid keeps
 * itself up to date after its own edits, so they do not redraw the slide; any other change to the deck does, and the
 * canvas draws new grids and puts the keyboard back on the cell it was on.
 */
export function wireTables(session: Session, scene: Scene, root: HTMLElement, hooks: TableHooks) {
  const grids = new Map<string, Grid>();
  for (const block of scene.blocks) {
    if (block.type !== "table") continue;
    const figure = [...root.querySelectorAll<HTMLElement>(".dc-block")].find(
      (node) => node.dataset.id === block.id,
    );
    const plain = figure?.querySelector("table.dc-table");
    if (!plain) continue;
    const id = block.id;
    const grid = createGrid({
      data: gridOf(block),
      limits: TABLE_LIMITS,
      header: block.header !== false,
      // The first column names its rows when it holds words. A column of numbers names nothing.
      rowHeaders: block.columns[0]?.kind !== "number",
      language: session.doc.deck.language,
      name: block.title ? `Table: ${block.title}` : "Table",
      change(next) {
        let problem: string | undefined;
        hooks.quietly(() => {
          const result = session.apply([{ op: "block.set", scene: scene.id, id, set: changesOf(next) }]);
          if (!result.ok) problem = problemOf(result);
        });
        if (problem === undefined) hooks.changed();
        return problem;
      },
      say: hooks.hint,
      chose: () => hooks.select(id),
      leave: () => hooks.leave(id),
    });
    const caption = plain.querySelector("caption");
    if (caption) grid.element.prepend(caption);
    plain.replaceWith(grid.element);
    grids.set(id, grid);
  }
  return grids;
}

/** The table cell that has the keyboard inside `root`, with the block it is in, so a redraw can put the keyboard back. */
export function cellFocus(root: ParentNode): { id: string; spot: Spot } | undefined {
  const active = document.activeElement;
  if (!(active instanceof Element) || !root.contains(active)) return undefined;
  const cell = active.closest<HTMLElement>("[data-cell]");
  const id = cell?.closest<HTMLElement>("[data-id]")?.dataset.id;
  if (!cell || id === undefined) return undefined;
  return { id, spot: { row: Number(cell.dataset.row), column: Number(cell.dataset.col) } };
}
