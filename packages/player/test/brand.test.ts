// @vitest-environment happy-dom
import type { DeckLook, Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeck } from "../src/load.ts";
import { mountPlayer, type Player } from "../src/player.ts";
import { mountPresenterView } from "../src/presenter.ts";
import { renderReading } from "../src/reading.ts";
import { brandUrl } from "../src/safe.ts";
import { demoSource, sceneWith } from "./helpers.ts";
import { COLORS, lookWith, slot, template } from "./looks.ts";

const text = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  role: "body",
  text: `Words of ${id}`,
  ...more,
});

/** Slots in the order a reader meets them: the claim, then the right-hand side, then the left. */
const REVERSED = template("reversed", [
  slot("claim", "claim", { x: 6, y: 8, w: 88, h: 20 }),
  slot("right", "body", { x: 52, y: 34, w: 42, h: 50 }),
  slot("left", "body", { x: 6, y: 34, w: 42, h: 50 }),
]);

const templated = (more: Record<string, unknown> = {}): Scene =>
  sceneWith({ schemaVersion: "0.4", layout: undefined, template: "reversed", ...more });

describe("brandUrl", () => {
  it("takes a brand font, logo or image under the deck's folder, and nothing else", () => {
    expect(brandUrl(".", "brand/fonts/A.woff2")).toBe("./brand/fonts/A.woff2");
    expect(brandUrl("/decks/q3/", "brand/logos/mark.svg")).toBe("/decks/q3/brand/logos/mark.svg");
    expect(brandUrl("", "brand/images/hero.jpg")).toBe("/brand/images/hero.jpg");
    for (const path of [
      "brand/brand.json",
      "brand/templates/split.json",
      "brand/fonts/../../deck.json",
      "assets/x.png",
      "../brand/fonts/A.woff2",
      "https://example.com/brand/fonts/A.woff2",
      "brand/fonts/",
    ]) {
      expect(brandUrl(".", path), path).toBeUndefined();
    }
  });
});

describe("the reading view of a template scene", () => {
  const deck = demoSource().deck;
  const look = lookWith({ templates: { reversed: REVERSED } });
  const scene = templated({
    summary: { id: "claim-1", text: "Demand doubled." },
    blocks: [text("l", { slot: "left" }), text("r", { slot: "right" }), text("lost", { slot: "elsewhere" })],
  });
  const read = (ctx: { look?: DeckLook }) =>
    [...renderReading(deck, [scene], { assetBase: ".", ...ctx }).querySelectorAll("article p")].map(
      (p) => p.textContent,
    );

  it("follows the template's slot order, with the claim where the claim slot is, and what has no slot last", () => {
    expect(read({ look })).toEqual(["Demand doubled.", "Words of r", "Words of l", "Words of lost"]);
  });

  it("reads the claim first and the blocks as written where the page has no look for the template", () => {
    expect(read({})).toEqual(["Demand doubled.", "Words of l", "Words of r", "Words of lost"]);
  });

  it("is the same for a scene that is not a template: claim first, then the blocks as written", () => {
    const plain = sceneWith({
      summary: { id: "claim-1", text: "Demand doubled." },
      blocks: [text("b"), text("a")],
    });
    const lines = [...renderReading(deck, [plain], { assetBase: ".", look }).querySelectorAll("article p")].map(
      (p) => p.textContent,
    );
    expect(lines).toEqual(["Demand doubled.", "Words of b", "Words of a"]);
  });

  it("has no chrome, no slot box and no hidden content", () => {
    const view = renderReading(deck, [scene], {
      assetBase: ".",
      look: { ...look, chrome: { accent: "top", footer: { text: "Footer", place: "start" } } },
    });
    expect(view.querySelector(".dc-chrome, .dc-slot, .dc-logo, [data-gated]")).toBeNull();
  });
});

