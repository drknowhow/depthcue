import { isMarker, type Op, type Scene, type Session, TEXT_LIMITS } from "@depthcue/core";
import { h, renderScene } from "@depthcue/player";
import { createBuildBadges } from "./buildbadges.ts";
import { CHART_LABEL_MAX, wireBars } from "./chart.ts";
import { type CueBook, clock } from "./cues.ts";
import { drawGhosts, type GhostHooks } from "./ghosts.ts";
import { createSlotDrag } from "./slotdrag.ts";
import { describeBlock, IMAGE_FILE, needsAlt } from "./templates.ts";

export interface CanvasHooks {
  /** A short line about the field being edited, such as "Heading 42 of 90". `problem` marks a refused edit. */
  hint(text: string, problem: boolean): void;
  /** A block, or the claim, was chosen by focusing its text or activating it. */
  select(id: string): void;
  /** Escape was pressed on a block: nothing should stay chosen. */
  deselect?(): void;
  /** Delete was pressed on a block that has no text to delete: take the block out of the scene. */
  remove?(id: string): void;
  /** The text of a field changed as it was typed. `length` counts what is on the slide, applied or not. */
  typed?(id: string, length: number, limit: number): void;
  /** The slide was drawn again, or its text grew or shrank, so anything placed against a block should move. */
  changed?(): void;
  /** A picture file was dropped on an image, or pasted while the image had the keyboard: use it in its place. */
  replaceImage?(id: string, file: File): void;
  /** The cues of the clips. A clip that has some gets a row of places to jump to under it. */
  cues?: CueBook;
  /** Adds to an area of the slide that holds nothing yet, which the slide draws a place for. */
  ghosts?: GhostHooks;
}

export interface Canvas {
  readonly element: HTMLElement;
  /** A layer over the slide that is never redrawn with it, for the toolbar and later for handles and pins. */
  readonly overlay: HTMLElement;
  /** True while a keystroke is being applied, so the caller does not re-render under the caret. */
  readonly typing: boolean;
  /** Draws a scene, with `selectedId` marked when it is one of the scene's blocks. */
  render(sceneId: string, selectedId?: string): void;
  /** Moves the selection mark without redrawing. */
  mark(id: string | undefined): void;
  /** The element a block, or the claim, is drawn in. */
  nodeOf(id: string): HTMLElement | undefined;
  /** Puts the keyboard on a block: the caret at the end of its text, or the block itself when it has none. */
  focusBlock(id: string): void;
  /** Draws the rows of cue chips again from the cue book, without redrawing the slide or resetting a video. */
  refreshCues(): void;
  /** Shows or hides the build order: a badge beside each part that says which step reveals it. */
  setBuild(on: boolean): void;
  /** Stops watching the size of the slide. */
  destroy(): void;
}

/** One piece of text on a scene that can be edited where it appears. */
interface Field {
  /** The block the field is in, or the claim. */
  id: string;
  /** Tells fields of one block apart, for joining a visit's keystrokes into one undo step. Defaults to `id`. */
  key?: string;
  label: string;
  /** What assistive technology calls the field. Defaults to the label followed by "text". */
  name?: string;
  /** Said when the field is emptied, which the schema refuses. */
  empty?: string;
  limit: number;
  node: HTMLElement;
  read(scene: Scene): string | undefined;
  write(scene: Scene, text: string): Op;
}

/** The claim holds this many characters. The schema says so too; the core does not export it. */
export const SUMMARY_LIMIT = 280;

const supportsPlaintext = (() => {
  let answer: boolean | undefined;
  return () => {
    if (answer === undefined) {
      const probe = document.createElement("div");
      probe.contentEditable = "plaintext-only";
      answer = probe.contentEditable === "plaintext-only";
    }
    return answer;
  };
})();

