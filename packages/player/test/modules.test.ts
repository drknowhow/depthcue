// @vitest-environment happy-dom
import type { Deck, Scene } from "@depthcue/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  createModuleHost,
  type HydrateContext,
  type ModuleCode,
  type ModuleEntry,
  type ModuleEvent,
  type ModuleHost,
  type ModuleInstance,
  type ModuleManifest,
  SETTLE_LIMIT_MS,
  satisfies,
  settingFor,
} from "../src/modules.ts";
import { renderScene } from "../src/scene.ts";
import { demoSource, sceneWith } from "./helpers.ts";

const manifest = (over: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id: "chart",
  title: "Charts",
  fallback: "a plain chart",
  version: "1.2",
  blocks: ["bar-chart"],
  activation: "visible",
  budgetBytes: 1000,
  export: "static",
  commands: {},
  ...over,
});

describe("satisfies", () => {
  it("needs the same major version", () => {
    expect(satisfies("1.2", "1")).toBe(true);
    expect(satisfies("2.0", "1")).toBe(false);
    expect(satisfies("1.9", "2")).toBe(false);
  });

  it("treats a minor as a floor", () => {
    expect(satisfies("1.2", "1.2")).toBe(true);
    expect(satisfies("1.5", "1.2")).toBe(true);
    expect(satisfies("1.1", "1.2")).toBe(false);
  });

  it("ignores a patch, and reads a bare major as 1.0", () => {
    expect(satisfies("1.2", "1.2.9")).toBe(true);
    expect(satisfies("1", "1.0")).toBe(true);
    expect(satisfies("1", "1.1")).toBe(false);
  });

  it("gives version 0 no special treatment", () => {
    expect(satisfies("0.2", "0.1")).toBe(true);
    expect(satisfies("0.1", "0.2")).toBe(false);
  });
});

describe("settingFor", () => {
  const deck = (modules?: Record<string, string>) => ({ ...demoSource().deck, modules }) as Deck;

  it("is on when the deck says nothing, and off when it says off", () => {
    expect(settingFor(deck(), manifest())).toBe("on");
    expect(settingFor(deck({ other: "off" }), manifest())).toBe("on");
    expect(settingFor(deck({ chart: "off" }), manifest())).toBe("off");
  });

  it("is incompatible when the deck needs a version the module does not have", () => {
    expect(settingFor(deck({ chart: "1.2" }), manifest())).toBe("on");
    expect(settingFor(deck({ chart: "2" }), manifest())).toBe("incompatible");
    expect(settingFor(deck({ chart: "1.3" }), manifest())).toBe("incompatible");
  });
});

/** Stands in for IntersectionObserver so a test decides when a block comes into view. */
class FakeObserver {
  static all: FakeObserver[] = [];
  disconnected = false;
  nodes: Element[] = [];
  constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    FakeObserver.all.push(this);
  }
  observe(node: Element) {
    this.nodes.push(node);
  }
  disconnect() {
    this.disconnected = true;
  }
  fire(isIntersecting = true) {
    this.callback([{ isIntersecting }]);
  }
  static see(node: Element, isIntersecting = true) {
    for (const observer of FakeObserver.all) {
      if (!observer.disconnected && observer.nodes.includes(node)) observer.fire(isIntersecting);
    }
  }
}

const twoCharts = (): Scene =>
  sceneWith({
    id: "pair",
    layout: "text-media",
    blocks: [
      { id: "heading-one", type: "text", role: "heading", text: "Two charts" },
      { id: "chart-one", type: "bar-chart", data: [{ label: "A", value: 1 }] },
      { id: "chart-two", type: "bar-chart", data: [{ label: "B", value: 2 }] },
    ],
  });

type Hydrate = (context: HydrateContext) => ModuleInstance | undefined | Promise<ModuleInstance | undefined>;

