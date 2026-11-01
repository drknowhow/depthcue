// @vitest-environment happy-dom
import type { DeckLook, Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { ownOf, renderScene } from "../src/scene.ts";
import { sceneWith } from "./helpers.ts";
import { lookWith, SPLIT, slot, style, template } from "./looks.ts";

const frame = { x: 56, y: 14, w: 38, h: 44 };
const text = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  role: "body",
  text: `Words of ${id}`,
  ...more,
});
const image = { id: "pic", type: "image", asset: "assets/method.svg", alt: "A diagram" };

function scene(more: Record<string, unknown>): Scene {
  return sceneWith({ schemaVersion: "0.4", layout: undefined, template: "split", ...more });
}

const draw = (s: Scene, look: DeckLook | undefined, extra: { number?: number; assetBase?: string } = {}) =>
  renderScene(s, { assetBase: ".", ...(look ? { look } : {}), ...extra });

const withSplit = (more: Partial<DeckLook> = {}) => lookWith({ templates: { split: SPLIT }, ...more });

const boxes = (section: Element) => [...section.querySelectorAll<HTMLElement>(".dc-slot")];
const idsIn = (parent: Element | null | undefined) =>
  [...(parent?.children ?? [])].map((child) =>
    child.classList.contains("dc-ghost") ? "ghost" : (child as HTMLElement).dataset.id,
  );

describe("a template scene", () => {
  it("is a box for each slot with something in it, in the template's order, at the slot's frame", () => {
    // Written right before left; drawn left before right.
    const section = draw(
      scene({
        summary: { id: "claim-1", text: "Demand doubled." },
        blocks: [text("r", { slot: "right" }), text("l", { slot: "left" })],
      }),
      withSplit(),
    );
    const placed = boxes(section);
    expect(placed.map((box) => box.dataset.slot)).toEqual(["claim", "left", "right"]);
    expect(placed.map((box) => box.dataset.role)).toEqual(["claim", "body", "content"]);
    expect(["--x", "--y", "--w", "--h"].map((name) => placed[1]?.style.getPropertyValue(name))).toEqual([
      "6",
      "34",
      "42",
      "50",
    ]);
    expect(placed[1]?.dataset.valign).toBe("middle");
    expect(placed[0]?.dataset.valign).toBeUndefined();
    expect(section.hasAttribute("data-framed")).toBe(true);
    expect(section.dataset.template).toBe("split");
  });

  it("stacks a slot's blocks in block order", () => {
    const section = draw(
      scene({
        blocks: [text("a", { slot: "left" }), text("b", { slot: "right" }), text("c", { slot: "left" })],
      }),
      withSplit(),
    );
    expect(idsIn(boxes(section)[0])).toEqual(["a", "c"]);
    expect(idsIn(boxes(section)[1])).toEqual(["b"]);
  });

  it("draws nothing for a slot with nothing in it", () => {
    const section = draw(scene({ blocks: [text("b", { slot: "right" })] }), withSplit());
    expect(boxes(section).map((box) => box.dataset.slot)).toEqual(["right"]);
  });

  it("draws the claim in the claim slot, with its id for the evidence links, and marks the blocks it cites", () => {
    const section = draw(
      scene({
        summary: { id: "claim-1", text: "Demand doubled.", evidenceIds: ["l"] },
        blocks: [text("l", { slot: "left" }), text("r", { slot: "right" })],
      }),
      withSplit(),
    );
    const claim = boxes(section)[0]?.querySelector<HTMLElement>(".dc-claim");
    expect(claim?.textContent).toBe("Demand doubled.");
    expect(claim?.dataset.id).toBe("claim-1");
    expect(section.querySelector("[data-id='l']")?.hasAttribute("data-evidence")).toBe(true);
    expect(section.querySelector("[data-id='r']")?.hasAttribute("data-evidence")).toBe(false);
  });

  it("keeps a pinned block's place in its slot as a ghost and draws the block at its own frame", () => {
    const section = draw(
      scene({
        blocks: [text("a", { slot: "left" }), text("b", { slot: "left", frame }), { ...image, frame }],
      }),
      withSplit(),
    );
    expect(idsIn(boxes(section)[0])).toEqual(["a", "ghost"]);
    expect(idsIn(section.querySelector(".dc-pins"))).toEqual(["b", "pic"]);
    // The block pinned with no slot floats over the template: it is in no box and leaves nothing behind.
    expect(section.querySelectorAll(".dc-ghost")).toHaveLength(1);
    expect(boxes(section).some((box) => box.querySelector("[data-id='pic']"))).toBe(false);
  });

  it("follows the template's blocks that have no slot to go to, in a stack of their own, rather than drop them", () => {
    const section = draw(
      scene({
        summary: { id: "claim-1", text: "Demand doubled." },
        blocks: [text("a", { slot: "left" }), text("lost", { slot: "nowhere" }), text("bare")],
      }),
      lookWith({
        templates: { split: template("split", [slot("left", "body", { x: 6, y: 34, w: 42, h: 50 })]) },
      }),
    );
    const stack = section.querySelector(".dc-stack");
    expect(boxes(section).map((box) => box.dataset.slot)).toEqual(["left"]);
    expect(idsIn(stack)).toEqual(["claim-1", "lost", "bare"]);
  });
});

