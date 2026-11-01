import { describe, expect, it } from "vitest";
import {
  escapeText,
  type Flow,
  literalText,
  parseText,
  readsAsWritten,
  type Span,
  serializeText,
  visibleText,
} from "../src/index.ts";

const body = { lists: true };
const line = { lists: false };
const spans = (text: string): Span[] => {
  const [first] = parseText(text, line);
  if (first?.type !== "paragraph") throw new Error("expected one paragraph");
  return first.children;
};
const t = (text: string): Span => ({ type: "text", text });

/**
 * Each character the audience sees, with the formatting on it, so two trees that mean the same compare equal. Spaces
 * are left out: markup cannot hold bold or italic at the edge of a span, so the writer moves them out of it.
 */
function marks(flow: Flow[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly Span[], on: ReadonlySet<string>) => {
    for (const span of list) {
      if (span.type === "text") {
        for (const char of span.text) if (!/\s/.test(char)) out.push([char, ...[...on].sort()].join("|"));
      } else {
        const mark =
          span.type === "link" ? `link ${span.href}` : span.type === "tone" ? `tone ${span.tone}` : span.type;
        walk(span.children, new Set([...on, mark]));
      }
    }
  };
  for (const block of flow) {
    if (block.type === "paragraph") walk(block.children, new Set());
    else for (const item of block.items) walk(item, new Set([block.type]));
  }
  return out;
}

describe("reading markup", () => {
  it("reads bold, italic and both", () => {
    expect(spans("a **b** c")).toEqual([t("a "), { type: "strong", children: [t("b")] }, t(" c")]);
    expect(spans("*b*")).toEqual([{ type: "em", children: [t("b")] }]);
    expect(spans("***b***")).toEqual([{ type: "em", children: [{ type: "strong", children: [t("b")] }] }]);
    expect(spans("**a *b* c**")).toEqual([
      { type: "strong", children: [t("a "), { type: "em", children: [t("b")] }, t(" c")] },
    ]);
  });

  it("leaves a star with a space on each side, and an unmatched one, as a star", () => {
    expect(spans("5 * 3 = 15")).toEqual([t("5 * 3 = 15")]);
    expect(spans("a *b")).toEqual([t("a *b")]);
    expect(spans("**")).toEqual([t("**")]);
    expect(spans("* a *")).toEqual([t("* a *")]);
  });

  it("reads https and mailto links, and leaves every other address as written", () => {
    expect(spans("see [the report](https://example.com/q3)")).toEqual([
      t("see "),
      { type: "link", href: "https://example.com/q3", children: [t("the report")] },
    ]);
    expect(spans("[mail](mailto:team@example.com)")).toEqual([
      { type: "link", href: "mailto:team@example.com", children: [t("mail")] },
    ]);
    for (const text of [
      "[x](http://example.com)",
      "[x](javascript:alert(1))",
      "[x](data:text/html,hi)",
      "[x](https://a b)",
      "[x](example.com)",
      "[](https://example.com)",
    ]) {
      expect(spans(text), text).toEqual([t(text)]);
    }
  });

  it("colors a label with a tone, and only with a tone that may color text", () => {
    expect(spans("[up 12%]{action}")).toEqual([{ type: "tone", tone: "action", children: [t("up 12%")] }]);
    expect(spans("[x]{bg}")).toEqual([t("[x]{bg}")]);
    expect(spans("[x]{red}")).toEqual([t("[x]{red}")]);
  });

  it("reads markup inside a label, but no link inside a link", () => {
    expect(spans("[**big**]{evidence}")).toEqual([
      { type: "tone", tone: "evidence", children: [{ type: "strong", children: [t("big")] }] },
    ]);
    expect(spans("[a [b](https://x.io)](https://y.io)")).toEqual([
      { type: "link", href: "https://y.io", children: [t("a [b](https://x.io)")] },
    ]);
  });

  it("treats a backslash before punctuation as an escape, and any other backslash as itself", () => {
    expect(spans("\\*not italic\\*")).toEqual([t("*not italic*")]);
    expect(spans("\\[x\\](https://a.io)")).toEqual([t("[x](https://a.io)")]);
    expect(spans("C:\\Users\\me")).toEqual([t("C:\\Users\\me")]);
    expect(spans("a\\\\b")).toEqual([t("a\\b")]);
    expect(spans("end\\")).toEqual([t("end\\")]);
  });

  it("reads lists in body text only, one item per line", () => {
    expect(parseText("Plan:\n- one\n- **two**\n1. first\n2. second", body)).toEqual([
      { type: "paragraph", children: [t("Plan:")] },
      { type: "bullets", items: [[t("one")], [{ type: "strong", children: [t("two")] }]] },
      { type: "numbers", start: 1, items: [[t("first")], [t("second")]] },
    ]);
    expect(parseText("- one", line)).toEqual([{ type: "paragraph", children: [t("- one")] }]);
    expect(parseText("3. third\n4. fourth", body)).toEqual([
      { type: "numbers", start: 3, items: [[t("third")], [t("fourth")]] },
    ]);
  });

  it("keeps a line that only looks like a list item as text", () => {
    for (const text of ["-no space", "2024. was the year", "1.5 million", "\\- escaped"]) {
      const flow = parseText(text, body);
      expect(flow[0]?.type, text).toBe("paragraph");
    }
  });

  it("never returns HTML: a tag is text", () => {
    expect(spans("<b>x</b> <script>alert(1)</script>")).toEqual([t("<b>x</b> <script>alert(1)</script>")]);
  });
});

