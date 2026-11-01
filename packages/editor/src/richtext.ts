import { type Flow, isLinkTarget, type Span, TONES, type Tone } from "@depthcue/core";
import { h, renderFlow, renderSpans } from "@depthcue/player";

/*
 * Rich text on the slide: a text of a scene that reads markup is edited as the elements the player draws it with, and
 * what is typed is read back into paragraphs and lists (`Flow`) and written as markup by the core's `serializeText`.
 * Only what the core's markup can say is kept: paragraphs, list items, bold, italic, links and tones. Any other element,
 * whatever way it got into the field, is read for its words alone, and nothing here ever sets HTML.
 */

/** A stretch of text and the elements around it that mean something: bold, italic, a link or a tone. */
interface Run {
  text: string;
  marks: readonly Element[];
}
type Row = { line: Run[] } | { item: Run[]; ordered: boolean; start: number };

const BLOCKS = new Set(
  "P DIV H1 H2 H3 H4 H5 H6 BLOCKQUOTE PRE SECTION ARTICLE LI UL OL TABLE TR TD".split(" "),
);
const SKIPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
const isTone = (name: string | null): name is Tone => (TONES as readonly (string | null)[]).includes(name);
const isList = (el: Node): el is Element =>
  el instanceof Element && (el.tagName === "UL" || el.tagName === "OL");

/** Whether an element is formatting the markup has: a link counts only when its address may be one. */
function isMark(el: Element): boolean {
  switch (el.tagName) {
    case "B":
    case "STRONG":
    case "I":
    case "EM":
      return true;
    case "A":
      return isLinkTarget(el.getAttribute("href") ?? "");
    default:
      return isTone(el.getAttribute("data-tone"));
  }
}

function spanOf(el: Element): Span {
  switch (el.tagName) {
    case "B":
    case "STRONG":
      return { type: "strong", children: [] };
    case "I":
    case "EM":
      return { type: "em", children: [] };
    case "A":
      return { type: "link", href: el.getAttribute("href") as string, children: [] };
    default:
      return { type: "tone", tone: el.getAttribute("data-tone") as Tone, children: [] };
  }
}

/** Nests runs back into spans the way their elements nested, so one `strong` that holds two runs is one span. */
function tree(runs: readonly Run[]): Span[] {
  const top: Span[] = [];
  const open: Array<{ el: Element; kids: Span[] }> = [];
  for (const run of runs) {
    if (run.text === "") continue;
    let shared = 0;
    while (shared < run.marks.length && open[shared]?.el === run.marks[shared]) shared++;
    open.length = shared;
    let kids = open[shared - 1]?.kids ?? top;
    for (const el of run.marks.slice(shared)) {
      const span = spanOf(el);
      kids.push(span);
      kids = (span as { children: Span[] }).children;
      open.push({ el, kids });
    }
    const last = kids[kids.length - 1];
    if (last?.type === "text") last.text += run.text;
    else kids.push({ type: "text", text: run.text });
  }
  return top;
}

/**
 * The paragraphs and lists a rich field shows. The reading is as forgiving as the browser is inventive: `b` and `strong`
 * both bold, a block element or a `br` ends a line, a space the browser made non-breaking is a space, and an empty
 * line, a `div` with only a `br`, is kept. Consecutive lines make one paragraph, as in the markup. `lists` is true for
 * body text; elsewhere a list is read as lines.
 */
