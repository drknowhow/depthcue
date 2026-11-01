/**
 * Inline markup: the small Markdown subset that a text block is written in from schema 0.3.
 *
 * - `**bold**` and `*italic*`, paired much the way CommonMark pairs them, so a `*` with a space on each side is a star.
 *   Two differences: a star opens or closes by the space next to it alone, so `a*b*c` is italic inside a word, and what
 *   is left of a run after it pairs counts as its own run for the rule of three.
 * - `[label](https://...)` and `[label](mailto:...)` are links. Any other address leaves the whole thing as written.
 * - `[label]{tone}` colors the label with a palette color that may color text (`TONES`).
 * - A backslash before ASCII punctuation makes that character plain. Before anything else it is a backslash.
 * - In body text only, a line that starts `- ` is a bullet, and one that starts with a number, a dot and a space, such
 *   as `1. `, is a numbered item. Consecutive items make one list.
 *
 * Markup that does not match is literal text: nothing is ever refused for its markup. The parser returns a tree and
 * never HTML, so a renderer builds DOM nodes from it and no text reaches the page as markup.
 *
 * `serializeText` writes a tree back. `serializeText(parseText(s))` gives `s` back for every `s` it wrote itself, the
 * canonical form; other strings come back in that form with the same meaning.
 */
import { TONES } from "./schema.ts";

export type Tone = (typeof TONES)[number];

/** A run of text and the formatting around it. Children are never empty. */
export type Span =
  | { type: "text"; text: string }
  | { type: "strong"; children: Span[] }
  | { type: "em"; children: Span[] }
  | { type: "link"; href: string; children: Span[] }
  | { type: "tone"; tone: Tone; children: Span[] };

/**
 * A paragraph or a list. A paragraph keeps its line breaks in its text, empty lines included. A list item is one line.
 * A numbered list counts up from `start`.
 */
export type Flow =
  | { type: "paragraph"; children: Span[] }
  | { type: "bullets"; items: Span[][] }
  | { type: "numbers"; start: number; items: Span[][] };

/** Whether lines may be list items: true for body text, false for headings, captions and quotes. */
export interface TextOptions {
  lists: boolean;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const SPACE = /\s/;
/** A link address: https or mailto, with no space, bracket, parenthesis, angle bracket or backslash in it. */
const LINK = /^(?:https:\/\/|mailto:)[^\s()[\]<>\\]+$/;
const BULLET = /^- /;
const NUMBER = /^(\d{1,3})\. /;

const isTone = (name: string): name is Tone => (TONES as readonly string[]).includes(name);
const escapes = (text: string, at: number): boolean =>
  text[at] === "\\" && at + 1 < text.length && PUNCTUATION.test(text[at + 1] as string);

interface Delimiter {
  kind: "delimiter";
  /** Stars still unmatched. */
  count: number;
  /** Stars in the run as written, for CommonMark's rule of three. */
  length: number;
  open: boolean;
  close: boolean;
}
type Token = { kind: "text"; text: string } | { kind: "span"; span: Span } | Delimiter;

/** Where each `[` that has a partner closes, ignoring escaped brackets. */
function brackets(text: string): Map<number, number> {
  const partner = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (escapes(text, i)) i++;
    else if (text[i] === "[") open.push(i);
    else if (text[i] === "]" && open.length > 0) partner.set(open.pop() as number, i);
  }
  return partner;
}

/** A link or a tone span starting at `start`, whose label closes at `end`, or undefined when it is not one. */
function bracketSpan(
  text: string,
  start: number,
  end: number,
  inLink: boolean,
): { span: Span; next: number } | undefined {
  const label = text.slice(start + 1, end);
  const opener = text[end + 1];
  if (label.length === 0 || (opener !== "(" && opener !== "{")) return undefined;
  const close = text.indexOf(opener === "(" ? ")" : "}", end + 2);
  if (close < 0) return undefined;
  const target = text.slice(end + 2, close);
  if (opener === "(") {
    // A link inside a link label has nowhere to go, so it stays as written.
    if (inLink || !LINK.test(target)) return undefined;
    return { span: { type: "link", href: target, children: parseSpans(label, true) }, next: close + 1 };
  }
  if (!isTone(target)) return undefined;
  return { span: { type: "tone", tone: target, children: parseSpans(label, inLink) }, next: close + 1 };
}

