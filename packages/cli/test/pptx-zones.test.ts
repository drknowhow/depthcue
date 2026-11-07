import { describe, expect, it } from "vitest";
import { applyMaster } from "../src/pptx/master.ts";
import type { Ink, SlideMeasure, TextPlace } from "../src/pptx/measure.ts";

/* The header and the footer in the file: the number and the fixed footer words are PowerPoint's own placeholders, and every other zone is text on the slide. */

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

const ink: Ink = {
  px: 14,
  weight: 400,
  italic: false,
  caps: false,
  align: "left",
  color: "#555555",
  family: "Inter",
  lineHeight: 20,
  natural: 20,
  spacing: 0,
} as unknown as Ink;
const place = (text: string, x: number, y: number, align: Ink["align"] = "left"): TextPlace => ({
  text,
  box: { x, y, w: 120, h: 20 },
  inset: { t: 0, r: 0, b: 0, l: 0 },
  ink: { ...ink, align },
});

const measure = (zones: NonNullable<NonNullable<SlideMeasure["chrome"]>["zones"]>): SlideMeasure =>
  ({
    slide: { w: 1280, h: 720 },
    beyond: { right: 0, bottom: 0 },
    fonts: { display: "Inter", body: "Inter", mono: "Inter" },
    tones: {},
    link: "#0000ff",
    items: [],
    chrome: { zones },
  }) as unknown as SlideMeasure;

const SLIDES = [
  { id: "a", title: "Annual review" },
  { id: "b", title: "Results" },
];

function run(footer: Record<string, string>, header: Record<string, string>, start?: number) {
  const parts = new Map<string, Uint8Array>();
  parts.set("[Content_Types].xml", enc("<Types></Types>"));
  parts.set("ppt/presentation.xml", enc('<p:presentation xmlns:p="x"><p:sldIdLst/></p:presentation>'));
  for (const n of [1, 2])
    parts.set(`ppt/slides/slide${n}.xml`, enc("<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>"));
  const zones = [
    { band: "head" as const, at: "start" as const, place: place("Annual review", 80, 30) },
    { band: "foot" as const, at: "start" as const, place: place("Acme", 80, 680) },
    { band: "foot" as const, at: "center" as const, place: place("1 / 2", 560, 680, "center") },
    { band: "foot" as const, at: "end" as const, place: place("1", 1080, 680, "right") },
  ];
  const look = {
    colors: { bg: "#ffffff" },
    theme: "light",
    templates: {},
    chrome: { accent: "none", bands: { header, footer } },
    outline: {
      title: "Annual review",
      slides: SLIDES,
      ...(start === undefined ? {} : { numbering: { start } }),
    },
  };
  const scenes = SLIDES.map((s) => ({ id: s.id, title: s.title, blocks: [] }));
  applyMaster(parts, {
    look: look as never,
    scenes: scenes as never,
    measures: [measure(zones), measure(zones)],
    pictures: false,
  });
  return {
    slide: dec(parts.get("ppt/slides/slide1.xml")),
    presentation: dec(parts.get("ppt/presentation.xml")),
    master: dec(parts.get("ppt/slideMasters/slideMaster1.xml")),
  };
}

describe("the header and the footer in the file", () => {
  const footer = { start: "Acme", center: "{number} / {count}", end: "{number}" };

  it("keeps the number and the fixed footer words as placeholders and writes the rest as text boxes", () => {
    const { slide, master } = run(footer, { start: "{deck}" });
    expect(master).toContain('type="ftr"');
    expect(master).toContain('type="sldNum"');
    expect(slide).toContain('<p:ph type="ftr"');
    expect(slide).toContain("<a:t>Acme</a:t>");
    expect(slide).toContain('name="Header start"');
    expect(slide).toContain("<a:t>Annual review</a:t>");
    expect(slide).toContain('name="Footer center"');
    expect(slide).toContain(" / 2</a:t>");
    expect(slide).toContain('type="slidenum"');
    expect(slide).not.toContain('name="Footer start"');
    expect(slide).not.toContain('name="Footer end"');
  });

  it("starts PowerPoint's numbering where the deck's does", () => {
    expect(run(footer, {}, 0).presentation).toContain('firstSlideNum="0"');
    expect(run(footer, {}).presentation).not.toContain("firstSlideNum");
  });
});
