import {
  type ApplyResult,
  addBlock,
  type Block,
  type Frame,
  type Op,
  SAFE_MARGIN,
  type Scene,
  type Session,
  type SlotName,
} from "@depthcue/core";
import { numberText } from "@depthcue/player";
import { slotFor } from "./adder.ts";
import { problemOf } from "./fields.ts";
import { fitted, nudged, type Rect, slideIn } from "./pin.ts";
import { tabSeparated } from "./tablecells.ts";
import { idsInScene, uniqueId } from "./templates.ts";

/*
 * Cut, copy, paste and duplicate for a block. What is copied is the whole block as JSON, so another deck's editor can
 * paste it, and its words as plain text, so any other program gets something readable. A paste is the same
 * `block.add` an add or a drop makes, so it is one step of Undo and review sees it as an edit like any other.
 */

/** What a copied block is on the clipboard. */
export interface Copied {
  /** The envelope, `{"depthcue":"block","version":1,"block":{...}}`. */
  json: string;
  /** The block's words, for any program that only takes text. */
  words: string;
  /** The words again, carrying the envelope in an attribute, which every way of reading the clipboard passes on. */
  html: string;
}

/** What a clipboard offered, in each of the forms we look in. */
export interface Offered {
  json?: string | undefined;
  html?: string | undefined;
  plain?: string | undefined;
}

export type Read = { block: Block } | { problem: string };

const CARRIER = "data-depthcue-block";
const VERSION = 1;

/**
 * The words a block says: its text, its alt text, a chart's title and what each bar says, or a table's rows, tab
 * separated like a spreadsheet's, with its numbers written the way the deck's language writes them.
 */
export function wordsOf(block: Block, language?: string): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "table":
    case "chart":
      return tabSeparated(block, (value) => numberText(value, language));
    case "bar-chart":
      return [block.title, ...block.data.map((row) => `${row.label}: ${row.value}`)]
        .filter((line) => line !== undefined && line !== "")
        .join("\n");
    case "image":
    case "clip":
      return block.alt ?? "";
    default:
      return "";
  }
}

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function copiedBlock(block: Block, language?: string): Copied {
  const json = JSON.stringify({ depthcue: "block", version: VERSION, block });
  const words = wordsOf(block, language);
  const html = `<meta charset="utf-8"><span ${CARRIER}="${escaped(json)}">${escaped(words).replace(/\n/g, "<br>")}</span>`;
  return { json, words, html };
}

const NOT_OURS = "The clipboard holds no block from Depthcue. Copy one first.";

/** The block in an envelope: undefined when the text is not one, a string saying what is wrong when it is a bad one. */
function envelopeIn(text: string | undefined): Block | string | undefined {
  if (!text?.includes('"depthcue"')) return undefined;
  let found: unknown;
  try {
    found = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof found !== "object" || found === null) return undefined;
  const envelope = found as { depthcue?: unknown; version?: unknown; block?: unknown };
  if (envelope.depthcue !== "block") return undefined;
  if (envelope.version !== VERSION)
    return "That block was copied by a newer Depthcue, which this editor cannot read.";
  const block = envelope.block as { type?: unknown } | null;
  if (typeof block !== "object" || block === null || typeof block.type !== "string")
    return "The copied block is damaged, so it was not pasted.";
  return block as Block;
}

/** The envelope a clipboard's HTML carries, if it carries one. */
function carried(html: string | undefined): string | undefined {
  if (!html?.includes(CARRIER)) return undefined;
  const page = new DOMParser().parseFromString(html, "text/html");
  return page.querySelector(`[${CARRIER}]`)?.getAttribute(CARRIER) ?? undefined;
}

/** The block a clipboard offers. The JSON form is read first, then the HTML, then plain text that happens to be an envelope. */
export function blockFrom(offered: Offered): Read {
  for (const text of [offered.json, carried(offered.html), offered.plain]) {
    const found = envelopeIn(text);
    if (found === undefined) continue;
    return typeof found === "string" ? { problem: found } : { block: found };
  }
  return { problem: NOT_OURS };
}