interface Setup {
  host: ModuleHost;
  root: HTMLElement;
  scene: Scene;
  events: ModuleEvent[];
  hydrate: Mock<Hydrate>;
  load: Mock<() => Promise<ModuleCode>>;
  announced: string[];
}

function setup(
  options: {
    scene?: Scene;
    manifest?: Partial<ModuleManifest>;
    deck?: Partial<Deck> & { modules?: Record<string, string> };
    hydrate?: Hydrate;
    load?: () => Promise<ModuleCode>;
  } = {},
): Setup {
  const events: ModuleEvent[] = [];
  const announced: string[] = [];
  const hydrate = vi.fn<Hydrate>(options.hydrate ?? (() => ({})));
  const load = vi.fn<() => Promise<ModuleCode>>(options.load ?? (async () => ({ hydrate })));
  const entry: ModuleEntry = { manifest: manifest(options.manifest), load };
  const deck = { ...demoSource().deck, ...options.deck } as Deck;
  const host = createModuleHost({
    registry: [entry],
    deck: () => deck,
    assetBase: () => "/deck",
    reducedMotion: () => true,
    announce: (message) => announced.push(message),
    onEvent: (event) => events.push(event),
  });
  const scene = options.scene ?? twoCharts();
  const root = document.createElement("div");
  root.append(renderScene(scene, { assetBase: "/deck" }));
  document.body.append(root);
  return { host, root, scene, events, hydrate, load, announced };
}

const block = (root: HTMLElement, id: string) => root.querySelector(`[data-id="${id}"]`) as HTMLElement;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  await tick();
  await tick();
};

