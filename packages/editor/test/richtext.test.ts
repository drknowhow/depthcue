// @vitest-environment happy-dom
import { type Flow, parseText, serializeText, visibleText } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { drawRich, flowOfDom, plainFlow } from "../src/richtext.ts";

/** A field holding `markup` as DOM, built the way the editor builds it from the markup of a body text. */
const drawn = (markup: string, lists = true): HTMLElement => {
  const node = document.createElement("div");
  drawRich(node, parseText(markup, { lists }), lists);
  return node;
};
/** A field holding whatever a browser might leave in it. */
const html = (source: string): HTMLElement => {
  const node = document.createElement("div");
  node.innerHTML = source;
  return node;
};
const written = (node: Node, lists = true) => serializeText(flowOfDom(node, lists), { lists });

describe("reading a rich field back into markup", () => {
  // Each of these is markup the core writes itself, so the player's drawing of it must read back unchanged.
  it.each([
    "Plain words",
    "**bold** and *italic*, then ***both***",
    "a **b *c* d** e",
    "[a link](https://example.com/a) and [a mail](mailto:someone@example.com)",
    "[colored]{action} and [**bold** inside]{evidence}",
    "Intro\n- one\n- **two**\n1. first\n2. second\nOutro",
    "one\ntwo",
    "one\n\ntwo",
    "3. three\n4. four",
    "\\*not bold\\* and a dash - and [brackets] here",
    "Line\n\\- not an item\n\\1. not a number",
  ])("gives back %j as it was written", (markup) => {
    expect(written(drawn(markup))).toBe(markup);
  });

  it("reads the same words in a heading, a caption and a quote, which have no lists", () => {
    const markup = "A *new* **day**, with a [link](https://example.com) and [color]{muted}";
    expect(written(drawn(markup, false), false)).toBe(markup);
  });

  it("counts the words the audience sees, and not the markup", () => {
    const flow = flowOfDom(drawn("**bold** [a](https://example.com/long/address) [c]{action}\n- item"), true);
    expect(visibleText(flow)).toBe("bold a c\nitem");
  });
});

describe("what a browser leaves in a field", () => {
  it("reads b and i as bold and italic, as strong and em are", () => {
    expect(written(html("<b>one</b> <i>two</i> <strong>three</strong> <em>four</em>"))).toBe(
      "**one** *two* **three** *four*",
    );
  });

  it("takes a div, a p or a br as the end of a line, and joins the lines into one paragraph", () => {
    expect(written(html("<div>one</div><div>two</div>"))).toBe("one\ntwo");
    expect(written(html("<p>one</p><p>two<br>three</p>"))).toBe("one\ntwo\nthree");
    expect(written(html("one<br>two"))).toBe("one\ntwo");
  });

  it("keeps an empty line, a div with only a br, and ignores the br a browser puts at the end of a line", () => {
    expect(written(html("<div>a</div><div><br></div><div>b</div>"))).toBe("a\n\nb");
    expect(written(html("<div>a<br></div><div>b</div>"))).toBe("a\nb");
  });

  it("drops blank lines and spaces at either end, and turns a non-breaking space into a space", () => {
    expect(written(html("<div><br></div><div> a&nbsp;&nbsp;b </div><div><br></div>"))).toBe("a  b");
    expect(written(html("<div>one</div>\n  <div>two</div>\n"))).toBe("one\ntwo");
  });

  it("keeps only what the markup can say, and reads any other element as its words", () => {
    const messy = html(
      '<p>a <u>under</u> <span style="color: red">red</span> <font color="red">font</font>' +
        '<img src="x" alt="picture" onerror="globalThis.pwned = 1"> <script>globalThis.pwned = 1</script>' +
        "<style>p { color: red }</style><object data='x'>object</object>b</p>",
    );
    // The picture has no words, the script and the style are not words at all, and the object's words are its own.
    expect(written(messy)).toBe("a under red font objectb");
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("nests marks as the elements nest, and keeps one strong across the runs inside it", () => {
    const flow = flowOfDom(html("<b>a <i>b</i> c</b>"), true);
    expect(flow).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "strong",
            children: [
              { type: "text", text: "a " },
              { type: "em", children: [{ type: "text", text: "b" }] },
              { type: "text", text: " c" },
            ],
          },
        ],
      },
    ] satisfies Flow[]);
    // Italic around bold, and bold around italic, both read back as markup that reads as the same words.
    expect(written(html("<i><b>x</b></i>"))).toBe("***x***");
  });

  it("makes a link only of an address a link may have, and reads any other as its words", () => {
    expect(
      written(html('<a href="https://example.com/a">yes</a> <a href="mailto:a@b.example">mail</a>')),
    ).toBe("[yes](https://example.com/a) [mail](mailto:a@b.example)");
    expect(
      written(
        html(
          '<a href="javascript:alert(1)">script</a> <a href="http://example.com">plain http</a> <a href="https://a b">space</a> <a>none</a>',
        ),
      ),
    ).toBe("script plain http space none");
  });

  it("makes a tone only of one of the four, and reads any other as its words", () => {
    expect(
      written(
        html(
          '<span data-tone="action">a</span> <span data-tone="muted">b</span> <span data-tone="text">c</span> <span data-tone="evidence">d</span> <span data-tone="red">e</span>',
        ),
      ),
    ).toBe("[a]{action} [b]{muted} [c]{text} [d]{evidence} e");
  });

  it("escapes what the person typed that the markup would read as formatting", () => {
    expect(written(html("<div>*star* and [x](https://example.com) and **two**</div>"))).toBe(
      "\\*star\\* and [x\\](https://example.com) and \\*\\*two\\*\\*",
    );
    expect(written(html("<div>- not a list</div><div>1. nor this</div>"))).toBe(
      "\\- not a list\n1\\. nor this",
    );
  });
});