describe("a template scene the page has no look for", () => {
  const plain = scene({
    summary: { id: "claim-1", text: "Demand doubled." },
    blocks: [text("a", { slot: "left" }), text("b", { slot: "right", frame })],
  });

  it("is a plain stack of everything the scene says, claim first, with a pinned block's room kept", () => {
    for (const look of [undefined, lookWith()]) {
      const section = draw(plain, look);
      expect(section.querySelector(".dc-slot")).toBeNull();
      expect(idsIn(section.querySelector(".dc-stack"))).toEqual(["claim-1", "a", "ghost"]);
      expect(idsIn(section.querySelector(".dc-pins"))).toEqual(["b"]);
    }
  });
});

describe("a block's style", () => {
  const look = withSplit({
    styles: {
      quote: style({
        font: "display",
        weight: "bold",
        case: "upper",
        tone: "action",
        size: "l",
        align: "center",
      }),
      card: style({ fill: "surface", border: "line", edge: "start", radius: "m", pad: "l" }),
      banner: style({ fill: "action", pad: "m" }),
      lead: style({ size: "xl", weight: "bold" }),
    },
    templates: {
      split: template("split", [
        slot("claim", "claim", { x: 6, y: 8, w: 88, h: 20 }, { style: "lead" }),
        slot("left", "body", { x: 6, y: 34, w: 42, h: 50 }, { style: "card" }),
        slot("right", "content", { x: 52, y: 34, w: 42, h: 50 }),
      ]),
    },
  });
  const find = (section: Element, id: string) => section.querySelector<HTMLElement>(`[data-id='${id}']`);

  it("is set on the block as the attributes the stylesheet answers, left out when it says none", () => {
    const section = draw(scene({ blocks: [text("q", { slot: "right", style: "quote" })] }), look);
    const q = find(section, "q");
    expect(
      ["font", "weight", "case", "tone", "size", "align"].map((name) => q?.getAttribute(`data-${name}`)),
    ).toEqual(["display", "bold", "upper", "action", "l", "center"]);
    expect(q?.hasAttribute("data-fill")).toBe(false);
    expect(q?.hasAttribute("data-on")).toBe(false);
  });

  it("falls to the slot's style when the block names none, and the block's own style wins over the slot's", () => {
    const section = draw(
      scene({ blocks: [text("a", { slot: "left" }), text("b", { slot: "left", style: "quote" })] }),
      look,
    );
    // The slot's style is the card, which fills; the block's own is the quote, which sets its case and does not fill.
    expect(find(section, "a")?.dataset.fill).toBe("surface");
    expect(find(section, "a")?.hasAttribute("data-case")).toBe(false);
    expect(find(section, "b")?.dataset.case).toBe("upper");
    expect(find(section, "b")?.hasAttribute("data-fill")).toBe(false);
  });

  it("gives fill, border, accent edge, radius and padding as attributes", () => {
    const a = find(draw(scene({ blocks: [text("a", { slot: "left" })] }), look), "a");
    expect(
      ["fill", "border", "edge", "radius", "pad"].map((name) => a?.getAttribute(`data-${name}`)),
    ).toEqual(["surface", "line", "start", "m", "l"]);
    // A fill that is the slide's own surface keeps the slide's text colors.
    expect(a?.hasAttribute("data-on")).toBe(false);
  });

  it("reverses the text on a strong fill, unless the block names its own tone", () => {
    const section = draw(
      scene({
        blocks: [
          text("a", { slot: "right", style: "banner" }),
          text("b", { slot: "right", style: "banner", tone: "muted" }),
        ],
      }),
      look,
    );
    expect(find(section, "a")?.dataset.on).toBe("strong");
    expect(find(section, "a")?.dataset.tone).toBe("bg");
    expect(find(section, "b")?.dataset.on).toBe("strong");
    expect(find(section, "b")?.dataset.tone).toBe("muted");
  });

  it("lets the block's own size and alignment win over the style's", () => {
    const section = draw(
      scene({ blocks: [text("a", { slot: "right", style: "quote", size: "s", align: "end" })] }),
      look,
    );
    expect(find(section, "a")?.dataset.size).toBe("s");
    expect(find(section, "a")?.dataset.align).toBe("end");
    expect(find(section, "a")?.dataset.tone).toBe("action");
  });

  it("dresses the claim in the claim slot's style, and leaves a block with an unknown style as it is", () => {
    const section = draw(
      scene({
        summary: { id: "claim-1", text: "Demand doubled." },
        blocks: [text("a", { slot: "right", style: "missing" })],
      }),
      look,
    );
    const claim = find(section, "claim-1");
    expect(claim?.dataset.size).toBe("xl");
    expect(claim?.dataset.weight).toBe("bold");
    expect(find(section, "a")?.hasAttribute("data-weight")).toBe(false);
  });

  it("does not take a style from the object's prototype", () => {
    expect(ownOf(look.styles, "constructor")).toBeUndefined();
    expect(ownOf(look.styles, "__proto__")).toBeUndefined();
    expect(ownOf(look.styles, "card")?.fill).toBe("surface");
    const section = draw(scene({ blocks: [text("a", { slot: "right", style: "constructor" })] }), look);
    expect(find(section, "a")?.hasAttribute("data-weight")).toBe(false);
  });
});

