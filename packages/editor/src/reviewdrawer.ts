import type { Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Outcome, ReviewBook } from "./reviewbook.ts";
import { type ChangeRow, rowOf } from "./reviewview.ts";

export interface ReviewDrawerHooks {
  /** Shows what a change is about: its scene, and its block when it has one. */
  goTo(scene: string, block: string | undefined): void;
  /** The drawer was closed by the key or its button, so the control that opened it can have the keyboard back. */
  closed(): void;
}

export interface ReviewDrawer {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Redraws the list from the book. Does nothing while the drawer is closed, and draws when it opens. */
  render(): void;
  destroy(): void;
}

const EMPTY = "Nothing to review. When an agent edits the deck, what it changed is listed here.";

/**
 * The changes since the deck was last reviewed, one row each: where it is, what it was and what it is, and the two
 * answers, Accept and Revert. It opens over the right of the stage and closes with Esc. Rows are drawn from the book on
 * every render, so an edit, an undo or the agent's next change shows at once.
 */
export function createReviewDrawer(
  session: Session,
  book: ReviewBook,
  hooks: ReviewDrawerHooks,
): ReviewDrawer {
  let open = false;
  let busy = false;
  let drawn = "";

  const count = h("span", { class: "ed-review-count" });
  const acceptAll = h("button", { type: "button", "data-action": "accept-all" }, "Accept all");
  const close = h("button", {
    type: "button",
    "data-action": "close-review",
    "aria-label": "Close the changes",
  });
  close.append(h("span", { class: "ed-icon ed-icon-close", "aria-hidden": "true" }));
  const problem = h("p", { class: "ed-problem ed-review-problem", role: "alert", hidden: true });
  const empty = h("p", { class: "ed-review-empty" });
  const list = h("ol", { class: "ed-review-list" });
  const element = h(
    "aside",
    { class: "ed-review", id: "ed-review", "aria-label": "Changes to review", tabindex: "-1", hidden: true },
    h("header", { class: "ed-review-head" }, h("h2", {}, "Changes"), count, acceptAll, close),
    problem,
    empty,
    list,
  );

  const show = (outcome: Outcome) => {
    problem.hidden = outcome.ok;
    problem.textContent = outcome.ok ? "" : outcome.message;
  };

  /** Runs an answer and shows what came of it. A second one waits for the first, so an accept is not asked twice. */
  function answer(run: () => Outcome | Promise<Outcome>) {
    if (busy) return;
    busy = true;
    const finish = (outcome: Outcome) => {
      busy = false;
      show(outcome);
      render();
    };
    try {
      const outcome = run();
      if (outcome instanceof Promise)
        void outcome.then(finish, (error: Error) => finish({ ok: false, message: error.message }));
      else finish(outcome);
    } catch (error) {
      finish({ ok: false, message: (error as Error).message });
    }
  }

  function rowElement(row: ChangeRow): HTMLLIElement {
    const { change } = row;
    const target = change.scene;
    const where =
      target === undefined
        ? h("span", { class: "ed-ri-where" }, row.where)
        : h("button", { type: "button", class: "ed-ri-where", "data-action": "show-change" }, row.where);
    where.addEventListener("click", () => {
      if (target !== undefined) hooks.goTo(target, change.block);
    });
    const diff = h("p", { class: "ed-df" });
    if (row.before !== undefined) diff.append(h("s", {}, row.before || "(empty)"));
    if (row.before !== undefined && row.after !== undefined) diff.append(" ");
    if (row.after !== undefined) diff.append(h("mark", {}, row.after || "(empty)"));
    const accept = h(
      "button",
      { type: "button", "data-action": "accept-change", "aria-label": `Accept: ${row.said}` },
      "Accept",
    );
    const revert = h(
      "button",
      { type: "button", "data-action": "revert-change", "aria-label": `Revert: ${row.said}` },
      "Revert",
    );
    accept.addEventListener("click", () => answer(() => book.accept([change.id])));
    revert.addEventListener("click", () => answer(() => book.revert([change.id])));
    return h(
      "li",
      { class: "ed-ri", "data-id": change.id, "data-by": change.by },
      h(
        "div",
        { class: "ed-ri-head" },
        where,
        change.by === "outside"
          ? h(
              "span",
              { class: "ed-ri-by", title: "Made by editing the files, not through the agent's tools" },
              "Outside",
            )
          : null,
      ),
      diff,
      h("div", { class: "ed-acts" }, accept, revert),
    );
  }

  function render() {
    if (!open) return;
    const { problem: unreadable, ready } = book.state;
    const rows = book.changes().map((change) => rowOf(change, session.doc));
    // Redrawing the same rows would drop the keyboard from the button that has it, so it is skipped.
    const key = JSON.stringify([
      unreadable,
      ready,
      rows.map((row) => [row.change.id, row.change.by, row.where, row.before, row.after]),
    ]);
    if (key === drawn) return;
    drawn = key;
    const held = document.activeElement;
    const was =
      held instanceof HTMLElement && list.contains(held)
        ? {
            id: held.closest("li")?.getAttribute("data-id"),
            action: held.getAttribute("data-action"),
            at: [...list.children].indexOf(held.closest("li") as Element),
          }
        : undefined;

    count.textContent = rows.length > 0 ? `${rows.length}` : "";
    acceptAll.toggleAttribute("disabled", rows.length === 0);
    empty.hidden = rows.length > 0;
    empty.textContent = unreadable
      ? `The review cannot be read. ${unreadable}`
      : ready
        ? EMPTY
        : "Reading the review…";
    list.replaceChildren(...rows.map(rowElement));

    if (was) {
      // The row that had the keyboard may be gone, because it was just answered: the one that took its place gets it.
      const same = was.id
        ? list.querySelector(`[data-id="${CSS.escape(was.id)}"] [data-action="${was.action}"]`)
        : null;
      const next = (
        list.children[Math.min(was.at, list.children.length - 1)] as HTMLElement | undefined
      )?.querySelector<HTMLElement>("[data-action='accept-change']");
      ((same as HTMLElement | null) ?? next ?? close).focus({ preventScroll: true });
    } else if (document.activeElement === acceptAll && rows.length === 0) {
      close.focus({ preventScroll: true }); // the button that had the keyboard has nothing left to accept
    }
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    drawer.close();
    hooks.closed();
  }

  close.addEventListener("click", () => {
    drawer.close();
    hooks.closed();
  });
  acceptAll.addEventListener("click", () => answer(() => book.accept("all")));

  const drawer: ReviewDrawer = {
    element,
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      element.hidden = false;
      drawn = "";
      problem.hidden = true;
      document.addEventListener("keydown", onKey);
      render();
      element.focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      open = false;
      element.hidden = true;
      document.removeEventListener("keydown", onKey);
    },
    toggle() {
      if (open) drawer.close();
      else drawer.open();
    },
    render,
    destroy() {
      drawer.close();
      element.remove();
    },
  };
  return drawer;
}