/** The file a block shows, which has to be in the deck. Undefined for a block with no file. */
function fileOf(block: Block): string | undefined {
  if (block.type === "image") return block.asset;
  if (block.type === "clip") return block.source;
  return undefined;
}

/** Why a block cannot go into a deck that does not have its file, or undefined when it can. */
export function missingFile(assets: ReadonlySet<string>, block: Block): string | undefined {
  const file = fileOf(block);
  if (file === undefined || assets.has(file)) return undefined;
  const what = block.type === "image" ? "image" : "video";
  return `That ${what} uses ${file}, which is not in this deck. Add the file to the deck's assets folder first.`;
}

/** The size a block gets when it is pinned where nothing says how large it is, in percent of the slide. */
const PINNED_SIZE: Readonly<Record<string, { w: number; h: number }>> = {
  text: { w: 40, h: 14 },
  "bar-chart": { w: 45, h: 45 },
  chart: { w: 45, h: 45 },
  image: { w: 40, h: 40 },
  clip: { w: 45, h: 30 },
  table: { w: 55, h: 40 },
};
const PINNED_OTHER = { w: 40, h: 30 };

/** A duplicate of a pinned block sits this far, in percent of the slide, down and to the right of the original. */
export const DUPLICATE_OFFSET = 3;

/** A frame moved inside the margin a projector could cut, when it has room there: a block that is wider stays as it is. */
function insideMargin(frame: Frame): Frame {
  const keep = (at: number, size: number) => Math.max(SAFE_MARGIN, Math.min(100 - SAFE_MARGIN - size, at));
  return fitted({ ...frame, x: keep(frame.x, frame.w), y: keep(frame.y, frame.h) });
}

/** A duplicate goes down and to the right of its original, or up and to the left where the margin leaves no room. */
function offsetFrame(frame: Frame): Frame {
  const step = (at: number, size: number) =>
    at + DUPLICATE_OFFSET + size <= 100 - SAFE_MARGIN ? DUPLICATE_OFFSET : -DUPLICATE_OFFSET;
  return nudged(frame, step(frame.x, frame.w), step(frame.y, frame.h));
}

/** Where a pasted block goes. */
export type Where =
  /** Where a drop would put it: after this block, or into the first area that takes it when none is named. */
  | { after: string | undefined; keepFrame?: boolean }
  /** At the end of this area. */
  | { slot: SlotName }
  /** Pinned, centered on this point, which is in percent of the slide. */
  | { pin: { x: number; y: number } };

export type Pasted = { ok: true; id: string; ops: Op[] } | { ok: false; message: string };

/**
 * The operations that paste a copied block into a scene. The block gets an id of its own, keeps only the sources the
 * scene has, and is pinned only where the caller asks. The core's `addBlock` decides where it lands and whether the area
 * takes it, so a paste, an add and a drop agree.
 */
export function pasteInto(scene: Scene, copied: Block, where: Where): Pasted {
  const { frame, sourceIds, ...rest } = copied as Block & { frame?: Block["frame"]; sourceIds?: string[] };
  const sources = new Set((scene.sources ?? []).map((source) => source.id));
  const kept = (sourceIds ?? []).filter((id) => sources.has(id));
  const base = typeof copied.id === "string" ? copied.id : copied.type;
  const id = uniqueId(`${base}-copy`, idsInScene(scene));
  let pinned: Block["frame"];
  if ("pin" in where) {
    const size = frame ?? { ...(PINNED_SIZE[copied.type] ?? PINNED_OTHER), x: 0, y: 0 };
    pinned = insideMargin({ x: where.pin.x - size.w / 2, y: where.pin.y - size.h / 2, w: size.w, h: size.h });
  } else if ("after" in where && where.keepFrame && frame) {
    pinned = offsetFrame(frame);
  }
  const block = {
    ...rest,
    id,
    ...(kept.length > 0 ? { sourceIds: kept } : {}),
    ...(pinned ? { frame: pinned } : {}),
  } as Block;

  let into: SlotName | undefined;
  let after: string | undefined;
  if ("slot" in where) {
    into = where.slot;
  } else {
    after = "after" in where ? where.after : undefined;
    into = slotFor(scene, block.type, after);
    if (into === undefined) return { ok: false, message: "This slide has no place for that." };
  }
  const placed = addBlock(scene, into, block, after);
  return placed.ok ? { ok: true, id, ops: placed.ops } : { ok: false, message: placed.message };
}