describe("lists", () => {
  it("reads ul and ol as bullets and numbers, a paragraph before and after, and where a numbered list starts", () => {
    const flow = flowOfDom(
      html("Before<ul><li>a</li><li><b>b</b></li></ul><ol start='3'><li>c</li><li>d</li></ol>After"),
      true,
    );
    expect(flow.map((part) => part.type)).toEqual(["paragraph", "bullets", "numbers", "paragraph"]);
    expect(serializeText(flow, { lists: true })).toBe("Before\n- a\n- **b**\n3. c\n4. d\nAfter");
  });

  it("keeps an empty item, which is what Enter in a list leaves, and an item that holds a div or a br", () => {
    expect(written(html("<ul><li>a</li><li><br></li></ul>"))).toBe("- a\n- ");
    expect(written(html("<ul><li><div>a</div></li><li>b<br>c</li><li>d<br></li></ul>"))).toBe(
      "- a\n- b c\n- d",
    );
  });

  it("reads a list inside an item as more items of that list, for it has no depth", () => {
    expect(written(html("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"))).toBe("- a\n- b\n- c");
  });

  it("makes one list of items that follow each other, and two when another kind comes between them", () => {
    expect(written(html("<ul><li>a</li></ul><ul><li>b</li></ul><ol><li>c</li></ol>"))).toBe("- a\n- b\n1. c");
  });

  it("reads a list as lines where text has no lists", () => {
    const flow = flowOfDom(html("<ul><li>a</li><li>b</li></ul>"), false);
    expect(flow).toEqual([{ type: "paragraph", children: [{ type: "text", text: "a\nb" }] }]);
  });

  it("does not read a blank line before a list, which the player does not draw: a br ends the line and no more", () => {
    expect(drawn("Intro\n\n- a\n- b").querySelector("p")?.innerHTML).toBe("Intro<br>");
    expect(written(drawn("Intro\n\n- a\n- b"))).toBe("Intro\n- a\n- b");
  });
});

describe("pasted text", () => {
  it("reads lines that start with a marker as list items, and everything else as words", () => {
    const flow = plainFlow("Intro line\n- one\n- two\n3. three\n4. four\nOutro");
    expect(flow.map((part) => part.type)).toEqual(["paragraph", "bullets", "numbers", "paragraph"]);
    expect(serializeText(flow, { lists: true })).toBe("Intro line\n- one\n- two\n3. three\n4. four\nOutro");
  });

  it("reads no formatting in what is pasted, so stars and brackets are the characters", () => {
    const flow = plainFlow("**not bold** and [not](https://example.com)\n- *also not*");
    expect(visibleText(flow)).toBe("**not bold** and [not](https://example.com)\n*also not*");
    expect(parseText(serializeText(flow, { lists: true }), { lists: true })).toEqual(flow);
  });

  it("keeps empty lines in a paragraph, and an item with nothing after its marker", () => {
    expect(plainFlow("a\n\nb")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "a\n\nb" }] },
    ]);
    expect(plainFlow("- \n- x")).toEqual([{ type: "bullets", items: [[], [{ type: "text", text: "x" }]] }]);
  });

  it("draws into a field as the player draws, and nothing in it is made from the text as markup", () => {
    const node = document.createElement("div");
    const text = '<img src=x onerror="globalThis.pwned=1"> and **stars**';
    drawRich(node, plainFlow(`- ${text}`), true);
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("ul li")?.textContent).toBe(text);
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });
});
