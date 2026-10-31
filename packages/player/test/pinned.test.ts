// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountPlayer, type Player } from "../src/player.ts";
import { renderScene } from "../src/scene.ts";
import { demoSource, sceneWith } from "./helpers.ts";

const ctx = { assetBase: "." };
const frame = { x: 56, y: 14, w: 38, h: 44 };

const heading = { id: "t-heading", type: "text", role: "heading", text: "Hello" };
const body = { id: "t-body", type: "text", role: "body", text: "Words" };
const image = { id: "t-image", type: "image", asset: "assets/method.svg", alt: "A diagram" };
const chart = { id: "t-chart", type: "bar-chart", data: [{ label: "A", value: 1 }] };

const idsIn = (parent: Element | null | undefined) =>
  [...(parent?.children ?? [])].map((child) => (child as HTMLElement).dataset.id);

describe("a scene with no frame", () => {
  it("is drawn as before: no slide, no layer for pins", () => {
    const section = renderScene(sceneWith({ schemaVersion: "0.2", blocks: [heading, body] }), ctx);
    expect(section.hasAttribute("data-framed")).toBe(false);
    expect(section.querySelector(".dc-pins")).toBeNull();
    expect(section.querySelector(".dc-pinned")).toBeNull();
  });
});

describe("a pinned block", () => {
  const scene = sceneWith({
    schemaVersion: "0.2",
    blocks: [heading, { ...body, frame }],
  });

  it("makes the scene a framed slide", () => {
    expect(renderScene(scene, ctx).hasAttribute("data-framed")).toBe(true);
  });

  it("sits in the layer for pins, with its frame as four numbers for the stylesheet", () => {
    const section = renderScene(scene, ctx);
    const node = section.querySelector<HTMLElement>("[data-id='t-body']");
    expect(node?.parentElement?.className).toBe("dc-pins");
    expect(node?.classList.contains("dc-pinned")).toBe(true);
    expect(["--x", "--y", "--w", "--h"].map((name) => node?.style.getPropertyValue(name))).toEqual([
      "56",
      "14",
      "38",
      "44",
    ]);
  });

  it("keeps fractions as they were written", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        blocks: [{ ...body, frame: { x: 12.5, y: 0.25, w: 33.3, h: 20.05 } }],
      }),
      ctx,
    );
    const node = section.querySelector<HTMLElement>("[data-id='t-body']");
    expect(["--x", "--y", "--w", "--h"].map((name) => node?.style.getPropertyValue(name))).toEqual([
      "12.5",
      "0.25",
      "33.3",
      "20.05",
    ]);
  });

  it("leaves the template's regions, and the rest of the scene is laid out without it", () => {
    const section = renderScene(scene, ctx);
    expect(idsIn(section.querySelector(".dc-stack"))).toEqual(["t-heading"]);
    expect(section.querySelector(".dc-stack [data-id='t-body']")).toBeNull();
  });

  it("is a block like any other: identified, gated by a step, and cited", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        sources: [{ id: "src-a", title: "Report" }],
        steps: [{ id: "step-one", reveal: ["t-body"] }],
        blocks: [heading, { ...body, frame, sourceIds: ["src-a"] }],
      }),
      ctx,
    );
    const node = section.querySelector<HTMLElement>("[data-id='t-body']");
    expect(node?.dataset.gated).toBe("");
    expect(node?.dataset.revealed).toBe("false");
    expect(node?.classList.contains("dc-block")).toBe(true);
    expect(node?.querySelector(".dc-cite")?.textContent).toBe("Source: Report");
  });

  it("is in the layer in block order, whatever its place on the slide", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        blocks: [
          { ...body, id: "first", frame: { x: 70, y: 70, w: 20, h: 20 } },
          { ...body, id: "second", frame: { x: 5, y: 5, w: 20, h: 20 } },
          { ...body, id: "third", frame: { x: 40, y: 40, w: 20, h: 20 } },
        ],
      }),
      ctx,
    );
    expect(idsIn(section.querySelector(".dc-pins"))).toEqual(["first", "second", "third"]);
  });

  it("comes before the sources, which stay in the flow", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        sources: [{ id: "src-a", title: "Report" }],
        blocks: [heading, { ...body, frame }],
      }),
      ctx,
    );
    const names = [...section.children].map((child) => child.className);
    expect(names.indexOf("dc-pins")).toBeGreaterThan(-1);
    expect(names.indexOf("dc-pins")).toBeLessThan(names.indexOf("dc-sources"));
  });
});

describe("a pinned block in each template", () => {
  it("leaves the evidence region of claim-evidence, though the claim still cites it", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        layout: "claim-evidence",
        summary: { id: "the-claim", text: "A claim.", evidenceIds: ["t-chart", "t-image"] },
        blocks: [{ ...chart, frame }, image],
      }),
      ctx,
    );
    expect(idsIn(section.querySelector(".dc-evidence-region"))).toEqual(["t-image"]);
    expect(section.querySelector(".dc-pins [data-id='t-chart']")).not.toBeNull();
  });

  it("leaves the support region of claim-evidence", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        layout: "claim-evidence",
        summary: { id: "the-claim", text: "A claim.", evidenceIds: ["t-image"] },
        blocks: [image, { ...body, frame }],
      }),
      ctx,
    );
    expect(section.querySelector(".dc-support-region")?.children.length).toBe(0);
    expect(section.querySelector(".dc-pins [data-id='t-body']")).not.toBeNull();
  });

  it("takes a pinned heading out of the claim region when there is no claim", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        layout: "claim-evidence",
        blocks: [{ ...heading, frame }, chart],
      }),
      ctx,
    );
    expect(section.querySelector(".dc-claim-region")?.children.length).toBe(0);
    expect(section.querySelector(".dc-pins [data-id='t-heading']")).not.toBeNull();
  });

  it("drops the media region of text-media when every picture is pinned", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        layout: "text-media",
        blocks: [heading, { ...image, frame }],
      }),
      ctx,
    );
    expect(section.querySelector(".dc-media-region")).toBeNull();
    expect(idsIn(section.querySelector(".dc-text-region"))).toEqual(["t-heading"]);
    expect(section.querySelector(".dc-pins img")).not.toBeNull();
  });

  it("keeps the unpinned picture of text-media in its region", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.2",
        layout: "text-media",
        blocks: [{ ...heading, frame }, image],
      }),
      ctx,
    );
    expect(idsIn(section.querySelector(".dc-media-region"))).toEqual(["t-image"]);
    expect(idsIn(section.querySelector(".dc-text-region"))).toEqual([]);
  });
});

describe("a pinned block in the player", () => {
  let host: HTMLElement;
  let player: Player | undefined;

  beforeEach(() => {
    history.replaceState(null, "", "/");
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    player?.destroy();
    host.remove();
  });

  it("appears with its step, like a block in a region", () => {
    const { deck } = demoSource();
    const scene = sceneWith({
      schemaVersion: "0.2",
      steps: [{ id: "step-one", reveal: ["t-body"] }],
      blocks: [heading, { ...body, frame }],
    });
    player = mountPlayer(
      host,
      { deck: { ...deck, scenes: [scene.id] }, scenes: [scene], assetBase: "." },
      { reducedMotion: true },
    );
    const node = () => host.querySelector<HTMLElement>(".dc-pins [data-id='t-body']");
    expect(node()?.dataset.revealed).toBe("false");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(node()?.dataset.revealed).toBe("true");
  });
});
