import type { Scene } from "@depthcue/core";
import { h } from "@depthcue/player";
import { createCanvas } from "./canvas.ts";
import type { DraftNotice, EditorStore } from "./store.ts";

const LEAD = { human: "Human", agent: "Agent", shared: "Shared" } as const;

const SAVE_LABEL = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Not saved",
} as const;

function button(action: string, label: string, onClick: () => void, extra: Record<string, string> = {}) {
  const node = h("button", { type: "button", "data-action": action, ...extra }, label);
  node.addEventListener("click", onClick);
  return node;
}

export interface Editor {
  /** The scene being edited. */
  readonly sceneId: string;
  select(sceneId: string): void;
  destroy(): void;
}

/**
 * Mounts the editor into `host`: a top bar, the scene list, and the selected scene with its text editable in
 * place. All state lives in the store's session; this only reflects it and sends edits back through it.
 */
export function mountEditor(host: HTMLElement, store: EditorStore): Editor {
  const { session } = store;
  let selected = session.doc.deck.scenes[0] as string;

  const hint = h("p", { class: "ed-hint", "aria-live": "polite" });
  const canvas = createCanvas(session, {
    hint(text, problem) {
      hint.textContent = text;
      hint.toggleAttribute("data-problem", problem);
    },
  });

  const deckTitle = h("h1", { class: "ed-deck" });
  const status = h("span", { class: "ed-status", role: "status", "aria-live": "polite" });
  const undo = button("undo", "Undo", () => session.undo());
  const redo = button("redo", "Redo", () => session.redo());
  const save = button("save", "Save", () => void store.save(), { class: "ed-primary" });
  const present = h(
    "a",
    { class: "ed-link", href: "/present", target: "_blank", rel: "noopener" },
    "Present",
  );
  const bar = h(
    "header",
    { class: "ed-bar" },
    deckTitle,
    h("div", { class: "ed-actions" }, undo, redo, status, save, present),
  );
  const notices = h("div", { class: "ed-notices" });
  const sceneList = h("ol", { class: "ed-scene-list" });
  const rail = h("nav", { class: "ed-scenes", "aria-label": "Scenes" }, sceneList);
  const stage = h("main", { class: "ed-main", "aria-label": "Scene preview" }, canvas.element, hint);
  const root = h("div", { class: "ed-app" }, bar, notices, rail, stage);
  host.replaceChildren(root);

  function renderScenes() {
    const { deck, scenes } = session.doc;
    sceneList.replaceChildren(
      ...deck.scenes.map((id, index) => {
        const scene = scenes[id] as Scene;
        const item = h(
          "button",
          {
            type: "button",
            class: "ed-scene",
            "data-scene": id,
            "aria-current": id === selected ? "true" : "false",
          },
          h("span", { class: "ed-num" }, String(index + 1)),
          h("span", { class: "ed-title" }, scene.title),
          h("span", { class: "ed-lead", "data-lead": scene.lead ?? "human" }, LEAD[scene.lead ?? "human"]),
        );
        item.addEventListener("click", () => select(id));
        return h("li", {}, item);
      }),
    );
  }

  function renderBar() {
    const { deck } = session.doc;
    deckTitle.textContent = deck.title;
    document.title = `${deck.title} · Depthcue editor`;
    const state = store.status;
    undo.toggleAttribute("disabled", !session.canUndo);
    redo.toggleAttribute("disabled", !session.canRedo);
    save.toggleAttribute(
      "disabled",
      state.save === "saved" || state.save === "saving" || state.conflict !== undefined,
    );
    save.textContent = state.save === "saving" ? "Saving…" : "Save";
    status.dataset.state = state.save;
    status.textContent =
      state.save === "error"
        ? (state.message ?? SAVE_LABEL.error)
        : state.message
          ? `${SAVE_LABEL[state.save]}. ${state.message}`
          : SAVE_LABEL[state.save];
    present.setAttribute("href", `/present#/${encodeURIComponent(selected)}`);
  }

  function renderNotices() {
    const { conflict, draft } = store.status;
    const rows: HTMLElement[] = [];
    if (conflict) {
      rows.push(
        notice(
          "conflict",
          "The files changed on disk while you had unsaved edits. Choose which version to keep.",
          button("take-disk", "Load the disk version", () => void store.takeDisk()),
          button("keep-mine", "Keep mine and save", () => void store.keepMine()),
        ),
      );
    }
    if (draft) rows.push(draftNotice(draft));
    notices.replaceChildren(...rows);
  }

  function notice(kind: string, text: string, ...actions: HTMLElement[]) {
    return h("div", { class: "ed-notice", "data-kind": kind, role: "alert" }, h("p", {}, text), ...actions);
  }

  function draftNotice(draft: DraftNotice) {
    const when = draft.savedAt ? ` (${new Date(draft.savedAt).toLocaleString()})` : "";
    const text = `${draft.message}${draft.kind === "unusable" ? "" : when}`;
    if (draft.kind === "stale") {
      return notice(
        "draft",
        text,
        button("use-draft", "Use the draft", () => store.useDraft()),
        button("discard-draft", "Discard the draft", () => void store.discardDraft()),
      );
    }
    if (draft.kind === "restored") {
      return notice(
        "draft",
        text,
        button("discard-draft", "Discard the draft", () => void store.discardDraft()),
        button("dismiss", "Keep editing", () => store.dismissNotice()),
      );
    }
    return notice(
      "draft",
      text,
      button("dismiss", "OK", () => store.dismissNotice()),
    );
  }

  function ensureSelection() {
    const ids = session.doc.deck.scenes;
    if (!ids.includes(selected)) selected = (ids[0] as string) ?? selected;
  }

  function select(sceneId: string) {
    if (!session.doc.scenes[sceneId]) return;
    selected = sceneId;
    renderScenes();
    renderBar();
    canvas.render(selected);
  }

  const onKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void store.save();
    } else if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) session.redo();
      else session.undo();
    } else if (key === "y") {
      event.preventDefault();
      session.redo();
    }
  };
  document.addEventListener("keydown", onKey);

  const unsubscribeSession = session.subscribe(() => {
    ensureSelection();
    renderScenes();
    renderBar();
    if (!canvas.typing) canvas.render(selected);
  });
  const unsubscribeStore = store.subscribe(() => {
    renderBar();
    renderNotices();
  });

  renderScenes();
  renderBar();
  renderNotices();
  canvas.render(selected);

  return {
    get sceneId() {
      return selected;
    },
    select,
    destroy() {
      document.removeEventListener("keydown", onKey);
      unsubscribeSession();
      unsubscribeStore();
      host.replaceChildren();
    },
  };
}