beforeEach(() => {
  FakeObserver.all = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("attaching modules to a scene", () => {
  it("marks the blocks a module handles as pending and leaves the others alone", () => {
    const { host, root, scene } = setup();
    host.attach(root, scene);
    expect(block(root, "chart-one").dataset).toMatchObject({ module: "chart", moduleState: "pending" });
    expect(block(root, "chart-two").dataset.moduleState).toBe("pending");
    expect(block(root, "heading-one").dataset.module).toBeUndefined();
    expect(host.states()).toEqual({ "chart-one": "pending", "chart-two": "pending" });
  });

  it("does not load the module's code until a block is in view", async () => {
    const { host, root, scene, load } = setup();
    host.attach(root, scene);
    await flush();
    expect(load).not.toHaveBeenCalled();
    FakeObserver.see(block(root, "chart-one"), false);
    await flush();
    expect(load).not.toHaveBeenCalled();
  });

  it("hydrates a block when it scrolls into view, handing over what the module needs", async () => {
    const { host, root, scene, hydrate, events, load } = setup();
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);
    const context = hydrate.mock.calls[0]?.[0] as HydrateContext;
    expect(context.block.id).toBe("chart-one");
    expect(context.node).toBe(block(root, "chart-one"));
    expect(context.scene).toBe(scene);
    expect(context.assetBase).toBe("/deck");
    expect(context.reducedMotion).toBe(true);
    expect(block(root, "chart-one").dataset.moduleState).toBe("hydrated");
    expect(block(root, "chart-two").dataset.moduleState).toBe("pending");
    expect(events).toContainEqual({ type: "hydrated", module: "chart", block: "chart-one" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads the code once however many blocks use it, and across scenes", async () => {
    const { host, root, scene, load } = setup();
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    FakeObserver.see(block(root, "chart-two"));
    await flush();
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("lets the module announce to screen readers", async () => {
    const { host, root, scene, announced } = setup({
      hydrate: ({ announce }) => {
        announce("Chart ready.");
        return undefined;
      },
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(announced).toEqual(["Chart ready."]);
  });

  it("hydrates anyway when the browser has no IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { host, root, scene, hydrate } = setup();
    host.attach(root, scene);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("stops watching a block as soon as it has been seen", () => {
    const { host, root, scene } = setup();
    host.attach(root, scene);
    const [first, second] = FakeObserver.all;
    first?.fire();
    expect(first?.disconnected).toBe(true);
    expect(second?.disconnected).toBe(false);
  });

  it("stops watching every block that was never seen when the scene goes away", () => {
    const { host, root, scene } = setup();
    host.attach(root, scene);
    expect(FakeObserver.all).toHaveLength(2);
    host.detach();
    expect(FakeObserver.all.map((observer) => observer.disconnected)).toEqual([true, true]);
  });

  it("cancels the timer, and loads nothing, when the scene goes away before it runs", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { host, root, scene, load } = setup();
    host.attach(root, scene);
    host.detach();
    await flush();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("idle activation", () => {
  it("waits for spare time, and does not need the block to be in view", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const { host, root, scene, hydrate } = setup({ manifest: { activation: "idle" } });
    host.attach(root, scene);
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
    expect(FakeObserver.all).toHaveLength(0);
    for (const run of idle) run();
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("falls back to a timer when there is no requestIdleCallback", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const { host, root, scene, hydrate } = setup({ manifest: { activation: "idle" } });
    host.attach(root, scene);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("cancels the wait when the scene goes away", async () => {
    const cancelled: number[] = [];
    vi.stubGlobal("requestIdleCallback", () => 7);
    vi.stubGlobal("cancelIdleCallback", (handle: number) => cancelled.push(handle));
    const { host, root, scene } = setup({ manifest: { activation: "idle" } });
    host.attach(root, scene);
    host.detach();
    expect(cancelled).toEqual([7, 7]);
  });
});

describe("a module that fails", () => {
  const snapshotOf = (root: HTMLElement, id: string) => block(root, id).outerHTML;

  it("puts the static block back when hydrating throws, and says so", async () => {
    const { host, root, scene, events } = setup({
      hydrate: ({ node }) => {
        node.append("added by the module");
        node.dataset.enhanced = "yes";
        throw new Error("boom");
      },
    });
    host.attach(root, scene);
    const before = snapshotOf(root, "chart-one");
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    const after = block(root, "chart-one");
    expect(after.textContent).not.toContain("added by the module");
    expect(after.dataset.enhanced).toBeUndefined();
    expect(after.dataset.moduleState).toBe("failed");
    expect(after.outerHTML.replace(' data-module-state="failed"', ' data-module-state="pending"')).toBe(
      before,
    );
    expect(after.isConnected).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "failed", module: "chart", block: "chart-one" });
    expect(String(events.at(-1)?.error)).toBe("Error: boom");
    expect(console.warn).toHaveBeenCalled();
    expect(host.states()["chart-one"]).toBe("failed");
  });

  it("does the same when hydrating rejects later", async () => {
    const { host, root, scene } = setup({ hydrate: async () => Promise.reject(new Error("late")) });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(block(root, "chart-one").dataset.moduleState).toBe("failed");
  });

  it("does the same when the code does not load, and tries again on the next scene", async () => {
    const { host, root, scene, load, hydrate } = setup({
      load: vi
        .fn<() => Promise<ModuleCode>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ hydrate: () => ({}) }),
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(block(root, "chart-one").dataset.moduleState).toBe("failed");
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(block(root, "chart-one").dataset.moduleState).toBe("hydrated");
    expect(hydrate).not.toHaveBeenCalled();
  });

  it("leaves the other blocks of the scene running", async () => {
    const { host, root, scene } = setup({
      hydrate: ({ block: target }) => {
        if (target.id === "chart-one") throw new Error("only this one");
        return {};
      },
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    FakeObserver.see(block(root, "chart-two"));
    await flush();
    expect(host.states()).toEqual({ "chart-one": "failed", "chart-two": "hydrated" });
    expect(block(root, "heading-one").textContent).toBe("Two charts");
  });

  it("does not touch the page if it fails after the scene has changed", async () => {
    let fail: (error: Error) => void = () => {};
    const { host, root, scene, events } = setup({
      hydrate: () =>
        new Promise<undefined>((_, reject) => {
          fail = reject;
        }),
    });
    host.attach(root, scene);
    const node = block(root, "chart-one");
    FakeObserver.see(node);
    await flush();
    host.detach();
    fail(new Error("too late"));
    await flush();
    expect(node.isConnected).toBe(true);
    expect(events.filter((event) => event.type === "failed")).toEqual([]);
  });
});

describe("modules a deck turns off", () => {
  it("leaves a block static when the deck says off, and never loads the code", async () => {
    const { host, root, scene, load } = setup({ deck: { modules: { chart: "off" } } });
    host.attach(root, scene);
    expect(block(root, "chart-one").dataset).toMatchObject({ module: "chart", moduleState: "off" });
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(host.states()).toEqual({ "chart-one": "off", "chart-two": "off" });
  });

  it("leaves a block static when the deck needs another version, and says which state it is in", () => {
    const { host, root, scene, events } = setup({ deck: { modules: { chart: "2" } } });
    host.attach(root, scene);
    expect(block(root, "chart-one").dataset.moduleState).toBe("incompatible");
    expect(events.map((event) => event.type)).toEqual(["incompatible", "incompatible"]);
  });
});

describe("leaving a scene", () => {
  it("disposes every hydrated module once, and forgets them", async () => {
    const dispose = vi.fn();
    const { host, root, scene } = setup({ hydrate: () => ({ dispose }) });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    FakeObserver.see(block(root, "chart-two"));
    await flush();
    host.detach();
    expect(dispose).toHaveBeenCalledTimes(2);
    host.detach();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(host.states()).toEqual({});
  });

  it("disposes the earlier scene's modules when another scene is attached", async () => {
    const dispose = vi.fn();
    const { host, root, scene } = setup({ hydrate: () => ({ dispose }) });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    host.attach(root, scene);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps closing the rest when one dispose throws, and warns", async () => {
    let calls = 0;
    const second = vi.fn();
    const { host, root, scene } = setup({
      hydrate: () => {
        calls += 1;
        return calls === 1
          ? {
              dispose: () => {
                throw new Error("stuck");
              },
            }
          : { dispose: second };
      },
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    FakeObserver.see(block(root, "chart-two"));
    await flush();
    host.detach();
    expect(second).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it("disposes at once a module that finishes hydrating after the scene has changed", async () => {
    const dispose = vi.fn();
    let finish: (instance: ModuleInstance) => void = () => {};
    const { host, root, scene, events } = setup({
      hydrate: () =>
        new Promise<ModuleInstance>((resolve) => {
          finish = resolve;
        }),
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    host.detach();
    finish({ dispose, commands: { ping: () => {} } });
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(host.invoke("chart-one", "ping")).toBe(false);
    expect(events.filter((event) => event.type === "hydrated")).toEqual([]);
  });

  it("never calls hydrate for code that loaded after the scene changed", async () => {
    let arrive: (code: ModuleCode) => void = () => {};
    const { host, root, scene, hydrate } = setup({
      load: () =>
        new Promise<ModuleCode>((resolve) => {
          arrive = resolve;
        }),
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    host.detach();
    arrive({ hydrate });
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
  });
});

describe("commands", () => {
  it("runs a command on a hydrated block's module with its arguments", async () => {
    const run = vi.fn();
    const { host, root, scene } = setup({ hydrate: () => ({ commands: { highlight: run } }) });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(host.invoke("chart-one", "highlight", { row: 1 })).toBe(true);
    expect(run).toHaveBeenCalledWith({ row: 1 });
  });

  it("says no for a block with no module, a command it lacks, or a module not yet hydrated", async () => {
    const { host, root, scene } = setup({ hydrate: () => ({ commands: { highlight: () => {} } }) });
    host.attach(root, scene);
    expect(host.invoke("chart-one", "highlight")).toBe(false);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(host.invoke("chart-one", "dance")).toBe(false);
    expect(host.invoke("heading-one", "highlight")).toBe(false);
    expect(host.invoke("nothing-here", "highlight")).toBe(false);
  });

  it("says no and warns when the command throws", async () => {
    const { host, root, scene } = setup({
      hydrate: () => ({
        commands: {
          bad: () => {
            throw new Error("bad args");
          },
        },
      }),
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(host.invoke("chart-one", "bad")).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it("treats a command name from an agent as data, never as a property lookup", async () => {
    const { host, root, scene } = setup({ hydrate: () => ({ commands: { highlight: () => {} } }) });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    await flush();
    expect(host.invoke("chart-one", "constructor")).toBe(false);
    expect(host.invoke("chart-one", "__proto__")).toBe(false);
  });
});

describe("settled", () => {
  it("resolves once the blocks in view have hydrated", async () => {
    let release: () => void = () => {};
    const { host, root, scene } = setup({
      hydrate: () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    FakeObserver.see(block(root, "chart-two"), false);
    let done = false;
    void host.settled().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).toBe(true);
  });

  it("does not wait for a block that is out of view, once the observer has said so", async () => {
    const { host, root, scene } = setup();
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"), false);
    FakeObserver.see(block(root, "chart-two"), false);
    await host.settled();
    expect(host.states()["chart-one"]).toBe("pending");
  });

  it("waits for each block's first report, in view or not, however long that takes", async () => {
    const { host, root, scene } = setup();
    host.attach(root, scene);
    let done = false;
    void host.settled().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done).toBe(false);
    FakeObserver.see(block(root, "chart-one"), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    FakeObserver.see(block(root, "chart-two"), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(true);
  });

  it("still waits for the hydration a report started", async () => {
    let release: () => void = () => {};
    const { host, root, scene } = setup({
      hydrate: () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    });
    host.attach(root, scene);
    FakeObserver.see(block(root, "chart-one"));
    FakeObserver.see(block(root, "chart-two"), false);
    let done = false;
    void host.settled().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(done).toBe(false);
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(true);
  });

  it("waits for the idle callback to run", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => {});
    const { host, root, scene, hydrate } = setup({ manifest: { activation: "idle" } });
    host.attach(root, scene);
    let done = false;
    void host.settled().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(done).toBe(false);
    for (const run of idle) run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(true);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it("waits for the timer when there is no observer to ask", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { host, root, scene, hydrate } = setup();
    host.attach(root, scene);
    await host.settled();
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  /** Starts waiting, then lets the scene go: the wait must not be left holding on for it. */
  const resolvesWhenSceneLeaves = async (options: Parameters<typeof setup>[0] = {}) => {
    const { host, root, scene } = setup(options);
    host.attach(root, scene);
    let done = false;
    void host.settled().then(() => {
      done = true;
    });
    host.detach();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return done;
  };

  it("stops waiting when the scene goes away, whether it was waiting on an observer", async () => {
    expect(await resolvesWhenSceneLeaves()).toBe(true);
  });

  it("stops waiting when the scene goes away, whether it was waiting on idle time", async () => {
    vi.stubGlobal("requestIdleCallback", () => 7);
    vi.stubGlobal("cancelIdleCallback", () => {});
    expect(await resolvesWhenSceneLeaves({ manifest: { activation: "idle" } })).toBe(true);
  });

  it("stops waiting when the scene goes away, whether it was waiting on a timer", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    expect(await resolvesWhenSceneLeaves()).toBe(true);
  });

  describe("when nothing ever reports", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it(`gives up after ${SETTLE_LIMIT_MS} ms, so a page nobody is looking at does not hang a render`, async () => {
      const { host, root, scene } = setup();
      host.attach(root, scene);
      let done = false;
      void host.settled().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(SETTLE_LIMIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    });

    it("does not leave its timer running once the blocks have reported", async () => {
      const { host, root, scene } = setup();
      host.attach(root, scene);
      FakeObserver.see(block(root, "chart-one"), false);
      FakeObserver.see(block(root, "chart-two"), false);
      await host.settled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
