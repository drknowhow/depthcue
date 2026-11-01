import type { ApplyOptions, Op } from "@depthcue/core";
import { h } from "@depthcue/player";
import { createAdder } from "./adder.ts";
import { createCanvas } from "./canvas.ts";
import { popoverChip } from "./chip.ts";
import { listCommands } from "./commands.ts";
import { countsOf } from "./commentview.ts";
import { createCueBook } from "./cues.ts";
import { type Edits, problemOf } from "./fields.ts";
import { createLayoutWatch, type LayoutWatch } from "./layout-watch.ts";
import { createPalette } from "./palette.ts";
import { deckPanel, panelHost } from "./panels.ts";
import { createQuickBar } from "./quickbar.ts";
import { createRibbon } from "./ribbon.ts";
import { createSceneBar } from "./scenebar.ts";
import { createShortcuts, keyName } from "./shortcuts.ts";
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
 * text editable in place, and the rest of its properties in a toolbar over the chosen block, a quick bar at the foot
 * of the stage and the popovers of the top bar.
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
    block: () => selectedBlock,
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
    comments: { book: store.comments, changed: () => renderComments() },
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
  // Comments: the button shows or hides the pins and says how many are open; a second one, only while there are some,
  // brings the resolved ones back into view. In a narrow window the words give way to the icons, which keep their names.
  const commentCount = h("span", { class: "ed-count" });
  const commentsButton = h(
    "button",
    { type: "button", "data-action": "comments", "aria-pressed": "true" },
    h("span", { class: "ed-icon ed-icon-comments", "aria-hidden": "true" }),
    h("span", { class: "ed-bar-words" }, "Comments"),
    commentCount,
  );
  commentsButton.addEventListener("click", () => {
    const pins = canvas.comments;
    if (pins) pins.setShown(!pins.shown);
  });
  const resolvedCount = h("span", { class: "ed-count ed-count-plain" });
  const resolvedButton = h(
    "button",
    { type: "button", "data-action": "resolved", "aria-pressed": "false" },
    h("span", { class: "ed-icon ed-icon-resolved", "aria-hidden": "true" }),
    h("span", { class: "ed-bar-words" }, "Resolved"),
    resolvedCount,
  );
  resolvedButton.addEventListener("click", () => {
    const pins = canvas.comments;
    if (pins) pins.setShowResolved(!pins.showResolved);
  });
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
    h(
      "div",
      { class: "ed-actions" },
      undo,
      redo,
      status,
      retry,
      deckChip.chip.wrap,
      commentsButton,
      resolvedButton,
      present,
    ),
  );
  const notices = h("div", { class: "ed-notices" });
  const strip = createStrip(session, {
    select: (id) => select(id),
    act: (ops, options) => session.apply(ops, options),
    comments: () => countsOf(store.comments.state.comments, session.doc).byScene,
  });
  const quick = createQuickBar(session, {
    edits: editsFor("quick"),
    problem: showProblem,
    upload: (file) => store.upload(file),
    add: (kind, file) => void adder.quick(kind, file),
    claim: () => adder.claim(),
    hasVideo: () => adder.hasVideo(),
    build: (on) => canvas.setBuild(on),
    comment: () => toggleCommenting(),
    keys: () => shortcuts.open(),
    palette: () => palette.toggle(),
  });
  // What `depthcue check` and `depthcue render` would say about the deck, one problem at a time. The rules are theirs:
  // the core's for what the files say, and a render's for what the audience would see.
  let watch: LayoutWatch | undefined;
  const ribbon = createRibbon(session, {
    scene: () => selected,
    found: (sceneId) => watch?.of(sceneId) ?? [],
    go(problem, focus) {
      if (problem.scene !== selected) select(problem.scene);
      selectBlock(problem.block);
      if (focus && problem.block !== undefined) canvas.focusBlock(problem.block);
    },
    fix(problem) {
      if (!problem.fix) return;
      const result = session.apply(problem.fix.ops);
      showProblem(result.ok ? undefined : problemOf(result));
    },
  });
  const layout = createLayoutWatch(store, { scene: () => selected, changed: () => ribbon.render() });
  watch = layout;
  // Every key the editor answers is in one table, which also draws the sheet that the ? key and the bar open.
  const shortcuts = createShortcuts(host, {
    add: (kind) => void adder.quick(kind),
    pickImage: () => quick.pickImage(),
    comment: () => toggleCommenting(),
    undo: () => session.undo(),
    redo: () => session.redo(),
    save: () => void store.save(),
    pin() {
      if (selectedBlock === undefined) return false;
      toolbar.togglePin(selectedBlock);
      return true;
    },
    // Alt+F10 moves the keyboard into the toolbar of the chosen block.
    toolbar: () => toolbar.focus(),
    palette: () => palette.toggle(),
  });
  // Everything the editor can do, found by typing. Each command calls what the buttons call, so it does the same thing,
  // in the same one undo step, and is listed only while it can be done.
  const palette = createPalette({
    commands: () =>
      listCommands({
        session,
        scene: () => selected,
        block: () => selectedBlock,
        add: (kind) => void adder.quick(kind),
        pickImage: () => quick.pickImage(),
        claim: () => adder.claim(),
        hasVideo: () => adder.hasVideo(),
        togglePin: (id) => toolbar.togglePin(id),
        remove: (id) => toolbar.remove(id),
        comment: (id) => void canvas.comments?.compose(id),
        commentsShown: () => canvas.comments?.shown ?? false,
        showComments: (on) => canvas.comments?.setShown(on),
        setLead: (lead) => sceneBar.setLead(lead),
        setLayout: (layout) => sceneBar.setLayout(layout),
        autoLayout: () => sceneBar.autoLayout(),
        ribbon,
        goTo: (id) => select(id),
        undo: () => session.undo(),
        redo: () => session.redo(),
        save: () => void store.save(),
        present: () => void window.open(present.href, "_blank", "noopener"),
        showKeys: () => shortcuts.open(),
        keysOf: (id) => shortcuts.keysOf(id),
      }),
    keyName,
  });
  const stage = h("main", { class: "ed-main", "aria-label": "Scene preview" }, canvas.element, hint);
  // The bar floats over the foot of the stage and stays there while the slide scrolls under it.
  const floor = h("div", { class: "ed-stage" }, stage, quick.element);
  const root = h(
    "div",
    { class: "ed-app" },
    bar,
    notices,
    ribbon.element,
    strip.element,
    floor,
    shortcuts.sheet,
    palette.element,
  );
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
    // A plain "Saved" says nothing the dot does not, so a narrow window may leave the word to the tooltip.
    status.title = status.textContent;
    status.toggleAttribute("data-quiet", state.save === "saved" && !state.message);
    present.setAttribute("href", `/present#/${encodeURIComponent(selected)}`);
  }

  /** Starts the Comment tool, or stops it. The key, the quick bar's button and the palette all come here. */
  function toggleCommenting() {
    const pins = canvas.comments;
    if (pins) pins.setTool(!pins.tool);
  }

  /** The Comments button and the tool's button: how many are open, whether they are shown, whether the tool is on. */
  function renderComments() {
    const pins = canvas.comments;
    if (!pins) return;
    const { comments, problem, ready } = store.comments.state;
    const { total } = countsOf(comments, session.doc);
    const counted = ready && problem === undefined;
    commentCount.textContent = counted && total.open > 0 ? String(total.open) : "";
    commentCount.toggleAttribute("data-tasks", total.tasks > 0);
    const open = `${total.open} open ${total.open === 1 ? "comment" : "comments"}`;
    const said = problem
      ? `Comments cannot be shown. ${problem}`
      : `${counted ? open : "Comments"}${total.tasks > 0 ? `, ${total.tasks} waiting for the agent` : ""}. ${pins.shown ? "Shown on the slides. Press to hide them." : "Hidden. Press to show them."}`;
    commentsButton.setAttribute("aria-label", said);
    commentsButton.title = said;
    commentsButton.setAttribute("aria-pressed", String(pins.shown));
    commentsButton.toggleAttribute("disabled", problem !== undefined);
    resolvedButton.hidden = !(pins.shown && total.resolved > 0);
    resolvedButton.setAttribute("aria-pressed", String(pins.showResolved));
    resolvedCount.textContent = String(total.resolved);
    const resolved = `${total.resolved} resolved ${total.resolved === 1 ? "comment" : "comments"}. ${pins.showResolved ? "Shown dimmed. Press to hide them." : "Hidden. Press to show them."}`;
    resolvedButton.setAttribute("aria-label", resolved);
    resolvedButton.title = resolved;
    quick.setCommenting(pins.tool);
  }

  /** The popovers and buttons of the bar, redrawn from the deck. Saving changes none of it, so a save skips this. */
  function renderBar() {
    renderStatus();
    renderComments();
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
    ribbon.render();
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

  const unsubscribeSession = session.subscribe((event) => {
    // A save changes no content, and the store tells the bar. Redrawing here would rebuild a field mid-keystroke.
    if (event.type === "saved") return;
    ensureSelection();
    renderScenes();
    renderBar();
    ribbon.render();
    if (!canvas.typing) canvas.render(selected, selectedBlock);
    toolbar.render(selected, selectedBlock, typingIn === "toolbar");
  });
  const unsubscribeStore = store.subscribe(() => {
    renderStatus();
    renderNotices();
  });
  // The pins follow the book on their own. The bar and the strip read the counts from it.
  const unsubscribeComments = store.comments.subscribe(() => {
    renderComments();
    renderScenes();
  });

  // A click on the stage that lands on no block, and not on the toolbar or the build badges, lets go of the choice.
  // The quick bar is beside the stage and not in it, so a press on the bar keeps the choice its adds go after.
  // This runs while the click is still on its way down, before the target's own handler. A button in the toolbar can
  // be gone by the time the click bubbles back up, because the removal it caused redrew the toolbar.
  stage.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-id], .ed-toolbar, .ed-build, .ed-comments"))
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
      shortcuts.destroy();
      palette.destroy();
      layout.destroy();
      ribbon.destroy();
      unsubscribeSession();
      unsubscribeStore();
      unsubscribeComments();
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
