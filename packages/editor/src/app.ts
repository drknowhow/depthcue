import type { ApplyOptions, Op } from "@depthcue/core";
import { h } from "@depthcue/player";
import { createAdder } from "./adder.ts";
import { createCanvas } from "./canvas.ts";
import { popoverChip } from "./chip.ts";
import { createCueBook } from "./cues.ts";
import type { Edits } from "./fields.ts";
import { deckPanel, panelHost } from "./panels.ts";
import { createQuickBar } from "./quickbar.ts";
import { createSceneBar } from "./scenebar.ts";
import type { DraftNotice, EditorStore } from "./store.ts";
import { createStrip } from "./strip.ts";
import { createToolbar } from "./toolbar.ts";

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

/** True when a key pressed on this element goes into text: a field, or text being edited on the slide. */
const typesInto = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;

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
 * text editable in place, and the rest of its properties in a toolbar over the chosen block, an add row under the
 * slide and the popovers of the top bar.
 * All state lives in the store's session; this only reflects it and sends edits back through it.
 */
export function mountEditor(host: HTMLElement, store: EditorStore): Editor {
  const { session } = store;
  let selected = session.doc.deck.scenes[0] as string;
  let selectedBlock: string | undefined;
  // The form that is applying a keystroke right now, so that one is not rebuilt under the caret.
  let typingIn: "toolbar" | "scene" | "quick" | "deck" | undefined;

  const editsFor = (form: NonNullable<typeof typingIn>): Edits => ({
    type(ops: readonly Op[], options?: ApplyOptions) {
      typingIn = form;
      try {
        return session.apply(ops, options);
      } finally {
        typingIn = undefined;
      }
    },
    act: (ops: readonly Op[], options?: ApplyOptions) => session.apply(ops, options),
  });

  const hint = h("p", { class: "ed-hint", "aria-live": "polite" });
  const showProblem = (text: string | undefined) => {
    hint.textContent = text ?? "";
    hint.toggleAttribute("data-problem", text !== undefined);
  };
  // The cues of a clip are a file beside its video. They load, and change, apart from the deck's own edits.
  const cues = createCueBook(store.cueApi, {
    problem: showProblem,
    changed() {
      canvas.refreshCues();
      toolbar.render(selected, selectedBlock);
    },
  });
  const adder = createAdder(session, {
    scene: () => selected,
    act: (ops) => session.apply(ops),
    problem: showProblem,
    upload: (file) => store.upload(file),
    added(id) {
      selectBlock(id);
      canvas.focusBlock(id);
    },
  });
  const canvas = createCanvas(session, {
    cues,
    ghosts: {
      add: (slot, kind, file) => void adder.add(slot, kind, file),
      claim: () => adder.claim(),
      hasVideo: () => adder.hasVideo(),
    },
    // The count of a field is in the toolbar; this line is for what was refused.
    hint: (text, problem) => showProblem(problem ? text : undefined),
    select: (id) => selectBlock(id),
    deselect: () => selectBlock(undefined),
    remove: (id) => toolbar.remove(id),
    nudge: (id, dx, dy) => toolbar.nudge(id, dx, dy),
    typed: (id, length, limit) => toolbar.typed(id, length, limit),
    changed: () => toolbar.place(),
    replaceImage(id, file) {
      selectBlock(id);
      void toolbar.replaceImage(id, file);
    },
  });
  const toolbar = createToolbar(session, canvas, {
    edits: editsFor("toolbar"),
    problem: showProblem,
    upload: (file) => store.upload(file),
    deselect: () => selectBlock(undefined),
    goTo(id) {
      selectBlock(id);
      canvas.focusBlock(id);
    },
    focusBlock: (id) => canvas.focusBlock(id),
    openSources: () => sceneBar.open("sources"),
    cues,
  });
  canvas.overlay.append(toolbar.element);

  const deckTitle = h("h1", { class: "ed-deck" });
  const status = h("span", { class: "ed-status", role: "status", "aria-live": "polite" });
  const undo = button("undo", "Undo", () => session.undo());
  const redo = button("redo", "Redo", () => session.redo());
  const retry = button("retry", "Try again", () => void store.save());
  retry.hidden = true;
  const deckChip = popoverChip(
    deckPanel(
      panelHost(session, {
        edits: editsFor("deck"),
        upload: (file) => store.upload(file),
        problem: showProblem,
        close: () => deckChip.close(),
        openSources: () => sceneBar.open("sources"),
      }),
    ),
  );
  const present = h(
    "a",
    { class: "ed-link", href: "/present", target: "_blank", rel: "noopener" },
    "Present",
  );
  const sceneBar = createSceneBar(session, {
    edits: editsFor("scene"),
    problem: showProblem,
    upload: (file) => store.upload(file),
  });
  const bar = h(
    "header",
    { class: "ed-bar" },
    deckTitle,
    sceneBar.element,
    h("div", { class: "ed-actions" }, undo, redo, status, retry, deckChip.chip.wrap, present),
  );
  const notices = h("div", { class: "ed-notices" });
  const strip = createStrip(session, {
    select: (id) => select(id),
    act: (ops, options) => session.apply(ops, options),
  });
  const quick = createQuickBar(session, {
    edits: editsFor("quick"),
    problem: showProblem,
    upload: (file) => store.upload(file),
    block: () => selectedBlock,
    added(id) {
      selectBlock(id);
      canvas.focusBlock(id);
    },
    build: (on) => canvas.setBuild(on),
  });
  const stage = h(
    "main",
    { class: "ed-main", "aria-label": "Scene preview" },
    canvas.element,
    hint,
    quick.element,
  );
  const root = h("div", { class: "ed-app" }, bar, notices, strip.element, stage);
  host.replaceChildren(root);
  // A file dropped anywhere but on an image would open in this tab and take the editor away.
  const refuseFiles = (event: DragEvent) => {
    if (event.defaultPrevented || event.dataTransfer?.types.includes("Files") !== true) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  };
  root.addEventListener("dragover", refuseFiles);
  root.addEventListener("drop", refuseFiles);

  const renderScenes = () => strip.render(selected);

  /** The part of the bar that follows the store: the title, undo, redo and how saving is going. */
  function renderStatus() {
    const { deck } = session.doc;
    deckTitle.textContent = deck.title;
    document.title = `${deck.title} · Depthcue editor`;
    const state = store.status;
    undo.toggleAttribute("disabled", !session.canUndo);
    redo.toggleAttribute("disabled", !session.canRedo);
    retry.hidden = state.save !== "error" || state.conflict !== undefined;
    status.dataset.state = state.save;
    status.textContent =
      state.save === "error"
        ? (state.message ?? SAVE_LABEL.error)
        : state.message
          ? `${SAVE_LABEL[state.save]}. ${state.message}`
          : SAVE_LABEL[state.save];
    present.setAttribute("href", `/present#/${encodeURIComponent(selected)}`);
  }

  /** The popovers and buttons of the bar, redrawn from the deck. Saving changes none of it, so a save skips this. */
  function renderBar() {
    renderStatus();
    sceneBar.render(selected, typingIn === "scene");
    quick.render(selected, typingIn === "quick");
    const live = session.doc.scenes[selected];
    if (live) deckChip.fill(live, typingIn === "deck");
  }

  function renderNotices() {
    const { conflict, draft } = store.status;
    const rows: HTMLElement[] = [];
    if (conflict) {
      rows.push(
        notice(
          "conflict",
          "The files changed on disk while you had unsaved edits, so saving has stopped. Reload to take the files as they are now, or keep your version as a file first.",
          button("take-disk", "Reload", () => void store.takeDisk()),
          button("keep-mine", "Keep mine as copy", () => void store.keepMineAsCopy()),
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
    if (selectedBlock !== undefined && !hasItem(selected, selectedBlock)) selectedBlock = undefined;
  }

  /** A block of the scene, or its claim: the things the slide lets you choose. */
  function hasItem(sceneId: string, id: string) {
    const current = session.doc.scenes[sceneId];
    return current?.summary?.id === id || current?.blocks.some((block) => block.id === id) === true;
  }

  function select(sceneId: string) {
    if (!session.doc.scenes[sceneId]) return;
    if (sceneId !== selected) selectedBlock = undefined;
    selected = sceneId;
    renderScenes();
    renderBar();
    canvas.render(selected, selectedBlock);
    toolbar.render(selected, selectedBlock);
  }

  function selectBlock(id: string | undefined) {
    const next = id !== undefined && hasItem(selected, id) ? id : undefined;
    canvas.mark(next);
    if (next === selectedBlock) return;
    selectedBlock = next;
    toolbar.render(selected, selectedBlock);
  }

  const onKey = (event: KeyboardEvent) => {
    // Alt+F10 moves the keyboard into the toolbar of the chosen block.
    if (event.key === "F10" && event.altKey && toolbar.focus()) {
      event.preventDefault();
      return;
    }
    // P pins the chosen block where it is, or puts it back in its slot. In a field it is a letter like any other.
    if (
      event.key.toLowerCase() === "p" &&
      !(event.ctrlKey || event.metaKey || event.altKey || event.repeat) &&
      selectedBlock !== undefined &&
      !typesInto(event.target)
    ) {
      event.preventDefault();
      toolbar.togglePin(selectedBlock);
      return;
    }
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

  const unsubscribeSession = session.subscribe((event) => {
    // A save changes no content, and the store tells the bar. Redrawing here would rebuild a field mid-keystroke.
    if (event.type === "saved") return;
    ensureSelection();
    renderScenes();
    renderBar();
    if (!canvas.typing) canvas.render(selected, selectedBlock);
    toolbar.render(selected, selectedBlock, typingIn === "toolbar");
  });
  const unsubscribeStore = store.subscribe(() => {
    renderStatus();
    renderNotices();
  });

  // A click on the stage that lands on no block, and not on the toolbar or the add row, lets go of the choice.
  // This runs while the click is still on its way down, before the target's own handler. A button in the toolbar can
  // be gone by the time the click bubbles back up, because the removal it caused redrew the toolbar.
  stage.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-id], .ed-toolbar, .ed-quick, .ed-build"))
        selectBlock(undefined);
    },
    true,
  );

  renderScenes();
  renderBar();
  renderNotices();
  canvas.render(selected, selectedBlock);
  toolbar.render(selected, selectedBlock);

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
      strip.destroy();
      sceneBar.destroy();
      quick.destroy();
      deckChip.destroy();
      toolbar.destroy();
      canvas.destroy();
      host.replaceChildren();
    },
  };
}
