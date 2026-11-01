// @vitest-environment happy-dom

import { PALETTE_COLORS } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountPlayer, type Player } from "../src/player.ts";
import { mountPresenterView } from "../src/presenter.ts";
import { applyLook, lookKey } from "../src/style.ts";
import { demoSource } from "./helpers.ts";

const COLORS = {
  bg: "#101820",
  surface: "#182430",
  line: "#304050",
  text: "#f0f4f8",
  muted: "#b0bcc8",
  action: "#ff7755",
  evidence: "#88aaff",
};

describe("applyLook", () => {
  it("sets the theme, the font pair and every palette color the deck names, each as its own --dc property", () => {
    const element = document.createElement("div");
    applyLook(element, { theme: "ink", palette: COLORS, fonts: "classic" });
    expect(element.dataset.theme).toBe("ink");
    expect(element.dataset.fonts).toBe("classic");
    for (const color of PALETTE_COLORS) {
      expect(element.style.getPropertyValue(`--dc-${color}`), color).toBe(COLORS[color]);
    }
  });

  it("names all seven palette colors, so none is left to the preset by a list that forgot it", () => {
    expect(PALETTE_COLORS).toEqual(["bg", "surface", "line", "text", "muted", "action", "evidence"]);
    expect(Object.keys(COLORS)).toEqual([...PALETTE_COLORS]);
  });

  it("leaves a color the palette does not name to the preset, and a deck with no fonts to the default", () => {
    const element = document.createElement("div");
    applyLook(element, { theme: "paper", palette: { text: "#000000" } });
    expect(element.style.getPropertyValue("--dc-text")).toBe("#000000");
    expect(element.style.getPropertyValue("--dc-bg")).toBe("");
    expect(element.hasAttribute("data-fonts")).toBe(false);
  });

  it("takes off what an earlier look set that the new one does not", () => {
    const element = document.createElement("div");
    applyLook(element, { theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "modern" });
    applyLook(element, { theme: "ink", palette: { action: "#ff8866" } });
    expect(element.dataset.theme).toBe("ink");
    expect(element.style.getPropertyValue("--dc-bg")).toBe("");
    expect(element.style.getPropertyValue("--dc-action")).toBe("#ff8866");
    expect(element.hasAttribute("data-fonts")).toBe(false);
    applyLook(element, { theme: "ink" });
    expect(element.getAttribute("style") ?? "").toBe("");
  });
});

describe("lookKey", () => {
  it("is the same for the same look however the palette is written, and differs for each part of it", () => {
    const base = lookKey({ theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "modern" });
    expect(lookKey({ theme: "paper", palette: { action: "#aa2200", bg: "#ffffff" }, fonts: "modern" })).toBe(
      base,
    );
    expect(
      lookKey({ theme: "ink", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "modern" }),
    ).not.toBe(base);
    expect(
      lookKey({ theme: "paper", palette: { bg: "#fffffe", action: "#aa2200" }, fonts: "modern" }),
    ).not.toBe(base);
    expect(
      lookKey({ theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" }, fonts: "classic" }),
    ).not.toBe(base);
    expect(lookKey({ theme: "paper", palette: { bg: "#ffffff", action: "#aa2200" } })).not.toBe(base);
    expect(lookKey({ theme: "paper", fonts: "modern" })).not.toBe(base);
  });
});

describe("the player", () => {
  let host: HTMLElement;
  let player: Player | undefined;
  beforeEach(() => {
    history.replaceState(null, "", "/");
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    player?.destroy();
    player = undefined;
    host.remove();
  });
  const root = () => host.querySelector<HTMLElement>(".dc-player") as HTMLElement;

  it("draws the deck's palette and font pair on the page: each of the seven colors reaches the root", () => {
    const source = demoSource();
    source.deck = { ...source.deck, theme: "ink", palette: COLORS, fonts: "technical" };
    player = mountPlayer(host, source, { reducedMotion: true });
    expect(root().dataset.theme).toBe("ink");
    expect(root().dataset.fonts).toBe("technical");
    for (const color of PALETTE_COLORS) {
      expect(root().style.getPropertyValue(`--dc-${color}`), color).toBe(COLORS[color]);
    }
  });

  it("changes the look when the deck is swapped in, as the editor and live reload do", () => {
    const source = demoSource();
    player = mountPlayer(host, source, { reducedMotion: true });
    expect(root().style.getPropertyValue("--dc-evidence")).toBe("");
    player.update({ ...source, deck: { ...source.deck, palette: { evidence: "#0044cc" }, fonts: "modern" } });
    expect(root().style.getPropertyValue("--dc-evidence")).toBe("#0044cc");
    expect(root().dataset.fonts).toBe("modern");
    player.update(source);
    expect(root().style.getPropertyValue("--dc-evidence")).toBe("");
    expect(root().hasAttribute("data-fonts")).toBe(false);
  });
});

describe("the presenter view", () => {
  it("is drawn in the deck's palette and font pair too", () => {
    const source = demoSource();
    const host = document.createElement("div");
    document.body.append(host);
    const channel = new EventTarget() as unknown as NonNullable<
      Parameters<typeof mountPresenterView>[0]["channel"]
    >;
    Object.assign(channel as object, { postMessage() {}, close() {} });
    const view = mountPresenterView({
      host,
      source: { ...source, deck: { ...source.deck, palette: { bg: "#ffffff" }, fonts: "classic" } },
      channel,
    });
    const root = host.querySelector<HTMLElement>(".dc-presenter") as HTMLElement;
    expect(root.dataset.fonts).toBe("classic");
    expect(root.style.getPropertyValue("--dc-bg")).toBe("#ffffff");
    view.destroy();
    host.remove();
  });
});
