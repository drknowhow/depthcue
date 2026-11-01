// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderScene } from "../src/scene.ts";
import { sceneWith } from "./helpers.ts";

const ctx = { assetBase: "." };
const table = {
  id: "t-table",
  type: "table",
  title: "Orders by channel",
  columns: [{ label: "Channel" }, { label: "Orders", kind: "number" }],
  rows: [["A", 4000]],
  sourceIds: ["t-source"],
};
const chart = {
  id: "t-chart",
  type: "chart",
  kind: "line",
  columns: [{ label: "Quarter" }, { label: "Orders" }],
  rows: [["Q1", 10]],
};

describe("a table or a chart, which the player does not draw yet", () => {
  it("holds its place with what it is and its title", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.3",
        blocks: [table, chart],
        sources: [{ id: "t-source", title: "Order snapshot" }],
      }),
      ctx,
    );
    const [first, second] = section.querySelectorAll<HTMLElement>(".dc-placeholder");
    expect(first?.dataset.id).toBe("t-table");
    expect(first?.dataset.kind).toBe("table");
    expect(first?.querySelector(".dc-label")?.textContent).toBe("Table");
    expect(first?.querySelector("figcaption")?.textContent).toBe("Orders by channel");
    expect(first?.querySelector(".dc-cite")?.textContent).toBe("Source: Order snapshot");
    expect(second?.dataset.kind).toBe("line");
    expect(second?.querySelector(".dc-label")?.textContent).toBe("Chart");
    expect(second?.querySelector("figcaption")).toBeNull();
  });

  it("shows its title as written, like a caption, since markup is read only in a text block's text", () => {
    const image = { id: "t-image", type: "image", asset: "assets/a.png", alt: "A", caption: "**x**" };
    const section = renderScene(
      sceneWith({ schemaVersion: "0.3", blocks: [{ ...table, title: "**x**" }, image] }),
      ctx,
    );
    expect(section.querySelector(".dc-placeholder figcaption")?.textContent).toBe("**x**");
    expect(section.querySelector("[data-id='t-image'] figcaption")?.textContent).toBe("**x**");
    expect(section.querySelector("strong")).toBeNull();
  });

  it("takes part in steps and frames like any block", () => {
    const section = renderScene(
      sceneWith({
        schemaVersion: "0.3",
        blocks: [{ ...chart, frame: { x: 10, y: 10, w: 40, h: 40 } }],
        steps: [{ id: "t-step", reveal: ["t-chart"] }],
      }),
      ctx,
    );
    const pinned = section.querySelector<HTMLElement>(".dc-pins .dc-placeholder");
    expect(pinned?.dataset.gated).toBe("");
    expect(section.querySelector(".dc-ghost.dc-placeholder")).not.toBeNull();
  });
});
