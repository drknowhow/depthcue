// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderReading } from "../src/reading.ts";
import { renderChartTable, renderScene } from "../src/scene.ts";
import { demoSource, sceneWith } from "./helpers.ts";

const ctx = { assetBase: "." };
const { deck, scenes } = demoSource();
const [opening, demand, method] = scenes as [(typeof scenes)[0], (typeof scenes)[0], (typeof scenes)[0]];

describe("renderScene", () => {
  it("renders the title template with the lead on the section", () => {
    const section = renderScene(opening, ctx);
    expect(section.dataset.layout).toBe("title");
    expect(section.dataset.lead).toBe("human");
    expect(section.querySelector("h2.dc-heading")?.textContent).toBe("Channel B now leads demand");
    expect(section.getAttribute("aria-label")).toBe(opening.title);
  });

  it("renders claim-evidence with the claim and the chart in their regions", () => {
    const section = renderScene(demand, ctx);
    expect(section.dataset.lead).toBe("agent");
    expect(section.querySelector(".dc-claim-region .dc-claim")?.textContent).toBe(
      "Channel B now leads, 60 to 40.",
    );
    expect(section.querySelector(".dc-evidence-region table.dc-chart")).not.toBeNull();
    expect(section.querySelector(".dc-sources a")?.getAttribute("href")).toBe("./assets/report.csv");
  });

  it("marks only the blocks a step reveals as gated, and starts them hidden", () => {
    const section = renderScene(demand, ctx);
    const gated = [...section.querySelectorAll<HTMLElement>("[data-gated]")];
    expect(gated.map((node) => node.dataset.id)).toEqual(["claim-shift", "chart-demand"]);
    expect(gated.every((node) => node.dataset.revealed === "false")).toBe(true);
    expect(renderScene(opening, ctx).querySelector("[data-gated]")).toBeNull();
  });

  it("renders text-media with the image in the media region", () => {
    const section = renderScene(method, ctx);
    expect(section.dataset.layout).toBe("text-media");
    const image = section.querySelector<HTMLImageElement>(".dc-media-region img");
    expect(image?.getAttribute("src")).toBe("./assets/method.svg");
    expect(image?.getAttribute("alt")).toBeTruthy();
  });

  it("gives a decorative image an empty alt on the slide, and leaves it out of the reading version, alt text or not", () => {
    for (const alt of [{}, { alt: "Waves" }]) {
      const scene = sceneWith({
        schemaVersion: "0.6",
        layout: "text-media",
        blocks: [
          { id: "h", type: "text", role: "heading", text: "Hi" },
          { id: "i", type: "image", asset: "assets/sea.png", decorative: true, ...alt },
        ],
      });
      expect(renderScene(scene, ctx).querySelector("img")?.getAttribute("alt")).toBe("");
      expect(renderReading(deck, [scene], ctx).querySelector("img")).toBeNull();
    }
  });

  it("turns deck text into text, never into markup", () => {
    const hostile = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
    const section = renderScene(
      sceneWith({
        title: hostile,
        blocks: [
          { id: "h", type: "text", role: "heading", text: hostile },
          { id: "b", type: "text", role: "body", text: hostile },
        ],
      }),
      ctx,
    );
    expect(section.querySelector("script")).toBeNull();
    expect(section.querySelector("img")).toBeNull();
    expect(section.querySelector("h2")?.textContent).toBe(hostile);
    expect(section.getAttribute("aria-label")).toBe(hostile);
  });

  it("drops an unsafe asset path instead of rendering it", () => {
    const section = renderScene(
      sceneWith({
        layout: "text-media",
        blocks: [
          { id: "h", type: "text", role: "heading", text: "Hi" },
          { id: "i", type: "image", asset: "assets/../deck.json", alt: "x" },
        ],
      }),
      ctx,
    );
    expect(section.querySelector("img")).toBeNull();
  });

  it("links a source only when its url is http or https", () => {
    const section = renderScene(
      sceneWith({
        sources: [
          { id: "ok", title: "Fine", url: "https://example.com/a" },
          { id: "bad", title: "Bad", url: "javascript:alert(1)" },
        ],
      }),
      ctx,
    );
    const items = [...section.querySelectorAll(".dc-sources li")];
    expect(items[0]?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(items[0]?.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(items[1]?.querySelector("a")).toBeNull();
    expect(items[1]?.textContent).toBe("Bad");
  });

  it("keeps clips from loading until they are played", () => {
    const section = renderScene(
      sceneWith({
        layout: "text-media",
        blocks: [
          { id: "h", type: "text", role: "heading", text: "Hi" },
          { id: "c", type: "clip", source: "assets/demo.mp4", alt: "A demo" },
        ],
      }),
      ctx,
    );
    const video = section.querySelector("video");
    expect(video?.getAttribute("preload")).toBe("none");
    expect(video?.getAttribute("aria-label")).toBe("A demo");
  });
});

describe("renderChartTable", () => {
  const chart = demand.blocks.find((block) => block.type === "bar-chart");
  if (chart?.type !== "bar-chart") throw new Error("the demand scene should have a bar chart");

  it("is a table a screen reader can read, with the values as text", () => {
    const table = renderChartTable(chart);
    expect(table.querySelector("caption")?.textContent).toBe("Share of orders, latest quarter");
    const rows = [...table.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(rows).toEqual(["Channel A40%", "Channel B60%"]);
  });

  it("sizes each bar against the largest value", () => {
    const widths = [...renderChartTable(chart).querySelectorAll<HTMLElement>(".dc-bar")].map((bar) =>
      Number(bar.style.getPropertyValue("--w")),
    );
    expect(widths[1]).toBe(1);
    expect(widths[0]).toBeCloseTo(40 / 60, 5);
  });

  it("does not divide by zero when every value is 0", () => {
    const zero = { ...chart, data: chart.data.map((row) => ({ ...row, value: 0 })) };
    const widths = [...renderChartTable(zero).querySelectorAll<HTMLElement>(".dc-bar")].map((bar) =>
      Number(bar.style.getPropertyValue("--w")),
    );
    expect(widths).toEqual([0, 0]);
  });
});

describe("renderReading", () => {
  it("shows every scene with its reading text, chart table and sources", () => {
    const reading = renderReading(deck, scenes, ctx);
    expect(reading.querySelector("h1")?.textContent).toBe(deck.title);
    expect(reading.querySelectorAll("article")).toHaveLength(3);
    const second = reading.querySelectorAll("article")[1];
    expect(second?.textContent).toContain("channel B accounted for 60% of orders");
    expect(second?.querySelector("table.dc-chart")).not.toBeNull();
    expect(second?.querySelector(".dc-sources")).not.toBeNull();
  });

  it("contains no gated or hidden content", () => {
    const reading = renderReading(deck, scenes, ctx);
    expect(reading.querySelector("[data-gated]")).toBeNull();
  });

  it("falls back to the scene's own words when it has no reading text", () => {
    const bare = sceneWith({ title: "Bare" });
    expect(bare.reading).toBeUndefined();
    const reading = renderReading(deck, [bare], ctx);
    expect(reading.querySelector("article")?.textContent).toContain("Hello");
  });
});
