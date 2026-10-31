// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPlayer, type Player, type PlayerState } from "../src/player.ts";
import { demoSource } from "./helpers.ts";

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
  vi.useRealTimers();
});

const mount = (options: Parameters<typeof mountPlayer>[2] = {}) => {
  player = mountPlayer(host, demoSource(), { reducedMotion: true, ...options });
  return player;
};

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

const count = () => host.querySelector(".dc-count")?.textContent;
const sceneId = () => host.querySelector<HTMLElement>(".dc-scene")?.dataset.scene;
const revealed = () =>
  [...host.querySelectorAll<HTMLElement>("[data-gated]")].map((node) => node.dataset.revealed);

describe("mounting", () => {
  it("shows the first scene with a scene counter and the lead", () => {
    mount();
    expect(sceneId()).toBe("opening");
    expect(count()).toBe("1 / 3");
    expect(host.querySelector(".dc-title")?.textContent).toBe("Why channel B now leads");
    expect(host.querySelector<HTMLElement>(".dc-lead")?.dataset.lead).toBe("human");
    expect(host.querySelector("h1")?.textContent).toBe("Why channel B now leads");
  });

  it("opens at the scene named in the hash", () => {
    history.replaceState(null, "", "#/demand/1");
    mount();
    expect(sceneId()).toBe("demand");
    expect(player?.state.position).toEqual({ scene: 1, step: 1 });
    expect(revealed()).toEqual(["true", "false"]);
  });

  it("opens in the reading view when the hash says so", () => {
    history.replaceState(null, "", "#/read");
    mount();
    expect(player?.state.mode).toBe("read");
    expect(host.querySelector(".dc-reading")).not.toBeNull();
  });
});

describe("keyboard", () => {
  it("steps through reveals, then scenes, then stops at the end", () => {
    const p = mount();
    press("ArrowRight");
    expect(sceneId()).toBe("demand");
    expect(revealed()).toEqual(["false", "false"]);
    press("ArrowRight");
    expect(revealed()).toEqual(["true", "false"]);
    press("PageDown");
    expect(revealed()).toEqual(["true", "true"]);
    press(" ");
    expect(sceneId()).toBe("method");
    expect(p.next()).toBe(false);
    press("Enter");
    expect(sceneId()).toBe("method");
  });

  it("goes back with the left arrow and shift+space", () => {
    const p = mount();
    p.go({ scene: 2, step: 0 });
    press("ArrowLeft");
    expect(player?.state.position).toEqual({ scene: 1, step: 2 });
    press(" ", { shiftKey: true });
    expect(player?.state.position).toEqual({ scene: 1, step: 1 });
    press("PageUp");
    expect(player?.state.position).toEqual({ scene: 1, step: 0 });
  });

  it("jumps with Home and End", () => {
    mount();
    press("End");
    expect(sceneId()).toBe("method");
    press("Home");
    expect(sceneId()).toBe("opening");
  });

  it("toggles notes and the reading view", () => {
    mount();
    press("n");
    expect(player?.state.notes).toBe(true);
    expect(host.querySelector<HTMLElement>("#dc-notes")?.hidden).toBe(false);
    expect(host.querySelector("#dc-notes")?.textContent).toContain("Open with the answer");
    press("r");
    expect(player?.state.mode).toBe("read");
    expect(host.querySelector<HTMLElement>("#dc-notes")?.hidden).toBe(true);
    press("Escape");
    expect(player?.state.mode).toBe("present");
  });

  it("ignores keys typed into a field and keys with a modifier", () => {
    mount();
    const input = document.createElement("input");
    document.body.append(input);
    const typed = press("ArrowRight", {}, input);
    expect(typed.defaultPrevented).toBe(false);
    const chord = press("ArrowRight", { ctrlKey: true });
    expect(chord.defaultPrevented).toBe(false);
    expect(sceneId()).toBe("opening");
    input.remove();
  });

  it("leaves space and Enter to a focused control", () => {
    mount();
    const nextButton = host.querySelector<HTMLElement>("[data-action=notes]") as HTMLElement;
    const event = press(" ", {}, nextButton);
    expect(event.defaultPrevented).toBe(false);
    expect(sceneId()).toBe("opening");
  });

  it("does not step while the reading view is open", () => {
    mount();
    press("r");
    const event = press("ArrowRight");
    expect(event.defaultPrevented).toBe(false);
    expect(player?.state.position).toEqual({ scene: 0, step: 0 });
  });
});