describe("writing markup", () => {
  const canonical = [
    "Plain words.",
    "a **b** c",
    "*it* and **bold** and ***both***",
    "**a *b* c**",
    "*a **b** c*",
    "**a***b*",
    "*a***b**",
    "a*b*c",
    "x **y**z",
    "see [the report](https://example.com/q3) now",
    "[**big**]{evidence} and [mail](mailto:a@b.io)",
    "[a \\[1\\]]{muted}",
    "5 * 3 = 15",
    "\\*not italic\\*",
    "C:\\Users\\me",
    "a\\\\\\*",
    "first line\nsecond line\n\nafter a gap",
    "Plan:\n- one\n- **two**\n\n1. first\n2. second",
    "\\- not a bullet\n1\\. not a number",
    "[1\\](note) and [x\\]{action}",
  ];

  it.each(canonical)("gives back what it wrote: %j", (text) => {
    expect(serializeText(parseText(text, body), body)).toBe(text);
  });

  it("writes a text that is not in the canonical form in it, with the same meaning", () => {
    const flow = parseText("1. a\n1. b\n__x__", body);
    expect(serializeText(flow, body)).toBe("1. a\n2. b\n__x__");
  });

  it("moves spaces out of bold and italic, since markup cannot open or close on one", () => {
    const flow: Flow[] = [
      { type: "paragraph", children: [t("a"), { type: "strong", children: [t(" b ")] }] },
    ];
    const text = serializeText(flow, line);
    expect(text).toBe("a **b** ");
    expect(parseText(text, line)).toEqual([
      { type: "paragraph", children: [t("a "), { type: "strong", children: [t("b")] }, t(" ")] },
    ]);
  });

  it("drops formatting already in force, and empty spans", () => {
    const flow: Flow[] = [
      {
        type: "paragraph",
        children: [
          { type: "strong", children: [t("a "), { type: "strong", children: [t("b")] }] },
          { type: "em", children: [] },
        ],
      },
    ];
    expect(serializeText(flow, line)).toBe("**a b**");
  });

  it("writes a list item on one line", () => {
    const flow: Flow[] = [{ type: "bullets", items: [[t("two\nlines")]] }];
    expect(serializeText(flow, body)).toBe("- two lines");
  });

  it("reads back a tree it wrote with the same marks on every character", () => {
    const tree: Flow[] = [
      {
        type: "paragraph",
        children: [
          t("Costs *fell* [1] by "),
          { type: "tone", tone: "action", children: [{ type: "strong", children: [t("12%")] }] },
          t(", see "),
          { type: "link", href: "https://example.com", children: [{ type: "em", children: [t("notes")] }] },
          { type: "strong", children: [{ type: "em", children: [t("now")] }] },
          t("\\"),
        ],
      },
      { type: "bullets", items: [[t("- dash"), { type: "em", children: [t("x")] }]] },
      { type: "paragraph", children: [t("2. not listed")] },
    ];
    const text = serializeText(tree, body);
    expect(marks(parseText(text, body))).toEqual(marks(tree));
  });

  it("keeps italic then bold apart where their stars run together", () => {
    // `*]` closes into `**a`, so `***` is one run; the `**` it leaves must not pair with the inner `*`.
    const tree: Flow[] = [
      {
        type: "paragraph",
        children: [
          { type: "em", children: [t("]")] },
          { type: "strong", children: [t("a"), { type: "em", children: [t("\\")] }] },
        ],
      },
    ];
    const text = serializeText(tree, body);
    expect(text).toBe("*]***a*\\\\***");
    expect(marks(parseText(text, body))).toEqual(marks(tree));
  });
});