/** Where on the slide the pointer was, in percent of it. A slide with no size to measure answers with its middle. */
export function percentOn(slide: Rect | undefined, at: { x: number; y: number }): { x: number; y: number } {
  const box = slide && slideIn(slide);
  if (!box || box.width <= 0 || box.height <= 0) return { x: 50, y: 50 };
  return { x: ((at.x - box.left) / box.width) * 100, y: ((at.y - box.top) / box.height) * 100 };
}

/** Where the menu was opened on the slide: the area under the pointer, if any, and the pointer. */
export interface Here {
  slot: SlotName | undefined;
  at: { x: number; y: number };
}

export interface ClipboardHooks {
  /** The scene on show, and the block or claim chosen on it. */
  scene(): string;
  block(): string | undefined;
  /** Applies what a copy, cut or paste decided, as one undo step. */
  act(ops: readonly Op[]): ApplyResult;
  /** Says why something was refused, or clears the message when `text` is undefined. */
  problem(text: string | undefined): void;
  /** Takes a block out of its scene as one undo step, and moves on to its neighbour. */
  remove(id: string): void;
  /** A block was pasted or duplicated: choose it. */
  added(id: string): void;
  /** The room the slide is drawn in, for turning a pointer position into a place on it. */
  room(): Rect | undefined;
}

export interface BlockClipboard {
  /** Whether Paste could find something: this editor copied a block, or the browser lets it read the clipboard. */
  canPaste(): boolean;
  /** What the menu and the palette do. They write to the clipboard themselves, which a browser allows from a click. */
  copy(id: string): Promise<void>;
  cut(id: string): Promise<void>;
  paste(here?: Here): Promise<void>;
  duplicate(id: string): void;
  /**
   * The copy, cut and paste events, which reach the page for a key press and carry the clipboard with them, so they
   * need no permission. Each answers whether it took the event, and false leaves it to the browser.
   */
  onCopy(data: DataTransfer | null, cut: boolean): boolean;
  onPaste(data: DataTransfer | null): boolean;
}