describe("controls", () => {
  it("moves with the buttons and disables them at the ends", () => {
    mount();
    const previous = host.querySelector<HTMLElement>("[data-action=previous]") as HTMLElement;
    const next = host.querySelector<HTMLElement>("[data-action=next]") as HTMLElement;
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    previous.click();
    expect(sceneId()).toBe("opening");
    next.click();
    expect(sceneId()).toBe("demand");
    expect(previous.getAttribute("aria-disabled")).toBe("false");
    player?.go({ scene: 2, step: 0 });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    next.click();
    expect(sceneId()).toBe("method");
  });

  it("shows the step counter only for scenes with steps", () => {
    const p = mount();
    expect(count()).toBe("1 / 3");
    p.go({ scene: 1, step: 1 });
    expect(count()).toBe("2 / 3 · 1/2");
  });

  it("announces scene changes to a screen reader", () => {
    const p = mount();
    p.go({ scene: 1, step: 2 });
    expect(host.querySelector("[aria-live]")?.textContent).toBe(
      "Scene 2 of 3: Demand is shifting, step 2 of 2",
    );
  });

  it("marks the lead for each scene", () => {
    const p = mount();
    p.go({ scene: 1, step: 0 });
    expect(host.querySelector<HTMLElement>(".dc-lead")?.dataset.lead).toBe("agent");
    expect(host.querySelector(".dc-lead")?.textContent).toBe("Agent-led");
  });
});

describe("hash", () => {
  it("follows the scene as it changes, pushing a history entry per scene", () => {
    const p = mount();
    const before = history.length;
    p.go({ scene: 1, step: 0 });
    expect(location.hash).toBe("#/demand");
    expect(history.length).toBe(before + 1);
    p.next();
    expect(location.hash).toBe("#/demand/1");
    expect(history.length).toBe(before + 1);
    p.setMode("read");
    expect(location.hash).toBe("#/read");
  });

  it("follows a hash change from outside", () => {
    mount();
    history.replaceState(null, "", "#/method");
    dispatchEvent(new HashChangeEvent("hashchange"));
    expect(sceneId()).toBe("method");
  });

  it("leaves the address bar alone when hash is off", () => {
    const p = mount({ hash: false });
    p.go({ scene: 1, step: 0 });
    expect(location.hash).toBe("");
  });
});

describe("update", () => {
  it("keeps the place by scene id when the deck changes underneath", () => {
    const p = mount();
    p.go({ scene: 1, step: 1 });
    const next = demoSource();
    next.scenes.unshift({ ...next.scenes[0], id: "added-first", title: "Added first" } as never);
    next.deck.scenes.unshift("added-first");
    p.update(next);
    expect(sceneId()).toBe("demand");
    expect(p.state.position).toEqual({ scene: 2, step: 1 });
  });

  it("clamps when the scene it was on is gone", () => {
    const p = mount();
    p.go({ scene: 2, step: 0 });
    const next = demoSource();
    next.scenes.splice(2, 1);
    next.deck.scenes.splice(2, 1);
    p.update(next);
    expect(p.state.position.scene).toBe(1);
  });
});

describe("motion", () => {
  it("uses a view transition when motion is allowed and the browser has one", () => {
    const start = vi.fn((render: () => void) => {
      render();
      return {};
    });
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true });
    try {
      const p = mount({ reducedMotion: false });
      p.next();
      expect(start).toHaveBeenCalledTimes(1);
      expect(sceneId()).toBe("demand");
      expect(document.documentElement.dataset.dcDirection).toBe("forward");
      p.previous();
      expect(document.documentElement.dataset.dcDirection).toBe("back");
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });

  it("does not report the rejection of a view transition that a newer one skipped", async () => {
    // Pressing a key before the last animation ends skips it, and the browser rejects its `ready` promise.
    const start = vi.fn((render: () => void) => {
      render();
      return { ready: Promise.reject(new DOMException("Transition was skipped", "AbortError")) };
    });
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true });
    try {
      mount({ reducedMotion: false }).next();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });

  it("changes scenes directly under reduced motion", () => {
    const start = vi.fn();
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true });
    try {
      mount({ reducedMotion: true }).next();
      expect(start).not.toHaveBeenCalled();
      expect(sceneId()).toBe("demand");
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });

  it("does not use a view transition for a step inside the same scene", () => {
    const start = vi.fn((render: () => void) => {
      render();
      return {};
    });
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true });
    try {
      const p = mount({ reducedMotion: false });
      p.go({ scene: 1, step: 0 });
      start.mockClear();
      p.next();
      expect(start).not.toHaveBeenCalled();
      expect(revealed()).toEqual(["true", "false"]);
    } finally {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  });
});

describe("onChange and destroy", () => {
  it("reports each change with a copy of the state", () => {
    const seen: PlayerState[] = [];
    const p = mount({ onChange: (state) => seen.push(state) });
    p.next();
    p.toggleNotes();
    const last = seen.at(-1);
    expect(last?.notes).toBe(true);
    expect(seen.some((state) => state.position.scene === 1)).toBe(true);
    if (last) last.position.scene = 99;
    expect(p.state.position.scene).toBe(1);
  });

  it("removes its listeners and its DOM when destroyed", () => {
    const p = mount();
    p.destroy();
    expect(host.childElementCount).toBe(0);
    const event = press("ArrowRight");
    expect(event.defaultPrevented).toBe(false);
    player = undefined;
  });
});
