import type { Diagnostic } from "@depthcue/core";
import { afterEach, describe, expect, it } from "vitest";
import { createLayoutChecker, type LayoutChecker } from "../src/edit-layout.ts";
import type { Renderer, RenderOptions, SceneRender } from "../src/render.ts";

const overflow: Diagnostic = {
  severity: "error",
  code: "overflow",
  file: "scenes/method.json",
  path: "/blocks/1",
  message: "The scene is 40px taller than the 1280x720 stage.",
};

/** A browser that is not one: it counts how it was used, and can be told to fail. */
function fakeBrowser(log: string[], render?: (scene: string) => Promise<Diagnostic[]>) {
  const state = { opened: 0, closed: 0, running: 0, mostRunning: 0, finished: 0 };
  const open = async (): Promise<Renderer> => {
    state.opened += 1;
    log.push("open");
    return {
      async render(scene: string, options?: RenderOptions) {
        state.running += 1;
        state.mostRunning = Math.max(state.mostRunning, state.running);
        log.push(`render ${scene} screenshot=${String(options?.screenshot)}`);
        try {
          const diagnostics = render ? await render(scene) : [overflow];
          return { scene, diagnostics } as unknown as SceneRender;
        } finally {
          state.running -= 1;
          state.finished += 1;
        }
      },
      async close() {
        state.closed += 1;
        log.push("close");
      },
    };
  };
  return { state, open };
}

let checker: LayoutChecker | undefined;
afterEach(async () => {
  await checker?.close();
  checker = undefined;
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("the layout checker of the editor", () => {
  it("starts no browser until it is asked, then renders the scene without a screenshot and gives the diagnostics", async () => {
    const log: string[] = [];
    const browser = fakeBrowser(log);
    checker = createLayoutChecker("deck", { open: browser.open });
    await wait(10);
    expect(log).toEqual([]);
    expect(await checker.check("method")).toEqual({ available: true, diagnostics: [overflow] });
    expect(log).toEqual(["open", "render method screenshot=false"]);
  });

  it("keeps one browser for the questions that follow, and answers them one at a time", async () => {
    const log: string[] = [];
    const browser = fakeBrowser(log, async () => {
      await wait(15);
      return [];
    });
    checker = createLayoutChecker("deck", { open: browser.open });
    await Promise.all([checker.check("a"), checker.check("b"), checker.check("c")]);
    expect(browser.state.opened).toBe(1);
    expect(browser.state.mostRunning).toBe(1);
    expect(log.filter((line) => line.startsWith("render"))).toHaveLength(3);
  });

  it("closes the browser after a quiet spell, and starts another for the next question", async () => {
    const log: string[] = [];
    const browser = fakeBrowser(log);
    checker = createLayoutChecker("deck", { open: browser.open, idleMs: 20 });
    await checker.check("a");
    expect(browser.state.closed).toBe(0);
    await wait(80);
    expect(browser.state.closed).toBe(1);
    await checker.check("a");
    expect(browser.state.opened).toBe(2);
  });

  it("does not close the browser between questions that come closer together than the quiet spell", async () => {
    const browser = fakeBrowser([]);
    checker = createLayoutChecker("deck", { open: browser.open, idleMs: 60 });
    for (let i = 0; i < 4; i += 1) {
      await checker.check("a");
      await wait(25);
    }
    expect(browser.state.opened).toBe(1);
    expect(browser.state.closed).toBe(0);
  });

  it("does not close the browser while a render is under way, however short the quiet spell", async () => {
    const browser = fakeBrowser([], async () => {
      await wait(60);
      return [];
    });
    checker = createLayoutChecker("deck", { open: browser.open, idleMs: 20 });
    await checker.check("a");
    // The quiet spell is running when the next question comes, and is over before its render is.
    await checker.check("b");
    expect(browser.state.closed).toBe(0);
    expect(browser.state.finished).toBe(2);
  });

  it("says no render can be made when there is no browser, and leaves the machine alone for a while", async () => {
    let tries = 0;
    checker = createLayoutChecker("deck", {
      retryMs: 40,
      open: async () => {
        tries += 1;
        throw new Error("No browser could be started. Install Chrome or Edge.");
      },
    });
    const first = await checker.check("a");
    expect(first).toEqual({
      available: false,
      message: "No browser could be started. Install Chrome or Edge.",
    });
    expect(await checker.check("b")).toEqual(first);
    expect(tries).toBe(1);
    await wait(60);
    await checker.check("a");
    expect(tries).toBe(2);
  });

  it("starts a fresh browser after a render fails, and tells the editor why that scene had none", async () => {
    const log: string[] = [];
    let fail = true;
    const browser = fakeBrowser(log, async () => {
      if (fail) throw new Error("The player did not show scene a.");
      return [];
    });
    checker = createLayoutChecker("deck", { open: browser.open });
    expect(await checker.check("a")).toEqual({
      available: false,
      message: "The player did not show scene a.",
    });
    expect(browser.state.closed).toBe(1);
    fail = false;
    expect(await checker.check("a")).toEqual({ available: true, diagnostics: [] });
    expect(browser.state.opened).toBe(2);
  });

  it("closes the browser when it is closed, waits for a render under way, and answers no more questions", async () => {
    const log: string[] = [];
    const browser = fakeBrowser(log, async () => {
      await wait(30);
      return [];
    });
    checker = createLayoutChecker("deck", { open: browser.open });
    const pending = checker.check("a");
    await wait(5);
    await checker.close();
    // The render was let finish before the browser went: closing the browser under it would fail it.
    expect(browser.state.finished).toBe(1);
    expect(await pending).toEqual({ available: true, diagnostics: [] });
    expect(log.at(-1)).toBe("close");
    const after = await checker.check("a");
    expect(after.available).toBe(false);
    expect(browser.state.opened).toBe(1);
  });
});