function spansOf(tokens: readonly Token[]): Span[] {
  const out: Span[] = [];
  const push = (text: string) => {
    if (text.length === 0) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += text;
    else out.push({ type: "text", text });
  };
  for (const token of tokens) {
    if (token.kind === "text") push(token.text);
    else if (token.kind === "delimiter") push("*".repeat(token.count));
    else out.push(token.span);
  }
  return out;
}

/** CommonMark's rule of three: a run that could open and close does not pair with one whose length makes a multiple. */
const ruleOfThree = (opener: Delimiter, closer: Delimiter): boolean =>
  (opener.close || closer.open) &&
  (opener.length + closer.length) % 3 === 0 &&
  !(opener.length % 3 === 0 && closer.length % 3 === 0);

/** Pairs star runs into bold and italic, innermost first, the way CommonMark's emphasis algorithm does. */
function emphasis(tokens: Token[]): Span[] {
  const openers: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const closer = tokens[i] as Token;
    if (closer.kind !== "delimiter") continue;
    let k = openers.length - 1;
    while (closer.close && closer.count > 0 && k >= 0) {
      const at = openers[k] as number;
      const opener = tokens[at] as Delimiter;
      if (ruleOfThree(opener, closer)) {
        k--;
        continue;
      }
      const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      const inside = tokens.splice(at + 1, i - at - 1);
      tokens.splice(at + 1, 0, {
        kind: "span",
        span: { type: use === 2 ? "strong" : "em", children: spansOf(inside) },
      });
      i = at + 2;
      opener.count -= use;
      closer.count -= use;
      // What is left of a run counts as a run of its own for the rule of three. A closing `*` written right before an
      // opening `**` merges into `***`, and the `**` it leaves must pair the way it would have alone.
      opener.length = opener.count;
      closer.length = closer.count;
      // Openers between the pair are inside it now, and stay as stars.
      openers.length = k + 1;
      if (opener.count === 0) {
        openers.pop();
        k--;
      }
    }
    if (closer.open && closer.count > 0) openers.push(i);
  }
  return spansOf(tokens);
}

/** The spans of one paragraph, list item or label. `inLink` is true inside a link's label. */
function parseSpans(text: string, inLink: boolean): Span[] {
  const partner = brackets(text);
  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) tokens.push({ kind: "text", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (escapes(text, i)) {
      plain += text[i + 1];
      i += 2;
    } else if (char === "*") {
      let end = i;
      while (text[end] === "*") end++;
      const before = text[i - 1];
      const after = text[end];
      flush();
      tokens.push({
        kind: "delimiter",
        count: end - i,
        length: end - i,
        open: after !== undefined && !SPACE.test(after),
        close: before !== undefined && !SPACE.test(before),
      });
      i = end;
    } else {
      const end = char === "[" ? partner.get(i) : undefined;
      const found = end === undefined ? undefined : bracketSpan(text, i, end, inLink);
      if (found) {
        flush();
        tokens.push({ kind: "span", span: found.span });
        i = found.next;
      } else {
        plain += char;
        i++;
      }
    }
  }
  flush();
  return emphasis(tokens);
}

/** Reads markup into paragraphs and lists. Any string is valid: what is not markup is text. */
export function parseText(text: string, options: TextOptions): Flow[] {
  if (!options.lists) return [{ type: "paragraph", children: parseSpans(text, false) }];
  const out: Flow[] = [];
  let lines: string[] | undefined;
  const endParagraph = () => {
    if (lines) out.push({ type: "paragraph", children: parseSpans(lines.join("\n"), false) });
    lines = undefined;
  };
  for (const line of text.split("\n")) {
    const number = NUMBER.exec(line);
    const marker = number ? number[0] : BULLET.test(line) ? "- " : undefined;
    if (marker === undefined) {
      if (lines) lines.push(line);
      else lines = [line];
      continue;
    }
    endParagraph();
    const item = parseSpans(line.slice(marker.length), false);
    const last = out[out.length - 1];
    if (number) {
      if (last?.type === "numbers") last.items.push(item);
      else out.push({ type: "numbers", start: Number(number[1]), items: [item] });
    } else if (last?.type === "bullets") last.items.push(item);
    else out.push({ type: "bullets", items: [item] });
  }
  endParagraph();
  return out;
}

/** Text that the parser reads as exactly `text`: one paragraph with no formatting. */
export const literalText = (text: string): Flow[] => [{ type: "paragraph", children: textSpans(text) }];

