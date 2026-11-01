// @vitest-environment happy-dom
import { type Block, type Flow, parseText, type Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { renderReading } from "../src/reading.ts";
import { renderScene } from "../src/scene.ts";
import { renderFlow, renderText } from "../src/text.ts";
import { sceneWith } from "./helpers.ts";

type Text = Extract<Block, { type: "text" }>;

const ctx = { assetBase: "." };
const MARKUP = "**bold** and *italic*, [a link](https://example.com/a) and [tone]{action}";

const text = (over: Partial<Text> & { id: string; role: Text["role"] }): Text => ({
  type: "text",
  text: MARKUP,
  ...over,
});
const at03 = (blocks: Text[], over: Record<string, unknown> = {}): Scene =>
  sceneWith({ schemaVersion: "0.3", blocks, ...over });
const drawn = (block: Text, scene: Scene = at03([block])): HTMLElement =>
  renderScene(scene, ctx).querySelector<HTMLElement>(`[data-id="${block.id}"]`) as HTMLElement;

describe("text in a scene that reads markup", () => {
  it("draws bold, italic, a link and a tone span as elements, and the words as their text", () => {
    const node = drawn(text({ id: "b", role: "body" }));
    expect(node.tagName).toBe("DIV");
    expect(node.classList.contains("dc-body")).toBe(true);
    expect(node.querySelector("strong")?.textContent).toBe("bold");
    expect(node.querySelector("em")?.textContent).toBe("italic");
    expect(node.querySelector("span.dc-tone")?.getAttribute("data-tone")).toBe("action");
    expect(node.querySelector("span.dc-tone")?.textContent).toBe("tone");
    expect(node.textContent).toBe("bold and italic, a link and tone");
  });

  it("opens a link in a new tab with noopener noreferrer, and gives it only an https or mailto address", () => {
    const node = drawn(
      text({ id: "b", role: "body", text: "[a](https://x.example/p) [b](mailto:a@x.example)" }),
    );
    const [first, second] = [...node.querySelectorAll("a")];
    expect(first?.getAttribute("href")).toBe("https://x.example/p");
    expect(first?.getAttribute("target")).toBe("_blank");
    expect(first?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(first?.className).toBe("dc-link");
    expect(second?.getAttribute("href")).toBe("mailto:a@x.example");
  });

  it("leaves a link that is not https or mailto as the words it was written with", () => {
    const written = "[click](javascript:alert(1)) and [file](http://x.example) and [data](data:text/html,x)";
    const node = drawn(text({ id: "b", role: "body", text: written }));
    expect(node.querySelector("a")).toBeNull();
    expect(node.textContent).toBe(written);
  });

  it("never lets deck text become markup, whatever the markup around it", () => {
    const hostile = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
    const node = drawn(
      text({ id: "b", role: "body", text: `**${hostile}** [${hostile}](https://x.example)` }),
    );
    expect(node.querySelector("img, script")).toBeNull();
    expect(node.querySelector("strong")?.textContent).toBe(hostile);
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  it("draws bulleted and numbered lines as real lists, with a paragraph before and after", () => {
    const node = drawn(
      text({ id: "b", role: "body", text: "Before\n- one\n- two\n3. three\n4. four\nAfter" }),
    );
    expect([...node.children].map((child) => child.tagName)).toEqual(["P", "UL", "OL", "P"]);
    expect([...node.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    const numbered = node.querySelector("ol");
    expect(numbered?.getAttribute("start")).toBe("3");
    expect([...(numbered?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual([
      "three",
      "four",
    ]);
  });

  it("starts a numbered list at 1 without saying so, and keeps a line break and an empty line as breaks", () => {
    const node = drawn(text({ id: "b", role: "body", text: "1. a\n2. b" }));
    expect(node.querySelector("ol")?.hasAttribute("start")).toBe(false);
    const lines = drawn(text({ id: "c", role: "body", text: "one\n\ntwo" }));
    expect(lines.querySelector("p")?.innerHTML).toBe("one<br><br>two");
  });

  it("puts a heading, a caption and a quote in the element each always had, with spans and no lists", () => {
    const scene = at03([
      text({ id: "h", role: "heading", text: "A *new* **day**" }),
      text({ id: "c", role: "caption", text: "- not a list" }),
      text({ id: "q", role: "quote", text: "Said [she]{muted}" }),
    ]);
    expect(drawn(scene.blocks[0] as Text, scene).tagName).toBe("H2");
    expect(drawn(scene.blocks[0] as Text, scene).querySelector("em")?.textContent).toBe("new");
    const caption = drawn(scene.blocks[1] as Text, scene);
    expect(caption.tagName).toBe("P");
    expect(caption.querySelector("ul")).toBeNull();
    expect(caption.textContent).toBe("- not a list");
    const quote = drawn(scene.blocks[2] as Text, scene);
    expect(quote.tagName).toBe("BLOCKQUOTE");
    expect(quote.querySelector("p span.dc-tone")?.getAttribute("data-tone")).toBe("muted");
  });

  it("writes a block's tone, size and alignment as attributes, and leaves out what it does not say", () => {
    const styled = drawn(text({ id: "s", role: "body", tone: "evidence", size: "xl", align: "center" }));
    expect(styled.dataset.tone).toBe("evidence");
    expect(styled.dataset.size).toBe("xl");
    expect(styled.dataset.align).toBe("center");
    const plain = drawn(text({ id: "p", role: "body" }));
    expect(plain.hasAttribute("data-tone") || plain.hasAttribute("data-size")).toBe(false);
    expect(plain.hasAttribute("data-align")).toBe(false);
  });

  it("keeps the block's own marks on the element a pinned block is drawn as", () => {
    const block = text({ id: "f", role: "body", size: "l", frame: { x: 10, y: 10, w: 40, h: 30 } });
    const node = drawn(block);
    expect(node.classList.contains("dc-pinned")).toBe(true);
    expect(node.dataset.size).toBe("l");
  });
});

describe("text in a scene below 0.3", () => {
  it("shows markup exactly as written, in the element it always had", () => {
    const scene = sceneWith({
      schemaVersion: "0.2",
      blocks: [
        { id: "h", type: "text", role: "heading", text: "A **star** *here*" },
        { id: "b", type: "text", role: "body", text: "- not a list\n[x](https://x.example)" },
      ],
    });
    const heading = drawn(scene.blocks[0] as Text, scene);
    const body = drawn(scene.blocks[1] as Text, scene);
    expect(heading.tagName).toBe("H2");
    expect(heading.innerHTML).toBe("A **star** *here*");
    expect(body.tagName).toBe("P");
    expect(body.className).toContain("dc-body");
    expect(body.querySelector("ul, a, strong")).toBeNull();
    expect(body.textContent).toBe("- not a list\n[x](https://x.example)");
  });

  it("draws the same element for a block that is handed to renderText directly", () => {
    const old = renderText({ schemaVersion: "0.1" }, text({ id: "b", role: "body", text: "**x**" }));
    expect(old.tagName).toBe("P");
    expect(old.textContent).toBe("**x**");
  });
});

describe("the reading view", () => {
  const deck = {
    schemaVersion: "0.3",
    id: "d",
    title: "Deck",
    language: "en",
    theme: "paper",
    scenes: ["a"],
  };

  it("shows the formatting and the lists of a scene that reads markup when it has no reading text", () => {
    const scene = at03(
      [
        text({ id: "h", role: "heading", text: "A **bold** claim" }),
        text({ id: "b", role: "body", text: "- one\n- two" }),
      ],
      { id: "a" },
    );
    const view = renderReading(deck as never, [scene], ctx);
    const article = view.querySelector("article") as HTMLElement;
    expect(article.querySelector("strong")?.textContent).toBe("bold");
    expect([...article.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["one", "two"]);
  });

  it("gives a scene below 0.3 its text as written, and a reading text as written whatever the scene", () => {
    const old = sceneWith({ id: "a", blocks: [{ id: "b", type: "text", role: "body", text: "**x** - y" }] });
    expect(renderReading(deck as never, [old], ctx).querySelector("article p")?.textContent).toBe(
      "**x** - y",
    );
    const written = at03([text({ id: "b", role: "body" })], {
      id: "a",
      reading: { text: "**plain** words" },
    });
    const view = renderReading(deck as never, [written], ctx);
    expect(view.querySelector("article p")?.textContent).toBe("**plain** words");
    expect(view.querySelector("strong")).toBeNull();
  });
});

describe("renderFlow", () => {
  const flow = (source: string): Flow[] => parseText(source, { lists: true });

  it("draws what parseText read, and a round trip through the DOM reads the same words", () => {
    const source = "Intro with **bold**\n- a *b*\n- c\n1. d";
    const html = renderFlow(flow(source))
      .map((node) => node.outerHTML)
      .join("");
    expect(html).toBe(
      "<p>Intro with <strong>bold</strong></p><ul><li>a <em>b</em></li><li>c</li></ul><ol><li>d</li></ol>",
    );
  });
});
