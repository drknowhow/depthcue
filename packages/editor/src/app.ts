import { type ApplyOptions, kindOf, type Op, type SlotName, slotsOf } from "@depthcue/core";
import { h } from "@depthcue/player";
import { createAdder } from "./adder.ts";
import { createCanvas } from "./canvas.ts";
import { kindChange } from "./chartwire.ts";
import { popoverChip } from "./chip.ts";
import { afterWhenMoving } from "./cleanup.ts";
import { createBlockClipboard, type Here } from "./clipboard.ts";
import { type CommandSources, listCommands } from "./commands.ts";
import { countsOf } from "./commentview.ts";
import { createContextMenu } from "./contextmenu.ts";
import { createCueBook } from "./cues.ts";
import { type Edits, problemOf } from "./fields.ts";
import { createFooter } from "./footer.ts";
import { createLayoutWatch, type LayoutWatch } from "./layout-watch.ts";
import { notLoaded, PARTS, type Parts, withPart } from "./lazy.ts";
import { createPalette } from "./palette.ts";
import { deckPanel, panelHost } from "./panels.ts";
import { createQuickBar } from "./quickbar.ts";
import { countsByScene, summaryOf } from "./reviewbook.ts";
import type { ReviewDrawer } from "./reviewdrawer.ts";
import { checksByScene, createRibbon, problemsOf } from "./ribbon.ts";
import { createSceneBar } from "./scenebar.ts";
import { createShortcuts, keyName } from "./shortcuts.ts";
import type { DraftNotice, EditorStore } from "./store.ts";
import type { Storyboard } from "./storyboard.ts";
import { createStrip } from "./strip.ts";
import { createTableEditing } from "./tablecells.ts";
import { IMAGE_ACCEPT, IMAGE_FILE, type Layout, type NewBlockKind } from "./templates.ts";
import { createToolbar } from "./toolbar.ts";
import { createViewBar, FIT, stepZoom } from "./viewbar.ts";

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
 * All state lives in the store's session; this only reflects it and sends edits back through it. The parts most
 * sessions never open are fetched on first use from `parts`, which a test may replace.
 */
