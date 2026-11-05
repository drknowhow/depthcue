import type { AuditBy, AuditEntry } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { AuditBook } from "./auditbook.ts";

export interface AuditPaneHooks {
  /** Shows a slide, and a block of it when there is one. */
  goTo(scene: string, block: string | undefined): void;
  /** The slide being edited, which "This slide" keeps. */
  current(): string | undefined;
  /** Whether the deck still has the slide, since an entry can name one that was deleted. */
  has(scene: string): boolean;
}

export interface AuditPane {
  readonly element: HTMLElement;
  /** Shows the pane and reads the log. */
  show(): void;
  hide(): void;
  /** Redraws from the book and the current slide. Does nothing while hidden. */
  render(): void;
}

const BY_WORDS: Record<AuditBy, string> = { you: "You", agent: "Agent", outside: "Outside" };
const BY_TITLES: Record<AuditBy, string> = {
  you: "Made in the editor",
  agent: "Made through the agent's tools",
  outside: "Made by editing the files, not through any tool",
};

function whenOf(entry: AuditEntry): HTMLElement {
  const date = new Date(entry.time);
  const text = Number.isNaN(date.getTime())
    ? entry.time
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return h("time", { class: "ed-ai-time", datetime: entry.time, title: entry.time }, text);
}

/**
 * The History list: what was done to the deck, by whom and where, newest first. "This slide" keeps the entries of the
 * slide being edited and follows it as the selection moves; "All slides" lists everything. An entry that names a slide
 * has a button that goes to it, and to the block when it names one.
 */
export function createAuditPane(book: AuditBook, hooks: AuditPaneHooks): AuditPane {
  let shown = false;
  let everywhere = false;
  let by: AuditBy | "" = "";
  let drawn = "";

  const here = h(
    "button",
    { type: "button", "data-action": "log-this-slide", "aria-pressed": "true" },
    "This slide",
  );
  const all = h(
    "button",
    { type: "button", "data-action": "log-all-slides", "aria-pressed": "false" },
    "All slides",
  );
  const who = h(
    "select",
    { "aria-label": "Show entries by", "data-action": "log-by" },
    h("option", { value: "" }, "Everyone"),
    h("option", { value: "you" }, "You"),
    h("option", { value: "agent" }, "Agent"),
    h("option", { value: "outside" }, "Outside"),
  ) as HTMLSelectElement;
  const empty = h("p", { class: "ed-review-empty ed-ai-empty" });
  const skipped = h("p", { class: "ed-ai-skipped", hidden: true });
  const list = h("ol", { class: "ed-ai-list" });
  const element = h(
    "section",
    { class: "ed-audit", "aria-label": "History", hidden: true },
    h("div", { class: "ed-ai-filters" }, h("div", { class: "ed-ai-scope" }, here, all), who),
    empty,
    list,
    skipped,
  );

  function rowOf(entry: AuditEntry): HTMLLIElement {
    const scene = entry.scene;
    const place =
      scene === undefined
        ? null
        : h(
            "button",
            {
              type: "button",
              class: "ed-ri-where",
              "data-action": "go-to-slide",
              title: hooks.has(scene) ? `Go to slide ${scene}` : `Slide ${scene} is no longer in the deck`,
              ...(hooks.has(scene) ? {} : { disabled: true }),
            },
            entry.block === undefined ? scene : `${scene} · ${entry.block}`,
          );
    place?.addEventListener("click", () => {
      if (scene !== undefined && hooks.has(scene)) hooks.goTo(scene, entry.block);
    });
    return h(
      "li",
      { class: "ed-ai", "data-id": entry.id, "data-by": entry.by, "data-kind": entry.kind },
      h(
        "div",
        { class: "ed-ri-head" },
        whenOf(entry),
        h("span", { class: "ed-ri-by ed-ai-by", title: BY_TITLES[entry.by] }, BY_WORDS[entry.by]),
        place,
      ),
      h("p", { class: "ed-ai-summary" }, entry.summary),
    ) as HTMLLIElement;
  }

  function render() {
    if (!shown) return;
    const { entries, skipped: lost, ready, problem } = book.state;
    const current = hooks.current();
    const rows = entries
      .filter(
        (entry) =>
          (everywhere || current === undefined || entry.scene === current) && (by === "" || entry.by === by),
      )
      .reverse();
    const key = JSON.stringify([ready, problem, lost, everywhere, by, current, rows.map((row) => row.id)]);
    if (key === drawn) return;
    drawn = key;
    here.setAttribute("aria-pressed", String(!everywhere));
    all.setAttribute("aria-pressed", String(everywhere));
    empty.hidden = rows.length > 0;
    empty.textContent = problem
      ? `The history cannot be read. ${problem}`
      : !ready
        ? "Reading the history…"
        : entries.length === 0
          ? "Nothing has been logged yet. Edits, comments and reviews are listed here."
          : everywhere || current === undefined
            ? "Nothing matches."
            : `Nothing has happened on slide ${current} yet.`;
    skipped.hidden = lost === 0;
    skipped.textContent =
      lost === 0 ? "" : `${lost} ${lost === 1 ? "line" : "lines"} of the log could not be read.`;
    list.replaceChildren(...rows.map(rowOf));
  }

  const scope = (value: boolean) => () => {
    everywhere = value;
    render();
  };
  here.addEventListener("click", scope(false));
  all.addEventListener("click", scope(true));
  who.addEventListener("change", () => {
    by = who.value as AuditBy | "";
    render();
  });

  return {
    element,
    show() {
      shown = true;
      element.hidden = false;
      drawn = "";
      render();
      void book.sync();
    },
    hide() {
      shown = false;
      element.hidden = true;
    },
    render,
  };
}
