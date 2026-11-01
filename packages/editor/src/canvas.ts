import {
  type Frame,
  isMarker,
  type Op,
  parseText,
  readsMarkup,
  type Scene,
  type Session,
  serializeText,
  TEXT_LIMITS,
  visibleText,
} from "@depthcue/core";
import { applyLook, h, renderScene } from "@depthcue/player";
import { createBuildBadges } from "./buildbadges.ts";
import { CHART_LABEL_MAX, wireBars } from "./chart.ts";
import { type CommentPins, type CommentSurface, createCommentPins } from "./commentpins.ts";
import { type CueBook, clock } from "./cues.ts";
import { problemOf } from "./fields.ts";
import { createFrameDrag } from "./framedrag.ts";
import { drawGhosts, type GhostHooks } from "./ghosts.ts";
import type { Grid, Spot } from "./grid.ts";
import { frameOver, NUDGE, NUDGE_BIG, type Rect, slideIn } from "./pin.ts";
import { drawRich, flowOfDom, pastePlain, rangeIn, runFormat } from "./richtext.ts";
import { createSlotDrag } from "./slotdrag.ts";
import { restingBox, snap, standings } from "./snap.ts";
import { cellFocus, wireTables } from "./tablewire.ts";
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
  /** An arrow key was pressed on a pinned block: move it by `dx` and `dy` percent of the slide. */
  nudge?(id: string, dx: number, dy: number): void;
  /** The cues of the clips. A clip that has some gets a row of places to jump to under it. */
  cues?: CueBook;
  /** Adds to an area of the slide that holds nothing yet, which the slide draws a place for. */
  ghosts?: GhostHooks;
  /** The comments beside the deck. With them the slide draws a pin for each comment of the scene. */
  comments?: CommentSurface;
  /** What Ctrl+Z and Ctrl+Y do in a field of the slide. Without it the session's own undo and redo. */
  history?: { undo(): void; redo(): void };
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
  /**
   * The frame a block fills on the slide now, in percent of it, or undefined when it has no size to measure. Pinning a
   * block with this frame leaves it where it is.
   */
  measure(id: string): Frame | undefined;
  /** The room the slide is drawn in, in pixels, or undefined while no scene is drawn. The slide is the 16 by 9 box inside it. */
  room(): Rect | undefined;
  /** Puts the keyboard on a block: the caret at the end of its text, or the block itself when it has none. */
  focusBlock(id: string): void;
  /** The cell of a table's grid the keyboard last was on, or undefined when the block has no grid. Row -1 is the header. */
  cellOf(id: string): Spot | undefined;
  /** Puts the keyboard on a cell of a table's grid. */
  focusCell(id: string, spot: Spot): void;
  /** Draws the rows of cue chips again from the cue book, without redrawing the slide or resetting a video. */
  refreshCues(): void;
  /** Shows or hides the build order: a badge beside each part that says which step reveals it. */
  setBuild(on: boolean): void;
  /** The pins of the comments on the slide, when the canvas was given comments. */
  readonly comments: CommentPins | undefined;
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
  /** A pinned text is chosen and moved as a block, and is typed in only after Enter or a double click. */
  pinned?: boolean;
  /**
   * Set on a text of a scene that reads markup: the field holds the elements the player draws, is typed in as rich text,
   * and what it reads and writes is markup. `lists` is true for body text. The limit counts what the audience sees.
   */
  rich?: { lists: boolean };
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
    // Body text of a scene that reads markup is a `div` of paragraphs and lists, typed in as a whole.
    const rich = readsMarkup(scene) ? { lists: block.role === "body" } : undefined;
    fields.push({
      id: block.id,
      label: `${block.role[0]?.toUpperCase()}${block.role.slice(1)}`,
      limit: TEXT_LIMITS[block.role],
      node: rich?.lists ? node : (node.querySelector<HTMLElement>("p") ?? node),
      pinned: block.frame !== undefined,
      ...(rich && { rich }),
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
  /** Starts typing in a pinned text, by the id of its block. Filled in each time the slide is drawn. */
  const editors = new Map<string, () => void>();
  /** The grid of each table on the slide, by the id of its block. Drawn again with the slide. */
  let grids = new Map<string, Grid>();
  /** The blocks moved or changed size, so the grips and the toolbar move with them. */
  const changed = () => {
    drag.place();
    pins.place();
    build.place();
    notes?.place();
    hooks.changed?.();
  };

  function wire(field: Field, sceneId: string) {
    const { node, rich } = field;
    node.spellcheck = true;
    let visit = 0;
    /** True while what is typed was refused by the document, so what the field shows is not what the document has. */
    let refused = false;

    const armed = [
      "data-edit",
      "data-rich",
      "role",
      "aria-label",
      "aria-multiline",
      "contenteditable",
      "tabindex",
    ];
    /** What the node carried before it was armed. A pinned text is also its block, which a press chooses and Tab reaches. */
    let before: [string, string | null][] = [];
    /** Makes the text typeable. A pinned text is armed only while it is being edited. */
    const arm = () => {
      before = armed.map((name) => [name, node.getAttribute(name)]);
      node.dataset.edit = "";
      node.setAttribute("role", "textbox");
      node.setAttribute("aria-label", field.name ?? `${field.label} text`);
      node.setAttribute("aria-multiline", String(rich?.lists === true));
      // Rich text is made of elements, so it cannot be plain: its pastes and drops are made plain below instead.
      if (rich) node.dataset.rich = "";
      node.contentEditable = rich || !supportsPlaintext() ? "true" : "plaintext-only";
      node.tabIndex = 0;
    };
    const disarm = () => {
      for (const [name, value] of before) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    };
    /** A pinned text hands the keyboard back to its block when the edit ends from the keyboard. */
    const giveBack = () => {
      if (field.pinned) nodeOf(field.id)?.focus();
    };
    if (field.pinned) {
      editors.set(field.id, () => {
        // A double click on a word of the text being typed in selects the word, and leaves the caret there.
        if (node.hasAttribute("data-edit")) return;
        arm();
        node.focus();
        placeCaretAtEnd(node);
      });
    } else {
      arm();
    }

    const scene = () => session.doc.scenes[sceneId] as Scene;
    const current = () => field.read(scene()) ?? "";
    /** How long a text is for the limit: as the audience sees it, so markup and list markers do not count. */
    const lengthOf = (text: string) => (rich ? visibleText(parseText(text, rich)).length : text.length);
    /** What the field holds now, as the text the document would keep and the length the limit is about. */
    const readNode = () => {
      if (!rich) {
        const text = flat(node.textContent ?? "").trim();
        return { text, length: text.length };
      }
      const flow = flowOfDom(node, rich.lists);
      return { text: serializeText(flow, rich), length: visibleText(flow).length };
    };

    const check = ({ text, length }: { text: string; length: number }): string | undefined => {
      if (rich ? length === 0 : text === "")
        return field.empty ?? "Text cannot be empty. Remove the block instead.";
      if (length > field.limit) {
        const over = `${length - field.limit} over the limit of ${field.limit}.`;
        return rich ? `${over} Shorten it, or move the detail into a body block or the reading text.` : over;
      }
      return undefined;
    };

    /** Puts what the document says in the field, in place of what was typed and refused. */
    const showDocument = () => {
      if (rich) drawRich(node, parseText(current(), rich), rich.lists);
      else node.textContent = current();
    };

    const update = () => {
      const now = readNode();
      const problem = check(now);
      node.toggleAttribute("data-invalid", problem !== undefined);
      hooks.hint(problem ?? `${field.label} ${now.length} of ${field.limit}`, problem !== undefined);
      hooks.typed?.(field.id, now.length, field.limit);
      changed();
      refused = problem !== undefined;
      if (problem !== undefined || now.text === current()) return;
      typing = true;
      try {
        const result = session.apply([field.write(scene(), now.text)], {
          coalesce: `text:${field.key ?? field.id}:${visit}`,
        });
        // Markup can be refused though its words are in the limit: a tone too faint to read, or too much formatting.
        if (!result.ok) {
          refused = true;
          node.toggleAttribute("data-invalid", true);
          hooks.hint(problemOf(result), true);
        }
      } finally {
        typing = false;
      }
    };

    node.addEventListener("focus", () => {
      visit = ++visits;
      hooks.hint(`${field.label} ${lengthOf(current())} of ${field.limit}`, false);
      hooks.typed?.(field.id, lengthOf(current()), field.limit);
      hooks.select(field.id);
    });
    node.addEventListener("input", update);
    // A format command is one step to undo, and what is typed after it another.
    node.addEventListener("dc-format", () => {
      visit = ++visits;
    });
    node.addEventListener("beforeinput", (event) => {
      const type = event.inputType;
      if (rich && (type === "insertFromDrop" || type === "insertFromPasteAsQuotation")) {
        // Dropped text would bring its own elements with it. Plain text is pasted, and a drop is not a paste.
        event.preventDefault();
      } else if (rich?.lists && (type === "insertParagraph" || type === "insertLineBreak")) {
        // In body text Enter is a new line, or a new item in a list, which the browser makes itself.
        if (type === "insertParagraph" && !rangeIn(node)?.startContainer.parentElement?.closest("li")) {
          event.preventDefault();
          document.execCommand("insertLineBreak");
        }
      } else if (type === "insertParagraph" || type === "insertLineBreak") {
        // One line each: Enter finishes the edit. History belongs to the session, not to the browser.
        event.preventDefault();
        node.blur();
        giveBack();
      } else if (event.inputType === "historyUndo") {
        event.preventDefault();
        if (hooks.history) hooks.history.undo();
        else session.undo();
      } else if (event.inputType === "historyRedo") {
        event.preventDefault();
        if (hooks.history) hooks.history.redo();
        else session.redo();
      }
    });
    node.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (rich) pastePlain(node, text, rich.lists);
      else if (flat(text)) document.execCommand("insertText", false, flat(text));
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        // The block of a pinned text is this node, and its own Escape would let go of the choice.
        event.preventDefault();
        showDocument();
        node.removeAttribute("data-invalid");
        node.blur();
        if (field.pinned) giveBack();
        else hooks.deselect?.();
        return;
      }
      // Inside a rich text these keys are the text's. Elsewhere Ctrl+K stays the palette, which is why the key is stopped
      // here: the palette does not take a key that something has already used.
      if (!rich || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i") {
        event.preventDefault();
        const problem = runFormat(node, key === "b" ? "bold" : "italic");
        if (problem !== undefined) hooks.hint(problem, true);
      } else if (key === "k") {
        event.preventDefault();
        node.dispatchEvent(new Event("dc-link", { bubbles: true }));
      }
    });
    const settle = () => {
      const now = readNode();
      if (check(now) !== undefined || refused) {
        // Refused edits never reached the document, so show what it still says.
        showDocument();
      } else if (rich) {
        // The elements the browser made are replaced by the ones the player would draw for the same words.
        drawRich(node, flowOfDom(node, rich.lists), rich.lists);
      } else if (node.textContent !== now.text) {
        node.textContent = now.text;
      }
      refused = false;
      node.removeAttribute("data-invalid");
      hooks.hint("", false);
      if (field.pinned) disarm();
    };
    node.addEventListener("blur", (event) => {
      // The keyboard is on its way to the box that asks for a link's address, and the selection has to wait there.
      const to = event.relatedTarget;
      if (rich && to instanceof Element && to.closest("[data-formatbar]")) return;
      settle();
    });
    // The box that asked for an address let go of the keyboard somewhere other than the text.
    node.addEventListener("dc-settle", settle);
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

  /**
   * Images, charts and clips have no text to type into, so they are chosen by clicking or pressing Enter. A pinned text
   * is chosen the same way, because a press on it starts a move and not a caret; Enter or a double click types in it.
   */
  function wirePicker(scene: Scene, root: HTMLElement) {
    for (const block of scene.blocks) {
      if (block.type === "text" && !block.frame) continue;
      const node = [...root.querySelectorAll<HTMLElement>(".dc-block")].find(
        (candidate) => candidate.dataset.id === block.id,
      );
      if (!node) continue;
      node.dataset.pick = "";
      // A chart holds sliders and text fields of its own, a clip a player and its cue chips, and a table its cells,
      // which a button may not contain.
      node.setAttribute(
        "role",
        block.type === "bar-chart" || block.type === "clip" || block.type === "table" ? "group" : "button",
      );
      const missingAlt = needsAlt(block);
      node.toggleAttribute("data-alt-missing", missingAlt);
      node.setAttribute(
        "aria-label",
        `${describeBlock(block, 60, scene)}.${missingAlt ? " Alt text is missing." : ""} ${
          block.type === "text" ? "Pinned. Press Enter to type in it." : "Select to edit."
        }`,
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
      if (block.type === "text") node.addEventListener("dblclick", () => editors.get(block.id)?.());
      node.addEventListener("keydown", (event) => {
        // While a pinned text is being typed in, its keys are the text's: Delete, arrows and Enter act on the caret.
        if (event.target !== node || event.defaultPrevented || node.hasAttribute("data-edit")) return;
        if (event.key === "Enter" && block.type === "text") {
          event.preventDefault();
          editors.get(block.id)?.();
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          hooks.select(block.id);
        } else if (event.key === "Escape") {
          hooks.deselect?.();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          hooks.remove?.(block.id);
        } else if (block.frame && event.key.startsWith("Arrow")) {
          const step = event.shiftKey ? NUDGE_BIG : NUDGE;
          event.preventDefault();
          hooks.nudge?.(
            block.id,
            event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
            event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
          );
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
    pins.mark(id);
    if (id === undefined) return;
    nodeOf(id)?.setAttribute("data-selected", "");
  }

  const drag = createSlotDrag(session, element, overlay, nodeOf, {
    select: (id) => hooks.select(id),
    hint: (text, problem) => hooks.hint(text, problem),
    act: (ops) => session.apply(ops),
  });

  const pins = createFrameDrag(session, element, overlay, nodeOf, {
    select: (id) => hooks.select(id),
    hint: (text, problem) => hooks.hint(text, problem),
    act: (ops) => session.apply(ops),
    changed,
  });

  const build = createBuildBadges(session, element, overlay, nodeOf, {
    act: (ops) => session.apply(ops),
    problem: (text) => hooks.hint(text ?? "", text !== undefined),
  });

  // After the badges, so a thread opens over them, and before the toolbar, which the editor adds to the overlay later.
  const notes = hooks.comments && createCommentPins(session, element, overlay, nodeOf, hooks.comments);

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
    measure(id) {
      const node = nodeOf(id);
      const room = slot.querySelector<HTMLElement>(".dc-view");
      if (!node || !room) return undefined;
      return frameOver(restingBox(node), slideIn(room.getBoundingClientRect()));
    },
    room() {
      const room = slot.querySelector<HTMLElement>(".dc-view");
      return room ? room.getBoundingClientRect() : undefined;
    },
    focusBlock,
    cellOf: (id) => grids.get(id)?.active,
    focusCell: (id, spot) => grids.get(id)?.focus(spot),
    refreshCues() {
      const scene = drawn === undefined ? undefined : session.doc.scenes[drawn];
      if (!scene) return;
      wireCues(scene, slot);
      changed();
    },
    setBuild(on) {
      build.setOn(on);
    },
    comments: notes,
    destroy() {
      for (const grid of grids.values()) grid.destroy();
      drag.destroy();
      pins.destroy();
      build.destroy();
      notes?.destroy();
    },
    get typing() {
      return typing;
    },
    render(sceneId, selectedId) {
      const again = drawn === sceneId;
      drawn = sceneId;
      const scene = session.doc.scenes[sceneId];
      if (!scene) {
        for (const grid of grids.values()) grid.destroy();
        grids = new Map();
        slot.replaceChildren();
        drag.draw(undefined);
        pins.draw(undefined);
        build.draw(undefined);
        notes?.draw(undefined);
        hooks.changed?.();
        return;
      }
      const focused = slot.querySelector<HTMLElement>(
        "[data-edit]:focus, [data-pick]:focus, [data-slider]:focus",
      );
      const focusedId = (focused?.closest<HTMLElement>("[data-id]") ?? focused)?.dataset.id;
      const focusedBar = focused?.dataset.slider === undefined ? undefined : focused.dataset.row;

      // A cell that has the keyboard is told apart from the rest of the slide, so it gets the keyboard back after a redraw.
      const cellAt = cellFocus(slot);
      const view = h(
        "div",
        { class: "dc-view" },
        renderScene(scene, { assetBase: "", language: session.doc.deck.language }),
      );
      for (const node of view.querySelectorAll<HTMLElement>("[data-gated]")) node.dataset.revealed = "true";
      const frame = h("div", { class: "dc-player ed-frame" }, h("div", { class: "dc-stage" }, view));
      applyLook(frame, session.doc.deck);
      editors.clear();
      for (const field of fieldsOf(scene, view)) wire(field, sceneId);
      wirePicker(scene, view);
      for (const grid of grids.values()) grid.destroy();
      grids = wireTables(session, scene, view, {
        select: hooks.select,
        leave: focusBlock,
        hint: hooks.hint,
        quietly(change) {
          typing = true;
          try {
            change();
          } finally {
            typing = false;
          }
        },
        changed,
      });
      wireCues(scene, view);
      if (hooks.ghosts) drawGhosts(scene, view, hooks.ghosts);
      // A block that goes into its slot, or out of it, slides there from where it stood. Only a slide with a pin on
      // either side of the change can have one, so any other is drawn without measuring.
      const before =
        again && (slot.querySelector(".dc-pinned") || scene.blocks.some((block) => block.frame))
          ? standings(slot)
          : undefined;
      slot.replaceChildren(frame);
      drag.draw(scene);
      pins.draw(scene);
      build.draw(scene);
      notes?.draw(scene);
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
      // A table the keyboard was in keeps it, on the cell it was on, or the nearest one when the table got smaller.
      if (cellAt) grids.get(cellAt.id)?.focus(cellAt.spot);
      changed();
      // Last, so everything drawn above is placed where the blocks end up. What measures a block later, the toolbar
      // and the pin, asks for `restingBox`, which ignores a slide still on its way.
      if (before) snap(slot, before);
    },
  };
}