export function mountEditor(host: HTMLElement, store: EditorStore, parts: Parts = PARTS): Editor {
  const { session } = store;
  let selected = session.doc.deck.scenes[0] as string;
  let selectedBlock: string | undefined;
  // How far the slide is zoomed, as a multiple of the size that fits the window. It is the view's, not the deck's.
  let zoom = FIT;
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
  // Undo and redo take back the latest thing done: an edit, or an answer given in the drawer of changes.
  const said = (outcome: Promise<string | undefined>) =>
    void outcome.then((text) => {
      if (text !== undefined) showProblem(text);
    });
  const undoNow = () => said(store.history.undo());
  const redoNow = () => said(store.history.redo());
  // The cues of a clip are a file beside its video. They load, and change, apart from the deck's own edits.
  const cues = createCueBook(store.cueApi, {
    problem: showProblem,
    changed() {
      canvas.refreshCues();
      toolbar.render(selected, selectedBlock);
    },
  });
  // Templates, styles and the hints of a template's empty slots are a part of their own, fetched when first wanted.
  const useBrand = (then: (module: NonNullable<Parts["brand"]["ready"]>) => void) =>
    withPart(parts.brand, then, () => showProblem(notLoaded("the templates and styles")));
  const applied = (ops: readonly Op[]) => {
    const result = session.apply(ops);
    return result.ok ? undefined : problemOf(result);
  };
  const openChange = (first?: { layout: Layout }) =>
    useBrand((brand) =>
      brand.changeTemplate(
        session,
        root,
        selected,
        { act: applied, measure: (id) => canvas.measure(id) },
        first,
      ),
    );
  // Defining the brand is a part of its own: the Brand panel, Save as template and the template editor.
  const define = (then: (module: NonNullable<Parts["define"]["ready"]>) => void) =>
    withPart(parts.define, then, () => showProblem(notLoaded("the brand")));
  const brandHost = () => ({
    session,
    store,
    root,
    floor,
    scene: () => selected,
    measure: (id: string) => canvas.measure(id),
    select,
    problem: showProblem,
  });
  // The panel and the list of changes both take the right of the stage, so opening one closes the other.
  const openBrand = () => {
    drawer?.close();
    define((module) => module.openBrand(brandHost()));
  };
  const saveTemplate = () => define((module) => module.saveTemplate(brandHost()));
  const openPicker = () =>
    useBrand((brand) =>
      brand.pickTemplate(session, root, {
        add(scene) {
          const problem = applied([{ op: "scene.add", scene, after: selected }]);
          if (problem === undefined) select(scene.id);
          return problem;
        },
      }),
    );
  // A template scene drawn before the part was in is drawn again when it arrives, with its slots. One that did not
  // arrive is said once, and the slide goes on without them.
  let slotsAsked = false;
  /** The styles a menu was waiting for did not arrive: the next listing says so once, and the one after tries again. */
  let stylesMissed = false;
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
  // The image library is a part of its own. A deck with pictures opens it where the file chooser would have opened.
  const hasImages = () => [...session.doc.assets].some((path) => IMAGE_FILE.test(path));
  const openLibrary = (
    mode: "add" | "replace",
    choose: (asset: string) => void,
    upload: (file: File) => void,
    back: () => void,
  ) =>
    withPart(
      parts.library,
      (module) =>
        module.openLibrary(root, {
          mode,
          doc: () => session.doc,
          list: () => store.listAssets(),
          remove: (asset) => store.removeAsset(asset),
          choose,
          upload,
          back,
        }),
      () => showProblem(notLoaded("the image library")),
    );
  /** The library as the quick bar uses it: a picture goes where `quick` or an area chosen on the slide puts a block. */
  const addFromLibrary = (area?: SlotName) => {
    if (!hasImages()) return false;
    const put = (picture: File | string) =>
      void (area === undefined ? adder.quick("image", picture) : adder.add(area, "image", picture));
    openLibrary("add", put, put, () => quick.focusImage());
    return true;
  };
  const canvas = createCanvas(session, {
    cues,
    ghosts: {
      add: (slot, kind, file) => void adder.add(slot, kind, file),
      claim: () => adder.claim(),
      hasVideo: () => adder.hasVideo(),
    },
    slots(scene, view) {
      const brand = parts.brand.ready;
      if (brand) {
        brand.drawSlots(session.doc, scene, view, {
          add: (slot, kind, file) => void adder.into(slot, kind, file),
          claim: () => adder.claim(),
          hasVideo: () => adder.hasVideo(),
        });
      } else if (!slotsAsked) {
        slotsAsked = true;
        useBrand(() => {
          if (!canvas.typing) canvas.render(selected, selectedBlock);
        });
      }
    },
    // The count of a field is in the toolbar; this line is for what was refused.
    hint: (text, problem) => showProblem(problem ? text : undefined),
    comments: { book: store.comments, changed: () => renderComments(), part: parts.comments },
    history: { undo: undoNow, redo: redoNow },
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
    addImages: (files) => void adder.many(files),
  });
  const toolbar = createToolbar(session, canvas, {
    edits: editsFor("toolbar"),
    problem: showProblem,
    upload: (file) => store.upload(file),
    deselect: () => selectBlock(undefined),
    library(choose, back) {
      const id = selectedBlock;
      openLibrary("replace", choose, (file) => id !== undefined && void toolbar.replaceImage(id, file), back);
    },
    goTo(id) {
      selectBlock(id);
      canvas.focusBlock(id);
    },
    focusBlock: (id) => canvas.focusBlock(id),
    openSources: () => sceneBar.open("sources"),
    cues,
    parts,
  });
  canvas.overlay.append(toolbar.element);

  const deckTitle = h("h1", { class: "ed-deck" });
  const status = h("span", { class: "ed-status", role: "status", "aria-live": "polite" });
  const undo = button("undo", "Undo", undoNow);
  const redo = button("redo", "Redo", redoNow);
  const retry = button("retry", "Try again", () => void store.save());
  retry.hidden = true;
  const deckForm = deckPanel(
    panelHost(session, {
      edits: editsFor("deck"),
      upload: (file) => store.upload(file),
      problem: showProblem,
      close: () => deckChip.close(),
      openSources: () => sceneBar.open("sources"),
    }),
  );
  const deckChip = popoverChip(deckForm);
  // Download PowerPoint is a part of its own; its button closes the Deck popover, so the dialog gives the keyboard back
  // to the Deck chip.
  const openDownload = () =>
    withPart(
      parts.pptx,
      (module) => module.openDownload(root, store),
      () => showProblem(notLoaded("the PowerPoint download")),
    );
  deckForm.body.append(
    button("brand", "Brand…", () => {
      deckChip.close(true);
      openBrand();
    }),
    button("pptx", "Download PowerPoint…", () => {
      deckChip.close(true);
      openDownload();
    }),
  );
  const exportButton = button("export", "Export…", () =>
    withPart(
      parts.exporter,
      (module) => module.openExport(root, store),
      () => showProblem(notLoaded("the export dialog")),
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
  // Review: what changed since the deck was last looked at, mostly by the agent. The button says how many, and opens the
  // drawer that lists them with the two answers. Like the comment buttons, the words give way to the icon in a narrow window.
  const reviewCount = h("span", { class: "ed-count" });
  const reviewWords = h("span", { class: "ed-bar-words" }, "Reviewed");
  const reviewButton = h(
    "button",
    { type: "button", "data-action": "review", "aria-expanded": "false", "aria-controls": "ed-review" },
    h("span", { class: "ed-icon ed-icon-review", "aria-hidden": "true" }),
    reviewWords,
    reviewCount,
  );
  // The drawer that lists them is a part of its own, made when it is first opened, or at once when it is already in.
  let drawer: ReviewDrawer | undefined;
  const makeDrawer = (module: NonNullable<Parts["review"]["ready"]>) => {
    drawer = module.createReviewDrawer(session, store.review, {
      goTo(sceneId, blockId) {
        select(sceneId);
        selectBlock(blockId);
      },
      audit: store.audit,
      current: () => selected,
      has: (sceneId) => session.doc.scenes[sceneId] !== undefined,
      closed: () => reviewButton.focus({ preventScroll: true }),
    });
    floor.append(drawer.element);
  };
  // Pressed while the part is on its way, the button shows it is busy, and it opens once when the part comes: a second
  // press then is the same wish, not a second toggle that would shut it again.
  const reviewBusy = (on: boolean) =>
    on ? reviewButton.setAttribute("aria-busy", "true") : reviewButton.removeAttribute("aria-busy");
  const toggleReview = () => {
    if (reviewButton.hasAttribute("aria-busy")) return;
    reviewBusy(!parts.review.ready);
    withPart(
      parts.review,
      (module) => {
        reviewBusy(false);
        if (!drawer) makeDrawer(module);
        if (!drawer?.isOpen) {
          parts.define.ready?.closeBrand(floor);
          quick.closeScript();
        }
        drawer?.toggle();
        renderReview();
      },
      () => {
        reviewBusy(false);
        showProblem(notLoaded("the list of changes"));
      },
    );
  };
  reviewButton.addEventListener("click", toggleReview);
  const sceneBar = createSceneBar(session, {
    edits: editsFor("scene"),
    problem: showProblem,
    upload: (file) => store.upload(file),
    change: (layout) => openChange(layout && { layout }),
    save: saveTemplate,
    picture: (then) => toolbar.withPicture(then),
    library: (choose, back) =>
      openLibrary(
        "replace",
        choose,
        (file) => void store.upload(file).then(choose, (error: Error) => showProblem(error.message)),
        back,
      ),
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
      reviewButton,
      commentsButton,
      resolvedButton,
      exportButton,
      present,
    ),
  );
  const notices = h("div", { class: "ed-notices" });
  // The strip, full screen. It reads the same counts the strip and the ribbon do, so the numbers on a card are theirs.
  // Like the drawer it is a part of its own.
  let board: Storyboard | undefined;
  const makeBoard = (module: NonNullable<Parts["storyboard"]["ready"]>) => {
    board = module.createStoryboard(session, {
      open: (id) => select(id),
      selected: () => selected,
      comments: () => countsOf(store.comments.state.comments, session.doc).byScene,
      changed: () => countsByScene(store.review.changes()),
      checks: () => checksByScene(problemsOf(session, (id) => watch?.of(id) ?? [])),
    });
    palette.element.after(board.element);
  };
  const openBoard = () =>
    withPart(
      parts.storyboard,
      (module) => {
        if (!board) makeBoard(module);
        board?.open();
      },
      () => showProblem(notLoaded("the storyboard")),
    );
  const strip = createStrip(session, {
    select: (id) => select(id),
    act: (ops, options) => session.apply(ops, options),
    comments: () => countsOf(store.comments.state.comments, session.doc).byScene,
    changed: () => countsByScene(store.review.changes()),
    storyboard: openBoard,
    pick: openPicker,
  });
  const quick = createQuickBar(session, {
    edits: editsFor("quick"),
    problem: showProblem,
    upload: (file) => store.upload(file),
    add: (kind, file) => void adder.quick(kind, file),
    library: () => addFromLibrary(),
    voice: (scene, voice) => store.buildVoice(scene, voice),
    scriptOpened: () => {
      drawer?.close();
    },
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
  const layout = createLayoutWatch(store, {
    scene: () => selected,
    changed() {
      ribbon.render();
      board?.render();
    },
  });
  watch = layout;
  // Every key the editor answers is in one table, which also draws the sheet that the ? key and the bar open.
  const shortcuts = createShortcuts(host, {
    add: (kind) => void adder.quick(kind),
    pickImage: () => quick.pickImage(),
    comment: () => toggleCommenting(),
    undo: undoNow,
    redo: redoNow,
    save: () => void store.save(),
    pin() {
      if (selectedBlock === undefined) return false;
      toolbar.togglePin(selectedBlock);
      return true;
    },
    // Alt+F10 moves the keyboard into the toolbar of the chosen block.
    toolbar: () => toolbar.focus(),
    palette: () => palette.toggle(),
    storyboard: openBoard,
    // The keys of the chosen block. Copy, cut and paste come as events, which carry the clipboard with them.
    copy: (data, cut) => clip.onCopy(data, cut),
    paste: (data) => clip.onPaste(data),
    duplicate(again) {
      if (selectedBlock === undefined || !isBlock(selectedBlock)) return false;
      // Held down, the key does nothing more, and the browser's own use of it is still kept off.
      if (!again) clip.duplicate(selectedBlock);
      return true;
    },
    // Shift+F10 and the Menu key open the menu of the right-click on what the keyboard is on.
    menu: () => menu.openFromKeyboard(),
    scene: goScene,
    zoom: (change) => setZoom(change === "fit" ? FIT : stepZoom(zoom, change === "in" ? 1 : -1)),
  });
  const view = createViewBar({ go: goScene, zoom: (next) => setZoom(next) });
  // Cut, copy, paste and duplicate of a block. A paste is one more add, so it is one step of Undo like the rest.
  const clip = createBlockClipboard(session, {
    scene: () => selected,
    block: () => selectedBlock,
    act: (ops) => session.apply(ops),
    problem: showProblem,
    remove: (id) => toolbar.remove(id),
    added(id) {
      selectBlock(id);
      canvas.nodeOf(id)?.focus({ preventScroll: true });
    },
    room: () => canvas.room(),
  });
  // The file chooser of "Add an image here", which puts the image into the area the menu was opened over.
  let imageArea: SlotName | undefined;
  const imageHere = h("input", {
    type: "file",
    accept: IMAGE_ACCEPT,
    class: "ed-sr-only",
    tabindex: "-1",
    "aria-hidden": "true",
  });
  imageHere.addEventListener("click", (event) => {
    if (addFromLibrary(imageArea)) event.preventDefault();
  });
  imageHere.addEventListener("change", () => {
    const [file] = imageHere.files ?? [];
    const area = imageArea;
    imageHere.value = "";
    if (!file) return;
    void (area === undefined ? adder.quick("image", file) : adder.add(area, "image", file));
  });

  /** A block of the scene on show: the things Cut, Copy and Duplicate are for, which the claim is not. */
  const isBlock = (id: string) =>
    session.doc.scenes[selected]?.blocks.some((block) => block.id === id) === true;

  /** What the cell menu does to a table: each action is one change to it, so one step of Undo. */
  const tables = createTableEditing({
    scene: () => selected,
    apply: (ops) => session.apply(ops),
    block: (id) => session.doc.scenes[selected]?.blocks.find((block) => block.id === id),
    language: () => session.doc.deck.language,
    spot: (id) => canvas.cellOf(id),
    problem: showProblem,
  });

  /**
   * What the commands call on. The palette and the right-click menu list the same commands from the same sources, so
   * each does the same thing in the same one undo step, and is listed only while it can be done. `here` is set when the
   * menu was opened on the empty slide: an add or a paste then goes where the pointer was.
   */
  function sources(here?: Here): CommandSources {
    /** The area under the pointer, when it takes a block of that kind. Otherwise the quick bar's own choice is used. */
    const areaFor = (kind: NewBlockKind): SlotName | undefined => {
      const scene = session.doc.scenes[selected];
      const slot = here?.slot;
      if (!scene || slot === undefined) return undefined;
      return slotsOf(scene)
        .find((candidate) => candidate.name === slot)
        ?.accepts.includes(kind)
        ? slot
        : undefined;
    };
    return {
      session,
      scene: () => selected,
      block: () => selectedBlock,
      add(kind) {
        const area = areaFor(kind);
        void (area === undefined ? adder.quick(kind) : adder.add(area, kind));
      },
      pickImage() {
        const area = areaFor("image");
        if (area === undefined) {
          quick.pickImage();
          return;
        }
        imageArea = area;
        imageHere.click();
      },
      claim: () => adder.claim(),
      hasVideo: () => adder.hasVideo(),
      togglePin: (id) => toolbar.togglePin(id),
      picture: toolbar.picture,
      sized: (id) => Boolean(canvas.nodeOf(id)?.querySelector("img")?.naturalWidth),
      remove: (id) => toolbar.remove(id),
      comment: (id) => void canvas.comments?.compose(id),
      cut: (id) => void clip.cut(id),
      copy: (id) => void clip.copy(id),
      duplicate: (id) => clip.duplicate(id),
      paste: () => void clip.paste(here),
      canPaste: () => clip.canPaste(),
      moveBlock(id, direction) {
        const current = session.doc.scenes[selected];
        if (!current) return;
        const after = afterWhenMoving(
          current.blocks.map((block) => block.id),
          id,
          direction,
        );
        if (after === undefined) return;
        const result = session.apply([{ op: "block.move", scene: current.id, id, after }]);
        showProblem(result.ok ? undefined : problemOf(result));
      },
      chartKind(id, kind) {
        const current = session.doc.scenes[selected];
        const block = current?.blocks.find((candidate) => candidate.id === id);
        if (!current || !block) return;
        const change = kindChange(current, block, kind, session.doc.deck.language);
        if ("problem" in change) {
          showProblem(change.problem);
          return;
        }
        const result = session.apply(change.ops);
        showProblem(result.ok ? undefined : problemOf(result));
      },
      editData: (id) => void toolbar.openPanel(id, "data"),
      setTextStyle(id, key, value) {
        const result = session.apply([
          { op: "block.set", scene: selected, id, set: { [key]: value === "" ? null : value } },
        ]);
        showProblem(result.ok ? undefined : problemOf(result));
      },
      setBlockStyle(id, style) {
        showProblem(
          applied([{ op: "block.set", scene: selected, id, set: { style: style === "" ? null : style } }]),
        );
      },
      // The styles and their pictures come with the part. A menu opened before it is in says they are coming, and is
      // listed again when they come, or says once that they did not.
      stylesComing() {
        if (parts.brand.ready) return undefined;
        if (stylesMissed) {
          stylesMissed = false;
          return notLoaded("the styles");
        }
        void parts.brand.load().then((module) => {
          stylesMissed = !module;
          menu.refresh();
        });
        return "Loading the styles…";
      },
      stylePreview(style) {
        const block = session.doc.scenes[selected]?.blocks.find(
          (candidate) => candidate.id === selectedBlock,
        );
        return parts.brand.ready?.stylePreview(session.doc, style, block && kindOf(block));
      },
      changeTemplate: () => openChange(),
      pickTemplate: openPicker,
      brand: openBrand,
      saveTemplate,
      upgradeScene(id) {
        const result = session.apply([{ op: "scene.upgrade", id }]);
        showProblem(result.ok ? undefined : problemOf(result));
      },
      cell: () => tables.cell(selectedBlock),
      editCell(action, at) {
        if (selectedBlock !== undefined) tables.run(selectedBlock, action, at);
      },
      duplicateScene: (id) => strip.duplicate(id),
      removeScene: (id) => strip.remove(id),
      moveScene: (id, direction) => strip.move(id, direction),
      commentsShown: () => canvas.comments?.shown ?? false,
      showComments: (on) => canvas.comments?.setShown(on),
      deckStyle() {
        if (!deckChip.isOpen) deckChip.open();
        deckForm.reveal("style");
      },
      setLead: (lead) => sceneBar.setLead(lead),
      setLayout: (layout) => sceneBar.setLayout(layout),
      autoLayout: () => sceneBar.autoLayout(),
      ribbon,
      goTo: (id) => select(id),
      undo: undoNow,
      redo: redoNow,
      canUndo: () => store.history.canUndo,
      canRedo: () => store.history.canRedo,
      toggleReview,
      reviewOpen: () => drawer?.isOpen === true,
      storyboard: openBoard,
      download: openDownload,
      save: () => void store.save(),
      present: () => void window.open(present.href, "_blank", "noopener"),
      showKeys: () => shortcuts.open(),
      keysOf: (id) => shortcuts.keysOf(id),
    };
  }
  // Everything the editor can do, found by typing.
  // A command that cannot be done is greyed in a menu, with its reason. The palette lists only what works.
  const palette = createPalette({
    commands: () => listCommands(sources()).filter((command) => command.disabled === undefined),
    keyName,
  });
  const stage = h("main", { class: "ed-main", "aria-label": "Scene preview" }, canvas.element, hint);
  // The bar floats over the foot of the stage and stays there while the slide scrolls under it.
  const floor = h("div", { class: "ed-stage" }, stage, quick.element, quick.drawer);
  const footer = createFooter(view.element, { script: () => quick.toggleScript() });
  const root = h(
    "div",
    { class: "ed-app" },
    bar,
    notices,
    ribbon.element,
    strip.element,
    floor,
    footer.element,
    shortcuts.sheet,
    palette.element,
  );
  // A part fetched before the editor was mounted is used at once, as if it had never been apart.
  if (parts.review.ready) makeDrawer(parts.review.ready);
  if (parts.storyboard.ready) makeBoard(parts.storyboard.ready);
  // The menu of a right-click: on a block or the claim, on the empty slide, and on a scene of the strip. It chooses what
  // was pointed at first, so what it lists is what the palette would list for that choice.
  const menu = createContextMenu(root, {
    stage,
    strip: strip.element,
    kindOf(id) {
      const current = session.doc.scenes[selected];
      if (current?.summary?.id === id) return "claim";
      return current?.blocks.some((block) => block.id === id) ? "block" : undefined;
    },
    chosen: () =>
      selectedBlock === undefined ? undefined : { id: selectedBlock, node: canvas.nodeOf(selectedBlock) },
    commands(pointed) {
      if (pointed.target === "scene") {
        if (pointed.id !== undefined && pointed.id !== selected) select(pointed.id);
        return listCommands(sources());
      }
      if (pointed.target === "slide") {
        selectBlock(undefined);
        return listCommands(sources({ slot: pointed.slot, at: pointed.at }));
      }
      selectBlock(pointed.id);
      // The cell pointed at has the keyboard, so the menu and a command that runs both know which cell it is.
      if (pointed.target === "cell" && pointed.id !== undefined && pointed.cell) {
        canvas.focusCell(pointed.id, pointed.cell);
      }
      return listCommands(sources());
    },
    giveBack(pointed, ran) {
      if (pointed.target === "slide" || pointed.id === undefined) return;
      if (pointed.target === "cell") {
        // A change to the table drew it again, so the keyboard goes back by the place of the cell and not by the cell.
        canvas.focusCell(pointed.id, pointed.cell ?? canvas.cellOf(pointed.id) ?? { row: 0, column: 0 });
        return;
      }
      const node =
        pointed.target === "scene"
          ? [...strip.element.querySelectorAll<HTMLElement>("button[data-scene]")].find(
              (candidate) => candidate.dataset.scene === pointed.id,
            )
          : canvas.nodeOf(pointed.id);
      // A text that is open for typing takes the caret back when the menu was dismissed. After an item ran it does
      // not: the next Ctrl+V would paste words into the text and not a block after it.
      const typed = node?.matches("[data-edit]") ? node : node?.querySelector<HTMLElement>("[data-edit]");
      const target = typed ? (ran ? undefined : typed) : node && node.tabIndex >= 0 ? node : undefined;
      target?.focus({ preventScroll: true });
    },
    keyName,
  });
  root.append(menu.element, imageHere);
  host.replaceChildren(root);
  // A file dropped anywhere but on an image would open in this tab and take the editor away.
  const refuseFiles = (event: DragEvent) => {
    if (event.defaultPrevented || event.dataTransfer?.types.includes("Files") !== true) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  };
  root.addEventListener("dragover", refuseFiles);
  root.addEventListener("drop", refuseFiles);

  const renderScenes = () => {
    strip.render(selected);
    board?.render();
  };

  /** The part of the bar that follows the store: the title, undo, redo and how saving is going. */
  function renderStatus() {
    const { deck } = session.doc;
    deckTitle.textContent = deck.title;
    document.title = `${deck.title} · Depthcue editor`;
    const state = store.status;
    undo.toggleAttribute("disabled", !store.history.canUndo);
    redo.toggleAttribute("disabled", !store.history.canRedo);
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

  /** The Review button: how many changes the agent made that nobody has answered, and whether the drawer is open. */
  function renderReview() {
    const { problem, ready } = store.review.state;
    const { agent, outside } = summaryOf(store.review.changes());
    const pending = agent > 0 ? agent : outside;
    reviewWords.textContent = agent > 0 ? "Agent changed" : outside > 0 ? "Changed" : "Reviewed";
    reviewCount.textContent = pending > 0 ? String(pending) : "";
    reviewButton.dataset.state = pending > 0 ? "changed" : "clear";
    const plural = `${pending} ${pending === 1 ? "change" : "changes"}`;
    const said = problem
      ? `The review cannot be read. ${problem}`
      : !ready
        ? "Reading the review"
        : agent > 0
          ? `The agent changed ${plural} to review`
          : outside > 0
            ? `${plural} made outside the editor to review`
            : "Nothing to review";
    const open = drawer?.isOpen === true;
    reviewButton.setAttribute(
      "aria-label",
      `${said}. ${open ? "Press to close the list." : "Press to open the list."}`,
    );
    reviewButton.title = said;
    reviewButton.setAttribute("aria-expanded", String(open));
    drawer?.render();
  }

  /** The popovers and buttons of the bar, redrawn from the deck. Saving changes none of it, so a save skips this. */
  function renderBar() {
    renderStatus();
    renderView();
    renderReview();
    renderComments();
    sceneBar.render(selected, typingIn === "scene");
    quick.render(selected, typingIn === "quick");
    const live = session.doc.scenes[selected];
    if (live) deckChip.fill(live, typingIn === "deck");
    if (live)
      footer.render(live, session.doc.deck.scenes.indexOf(selected) + 1, session.doc.deck.scenes.length);
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

  /** The view bar: which slide this is of how many, and the zoom. */
  function renderView() {
    const ids = session.doc.deck.scenes;
    view.render(ids.indexOf(selected) + 1, ids.length, zoom);
  }

  /** Goes to the slide before or after the one on show, and stops at the ends. */
  function goScene(direction: 1 | -1) {
    const ids = session.doc.deck.scenes;
    const next = ids[ids.indexOf(selected) + direction];
    if (next !== undefined) select(next);
  }

  /** Zooms the slide. The room it is drawn in grows with it, and the stage scrolls to the part out of sight. */
  function setZoom(next: number) {
    zoom = next;
    canvas.element.style.setProperty("--ed-zoom", String(zoom));
    stage.toggleAttribute("data-zoomed", zoom !== FIT);
    renderView();
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
    // A menu open when the deck changes under it, such as an agent's edit, lists what was true before it.
    menu.close();
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
  // The review is read again when the agent writes, and an answer given in the drawer changes it. The marks follow.
  const unsubscribeReview = store.review.subscribe(() => {
    renderReview();
    renderScenes();
  });
  // An answer that took Undo with it changes what the buttons can do, and nothing else tells the bar.
  const unsubscribeHistory = store.history.subscribe(renderStatus);

  // A click on the stage that lands on no block, and not on the toolbar or the build badges, lets go of the choice.
  // The quick bar is beside the stage and not in it, so a press on the bar keeps the choice its adds go after.
  // This runs while the click is still on its way down, before the target's own handler. A button in the toolbar can
  // be gone by the time the click bubbles back up, because the removal it caused redrew the toolbar.
  stage.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest("[data-id], .ed-toolbar, .ed-build, .ed-comments, .ed-crop")
      )
        selectBlock(undefined);
    },
    true,
  );

  // Ctrl and the wheel, or a pinch on a trackpad, zoom the slide instead of the page.
  stage.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      setZoom(stepZoom(zoom, event.deltaY < 0 ? 1 : -1));
    },
    { passive: false },
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
      menu.destroy();
      palette.destroy();
      layout.destroy();
      ribbon.destroy();
      unsubscribeSession();
      unsubscribeStore();
      unsubscribeComments();
      unsubscribeReview();
      unsubscribeHistory();
      drawer?.destroy();
      board?.destroy();
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
