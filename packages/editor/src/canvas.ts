import { type Op, type Scene, type Session, TEXT_LIMITS } from "@depthcue/core";
import { h, renderScene } from "@depthcue/player";
import { describeBlock } from "./templates.ts";

export interface CanvasHooks {
  /** A short line about the field being edited, such as "Heading 42 of 90". `problem` marks a refused edit. */
  hint(text: string, problem: boolean): void;
  /** A block, or the claim, was chosen by focusing its text or activating it. */
  select(id: string): void;
}

export interface Canvas {
  readonly element: HTMLElement;
  /** True while a keystroke is being applied, so the caller does not re-render under the caret. */
  readonly typing: boolean;
  /** Draws a scene, with `selectedId` marked when it is one of the scene's blocks. */
  render(sceneId: string, selectedId?: string): void;
  /** Moves the selection mark without redrawing. */
  mark(id: string | undefined): void;
}

/** One piece of text on a scene that can be edited where it appears. */
interface Field {
  id: string;
  label: string;
  limit: number;
  node: HTMLElement;
  read(scene: Scene): string | undefined;
  write(scene: Scene, text: string): Op;
}

const SUMMARY_LIMIT = 280;

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
  const element = h("div", { class: "ed-canvas-host" });
  let typing = false;
  let visits = 0;

  function wire(field: Field, sceneId: string) {
    const { node } = field;
    node.dataset.edit = "";
    node.setAttribute("role", "textbox");
    node.setAttribute("aria-label", `${field.label} text`);
    node.setAttribute("aria-multiline", "false");
    node.contentEditable = supportsPlaintext() ? "plaintext-only" : "true";
    node.spellcheck = true;
    node.tabIndex = 0;
    let visit = 0;

    const scene = () => session.doc.scenes[sceneId] as Scene;
    const current = () => field.read(scene()) ?? "";

    const check = (text: string): string | undefined => {
      if (text === "") return "Text cannot be empty. Remove the block instead.";
      if (text.length > field.limit) return `${text.length - field.limit} over the limit of ${field.limit}.`;
      return undefined;
    };

    const update = () => {
      const text = flat(node.textContent ?? "").trim();
      const problem = check(text);
      node.toggleAttribute("data-invalid", problem !== undefined);
      hooks.hint(problem ?? `${field.label} ${text.length} of ${field.limit}`, problem !== undefined);
      if (problem !== undefined || text === current()) return;
      typing = true;
      try {
        session.apply([field.write(scene(), text)], { coalesce: `text:${field.id}:${visit}` });
      } finally {
        typing = false;
      }
    };

    node.addEventListener("focus", () => {
      visit = ++visits;
      hooks.hint(`${field.label} ${current().length} of ${field.limit}`, false);
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

  /** Images, charts and clips have no text to type into, so they are chosen by clicking or pressing Enter. */
  function wirePicker(scene: Scene, root: HTMLElement) {
    for (const block of scene.blocks) {
      if (block.type === "text") continue;
      const node = [...root.querySelectorAll<HTMLElement>(".dc-block")].find(
        (candidate) => candidate.dataset.id === block.id,
      );
      if (!node) continue;
      node.dataset.pick = "";
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `${describeBlock(block, 60)}. Select to edit.`);
      node.tabIndex = 0;
      node.addEventListener("click", () => hooks.select(block.id));
      node.addEventListener("keydown", (event) => {
        if (event.target !== node || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        hooks.select(block.id);
      });
    }
  }

  function mark(id: string | undefined) {
    for (const node of element.querySelectorAll<HTMLElement>("[data-selected]")) {
      node.removeAttribute("data-selected");
    }
    if (id === undefined) return;
    const found = [...element.querySelectorAll<HTMLElement>("[data-id]")].find(
      (node) => node.dataset.id === id,
    );
    found?.setAttribute("data-selected", "");
  }

  return {
    element,
    mark,
    get typing() {
      return typing;
    },
    render(sceneId, selectedId) {
      const scene = session.doc.scenes[sceneId];
      if (!scene) {
        element.replaceChildren();
        return;
      }
      const focused = element.querySelector<HTMLElement>("[data-edit]:focus, [data-pick]:focus");
      const focusedId = (focused?.closest<HTMLElement>("[data-id]") ?? focused)?.dataset.id;

      const view = h("div", { class: "dc-view" }, renderScene(scene, { assetBase: "" }));
      for (const node of view.querySelectorAll<HTMLElement>("[data-gated]")) node.dataset.revealed = "true";
      const frame = h(
        "div",
        { class: "dc-player ed-frame", "data-theme": session.doc.deck.theme },
        h("div", { class: "dc-stage" }, view),
      );
      for (const field of fieldsOf(scene, view)) wire(field, sceneId);
      wirePicker(scene, view);
      element.replaceChildren(frame);
      mark(selectedId);

      if (focusedId) {
        const again = [...element.querySelectorAll<HTMLElement>("[data-id]")].find(
          (node) => node.dataset.id === focusedId,
        );
        const target = again?.matches("[data-edit], [data-pick]")
          ? again
          : again?.querySelector<HTMLElement>("[data-edit]");
        if (target) {
          target.focus();
          if (target.matches("[data-edit]")) placeCaretAtEnd(target);
        }
      }
    },
  };
}
