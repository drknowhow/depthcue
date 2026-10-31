// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chartManifest } from "../src/modules/chart-manifest.ts";
import type { ModuleEntry, ModuleInstance } from "../src/modules.ts";
import { mountPlayer, type Player } from "../src/player.ts";
import { demoSource } from "./helpers.ts";

let host: HTMLElement;
let player: Player | undefined;
const watchers: Array<{ node: Element; fire: () => void; live: boolean }> = [];

class Watcher {
  private entry: { node: Element; fire: () => void; live: boolean } | undefined;
  constructor(private callback: (seen: Array<{ isIntersecting: boolean }>) => void) {}
  observe(node: Element) {
    this.entry = { node, fire: () => this.callback([{ isIntersecting: true }]), live: true };
    watchers.push(this.entry);
  }
  disconnect() {
    if (this.entry) this.entry.live = false;
  }
}

const seeAll = () => {
  for (const watcher of watchers.filter((entry) => entry.live)) watcher.fire();
};
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  history.replaceState(null, "", "/");
  watchers.length = 0;
  vi.stubGlobal("IntersectionObserver", Watcher);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  player?.destroy();
  player = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function registry(instance: ModuleInstance = {}) {
  const hydrate = vi.fn(() => instance);
  const entry: ModuleEntry = { manifest: chartManifest, load: async () => ({ hydrate }) };
  return { hydrate, entry };
}

const mount = (modules: ModuleEntry[] | undefined, deckModules?: Record<string, string>) => {
  const source = demoSource();
  if (deckModules) source.deck = { ...source.deck, modules: deckModules };
  player = mountPlayer(host, source, { reducedMotion: true, ...(modules ? { modules } : {}) });
  return player;
};

const states = () => player?.moduleStates() ?? {};

describe("a player with modules", () => {
  it("leaves every block static when no modules are given", async () => {
    mount(undefined);
    player?.go({ scene: 1, step: 2 });
    await flush();
    expect(host.querySelector("[data-module]")).toBeNull();
    expect(states()).toEqual({});
  });

  it("starts nothing on a scene with no matching block", async () => {
    const { hydrate, entry } = registry();
    mount([entry]);
    seeAll();
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("hydrates the chart on the scene that has one, once it is in view", async () => {
    const { hydrate, entry } = registry();
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    expect(states()).toEqual({ "chart-demand": "pending" });
    expect(hydrate).not.toHaveBeenCalled();
    seeAll();
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(states()).toEqual({ "chart-demand": "hydrated" });
    expect(host.querySelector<HTMLElement>("[data-id='chart-demand']")?.dataset.moduleState).toBe("hydrated");
  });

  it("disposes the module when the scene changes, and starts a fresh one when it comes back", async () => {
    const dispose = vi.fn();
    const { hydrate, entry } = registry({ dispose });
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    player?.go({ scene: 2, step: 0 });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(states()).toEqual({});
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("keeps the module while only the step changes", async () => {
    const dispose = vi.fn();
    const { hydrate, entry } = registry({ dispose });
    mount([entry]);
    player?.go({ scene: 1, step: 0 });
    seeAll();
    await flush();
    player?.next();
    player?.next();
    expect(dispose).not.toHaveBeenCalled();
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("does not hydrate in the reading view, and disposes when entering it", async () => {
    const dispose = vi.fn();
    const { hydrate, entry } = registry({ dispose });
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    player?.setMode("read");
    expect(dispose).toHaveBeenCalledTimes(1);
    seeAll();
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-module]")).toBeNull();
    player?.setMode("present");
    expect(states()).toEqual({ "chart-demand": "pending" });
  });

  it("starts over on a live reload, because the blocks were drawn again", async () => {
    const dispose = vi.fn();
    const { hydrate, entry } = registry({ dispose });
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    player?.update(demoSource());
    expect(dispose).toHaveBeenCalledTimes(1);
    seeAll();
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("disposes when the player is destroyed", async () => {
    const dispose = vi.fn();
    const { entry } = registry({ dispose });
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    player?.destroy();
    player = undefined;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("respects the deck: off and an unmet version leave the chart static", async () => {
    const { hydrate, entry } = registry();
    const off = mount([entry], { chart: "off" });
    off.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    expect(off.moduleStates()).toEqual({ "chart-demand": "off" });
    off.destroy();
    host.replaceChildren();
    const unmet = mount([entry], { chart: "9" });
    unmet.go({ scene: 1, step: 2 });
    expect(unmet.moduleStates()).toEqual({ "chart-demand": "incompatible" });
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("reports each module's life through onModule", async () => {
    const events: string[] = [];
    const { entry } = registry();
    player = mountPlayer(host, demoSource(), {
      reducedMotion: true,
      modules: [entry],
      onModule: (event) => events.push(`${event.type}:${event.block}`),
    });
    player.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    expect(events).toEqual(["pending:chart-demand", "hydrated:chart-demand"]);
  });

  it("runs a command on a block's module, and says when it cannot", async () => {
    const highlight = vi.fn();
    const { entry } = registry({ commands: { highlight } });
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    expect(player?.invoke("chart-demand", "highlight", { row: 0 })).toBe(false);
    seeAll();
    await flush();
    expect(player?.invoke("chart-demand", "highlight", { row: 0 })).toBe(true);
    expect(highlight).toHaveBeenCalledWith({ row: 0 });
    expect(player?.invoke("chart-demand", "nothing")).toBe(false);
  });

  it("announces what a module says in the live region", async () => {
    const entry: ModuleEntry = {
      manifest: chartManifest,
      load: async () => ({
        hydrate: ({ announce }) => {
          announce("Chart ready.");
          return undefined;
        },
      }),
    };
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await flush();
    expect(host.querySelector("[aria-live='polite'][aria-atomic='true']")?.textContent).toBe("Chart ready.");
  });

  it("settles once the modules in view are done", async () => {
    const { entry } = registry();
    mount([entry]);
    player?.go({ scene: 1, step: 2 });
    seeAll();
    await player?.settled();
    expect(states()).toEqual({ "chart-demand": "hydrated" });
  });
});