const textSpans = (text: string): Span[] => (text.length > 0 ? [{ type: "text", text }] : []);

function spanText(spans: readonly Span[]): string {
  return spans.map((span) => (span.type === "text" ? span.text : spanText(span.children))).join("");
}

/** The text the audience sees: no markup, no link addresses and no list markers, with a line break between lines. */
export function visibleText(flow: readonly Flow[]): string {
  return flow
    .map((block) =>
      block.type === "paragraph" ? spanText(block.children) : block.items.map(spanText).join("\n"),
    )
    .join("\n");
}

interface Context {
  strong: boolean;
  em: boolean;
  /** Inside a link's or a tone's label, where every bracket must be escaped. */
  label: boolean;
  link: boolean;
  /** A list item, which is one line and has its marker already written. */
  item: boolean;
}

const TOP: Context = { strong: false, em: false, label: false, link: false, item: false };

const sameSpan = (a: Span, b: Span): boolean =>
  a.type === b.type &&
  (a.type !== "link" || a.href === (b as { href: string }).href) &&
  (a.type !== "tone" || a.tone === (b as { tone: Tone }).tone);

/**
 * The spans as they can be written: formatting already in force is dropped, bold and italic give their leading and
 * trailing spaces to the text around them (markup cannot open or close on a space), and neighbours of one kind merge.
 */
function normalize(spans: readonly Span[], context: Context): Span[] {
  const out: Span[] = [];
  const push = (span: Span) => {
    const last = out[out.length - 1];
    if (span.type === "text") {
      if (span.text.length === 0) return;
      if (last?.type === "text") last.text += span.text;
      else out.push({ ...span });
    } else if (last && last.type !== "text" && sameSpan(last, span)) {
      last.children = normalize([...last.children, ...span.children], inner(context, span));
    } else out.push(span);
  };
  for (const span of spans) {
    if (span.type === "text") {
      push({ type: "text", text: context.item ? span.text.replace(/\n/g, " ") : span.text });
      continue;
    }
    const children = normalize(span.children, inner(context, span));
    const redundant =
      (span.type === "strong" && context.strong) ||
      (span.type === "em" && context.em) ||
      (span.type === "link" && context.link);
    if (redundant || children.length === 0) {
      for (const child of children) push(child);
      continue;
    }
    if (span.type === "strong" || span.type === "em") {
      const text = spanText(children);
      const lead = /^\s*/.exec(text)?.[0] ?? "";
      const trail = text.length > lead.length ? (/\s*$/.exec(text)?.[0] ?? "") : "";
      if (lead.length === text.length) {
        push({ type: "text", text });
        continue;
      }
      push({ type: "text", text: lead });
      const trimmed = trim(children, lead.length, trail.length);
      // Bold around nothing but italic is written as italic around bold: `***x***` reads that way.
      const only = trimmed.length === 1 ? trimmed[0] : undefined;
      if (span.type === "strong" && only?.type === "em") {
        push({ type: "em", children: [{ type: "strong", children: only.children }] });
      } else push({ ...span, children: trimmed });
      push({ type: "text", text: trail });
      continue;
    }
    push({ ...span, children });
  }
  return out;
}

const inner = (context: Context, span: Span): Context => ({
  ...context,
  strong: context.strong || span.type === "strong",
  em: context.em || span.type === "em",
  label: context.label || span.type === "link" || span.type === "tone",
  link: context.link || span.type === "link",
});

/** `spans` with `start` characters taken off the front and `end` off the back, from their text. */
function trim(spans: readonly Span[], start: number, end: number): Span[] {
  const out = spans.map((span) => ({ ...span }));
  let cut = start;
  for (let i = 0; cut > 0 && i < out.length; i++) cut = trimEdge(out, i, cut, true);
  cut = end;
  for (let i = out.length - 1; cut > 0 && i >= 0; i--) cut = trimEdge(out, i, cut, false);
  return out.filter((span) => (span.type === "text" ? span.text.length > 0 : span.children.length > 0));
}

function trimEdge(spans: Span[], index: number, cut: number, front: boolean): number {
  const span = spans[index] as Span;
  if (span.type === "text") {
    const take = Math.min(cut, span.text.length);
    spans[index] = {
      type: "text",
      text: front ? span.text.slice(take) : span.text.slice(0, span.text.length - take),
    };
    return cut - take;
  }
  const children = trim(span.children, front ? cut : 0, front ? 0 : cut);
  const removed = spanText(span.children).length - spanText(children).length;
  spans[index] = { ...span, children };
  return cut - removed;
}

