// @vitest-environment happy-dom
// What the player writes for a picture's fit, crop and focus and for a scene's own background. There is no layout in
// happy-dom, so these are the elements and the numbers the stylesheet reads; where the boxes land, and which part of the
// file is at the middle of one, is in packages/cli/test/images-player-e2e.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Deck, Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { renderReading } from "../src/reading.ts";
import { renderScene } from "../src/scene.ts";
import { sceneWith } from "./helpers.ts";
import { lookWith, slot, template } from "./looks.ts";

const ctx = { assetBase: "/deck" };
const picture = { id: "pic", type: "image", asset: "assets/grid.png", alt: "A grid" };
const draw = (blocks: unknown[], more: Record<string, unknown> = {}, look = lookWith()) =>
  renderScene(sceneWith({ schemaVersion: "0.6", layout: "text-media", blocks, ...more }), { ...ctx, look });
const figure = (section: HTMLElement) => section.querySelector<HTMLElement>(".dc-figure[data-id='pic']");

describe("a plain picture", () => {
  it("is an img in its figure and nothing more, as it was before 0.6", () => {
    const node = figure(draw([picture]));
    expect(node?.className).toBe("dc-figure dc-block");
    expect([...(node?.children ?? [])].map((child) => child.tagName)).toEqual(["IMG"]);
    const img = node?.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/deck/assets/grid.png");
    expect(img.getAttribute("alt")).toBe("A grid");
    expect(node?.querySelector(".dc-crop")).toBeNull();
  });
});