describe("escaping literal text", () => {
  const literal = [
    "Revenue *grew*, see [1](note)",
    "- dash at the start\n1. number at the start",
    "a ** b and \\* and **",
    "[x]{action} [y](https://a.io)",
    "C:\\path\\",
    "trailing \\",
  ];

  it.each(literal)("reads as exactly what was written: %j", (text) => {
    const escaped = escapeText(text, body);
    expect(parseText(escaped, body)).toEqual(literalText(text));
    expect(visibleText(parseText(escaped, body))).toBe(text);
  });

  it("leaves text alone that already reads as written", () => {
    for (const text of ["Plain words.", "5 * 3", "C:\\Users", "a [1] b", "x - y"]) {
      expect(readsAsWritten(text, body), text).toBe(true);
      expect(escapeText(text, body)).toBe(text);
    }
    expect(readsAsWritten("**x**", body)).toBe(false);
  });

  it("escapes a line that would be a list item only in body text", () => {
    expect(escapeText("- a", body)).toBe("\\- a");
    expect(escapeText("- a", line)).toBe("- a");
  });

  it("never more than doubles the length, so an upgraded text fits its stored limit", () => {
    const worst = "*[]\\".repeat(150);
    expect(escapeText(worst, body).length).toBeLessThanOrEqual(worst.length * 2);
  });
});

describe("what the audience sees", () => {
  it("is the text without markup, addresses or list markers", () => {
    expect(visibleText(parseText("Go **now**, see [notes](https://a.io)\n- one\n- two", body))).toBe(
      "Go now, see notes\none\ntwo",
    );
  });
});

describe("any string", () => {
  /** A small generator that keeps hitting the edges: stars, brackets, escapes, list markers and line breaks. */
  const pieces = [
    "a",
    "b",
    " ",
    "*",
    "**",
    "[",
    "]",
    "(https://x.io)",
    "{action}",
    "(",
    "{",
    "\\",
    "\n",
    "- ",
    "1. ",
  ];
  const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  it("is written back in a form that reads the same and is stable", () => {
    const next = random(7);
    for (let n = 0; n < 3000; n++) {
      let text = "";
      const length = 1 + Math.floor(next() * 14);
      for (let i = 0; i < length; i++) text += pieces[Math.floor(next() * pieces.length)];
      const first = parseText(text, body);
      const written = serializeText(first, body);
      const again = parseText(written, body);
      expect(visibleText(again), JSON.stringify(text)).toBe(visibleText(first));
      expect(marks(again), JSON.stringify(text)).toEqual(marks(first));
      expect(serializeText(again, body), JSON.stringify(text)).toBe(written);
      const escaped = escapeText(text, body);
      expect(parseText(escaped, body), JSON.stringify(text)).toEqual(literalText(text));
    }
  });

  it("holds for any tree an editor could build: what it writes reads back with the same marks", () => {
    const next = random(11);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
    const words = [
      "a",
      "b c",
      " ",
      "*",
      "**",
      "[",
      "]",
      "]{action}",
      "](https://x.io)",
      "\\",
      "\n",
      "\n- ",
      "1. ",
    ];
    const tree = (depth: number, inLink: boolean): Span[] =>
      Array.from({ length: 1 + Math.floor(next() * 3) }, (): Span => {
        const roll = next();
        if (depth >= 3 || roll < 0.4) return t(pick(words) + pick(words));
        if (roll < 0.55) return { type: "strong", children: tree(depth + 1, inLink) };
        if (roll < 0.7) return { type: "em", children: tree(depth + 1, inLink) };
        if (roll < 0.85 && !inLink)
          return { type: "link", href: "https://x.io/p", children: tree(depth + 1, true) };
        return { type: "tone", tone: pick(["action", "muted"] as const), children: tree(depth + 1, inLink) };
      });
    for (let n = 0; n < 1500; n++) {
      const flow: Flow[] = [
        { type: "paragraph", children: tree(0, false) },
        ...(next() < 0.5 ? [{ type: "bullets" as const, items: [tree(1, false), tree(1, false)] }] : []),
      ];
      const written = serializeText(flow, body);
      expect(marks(parseText(written, body)), JSON.stringify(written)).toEqual(marks(flow));
      expect(serializeText(parseText(written, body), body), JSON.stringify(written)).toBe(written);
    }
  });
});
