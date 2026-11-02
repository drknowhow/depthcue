import { acceptChanges, revertChanges, revertOps, type Session } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { Outcome, ReviewBook } from "./reviewbook.ts";
import { BRAND_CHANGE, type ChangeRow, rowOf } from "./reviewview.ts";

/**
 * The refusals that come of a template, a style, the brand or a brand file being in a change that was not chosen: a
 * brand.json that names a font, say, accepted without the font's own change.
 */
const WAITS = /^(unknown-(template|style)|no-brand|missing-brand-file)$/;

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
  const together = h("div", { class: "ed-review-together", hidden: true });
  const empty = h("p", { class: "ed-review-empty" });
  const list = h("ol", { class: "ed-review-list" });
  const element = h(
    "aside",
    { class: "ed-review", id: "ed-review", "aria-label": "Changes to review", tabindex: "-1", hidden: true },
    h("header", { class: "ed-review-head" }, h("h2", {}, "Changes"), count, acceptAll, close),
    problem,
    together,
    empty,
    list,
  );

  const show = (outcome: Outcome) => {
    const said = outcome.ok ? leftWords(outcome.left ?? []) : outcome.message;
    problem.hidden = said === "";
    problem.textContent = said;
    together.hidden = true;
  };

  /**
   * Why a revert left changes as they were, in core's words, which the command line prints too: a brand file's change,
   * or one that names a file that is gone. Each is named by its row when there is more than one.
   */
  function leftWords(ids: readonly string[]): string {
    const { review } = book.state;
    const said = ids.length > 0 && review ? revertChanges(review, session.doc, ids) : undefined;
    if (!said?.ok) return "";
    const rows = new Map(book.changes().map((change) => [change.id, change]));
    return said.left
      .map(({ id, why }) => {
        const change = rows.get(id);
        return said.left.length > 1 && change ? `${rowOf(change, session.doc).where}: ${why}` : why;
      })
      .join(" ");
  }

  /**
   * After an answer to one change was refused for want of a template, a style or the brand, the changes of the brand's
   * files nobody has chosen yet, which it may be waiting for, as the command line names them, with the answer that takes
   * them all at once.
   */
  function offerTogether(kind: "accept" | "revert", id: string) {
    const { review } = book.state;
    if (!review) return;
    const tried = (kind === "accept" ? acceptChanges : revertOps)(review, session.doc, [id]);
    if (tried.ok || !tried.diagnostics.some((diagnostic) => WAITS.test(diagnostic.code))) return;
    const left = book.changes().filter((change) => change.id !== id && BRAND_CHANGE.test(change.id));
    if (left.length === 0) return;
    const ids = [id, ...left.map((change) => change.id)];
    const names = left.map((change) => rowOf(change, session.doc).where);
    const both = h(
      "button",
      { type: "button", "data-action": `${kind}-together` },
      kind === "accept" ? "Accept them together" : "Revert them together",
    );
    both.addEventListener("click", () => answer(() => book[kind](ids)));
    together.replaceChildren(
      h(
        "p",
        {},
        `It may be waiting for ${names.join(", ")}: choose ${left.length === 1 ? "both" : "them"} together.`,
      ),
      both,
    );
    together.hidden = false;
  }

  /** Runs an answer and shows what came of it. A second one waits for the first, so an accept is not asked twice. */
  function answer(run: () => Outcome | Promise<Outcome>, refused?: () => void) {
    if (busy) return;
    busy = true;
    const finish = (outcome: Outcome) => {
      busy = false;
      show(outcome);
      if (!outcome.ok) refused?.();
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
    accept.addEventListener("click", () =>
      answer(
        () => book.accept([change.id]),
        () => offerTogether("accept", change.id),
      ),
    );
    revert.addEventListener("click", () =>
      answer(
        () => book.revert([change.id]),
        () => offerTogether("revert", change.id),
      ),
    );
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
      together.hidden = true;
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