/** The editable text of a scene, matched to the elements the player's renderer made for it. */
function fieldsOf(scene: Scene, root: HTMLElement): Field[] {
  const nodes = new Map<string, HTMLElement>();
  for (const node of root.querySelectorAll<HTMLElement>("[data-id]")) nodes.set(node.dataset.id ?? "", node);

  const fields: Field[] = [];
  for (const block of scene.blocks) {
    if (block.type === "bar-chart") {
      const labels = nodes.get(block.id)?.querySelectorAll<HTMLElement>('th[scope="row"]') ?? [];
      labels.forEach((node, index) => {
        const rowsOf = (current: Scene) => {
          const found = current.blocks.find((candidate) => candidate.id === block.id);
          return found?.type === "bar-chart" ? found.data : [];
        };
        fields.push({
          id: block.id,
          key: `${block.id}:row${index}`,
          label: `Bar ${index + 1} label`,
          name: `Bar ${index + 1} label`,
          empty: "A bar needs a label.",
          limit: CHART_LABEL_MAX,
          node,
          read: (current) => rowsOf(current)[index]?.label,
          write: (current, text) => ({
            op: "block.set",
            scene: current.id,
            id: block.id,
            set: { data: rowsOf(current).map((row, at) => (at === index ? { ...row, label: text } : row)) },
          }),
        });
      });
    }
    if (block.type !== "text") continue;
    const node = nodes.get(block.id);
    if (!node) continue;
    fields.push({
      id: block.id,
      label: `${block.role[0]?.toUpperCase()}${block.role.slice(1)}`,
      limit: TEXT_LIMITS[block.role],
      node: node.querySelector<HTMLElement>("p") ?? node,
      read: (current) => {
        const found = current.blocks.find((candidate) => candidate.id === block.id);
        return found?.type === "text" ? found.text : undefined;
      },
      write: (current, text) => ({ op: "block.set", scene: current.id, id: block.id, set: { text } }),
    });
  }
  const summary = scene.summary;
  const claim = summary && nodes.get(summary.id);
  if (summary && claim) {
    fields.push({
      id: summary.id,
      label: "Claim",
      limit: SUMMARY_LIMIT,
      node: claim,
      read: (current) => current.summary?.text,
      write: (current, text) => ({
        op: "scene.set",
        id: current.id,
        set: { summary: { ...(current.summary as NonNullable<Scene["summary"]>), text } },
      }),
    });
  }
  return fields;
}

const flat = (text: string) => text.replace(/\s+/g, " ");

