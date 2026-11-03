// @vitest-environment happy-dom
import type { Scene } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { followLink, linkElement } from "../src/links.ts";
import { renderScene } from "../src/scene.ts";
import { demoSource } from "./helpers.ts";

const { scenes } = demoSource();
const links = [
  { id: "site", title: "The site", target: "https://example.com/a" },
  { id: "plain", title: "Plain http", target: "http://example.com" },
  { id: "mail", title: "Write us", target: "mailto:a@example.com" },
  { id: "report", title: "The report", target: "assets/report.csv" },
  { id: "jump", title: "Back to start", target: `scene:${scenes[0]?.id}` },
  { id: "folder", title: "Project folder", target: "path:Y:\\Projects\\Depthcue" },
  { id: "bad", title: "Bad", target: "javascript:alert(1)" },
  { id: "ghost", title: "Gone", target: "scene:nowhere" },
];
const ctx = { assetBase: "/decks/q3", links, scenes };

describe("followLink", () => {
  it("opens an address in a new tab and keeps a mail link in the page", () => {
    expect(followLink(ctx, "site")).toMatchObject({ href: "https://example.com/a", outside: true });
    expect(followLink(ctx, "mail")).toMatchObject({ href: "mailto:a@example.com", outside: false });
  });

  it("reads a deck file from the asset base", () => {
    expect(followLink(ctx, "report")?.href).toBe("/decks/q3/assets/report.csv");
  });

  it("jumps to a scene by the hash the player reads", () => {
    expect(followLink(ctx, "jump")?.href).toBe(`#/${scenes[0]?.id}`);
  });

  it("gives a path no address", () => {
    const followed = followLink(ctx, "folder");
    expect(followed?.href).toBeUndefined();
    expect(followed?.path).toBe("Y:\\Projects\\Depthcue");
  });

  it("follows nothing it does not know, or that is unsafe", () => {
    expect(followLink(ctx, "bad")).toBeUndefined();
    expect(followLink(ctx, "absent")).toBeUndefined();
    expect(followLink({ assetBase: "." }, "site")).toBeUndefined();
    expect(followLink(ctx, "ghost")?.href).toBeUndefined();
  });
});

describe("linkElement", () => {
  it("makes an outside anchor safe to follow", () => {
    const node = linkElement(followLink(ctx, "site") as NonNullable<ReturnType<typeof followLink>>);
    expect(node.tagName).toBe("A");
    expect(node.getAttribute("target")).toBe("_blank");
    expect(node.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("makes a path a button, not an anchor", () => {
    const node = linkElement(followLink(ctx, "folder") as NonNullable<ReturnType<typeof followLink>>);
    expect(node.tagName).toBe("BUTTON");
    expect(node.getAttribute("href")).toBeNull();
  });
});

describe("a scene with library links", () => {
  const scene: Scene = {
    ...(scenes[0] as Scene),
    schemaVersion: "0.5",
    blocks: (scenes[0] as Scene).blocks.map((block, i) => (i === 0 ? { ...block, link: "site" } : block)),
    sources: [
      { id: "src-one", title: "Our report", link: "report" },
      { id: "src-two", title: "Where it lives", link: "folder" },
    ],
  };

  it("draws a block's link under it", () => {
    const section = renderScene(scene, ctx);
    const row = section.querySelector(".dc-block .dc-link-row a");
    expect(row?.getAttribute("href")).toBe("https://example.com/a");
    expect(row?.textContent).toBe("The site");
  });

  it("writes a source's own title over its link", () => {
    const section = renderScene(scene, ctx);
    const items = [...section.querySelectorAll(".dc-sources li")];
    expect(items[0]?.querySelector("a")?.getAttribute("href")).toBe("/decks/q3/assets/report.csv");
    expect(items[0]?.textContent).toBe("Our report");
    expect(items[1]?.querySelector("button")?.textContent).toBe("Where it lives");
  });

  it("draws no link for a block whose link the deck lacks", () => {
    const section = renderScene(scene, { assetBase: "." });
    expect(section.querySelector(".dc-link-row")).toBeNull();
  });
});