interface Writer {
  out: string;
  /** Whether a line may be a list item, so a line that only looks like one is escaped. */
  lists: boolean;
}

const lineStart = (w: Writer): boolean => w.out.length === 0 || w.out.endsWith("\n");

/** True when the star at `at` is in a run with white space on both sides, which can neither open nor close. */
function inertStar(text: string, at: number): boolean {
  let start = at;
  while (text[start - 1] === "*") start--;
  let end = at;
  while (text[end] === "*") end++;
  const before = text[start - 1];
  const after = text[end];
  return before !== undefined && after !== undefined && SPACE.test(before) && SPACE.test(after);
}

/** Writes plain text so that it reads back as itself. `followed` is true when markup comes right after it. */
function writeText(w: Writer, text: string, context: Context, followed: boolean) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (lineStart(w) && w.lists && !context.item) {
      const number = NUMBER.exec(text.slice(i));
      if (number) {
        w.out += `${number[1]}\\. `;
        i += number[0].length - 1;
        continue;
      }
      if (BULLET.test(text.slice(i))) {
        w.out += "\\-";
        continue;
      }
    }
    const next = text[i + 1];
    if (char === "\\") {
      const doubled = next === undefined ? followed : PUNCTUATION.test(next);
      w.out += doubled ? "\\\\" : "\\";
    } else if (char === "*") {
      w.out += inertStar(text, i) ? "*" : "\\*";
    } else if ((char === "[" || char === "]") && context.label) {
      w.out += `\\${char}`;
    } else if (char === "]" && (next === "(" || next === "{")) {
      w.out += "\\]";
    } else w.out += char;
  }
}

function writeSpans(w: Writer, spans: readonly Span[], context: Context, closed: boolean) {
  spans.forEach((span, index) => {
    const followed = closed || index < spans.length - 1;
    if (span.type === "text") {
      writeText(w, span.text, context, followed);
      return;
    }
    const within = inner(context, span);
    if (span.type === "strong" || span.type === "em") {
      const mark = span.type === "strong" ? "**" : "*";
      w.out += mark;
      writeSpans(w, span.children, within, true);
      w.out += mark;
    } else {
      w.out += "[";
      writeSpans(w, span.children, within, true);
      w.out += span.type === "link" ? `](${span.href})` : `]{${span.tone}}`;
    }
  });
}

/**
 * Writes paragraphs and lists as markup that `parseText` reads back the same. A link whose address is not https or
 * mailto would read back as text, so give links only addresses that `isLinkTarget` accepts.
 */
export function serializeText(flow: readonly Flow[], options: TextOptions): string {
  const w: Writer = { out: "", lists: options.lists };
  flow.forEach((block, index) => {
    if (index > 0) w.out += "\n";
    if (block.type === "paragraph") {
      writeSpans(w, normalize(block.children, TOP), TOP, false);
      return;
    }
    const item = { ...TOP, item: true };
    // A marker has at most three digits, and only the first item's number counts, so later ones stop at 999.
    const start = block.type === "numbers" ? Math.min(Math.max(Math.trunc(block.start), 0), 999) : 0;
    block.items.forEach((spans, i) => {
      if (i > 0) w.out += "\n";
      w.out += block.type === "bullets" ? "- " : `${Math.min(start + i, 999)}. `;
      writeSpans(w, normalize(spans, item), item, false);
    });
  });
  return w.out;
}

/** True when `text` read as markup is just `text`: no formatting, no link, no list and no escape in it. */
export function readsAsWritten(text: string, options: TextOptions): boolean {
  const flow = parseText(text, options);
  const only = flow.length === 1 ? flow[0] : undefined;
  if (only?.type !== "paragraph") return false;
  const [span, ...rest] = only.children;
  return span === undefined ? text === "" : rest.length === 0 && span.type === "text" && span.text === text;
}

/**
 * Markup that reads as exactly `text`. Text that already does comes back as it is; otherwise each character that would
 * be markup gets a backslash, the way `serializeText` writes plain text.
 */
export const escapeText = (text: string, options: TextOptions): string =>
  readsAsWritten(text, options) ? text : serializeText(literalText(text), options);

/** True for an address a link may have: https or mailto. */
export const isLinkTarget = (href: string): boolean => LINK.test(href);
