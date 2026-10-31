import { afterWhenDropping } from "./cleanup.ts";

export interface SortableOptions {
  /** The ids in their current order. */
  ids(): readonly string[];
  /** Called once when an item is released somewhere that changes the order. */
  move(id: string, after: string | null): void;
}

/**
 * Lets the items of a list be dragged into a new order. `item` is the list entry for an id; it is made
 * draggable, shows where the drop will land, and reports the result as "put `id` after `after`". Buttons stay the
 * way to reorder from the keyboard, so nothing depends on dragging.
 */
export function sortable(
  list: HTMLElement,
  items: ReadonlyMap<string, HTMLElement>,
  options: SortableOptions,
) {
  let dragging: string | undefined;

  const clear = () => {
    for (const node of items.values()) {
      node.removeAttribute("data-dragging");
      node.removeAttribute("data-drop");
    }
  };
  const halfOf = (node: HTMLElement, event: DragEvent): "upper" | "lower" => {
    const box = node.getBoundingClientRect();
    const horizontal = list.dataset.axis === "x";
    const before = horizontal
      ? event.clientX < box.left + box.width / 2
      : event.clientY < box.top + box.height / 2;
    return before ? "upper" : "lower";
  };

  for (const [id, node] of items) {
    node.draggable = true;
    node.addEventListener("dragstart", (event) => {
      dragging = id;
      node.setAttribute("data-dragging", "");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }
    });
    node.addEventListener("dragover", (event) => {
      if (dragging === undefined || dragging === id) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      for (const other of items.values()) if (other !== node) other.removeAttribute("data-drop");
      node.setAttribute("data-drop", halfOf(node, event));
    });
    node.addEventListener("drop", (event) => {
      if (dragging === undefined) return;
      event.preventDefault();
      const moved = dragging;
      const half = halfOf(node, event);
      dragging = undefined;
      clear();
      const after = afterWhenDropping(options.ids(), moved, id, half);
      if (after !== undefined) options.move(moved, after);
    });
    node.addEventListener("dragleave", (event) => {
      if (!node.contains(event.relatedTarget as Node | null)) node.removeAttribute("data-drop");
    });
    node.addEventListener("dragend", () => {
      dragging = undefined;
      clear();
    });
  }
}