export function flowOfDom(root: Node, lists: boolean): Flow[] {
  const rows: Row[] = [];
  let line: Run[] = [];
  /** Inside a list item, which is one line: a `br` is a space and a block is no break. */
  let inItem = false;

  const endLine = (force: boolean) => {
    if (force || line.length > 0) rows.push({ line });
    line = [];
  };
  const walk = (node: Node, marks: readonly Element[]) => {
    if (node instanceof Text) {
      // White space that holds a newline is how the markup was laid out in source, not something a person typed.
      if (/^\s*[\r\n]\s*$/.test(node.data)) return;
      const text = node.data.replace(/ /g, " ").replace(/[\r\n]+/g, " ");
      if (text !== "") line.push({ text, marks });
      return;
    }
    if (!(node instanceof Element) || SKIPPED.has(node.tagName)) return;
    if (node.tagName === "BR") {
      if (!inItem) endLine(true);
      else if (node.nextSibling) line.push({ text: " ", marks });
      return;
    }
    if (lists && isList(node) && !inItem) {
      endLine(false);
      list(node);
      return;
    }
    const block = BLOCKS.has(node.tagName) && !inItem;
    if (block) endLine(false);
    const inner = isMark(node) ? [...marks, node] : marks;
    for (const child of node.childNodes) walk(child, inner);
    if (block) endLine(false);
  };
  const list = (el: Element) => {
    const ordered = el.tagName === "OL";
    const start = Math.min(Math.max(Number.parseInt(el.getAttribute("start") ?? "1", 10) || 1, 0), 999);
    for (const child of el.childNodes) {
      if (isList(child)) list(child);
      else if (child instanceof Element && child.tagName === "LI") {
        const saved = line;
        line = [];
        inItem = true;
        const nested: Element[] = [];
        for (const part of child.childNodes) {
          if (isList(part)) nested.push(part);
          else walk(part, []);
        }
        inItem = false;
        rows.push({ item: line, ordered, start });
        line = saved;
        for (const inside of nested) list(inside);
      }
    }
  };
  for (const child of root.childNodes) walk(child, []);
  endLine(false);

  // Blank lines at either end are not text. Nor are the spaces before the first word and after the last.
  const blank = (row: Row | undefined) =>
    row !== undefined && "line" in row && row.line.every((run) => run.text.trim() === "");
  while (blank(rows[0])) rows.shift();
  while (blank(rows[rows.length - 1])) rows.pop();
  const first = rows[0];
  const head = first && ("line" in first ? first.line : first.item)[0];
  if (head) head.text = head.text.trimStart();
  const final = rows[rows.length - 1];
  const tail = final && ("line" in final ? final.line : final.item).at(-1);
  if (tail) tail.text = tail.text.trimEnd();

  const flow: Flow[] = [];
  let lines: Run[][] = [];
  const endParagraph = () => {
    if (lines.length === 0) return;
    const joined = lines.flatMap((one, at): Run[] => [
      ...(at > 0 ? [{ text: "\n", marks: [] }] : []),
      ...one,
    ]);
    flow.push({ type: "paragraph", children: tree(joined) });
    lines = [];
  };
  for (const row of rows) {
    if ("line" in row) {
      lines.push(row.line);
      continue;
    }
    endParagraph();
    const spans = tree(row.item);
    const last = flow[flow.length - 1];
    if (row.ordered) {
      if (last?.type === "numbers") last.items.push(spans);
      else flow.push({ type: "numbers", start: row.start, items: [spans] });
    } else if (last?.type === "bullets") last.items.push(spans);
    else flow.push({ type: "bullets", items: [spans] });
  }
  endParagraph();
  return flow;
}

/** Draws a text's paragraphs and lists into the field as the player draws them, in place of what was typed. */
export function drawRich(node: HTMLElement, flow: readonly Flow[], lists: boolean) {
  const only = flow[0];
  node.replaceChildren(
    ...(lists ? renderFlow(flow) : only?.type === "paragraph" ? renderSpans(only.children) : []),
  );
}

const MARKER = /^(?:- |(\d{1,3})\. )/;

/**
 * Pasted text as paragraphs and lists, with no formatting read from it: a line that starts `- ` or `1. ` is a list item
 * and everything else is words, so `**x**` pasted is the characters.
 */
export function plainFlow(text: string): Flow[] {
  const flow: Flow[] = [];
  let lines: string[] = [];
  const endParagraph = () => {
    const joined = lines.join("\n");
    if (lines.length > 0)
      flow.push({ type: "paragraph", children: joined ? [{ type: "text", text: joined }] : [] });
    lines = [];
  };
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line);
    if (!marker) {
      lines.push(line);
      continue;
    }
    endParagraph();
    const rest = line.slice(marker[0].length);
    const item: Span[] = rest ? [{ type: "text", text: rest }] : [];
    const last = flow[flow.length - 1];
    if (marker[1] !== undefined) {
      if (last?.type === "numbers") last.items.push(item);
      else flow.push({ type: "numbers", start: Number(marker[1]), items: [item] });
    } else if (last?.type === "bullets") last.items.push(item);
    else flow.push({ type: "bullets", items: [item] });
  }
  endParagraph();
  return flow;
}

/** The selection, when the keyboard is in this field. */
export function rangeIn(node: HTMLElement): Range | undefined {
  const selection = getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  return range && node.contains(range.commonAncestorContainer) ? range : undefined;
}