describe("a template's background", () => {
  const withBackground = (background: unknown, more: Record<string, unknown> = {}) =>
    lookWith({
      templates: {
        split: template("split", [slot("left", "body", { x: 6, y: 34, w: 42, h: 50 })], {
          background,
          ...more,
        } as never),
      },
    });
  const body = scene({ blocks: [text("a", { slot: "left" })] });

  it("is a named color, and reverses the text on a strong one", () => {
    const plain = draw(body, withBackground({ color: "surface" }));
    expect(plain.dataset.bg).toBe("surface");
    expect(plain.hasAttribute("data-on")).toBe(false);
    expect(plain.querySelector(".dc-backdrop")).toBeNull();
    for (const color of ["action", "evidence", "text"]) {
      const strong = draw(body, withBackground({ color }));
      expect(strong.dataset.bg, color).toBe(color);
      expect(strong.dataset.on, color).toBe("strong");
    }
  });

  it("is a brand image under a scrim of the color, drawn first and hidden from a screen reader", () => {
    const section = draw(body, withBackground({ color: "text", image: "images/hero.jpg", scrim: 60 }), {
      assetBase: "/decks/q3",
    });
    const backdrop = section.firstElementChild as HTMLElement;
    expect(backdrop.className).toBe("dc-backdrop");
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.style.getPropertyValue("--scrim")).toBe("60");
    expect(backdrop.style.backgroundImage).toContain("/decks/q3/brand/images/hero.jpg");
    expect(section.hasAttribute("data-image")).toBe(true);
    expect(section.dataset.on).toBe("strong");
  });

  it("draws no picture for an image that is not a brand image file", () => {
    for (const image of ["../secret.png", "images/../../x.png", "https://example.com/x.png"]) {
      const section = draw(body, withBackground({ color: "text", image, scrim: 50 }));
      expect(section.querySelector(".dc-backdrop"), image).toBeNull();
      expect(section.hasAttribute("data-image"), image).toBe(false);
    }
  });
});