export function createBlockClipboard(session: Session, hooks: ClipboardHooks): BlockClipboard {
  /** The last block this editor copied, for pasting where the browser will not let the page read the clipboard. */
  let own: { block: Block } | undefined;

  const sceneNow = () => session.doc.scenes[hooks.scene()];
  const blockOf = (id: string | undefined) =>
    id === undefined ? undefined : sceneNow()?.blocks.find((candidate) => candidate.id === id);

  function remember(block: Block): Copied {
    own = { block: JSON.parse(JSON.stringify(block)) as Block };
    return copiedBlock(block, session.doc.deck.language);
  }

  function fill(data: DataTransfer, copied: Copied) {
    data.setData("text/plain", copied.words);
    data.setData("text/html", copied.html);
    data.setData("application/json", copied.json);
  }

  async function write(copied: Copied): Promise<boolean> {
    const blob = (text: string, type: string) => new Blob([text], { type });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": blob(copied.words, "text/plain"),
          "text/html": blob(copied.html, "text/html"),
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** What the clipboard holds, read from a click. Undefined when the browser will not say. */
  async function offered(): Promise<Offered | undefined> {
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard.read === "function") {
        for (const item of await clipboard.read()) {
          const text = async (type: string) =>
            item.types.includes(type) ? await (await item.getType(type)).text() : undefined;
          const found = { html: await text("text/html"), plain: await text("text/plain") };
          if (found.html || found.plain) return found;
        }
        return {};
      }
      if (typeof clipboard.readText === "function") return { plain: await clipboard.readText() };
    } catch {
      // The person said no, or the browser keeps the clipboard to itself.
    }
    return undefined;
  }

  const apply = (ops: readonly Op[]) => {
    const result = hooks.act(ops);
    hooks.problem(result.ok ? undefined : problemOf(result));
    return result.ok;
  };

  /** Puts a block that was copied into the scene on show. `here` is set when the menu was opened on the empty slide. */
  function place(copied: Block, here: Here | undefined) {
    const scene = sceneNow();
    if (!scene) return;
    const refused = missingFile(session.doc.assets, copied);
    if (refused !== undefined) {
      hooks.problem(refused);
      return;
    }
    let planned: Pasted;
    if (here === undefined) {
      // After the chosen block. The claim is no block to go after, so a paste with the claim chosen goes where none is.
      const chosen = hooks.block();
      const after = scene.blocks.some((block) => block.id === chosen) ? chosen : undefined;
      planned = pasteInto(scene, copied, { after });
    } else {
      // An area under the pointer that takes the block gets it. Otherwise it is pinned where the pointer was.
      planned =
        here.slot === undefined ? { ok: false, message: "" } : pasteInto(scene, copied, { slot: here.slot });
      if (!planned.ok) planned = pasteInto(scene, copied, { pin: percentOn(hooks.room(), here.at) });
    }
    if (!planned.ok) {
      hooks.problem(planned.message);
      return;
    }
    if (apply(planned.ops)) hooks.added(planned.id);
  }

  async function paste(here?: Here) {
    const got = await offered();
    let read: Read;
    if (got !== undefined) read = blockFrom(got);
    else if (own) read = { block: own.block };
    else read = { problem: "Press Ctrl V to paste. The browser does not let a menu read the clipboard." };
    if ("problem" in read) {
      hooks.problem(read.problem);
      return;
    }
    place(read.block, here);
  }

  async function copy(id: string) {
    const block = blockOf(id);
    if (!block) return;
    const copied = await write(remember(block));
    hooks.problem(copied ? undefined : "The browser would not copy from a menu. Press Ctrl C instead.");
  }

  function duplicate(id: string) {
    const scene = sceneNow();
    const block = blockOf(id);
    if (!scene || !block) return;
    const planned = pasteInto(scene, block, { after: id, keepFrame: true });
    if (!planned.ok) {
      hooks.problem(planned.message);
      return;
    }
    if (apply(planned.ops)) hooks.added(planned.id);
  }

  return {
    canPaste: () =>
      own !== undefined ||
      (typeof navigator !== "undefined" &&
        (typeof navigator.clipboard?.read === "function" ||
          typeof navigator.clipboard?.readText === "function")),
    copy,
    async cut(id) {
      const block = blockOf(id);
      if (!block) return;
      // Taken out only after the copy, so a block is never lost to a clipboard that said no. Undo brings it back anyway.
      await write(remember(block));
      hooks.remove(id);
    },
    paste,
    duplicate,
    onCopy(data, cut) {
      const id = hooks.block();
      const block = blockOf(id);
      if (!data || !id || !block) return false;
      fill(data, remember(block));
      if (cut) hooks.remove(id);
      hooks.problem(undefined);
      return true;
    },
    onPaste(data) {
      // A pasted file is the browser's to handle, and Depthcue has no clipboard files of its own.
      if (!data || (data.files?.length ?? 0) > 0) return false;
      const read = blockFrom({
        json: data.getData("application/json"),
        html: data.getData("text/html"),
        plain: data.getData("text/plain"),
      });
      if ("problem" in read) {
        hooks.problem(read.problem);
        return false;
      }
      place(read.block, undefined);
      return true;
    },
  };
}