const select = (range: Range) => {
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/**
 * Puts pasted text in the field at the caret, as words. Text with lines in it that are list items, in a body, makes
 * lists. A heading, caption or quote is one line, so white space in what is pasted is one space.
 */
export function pastePlain(node: HTMLElement, text: string, lists: boolean) {
  const plain = text.replace(/\r\n?/g, "\n");
  if (!lists || !plain.includes("\n")) {
    const one = lists ? plain : plain.replace(/\s+/g, " ");
    if (one) document.execCommand("insertText", false, one);
    return;
  }
  const range = rangeIn(node);
  if (!range) return;
  const parts = plainFlow(plain).flatMap((part) =>
    part.type === "paragraph" ? renderSpans(part.children) : renderFlow([part]),
  );
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  fragment.append(...parts);
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) range.setStartAfter(last);
  range.collapse(true);
  select(range);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What the format bar and the keys ask for. A tone or a link names the one to give the selected words. */
export type Format = "bold" | "italic" | "bullets" | "numbers" | { tone: Tone } | { link: string };

const COMMAND = {
  bold: "bold",
  italic: "italic",
  bullets: "insertUnorderedList",
  numbers: "insertOrderedList",
} as const;

export const LINK_RULE = "A link starts with https:// or mailto: and has no spaces in it.";

const anchorAt = (range: Range) => range.startContainer.parentElement?.closest("a") ?? undefined;
const toneAt = (range: Range, node: HTMLElement) => {
  const found = range.commonAncestorContainer.parentElement?.closest<HTMLElement>("[data-tone]");
  return found && node.contains(found) ? found : undefined;
};

/** The tone of the words the caret is in, or the selected words are in, if they are in one. */
export const toneOf = (node: HTMLElement): Tone | undefined => {
  const range = rangeIn(node);
  const name = range && toneAt(range, node)?.getAttribute("data-tone");
  return isTone(name ?? null) ? (name as Tone) : undefined;
};

export const linkOf = (node: HTMLElement): string | undefined => {
  const range = rangeIn(node);
  return (range && anchorAt(range)?.getAttribute("href")) || undefined;
};

function tone(node: HTMLElement, range: Range, name: Tone): string | undefined {
  const inside = toneAt(range, node);
  if (inside?.getAttribute("data-tone") === name) {
    // Asking again for the tone the words have takes it away.
    inside.replaceWith(...inside.childNodes);
    return undefined;
  }
  if (range.collapsed) return "Select the words to color first.";
  const words = range.extractContents();
  for (const old of words.querySelectorAll("[data-tone]")) old.replaceWith(...old.childNodes);
  const span = h("span", { class: "dc-tone", "data-tone": name });
  span.append(words);
  range.insertNode(span);
  range.selectNodeContents(span);
  select(range);
  return undefined;
}

function link(range: Range, href: string): string | undefined {
  const anchor = anchorAt(range);
  if (href === "") {
    document.execCommand("unlink");
    return undefined;
  }
  if (!isLinkTarget(href)) return LINK_RULE;
  if (range.collapsed) {
    if (!anchor) return "Select the words to link first.";
    anchor.setAttribute("href", href);
    return undefined;
  }
  document.execCommand("createLink", false, href);
  return undefined;
}

/**
 * Formats the selected words of a field, and answers with what stopped it, if anything. It tells the field twice, with
 * `dc-format`, so the change is a step of its own to undo and what is typed next is another; between them the field is
 * told with `input`, as it is for a keystroke. `saved` is the selection to go back to when the keyboard was somewhere
 * else, such as in the box that asks for a link's address.
 */
export function runFormat(node: HTMLElement, how: Format, saved?: Range): string | undefined {
  node.focus({ preventScroll: true });
  if (saved) select(saved);
  const range = rangeIn(node);
  if (!range) return "Put the cursor in the text first.";
  node.dispatchEvent(new Event("dc-format"));
  let problem: string | undefined;
  if (typeof how === "string") document.execCommand(COMMAND[how]);
  else problem = "link" in how ? link(range, how.link) : tone(node, range, how.tone);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("dc-format"));
  return problem;
}

/** Whether bold, italic or a list is on where the caret is. */
export const isOn = (how: "bold" | "italic" | "bullets" | "numbers"): boolean => {
  try {
    return document.queryCommandState(COMMAND[how]);
  } catch {
    return false;
  }
};