function placeCaretAtEnd(node: HTMLElement) {
  const selection = getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * The selected scene as the audience sees it, with every step revealed, and with each piece of text editable in
 * place. Typing becomes a core `block.set` (or `scene.set` for a claim) joined into one undo step per visit to
 * the field. Text the schema would refuse, empty or too long, is held back and shown as a problem, never applied.
 */
export function createCanvas(session: Session, hooks: CanvasHooks): Canvas {
  const slot = h("div", { class: "ed-canvas-slot" });
  const overlay = h("div", { class: "ed-overlay" });
  const element = h("div", { class: "ed-canvas-host" }, slot, overlay);
  let typing = false;
  let visits = 0;
  /** The blocks moved or changed size, so the grips and the toolbar move with them. */
  const changed = () => {
    drag.place();
    build.place();
    hooks.changed?.();
  };

  function wire(field: Field, sceneId: string) {
    const { node } = field;
    node.dataset.edit = "";
    node.setAttribute("role", "textbox");
    node.setAttribute("aria-label", field.name ?? `${field.label} text`);
    node.setAttribute("aria-multiline", "false");
    node.contentEditable = supportsPlaintext() ? "plaintext-only" : "true";
    node.spellcheck = true;
    node.tabIndex = 0;
    let visit = 0;

    const scene = () => session.doc.scenes[sceneId] as Scene;
    const current = () => field.read(scene()) ?? "";

    const check = (text: string): string | undefined => {
      if (text === "") return field.empty ?? "Text cannot be empty. Remove the block instead.";
      if (text.length > field.limit) return `${text.length - field.limit} over the limit of ${field.limit}.`;
      return undefined;
    };

    const update = () => {
      const text = flat(node.textContent ?? "").trim();
      const problem = check(text);
      node.toggleAttribute("data-invalid", problem !== undefined);
      hooks.hint(problem ?? `${field.label} ${text.length} of ${field.limit}`, problem !== undefined);
      hooks.typed?.(field.id, text.length, field.limit);
      changed();
      if (problem !== undefined || text === current()) return;
      typing = true;
      try {
        session.apply([field.write(scene(), text)], { coalesce: `text:${field.key ?? field.id}:${visit}` });
      } finally {
        typing = false;
      }
    };

    node.addEventListener("focus", () => {
      visit = ++visits;
      hooks.hint(`${field.label} ${current().length} of ${field.limit}`, false);
      hooks.typed?.(field.id, current().length, field.limit);
      hooks.select(field.id);
    });
    node.addEventListener("input", update);
    node.addEventListener("beforeinput", (event) => {
      // One line each: Enter finishes the edit. History belongs to the session, not to the browser.
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault();
        node.blur();
      } else if (event.inputType === "historyUndo") {
        event.preventDefault();
        session.undo();
      } else if (event.inputType === "historyRedo") {
        event.preventDefault();
        session.redo();
      }
    });
    node.addEventListener("paste", (event) => {
      event.preventDefault();
      const pasted = flat(event.clipboardData?.getData("text/plain") ?? "");
      if (pasted) document.execCommand("insertText", false, pasted);
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        node.textContent = current();
        node.removeAttribute("data-invalid");
        node.blur();
        hooks.deselect?.();
      }
    });
    node.addEventListener("blur", () => {
      const text = flat(node.textContent ?? "").trim();
      if (check(text) !== undefined) {
        // Refused edits never reached the document, so show what it still says.
        node.textContent = current();
      } else if (node.textContent !== text) {
        node.textContent = text;
      }
      node.removeAttribute("data-invalid");
      hooks.hint("", false);
    });
  }

  /** An image takes a picture dropped on it or pasted into it. A dropped file that is not a picture is told so. */
  function wireDrop(node: HTMLElement, id: string) {
    const pictureIn = (files: FileList | null | undefined) =>
      [...(files ?? [])].find((file) => file.type.startsWith("image/") || IMAGE_FILE.test(file.name));
    // dragenter and dragleave fire again for every child the pointer crosses, so they are counted.
    let depth = 0;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    node.addEventListener("dragenter", (event) => {
      if (!carriesFiles(event)) return;
      depth++;
      node.dataset.drop = "";
      over(event);
    });
    node.addEventListener("dragover", over);
    node.addEventListener("dragleave", (event) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) node.removeAttribute("data-drop");
    });
    node.addEventListener("drop", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      node.removeAttribute("data-drop");
      const file = pictureIn(event.dataTransfer?.files);
      if (file) hooks.replaceImage?.(id, file);
      else hooks.hint("That is not a picture file. Use PNG, JPEG, GIF, WebP or SVG.", true);
    });
    node.addEventListener("paste", (event) => {
      const file = pictureIn(event.clipboardData?.files);
      if (!file) return;
      event.preventDefault();
      hooks.replaceImage?.(id, file);
    });
  }

  /** Images, charts and clips have no text to type into, so they are chosen by clicking or pressing Enter. */
  function wirePicker(scene: Scene, root: HTMLElement) {
    for (const block of scene.blocks) {
      if (block.type === "text") continue;
      const node = [...root.querySelectorAll<HTMLElement>(".dc-block")].find(
        (candidate) => candidate.dataset.id === block.id,
      );
      if (!node) continue;
      node.dataset.pick = "";
      // A chart holds sliders and text fields of its own, and a clip a player and its cue chips, which a button may
      // not contain.
      node.setAttribute("role", block.type === "bar-chart" || block.type === "clip" ? "group" : "button");
      const missingAlt = needsAlt(block);
      node.toggleAttribute("data-alt-missing", missingAlt);
      node.setAttribute(
        "aria-label",
        `${describeBlock(block, 60)}.${missingAlt ? " Alt text is missing." : ""} Select to edit.`,
      );
      node.tabIndex = 0;
      if (block.type === "image") wireDrop(node, block.id);
      if (block.type === "bar-chart") {
        wireBars(node, block.id, {
          session,
          sceneId: scene.id,
          quietly(change) {
            typing = true;
            try {
              change();
            } finally {
              typing = false;
            }
          },
          select: hooks.select,
          deselect: hooks.deselect,
        });
      }
      node.addEventListener("click", () => hooks.select(block.id));
      node.addEventListener("keydown", (event) => {
        if (event.target !== node) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          hooks.select(block.id);
        } else if (event.key === "Escape") {
          hooks.deselect?.();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          hooks.remove?.(block.id);
        }
      });
    }
  }

  /** The scene on the slide, for drawing the cue rows again when a clip's cues load or change. */
  let drawn: string | undefined;

  /**
   * The row of places to jump to under each clip that has cues, as the player shows them. The cues come from the cue
   * book and not from the deck, so a row is drawn after the slide and again whenever the book changes, and never
   * redraws the video, which would send it back to its start.
   */
  function wireCues(scene: Scene, root: HTMLElement) {
    const book = hooks.cues;
    if (!book) return;
    for (const block of scene.blocks) {
      if (block.type !== "clip") continue;
      const node = [...root.querySelectorAll<HTMLElement>(".dc-block")].find(
        (candidate) => candidate.dataset.id === block.id,
      );
      if (!node) continue;
      node.querySelector(".dc-clip-cues")?.remove();
      const entry = book.entry(block.source);
      // A video whose cues are loading, or could not be read, has none to show.
      if (entry.cues.length === 0) continue;
      const row = h(
        "div",
        { class: "dc-clip-cues", role: "group", "aria-label": "Jump to" },
        ...entry.cues.map((cue) =>
          h(
            "button",
            {
              type: "button",
              class: "dc-chip",
              "data-cue": cue.id,
              "data-marker": isMarker(cue) ? "" : undefined,
              "aria-label": `${cue.id}, at ${clock(cue.in)}`,
            },
            cue.id,
            h("span", { class: "dc-cue-time" }, clock(cue.in)),
          ),
        ),
      );
      row.addEventListener("click", (event) => {
        const chip = (event.target as Element).closest<HTMLElement>("[data-cue]");
        const cue = chip && entry.cues.find((candidate) => candidate.id === chip.dataset.cue);
        const video = node.querySelector("video");
        if (cue && video) video.currentTime = cue.in;
      });
      node.append(row);
    }
  }

  const nodeOf = (id: string) =>
    [...slot.querySelectorAll<HTMLElement>("[data-id]")].find((node) => node.dataset.id === id);

  function mark(id: string | undefined) {
    for (const node of slot.querySelectorAll<HTMLElement>("[data-selected]")) {
      node.removeAttribute("data-selected");
    }
    drag.mark(id);
    if (id === undefined) return;
    nodeOf(id)?.setAttribute("data-selected", "");
  }

  const drag = createSlotDrag(session, element, overlay, nodeOf, {
    select: (id) => hooks.select(id),
    hint: (text, problem) => hooks.hint(text, problem),
    act: (ops) => session.apply(ops),
  });

  const build = createBuildBadges(session, element, overlay, nodeOf, {
    act: (ops) => session.apply(ops),
    problem: (text) => hooks.hint(text ?? "", text !== undefined),
  });

  function focusBlock(id: string) {
    const node = nodeOf(id);
    const target = node?.matches("[data-edit], [data-pick]")
      ? node
      : node?.querySelector<HTMLElement>("[data-edit]");
    if (!target) return;
    target.focus();
    if (target.matches("[data-edit]")) placeCaretAtEnd(target);
  }

  return {
    element,
    overlay,
    mark,
    nodeOf,
    focusBlock,
    refreshCues() {
      const scene = drawn === undefined ? undefined : session.doc.scenes[drawn];
      if (!scene) return;
      wireCues(scene, slot);
      changed();
    },
    setBuild(on) {
      build.setOn(on);
    },
    destroy() {
      drag.destroy();
      build.destroy();
    },
    get typing() {
      return typing;
    },
    render(sceneId, selectedId) {
      drawn = sceneId;
      const scene = session.doc.scenes[sceneId];
      if (!scene) {
        slot.replaceChildren();
        drag.draw(undefined);
        build.draw(undefined);
        hooks.changed?.();
        return;
      }
      const focused = slot.querySelector<HTMLElement>(
        "[data-edit]:focus, [data-pick]:focus, [data-slider]:focus",
      );
      const focusedId = (focused?.closest<HTMLElement>("[data-id]") ?? focused)?.dataset.id;
      const focusedBar = focused?.dataset.slider === undefined ? undefined : focused.dataset.row;

      const view = h("div", { class: "dc-view" }, renderScene(scene, { assetBase: "" }));
      for (const node of view.querySelectorAll<HTMLElement>("[data-gated]")) node.dataset.revealed = "true";
      const frame = h(
        "div",
        { class: "dc-player ed-frame", "data-theme": session.doc.deck.theme },
        h("div", { class: "dc-stage" }, view),
      );
      for (const field of fieldsOf(scene, view)) wire(field, sceneId);
      wirePicker(scene, view);
      wireCues(scene, view);
      if (hooks.ghosts) drawGhosts(scene, view, hooks.ghosts);
      slot.replaceChildren(frame);
      drag.draw(scene);
      build.draw(scene);
      mark(selectedId);
      if (focusedId) {
        // After an undo or a redo the keyboard stays on the bar it was on.
        const bar =
          focusedBar === undefined
            ? undefined
            : nodeOf(focusedId)?.querySelector<HTMLElement>(`[data-slider][data-row="${focusedBar}"]`);
        if (bar) bar.focus();
        else focusBlock(focusedId);
      }
      changed();
    },
  };
}