describe("loadDeck", () => {
  const deckJson = { schemaVersion: "0.4", title: "T", language: "en", scenes: ["a"] };
  const sceneJson = sceneWith({ id: "a" });
  const look = lookWith({ chart: ["#112233"] });

  function serve(answers: Record<string, () => Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const answer = Object.entries(answers).find(([path]) => url.endsWith(path))?.[1];
        return answer ? answer() : new Response("Not found", { status: 404 });
      }),
    );
  }
  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
  const base = { "/deck.json": json(deckJson), "/scenes/a.json": json(sceneJson) };

  afterEach(() => vi.unstubAllGlobals());

  it("reads look.json beside the deck and hands it to the player", async () => {
    serve({ ...base, "/look.json": json(look) });
    const source = await loadDeck("/decks/q3");
    expect(source.look?.chart).toEqual(["#112233"]);
    expect(source.assetBase).toBe("/decks/q3");
  });

  it("draws the deck from deck.json alone when the server has no look to give", async () => {
    serve(base);
    expect((await loadDeck("/decks/q3")).look).toBeUndefined();
  });

  it("does not take a home page, or JSON that is not a look, for a look", async () => {
    serve({ ...base, "/look.json": () => new Response("<!doctype html><p>Home</p>", { status: 200 }) });
    expect((await loadDeck("/decks/q3")).look).toBeUndefined();
    serve({ ...base, "/look.json": json({ hello: "world" }) });
    expect((await loadDeck("/decks/q3")).look).toBeUndefined();
    serve({ ...base, "/look.json": json(null) });
    expect((await loadDeck("/decks/q3")).look).toBeUndefined();
  });

  it("fails, so a reload keeps the last good deck, when the server answers a look with an error", async () => {
    serve({ ...base, "/look.json": () => new Response("Boom", { status: 500 }) });
    await expect(loadDeck("/decks/q3")).rejects.toThrow("answered 500");
  });
});

describe("the player with a deck's look", () => {
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

  const source = () => {
    const base = demoSource();
    const scenes = [
      templated({ id: "one", title: "One", blocks: [text("a", { slot: "left" })] }),
      templated({ id: "two", title: "Two", blocks: [text("b", { slot: "left" })] }),
    ];
    return {
      ...base,
      deck: { ...base.deck, scenes: ["one", "two"] },
      scenes,
      look: lookWith({
        colors: { ...COLORS, action: "#00aa55" },
        templates: { reversed: REVERSED },
        chrome: { number: { place: "end" }, accent: "none" },
      }),
    };
  };

  it("draws the look's colors on the root, and the slide number of the scene on show", () => {
    player = mountPlayer(host, source(), { reducedMotion: true });
    expect(root().style.getPropertyValue("--dc-action")).toBe("#00aa55");
    expect(root().style.getPropertyValue("--dc-state")).toBe(COLORS.state);
    expect(host.querySelector(".dc-number")?.textContent).toBe("1");
    player.go({ scene: 1, step: 0 });
    expect(host.querySelector(".dc-number")?.textContent).toBe("2");
    expect(host.querySelectorAll(".dc-slot")).toHaveLength(1);
  });

  it("draws the new look when the deck is swapped in, as the editor and live reload do", () => {
    const first = source();
    player = mountPlayer(host, first, { reducedMotion: true });
    player.update({ ...first, look: { ...first.look, colors: { ...COLORS, action: "#ff0000" } } });
    expect(root().style.getPropertyValue("--dc-action")).toBe("#ff0000");
    player.update({ deck: first.deck, scenes: first.scenes, assetBase: first.assetBase });
    expect(root().style.getPropertyValue("--dc-action")).toBe("");
    expect(host.querySelector(".dc-slot")).toBeNull();
  });

  it("is not drawn in the reading view, which reads in slot order and carries no number", () => {
    player = mountPlayer(host, source(), { reducedMotion: true });
    player.setMode("read");
    expect(host.querySelector(".dc-number, .dc-chrome")).toBeNull();
    expect(host.querySelectorAll("article")).toHaveLength(2);
  });
});

describe("the presenter view with a deck's look", () => {
  it("is drawn in the look's colors too", () => {
    const base = demoSource();
    const host = document.createElement("div");
    document.body.append(host);
    const channel = new EventTarget() as unknown as NonNullable<
      Parameters<typeof mountPresenterView>[0]["channel"]
    >;
    Object.assign(channel as object, { postMessage() {}, close() {} });
    const view = mountPresenterView({
      host,
      source: { ...base, look: lookWith({ colors: { ...COLORS, bg: "#123456" }, fonts: "classic" }) },
      channel,
    });
    const root = host.querySelector<HTMLElement>(".dc-presenter") as HTMLElement;
    expect(root.style.getPropertyValue("--dc-bg")).toBe("#123456");
    expect(root.dataset.fonts).toBe("classic");
    view.destroy();
    host.remove();
  });
});
