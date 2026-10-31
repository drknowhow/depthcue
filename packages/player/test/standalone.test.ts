// @vitest-environment happy-dom
import { EXPORT_FORMAT } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSource } from "./helpers.ts";

let host: HTMLElement;

beforeEach(() => {
  location.hash = "";
  document.body.replaceChildren();
  host = document.createElement("div");
  host.id = "depthcue";
  document.body.append(host);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  delete (window as { depthcue?: unknown }).depthcue;
  document.title = "";
});

/** Puts the data script the exporter writes into the page, then runs the entry the way a script tag does. */
async function load(text: string | null) {
  if (text !== null) {
    const data = document.createElement("script");
    data.type = "application/json";
    data.id = "depthcue-data";
    data.textContent = text;
    document.body.append(data);
  }
  vi.resetModules();
  await import("../src/standalone.ts");
}

const exported = (overrides: Record<string, unknown> = {}) => {
  const { deck, scenes } = demoSource();
  return JSON.stringify({ format: EXPORT_FORMAT, deck, scenes, files: {}, ...overrides });
};

describe("an exported page", () => {
  it("shows the deck from the data in the page and names the document after it", async () => {
    await load(exported());
    expect(document.title).toBe("Why channel B now leads");
    expect(host.textContent).toContain("Channel B now leads demand");
    expect(host.classList.contains("dc-failed")).toBe(false);
  });

  it("makes no request for the deck", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await load(exported());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves assets beside the page", async () => {
    await load(exported());
    location.hash = "#/method";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("./assets/method.svg");
  });

  it("gives tools the player to drive", async () => {
    await load(exported());
    expect(typeof (window as { depthcue?: { settled?: unknown } }).depthcue?.settled).toBe("function");
  });

  it("says so, and shows nothing else, when the page has no data", async () => {
    await load(null);
    expect(host.textContent).toBe("The deck could not be shown: The page has no deck data.");
    expect(host.classList.contains("dc-failed")).toBe(true);
  });

  it("says so when the data is not JSON", async () => {
    await load("{not json");
    expect(host.textContent).toMatch(/^The deck could not be shown: /);
    expect(host.classList.contains("dc-failed")).toBe(true);
  });

  it("refuses data in a format it does not know", async () => {
    await load(exported({ format: "depthcue-export/2" }));
    expect(host.textContent).toBe(
      "The deck could not be shown: The deck data is not in a format this page understands.",
    );
  });

  it("refuses data without a deck", async () => {
    await load(JSON.stringify({ format: EXPORT_FORMAT, scenes: [] }));
    expect(host.classList.contains("dc-failed")).toBe(true);
    expect(host.textContent).toBe(
      "The deck could not be shown: The deck data is not in a format this page understands.",
    );
  });

  it("refuses data whose scenes are not a list", async () => {
    await load(JSON.stringify({ format: EXPORT_FORMAT, deck: demoSource().deck, scenes: "no" }));
    expect(host.classList.contains("dc-failed")).toBe(true);
  });

  it("gives a clip its chips from the cue map in the data, with no request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    // Blocks hydrate when they are seen, and there is no layout here to see them in.
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private callback: (seen: Array<{ isIntersecting: boolean }>) => void) {}
        observe() {
          this.callback([{ isIntersecting: true }]);
        }
        disconnect() {}
      },
    );
    const { deck, scenes } = demoSource();
    const clip = {
      schemaVersion: "0.1",
      id: "clip-scene",
      title: "A clip",
      layout: "text-media",
      blocks: [
        { id: "clip-heading", type: "text", role: "heading", text: "In motion" },
        { id: "intro-clip", type: "clip", source: "assets/intro.mp4", alt: "The opening" },
      ],
    };
    const cues = {
      format: "depthcue-cues/1",
      source: "assets/intro.mp4",
      duration: 4.2,
      width: 960,
      height: 540,
      fps: 30,
      cues: [
        { id: "dot", type: "circle", in: 0, out: 1.1 },
        { id: "title", type: "text", in: 1, out: 4.2 },
      ],
    };
    location.hash = "#/clip-scene";
    await load(
      exported({
        deck: { ...deck, scenes: [...deck.scenes, "clip-scene"] },
        scenes: [...scenes, clip],
        files: { "assets/intro.cues.json": cues },
      }),
    );
    await (window as unknown as { depthcue: { settled(): Promise<void> } }).depthcue.settled();
    const chips = [...host.querySelectorAll<HTMLElement>("[data-cue]")].map((chip) => chip.dataset.cue);
    expect(chips).toEqual(["dot", "title"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing on a page with no element to mount in", async () => {
    host.remove();
    await expect(load(exported())).resolves.toBeUndefined();
    expect(document.title).toBe("");
  });
});
