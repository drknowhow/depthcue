import type { ApplyOptions, Op, Scene } from "@depthcue/core";
import { h } from "@depthcue/player";
import { createCanvas } from "./canvas.ts";
import { type Edits, problemOf } from "./fields.ts";
import { createInspector, LAYOUT_CHOICES } from "./inspector.ts";
import { sortable } from "./sortable.ts";
import type { DraftNotice, EditorStore } from "./store.ts";
import { type Layout, newScene } from "./templates.ts";

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
  /** The selected block of that scene, if any. */
  readonly blockId: string | undefined;
  select(sceneId: string): void;
  destroy(): void;
}

/**
 * Mounts the editor into `host`: a slim top bar, the scene strip, the selected scene filling the rest with its
 * text editable in place, and a details panel with every other property that stays closed until it is asked for.
 * All state lives in the store's session; this only reflects it and sends edits back through it.
 */
export function mountEditor(host: HTMLElement, store: EditorStore): Editor {
  const { session } = store;
  let selected = session.doc.deck.scenes[0] as string;
  let selectedBlock: string | undefined;
  // True while the inspector is applying a keystroke, so it is not rebuilt under the caret.
  let typingInInspector = false;
  let detailsOpen = false;

  const edits: Edits = {
    type(ops: readonly Op[], options?: ApplyOptions) {
      typingInInspector = true;
      try {
        return session.apply(ops, options);
      } finally {
        typingInInspector = false;
      }
    },
    act: (ops: readonly Op[], options?: ApplyOptions) => session.apply(ops, options),
  };

  const hint = h("p", { class: "ed-hint", "aria-live": "polite" });
  const canvas = createCanvas(session, {
    hint(text, problem) {
      hint.textContent = text;
      hint.toggleAttribute("data-problem", problem);
    },
    select: (id) => selectBlock(id),
  });
  const inspector = createInspector({
    session,
    edits,
    scene: () => selected,
    block: () => selectedBlock,
    selectBlock: (id) => selectBlock(id),
    selectScene: (id) => select(id),
    upload: (file) => store.upload(file),
  });

  const deckTitle = h("h1", { class: "ed-deck" });
  const status = h("span", { class: "ed-status", role: "status", "aria-live": "polite" });
  const undo = button("undo", "Undo", () => session.undo());
  const redo = button("redo", "Redo", () => session.redo());
  const save = button("save", "Save", () => void store.save(), { class: "ed-primary" });
  const details = button("details", "Details", () => setDetails(!detailsOpen), {
    "aria-expanded": "false",
    "aria-controls": "ed-details",
  });
  const present = h(
    "a",
    { class: "ed-link", href: "/present", target: "_blank", rel: "noopener" },
    "Present",
  );
  const bar = h(
    "header",
    { class: "ed-bar" },
    deckTitle,
    h("div", { class: "ed-actions" }, undo, redo, status, save, details, present),
  );
  const notices = h("div", { class: "ed-notices" });
  const sceneList = h("ol", { class: "ed-scene-list" });

  const layoutChoice = h(
    "select",
    { "aria-label": "Layout for the new scene", "data-field": "rail:layout" },
    ...LAYOUT_CHOICES.map((choice) => h("option", { value: choice.value }, choice.label)),
  );
  const railProblem = h("p", { class: "ed-problem", role: "alert", hidden: true });
  const addScene = button("add-scene", "Add scene", () => {
    const scene = newScene(session.doc, layoutChoice.value as Layout);
    const result = edits.act([{ op: "scene.add", scene, after: selected }]);
    railProblem.hidden = result.ok;
    railProblem.textContent = result.ok ? "" : problemOf(result);
    if (result.ok) select(scene.id);
  });
  const rail = h(
    "nav",
    { class: "ed-scenes", "aria-label": "Scenes" },
    sceneList,
    h("div", { class: "ed-add-scene" }, layoutChoice, addScene),
    railProblem,
  );
  const stage = h("main", { class: "ed-main", "aria-label": "Scene preview" }, canvas.element, hint);
  inspector.element.id = "ed-details";
  const root = h("div", { class: "ed-app" }, bar, notices, rail, stage, inspector.element);
  host.replaceChildren(root);

  /** The details panel holds every property the slide cannot edit yet. It stays closed so the slide gets the room. */
  function setDetails(open: boolean) {
    detailsOpen = open;
    root.dataset.details = open ? "open" : "closed";
    inspector.element.hidden = !open;
    details.setAttribute("aria-expanded", String(open));
  }
  setDetails(false);

  function renderScenes() {
    const { deck, scenes } = session.doc;
    const items = new Map<string, HTMLElement>();
    for (const [index, id] of deck.scenes.entries()) {
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
      items.set(id, h("li", {}, item));
    }
    sceneList.replaceChildren(...items.values());
    // `flex-direction` is "row" even on a grid, so it only counts when the list really is a flex container.
    const layout = getComputedStyle(sceneList);
    sceneList.dataset.axis =
      layout.display.includes("flex") && layout.flexDirection.startsWith("row") ? "x" : "y";
    sortable(sceneList, items, {
      ids: () => session.doc.deck.scenes,
      move: (id, after) => void edits.act([{ op: "scene.move", id, after }]),
    });
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

  /** Keeps the selection pointing at things that exist after the document changed under it. */
  function ensureSelection() {
    const ids = session.doc.deck.scenes;
    if (!ids.includes(selected)) {
      selected = (ids[0] as string) ?? selected;
      selectedBlock = undefined;
    }
    const blocks = session.doc.scenes[selected]?.blocks ?? [];
    if (selectedBlock !== undefined && !blocks.some((block) => block.id === selectedBlock)) {
      selectedBlock = undefined;
    }
  }

  function select(sceneId: string) {
    if (!session.doc.scenes[sceneId]) return;
    if (sceneId !== selected) selectedBlock = undefined;
    selected = sceneId;
    renderScenes();
    renderBar();
    canvas.render(selected, selectedBlock);
    inspector.render();
  }

  function selectBlock(id: string | undefined) {
    const blocks = session.doc.scenes[selected]?.blocks ?? [];
    const picked = blocks.find((block) => block.id === id);
    const next = picked ? id : undefined;
    canvas.mark(next);
    // Only text can be edited on the slide so far. Picking anything else opens the panel that edits it.
    if (picked && picked.type !== "text") setDetails(true);
    if (next === selectedBlock) return;
    selectedBlock = next;
    inspector.render();
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
    if (!canvas.typing) canvas.render(selected, selectedBlock);
    if (!typingInInspector) inspector.render();
  });
  const unsubscribeStore = store.subscribe(() => {
    renderBar();
    renderNotices();
  });

  renderScenes();
  renderBar();
  renderNotices();
  canvas.render(selected, selectedBlock);
  inspector.render();

  return {
    get sceneId() {
      return selected;
    },
    get blockId() {
      return selectedBlock;
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