describe("the brand's chrome", () => {
  const chrome = {
    logo: { path: "brand/logos/mark.svg", alt: "Harbor", corner: "top-end", size: "m" },
    footer: { text: "Harbor Studio, confidential", place: "start" },
    number: { place: "end" },
    accent: "top",
  } as const;
  const body = scene({ blocks: [text("a", { slot: "left" })] });
  const look = (mode?: "full" | "minimal" | "none") =>
    lookWith({
      chrome,
      templates: {
        split: template(
          "split",
          [slot("left", "body", { x: 6, y: 34, w: 42, h: 50 })],
          mode ? { chrome: mode } : {},
        ),
      },
    });

  it("is the logo, the footer, the slide number and the accent, last in the scene", () => {
    const section = draw(body, look(), { number: 4 });
    const chromed = section.lastElementChild as HTMLElement;
    expect(chromed.className).toBe("dc-chrome");
    const logo = chromed.querySelector<HTMLImageElement>(".dc-logo");
    expect(logo?.getAttribute("src")).toBe("./brand/logos/mark.svg");
    expect(logo?.alt).toBe("Harbor");
    expect([logo?.dataset.corner, logo?.dataset.height]).toEqual(["top-end", "m"]);
    expect(chromed.querySelector(".dc-footer")?.textContent).toBe("Harbor Studio, confidential");
    expect(chromed.querySelector(".dc-number")?.textContent).toBe("4");
    expect(chromed.querySelector<HTMLElement>(".dc-accent")?.dataset.accent).toBe("top");
    expect([...chromed.querySelectorAll<HTMLElement>(".dc-foot")].map((foot) => foot.dataset.at)).toEqual([
      "start",
      "end",
    ]);
  });

  it("puts a footer and a number that share a place in one cell", () => {
    const shared = lookWith({
      chrome: { ...chrome, number: { place: "start" } },
      templates: { split: SPLIT },
    });
    const feet = draw(scene({ template: undefined, layout: "title", blocks: [text("a")] }), shared, {
      number: 2,
    }).querySelectorAll(".dc-foot");
    expect(feet).toHaveLength(1);
    expect([...(feet[0]?.children ?? [])].map((part) => part.className)).toEqual(["dc-footer", "dc-number"]);
  });

  it("is hidden from a screen reader but for the logo, which says the brand's words once", () => {
    const section = draw(body, look(), { number: 1 });
    for (const foot of section.querySelectorAll(".dc-foot"))
      expect(foot.getAttribute("aria-hidden")).toBe("true");
    expect(section.querySelector(".dc-accent")?.getAttribute("aria-hidden")).toBe("true");
    expect(section.querySelectorAll(".dc-chrome img")).toHaveLength(1);
    expect(section.querySelector(".dc-logo")?.getAttribute("alt")).toBe("Harbor");
  });

  it("is the logo alone on a minimal template, and nothing on a template that says none", () => {
    const minimal = draw(body, look("minimal"), { number: 1 });
    expect(minimal.querySelector(".dc-logo")).not.toBeNull();
    expect(minimal.querySelector(".dc-foot, .dc-accent")).toBeNull();
    expect(draw(body, look("none"), { number: 1 }).querySelector(".dc-chrome")).toBeNull();
  });

  it("is on a scene with no template too, and on none when the page has no look", () => {
    const plain = scene({ template: undefined, layout: "title", blocks: [text("a")] });
    expect(draw(plain, look(), { number: 1 }).querySelector(".dc-logo")).not.toBeNull();
    expect(draw(plain, undefined, { number: 1 }).querySelector(".dc-chrome")).toBeNull();
    expect(draw(plain, lookWith(), { number: 1 }).querySelector(".dc-chrome")).toBeNull();
  });

  it("leaves out the number when it was not told one, and a logo whose path is not a brand file", () => {
    const section = draw(body, look());
    expect(section.querySelector(".dc-number")).toBeNull();
    const bad = lookWith({
      chrome: { ...chrome, logo: { ...chrome.logo, path: "../logo.svg" } },
      templates: { split: SPLIT },
    });
    expect(draw(body, bad, { number: 1 }).querySelector(".dc-logo")).toBeNull();
  });

  it("is nothing when the brand draws none of it", () => {
    const empty = lookWith({ chrome: { accent: "none" }, templates: { split: SPLIT } });
    expect(draw(body, empty, { number: 1 }).querySelector(".dc-chrome")).toBeNull();
  });
});
