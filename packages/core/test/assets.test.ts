import { describe, expect, it } from "vitest";
import { assetRefs, assetsOf } from "../src/assets.ts";
import type { Scene } from "../src/types.ts";

const scene = (overrides: Record<string, unknown>) =>
  ({
    schemaVersion: "0.1",
    id: "s",
    title: "S",
    layout: "text-media",
    blocks: [{ id: "h", type: "text", role: "heading", text: "Hello" }],
    ...overrides,
  }) as Scene;

describe("assetRefs", () => {
  it("names every asset a scene uses and where it uses it", () => {
    const found = assetRefs(
      scene({
        blocks: [
          { id: "h", type: "text", role: "heading", text: "Hello" },
          { id: "pic", type: "image", asset: "assets/a.svg", alt: "A" },
          { id: "movie", type: "clip", source: "assets/m.mp4", poster: "assets/m.png", alt: "M" },
          { id: "bare", type: "clip", source: "assets/n.mp4", alt: "N" },
        ],
        sources: [
          { id: "csv", title: "Data", asset: "assets/d.csv" },
          { id: "web", title: "Web", url: "https://example.com" },
        ],
      }),
    );
    expect(found).toEqual([
      { path: "/blocks/1/asset", asset: "assets/a.svg" },
      { path: "/blocks/2/source", asset: "assets/m.mp4" },
      { path: "/blocks/2/poster", asset: "assets/m.png" },
      { path: "/blocks/3/source", asset: "assets/n.mp4" },
      { path: "/sources/0/asset", asset: "assets/d.csv" },
    ]);
  });

  it("finds nothing in a scene made of text", () => {
    expect(assetRefs(scene({}))).toEqual([]);
  });
});

describe("assetsOf", () => {
  it("lists each file once, in path order", () => {
    const found = assetsOf(
      scene({
        blocks: [
          { id: "one", type: "image", asset: "assets/z.svg", alt: "Z" },
          { id: "two", type: "image", asset: "assets/a.svg", alt: "A" },
          { id: "three", type: "image", asset: "assets/z.svg", alt: "Z again" },
        ],
        sources: [{ id: "csv", title: "Data", asset: "assets/a.svg" }],
      }),
    );
    expect(found).toEqual(["assets/a.svg", "assets/z.svg"]);
  });

  it("is empty for a scene with no assets", () => {
    expect(assetsOf(scene({}))).toEqual([]);
  });
});
