// @vitest-environment happy-dom
import type { ChromeDeck, DeckLook, PageLook, Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { renderScene } from "../src/scene.ts";
import { sceneWith } from "./helpers.ts";
import { lookWith } from "./looks.ts";

/* The header and the footer: the words come from the same resolver the export and the agent read. */

const titled = (id: string, title: string, template?: string): Scene =>
  sceneWith({ id, title, ...(template ? { template, layout: undefined, schemaVersion: "0.4" } : {}) });

const SCENES = [
  titled("cover", "Annual review", "cover"),
  titled("part-one", "Results", "section"),
  titled("revenue", "Revenue"),
  titled("costs", "Costs"),
];

const deck = (more: Partial<ChromeDeck> = {}): ChromeDeck => ({
  title: "Annual review",
  slides: SCENES.map((s) => ({ id: s.id, title: s.title, template: s.template })),
  ...more,
});

const lookFor = (
  bands: NonNullable<NonNullable<DeckLook["chrome"]>["bands"]>,
  more: Partial<ChromeDeck> = {},
): PageLook => lookWith({ chrome: { accent: "none", bands, deck: deck(more) } }) as unknown as PageLook;

const draw = (index: number, look: PageLook) => renderScene(SCENES[index] as Scene, { assetBase: ".", look });

const cell = (section: Element, band: "head" | "foot", at: string) =>
  section.querySelector<HTMLElement>(`.dc-${band}[data-at='${at}']`);

describe("the header and the footer", () => {
  const bands = {
    header: { start: "{deck}", end: "{section}" },
    footer: { center: "{number} / {count}", end: "{date}" },
  };

  it("draws the header along the top and the footer along the bottom, with their fields", () => {
    const section = draw(2, lookFor(bands, { date: "March 2027" }));
    expect(cell(section, "head", "start")?.textContent).toBe("Annual review");
    expect(cell(section, "head", "end")?.textContent).toBe("Results");
    expect(cell(section, "foot", "center")?.textContent).toBe("3 / 4");
    expect(cell(section, "foot", "end")?.textContent).toBe("March 2027");
    expect(section.querySelector(".dc-chrome")?.getAttribute("aria-hidden")).toBeNull();
    expect(section.querySelector(".dc-head")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws the number apart from the words, so a stylesheet and a measurement can tell them apart", () => {
    const section = draw(3, lookFor(bands));
    const zone = cell(section, "foot", "center");
    expect([...(zone?.children ?? [])].map((part) => part.className)).toEqual(["dc-number", "dc-footer"]);
    expect(zone?.querySelector(".dc-number")?.textContent).toBe("4");
  });

  it("leaves a zone out when it has nothing to say, and the number out on a template the deck skips", () => {
    const look = lookFor(bands, { numbering: { skip: ["cover", "section"] } });
    const cover = draw(0, look);
    expect(cell(cover, "head", "end")).toBeNull();
    expect(cover.querySelector(".dc-number")).toBeNull();
    expect(draw(2, look).querySelector(".dc-number")?.textContent).toBe("3");
  });

  it("numbers from where the deck says", () => {
    const section = draw(
      0,
      lookFor({ header: {}, footer: { end: "{number}" } }, { numbering: { start: 0 } }),
    );
    expect(section.querySelector(".dc-number")?.textContent).toBe("0");
  });

  it("draws nothing for a slide whose own chrome is none, and no words for one that is minimal", () => {
    const own = (chrome: "none" | "minimal"): PageLook => {
      const slides = SCENES.map((s) => ({
        id: s.id,
        title: s.title,
        template: s.template,
        ...(s.id === "revenue" ? { chrome } : {}),
      }));
      return lookFor(bands, { slides });
    };
    expect(draw(2, own("none")).querySelector(".dc-chrome")).toBeNull();
    const minimal = draw(2, own("minimal"));
    expect(minimal.querySelector(".dc-head, .dc-foot")).toBeNull();
  });

  it("still draws a look made before the header existed, with the number the context gives", () => {
    const old = lookWith({
      chrome: { footer: { text: "Harbor", place: "start" }, number: { place: "end" }, accent: "none" },
    }) as unknown as PageLook;
    const section = renderScene(SCENES[2] as Scene, { assetBase: ".", look: old, number: 7 });
    expect(cell(section, "foot", "start")?.textContent).toBe("Harbor");
    expect(section.querySelector(".dc-number")?.textContent).toBe("7");
  });
});