describe("a picture with a fit, crop or focus", () => {
  it("sits in a stage inside a clipping box that carries the crop as numbers", () => {
    const node = figure(draw([{ ...picture, crop: { x: 50, y: 0, w: 50, h: 40 } }]));
    const box = node?.querySelector<HTMLElement>(":scope > .dc-crop");
    expect(box).not.toBeNull();
    for (const [name, value] of [
      ["--cx", "50"],
      ["--cy", "0"],
      ["--cw", "50"],
      ["--ch", "40"],
    ]) {
      expect(box?.style.getPropertyValue(name as string), name).toBe(value);
    }
    // The stage is what the stylesheet sizes, the img what it scales into the stage.
    expect(box?.querySelector(":scope > .dc-crop-in > img")).not.toBeNull();
    expect(box?.querySelector(".dc-crop-in")?.hasAttribute("data-fit")).toBe(false);
  });

  it("names a fit on the stage, and the focus as numbers on the box", () => {
    const cover = figure(draw([{ ...picture, fit: "cover", focus: { x: 30, y: 80 } }]));
    const box = cover?.querySelector<HTMLElement>(".dc-crop") as HTMLElement;
    expect(cover?.querySelector(".dc-crop-in")?.getAttribute("data-fit")).toBe("cover");
    expect(box.style.getPropertyValue("--gx")).toBe("30");
    expect(box.style.getPropertyValue("--gy")).toBe("80");
    // With no crop the whole file shows.
    expect(box.style.getPropertyValue("--cw")).toBe("100");
    expect(box.style.getPropertyValue("--ch")).toBe("100");

    const contain = figure(draw([{ ...picture, fit: "contain" }]));
    expect(contain?.querySelector(".dc-crop-in")?.getAttribute("data-fit")).toBe("contain");
    expect(contain?.querySelector<HTMLElement>(".dc-crop")?.style.getPropertyValue("--gx")).toBe("");
  });

  it("takes its aspect ratio from the file once the file's size is known: the crop's width over its height", () => {
    const node = figure(draw([{ ...picture, crop: { x: 0, y: 0, w: 50, h: 100 } }]));
    const box = node?.querySelector<HTMLElement>(".dc-crop") as HTMLElement;
    const img = box.querySelector("img") as HTMLImageElement;
    expect(box.style.getPropertyValue("--a")).toBe("");
    Object.defineProperty(img, "naturalWidth", { value: 400 });
    Object.defineProperty(img, "naturalHeight", { value: 200 });
    img.dispatchEvent(new Event("load"));
    // 400 by 200 pixels, half the width: 200 by 200.
    expect(box.style.getPropertyValue("--a")).toBe("1");
  });

  it("keeps the room a pinned picture had, with the same box in it", () => {
    const section = draw([{ ...picture, fit: "cover", frame: { x: 10, y: 30, w: 40, h: 20 } }]);
    expect(section.querySelectorAll(".dc-crop")).toHaveLength(2);
    const ghost = section.querySelector(".dc-ghost .dc-crop");
    const img = ghost?.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 300 });
    Object.defineProperty(img, "naturalHeight", { value: 150 });
    img.dispatchEvent(new Event("load"));
    expect((ghost as HTMLElement).style.getPropertyValue("--a")).toBe("2");
  });

  it("is a decorative picture's empty alt, whatever else it says", () => {
    const node = figure(draw([{ ...picture, decorative: true, alt: undefined, fit: "cover" }]));
    expect(node?.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("replaces a picture slot's cover with the fit it names, and leaves cover to a slot with none", () => {
    const look = lookWith({
      templates: {
        wide: template("wide", [
          slot("pic", "picture", { x: 0, y: 0, w: 100, h: 69 }, { accepts: ["image"] }),
        ]),
      },
    });
    const draw2 = (extra: Record<string, unknown>) =>
      renderScene(
        sceneWith({
          schemaVersion: "0.6",
          layout: undefined,
          template: "wide",
          blocks: [{ ...picture, slot: "pic", ...extra }],
        }),
        { ...ctx, look },
      );
    // No fit: a bare img, which the stylesheet's picture rule covers.
    const plain = draw2({});
    expect(plain.querySelector(".dc-slot[data-role='picture'] > .dc-figure > img")).not.toBeNull();
    expect(plain.querySelector(".dc-crop")).toBeNull();
    // A fit: the box, whose stage reads the fit and so is not left to the slot's cover.
    const contained = draw2({ fit: "contain" });
    expect(
      contained.querySelector(".dc-slot[data-role='picture'] .dc-crop-in")?.getAttribute("data-fit"),
    ).toBe("contain");
    // A focus alone leaves the fit to the slot, which the stylesheet makes cover.
    const focused = draw2({ focus: { x: 20, y: 20 } });
    expect(focused.querySelector(".dc-slot[data-role='picture'] .dc-crop-in")?.hasAttribute("data-fit")).toBe(
      false,
    );
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../src/player.css"), "utf8");

  it("sizes the stage by container units, so no browser needs object-view-box", () => {
    expect(css).not.toContain("object-view-box");
    expect(css).toMatch(/\.dc-crop \{[^}]*container-type: size/);
    expect(css).toMatch(
      /\.dc-crop-in\[data-fit="cover"\],\s*\.dc-slot\[data-role="picture"\] \.dc-crop-in:not\(\[data-fit\]\) \{[^}]*max\(100cqw/,
    );
  });
});

describe("a scene's own background", () => {
  const body = { id: "t", type: "text", role: "body", text: "Words" };
  const backgroundOf = (background: unknown, more: Record<string, unknown> = {}, look = lookWith()) =>
    draw([body], { background, ...more }, look);

  it("is a backdrop from assets/ under a scrim of its color, drawn first", () => {
    const section = backgroundOf({ asset: "assets/grid.png", scrim: 40, color: "action", alt: "A grid" });
    const backdrop = section.firstElementChild as HTMLElement;
    expect(backdrop.className).toBe("dc-backdrop");
    expect(backdrop.style.backgroundImage).toContain("/deck/assets/grid.png");
    expect(backdrop.style.getPropertyValue("--scrim")).toBe("40");
    expect(section.hasAttribute("data-image")).toBe(true);
    expect(section.dataset.bg).toBe("action");
    expect(section.dataset.on).toBe("strong");
  });

  it("uses the slide's bg color when it names none, and centers the picture unless it has a focus", () => {
    const centered = backgroundOf({ asset: "assets/grid.png", scrim: 10, decorative: true });
    expect(centered.dataset.bg).toBe("bg");
    expect(centered.hasAttribute("data-on")).toBe(false);
    expect((centered.firstElementChild as HTMLElement).style.backgroundPosition).toBe("");
    const focused = backgroundOf({
      asset: "assets/grid.png",
      scrim: 10,
      focus: { x: 20, y: 90 },
      decorative: true,
    });
    expect((focused.firstElementChild as HTMLElement).style.backgroundPosition).toBe("20% 90%");
  });

  it("is an image to a screen reader when it says something, and hidden when it is decorative", () => {
    const says = backgroundOf({ asset: "assets/grid.png", scrim: 10, alt: "The harbor at night" })
      .firstElementChild as HTMLElement;
    expect(says.getAttribute("role")).toBe("img");
    expect(says.getAttribute("aria-label")).toBe("The harbor at night");
    expect(says.hasAttribute("aria-hidden")).toBe(false);
    const mood = backgroundOf({ asset: "assets/grid.png", scrim: 10, decorative: true, alt: "Ignored" })
      .firstElementChild as HTMLElement;
    expect(mood.getAttribute("aria-hidden")).toBe("true");
    expect(mood.hasAttribute("role")).toBe(false);
    expect(mood.hasAttribute("aria-label")).toBe(false);
  });

  it("replaces the template's own picture", () => {
    const look = lookWith({
      templates: {
        photo: template("photo", [slot("body", "body", { x: 6, y: 34, w: 42, h: 50 })], {
          background: { color: "text", image: "images/hero.jpg", scrim: 60 },
        } as never),
      },
    });
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.6",
        layout: undefined,
        template: "photo",
        blocks: [{ ...body, slot: "body" }],
        background: { asset: "assets/grid.png", scrim: 5, alt: "Own" },
      }),
      { ...ctx, look },
    );
    const backdrops = section.querySelectorAll<HTMLElement>(".dc-backdrop");
    expect(backdrops).toHaveLength(1);
    expect(backdrops[0]?.style.backgroundImage).toContain("/deck/assets/grid.png");
    expect(backdrops[0]?.style.backgroundImage).not.toContain("hero.jpg");
    expect(backdrops[0]?.style.getPropertyValue("--scrim")).toBe("5");
    expect(section.dataset.bg).toBe("bg");
  });

  it("draws nothing for a path outside assets/", () => {
    const section = backgroundOf({ asset: "../secret.png", scrim: 10, alt: "x" });
    expect(section.querySelector(".dc-backdrop")).toBeNull();
    expect(section.hasAttribute("data-image")).toBe(false);
  });
});

describe("the reading version", () => {
  const deck = {
    id: "d",
    title: "Deck",
    language: "en",
    schemaVersion: "0.6",
    scenes: ["s"],
  } as unknown as Deck;
  const read = (scene: Scene) => renderReading(deck, [scene], ctx);

  it("leaves a decorative picture out and keeps one that says something", () => {
    const scene = sceneWith({
      schemaVersion: "0.6",
      blocks: [
        { id: "a", type: "image", asset: "assets/grid.png", decorative: true },
        {
          id: "b",
          type: "image",
          asset: "assets/grid.png",
          alt: "A grid",
          crop: { x: 0, y: 0, w: 50, h: 50 },
        },
      ],
    });
    const images = [...read(scene).querySelectorAll("img")];
    expect(images.map((img) => img.getAttribute("alt"))).toEqual(["A grid"]);
    // The reading version shows the whole file, whatever the slide crops.
    expect(read(scene).querySelector(".dc-crop")).toBeNull();
  });

  it("shows a background that says something as a figure with its alt, and leaves a decorative one out", () => {
    const says = sceneWith({
      schemaVersion: "0.6",
      background: { asset: "assets/grid.png", scrim: 20, alt: "The harbor at night" },
    });
    const figures = [...read(says).querySelectorAll("figure img")];
    expect(figures.map((img) => img.getAttribute("alt"))).toEqual(["The harbor at night"]);
    expect(figures[0]?.getAttribute("src")).toBe("/deck/assets/grid.png");

    const mood = sceneWith({
      schemaVersion: "0.6",
      background: { asset: "assets/grid.png", scrim: 20, decorative: true },
    });
    expect(read(mood).querySelector("img")).toBeNull();
  });
});
