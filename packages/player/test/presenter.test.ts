// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BroadcastMount,
  CHANNEL_NAME,
  type Channel,
  mountBroadcast,
  readRequest,
  readState,
} from "../src/broadcast.ts";
import { type LeaseMount, mountLease } from "../src/lease.ts";
import type { PlayerSource } from "../src/load.ts";
import { mountPlayer, type Player } from "../src/player.ts";
import { formatElapsed, HELLO_EVERY_MS, mountPresenterView, type PresenterMount } from "../src/presenter.ts";
import { demoSource, sceneWith } from "./helpers.ts";

type Listener = (event: { data: unknown }) => void;

/** One end of a fake channel. What it posts reaches every other end on the same bus, as a copy, at once. */
interface FakeChannel extends Channel {
  posted: unknown[];
  closed: boolean;
  /** How many listeners are attached. A real channel that is closed delivers nothing, so only this shows a leak. */
  listening(): number;
}

class Bus {
  private readonly ends: Array<{ channel: FakeChannel; listeners: Set<Listener> }> = [];

  end(): FakeChannel {
    const listeners = new Set<Listener>();
    const channel: FakeChannel = {
      posted: [],
      closed: false,
      listening: () => listeners.size,
      postMessage: (message) => {
        channel.posted.push(message);
        for (const other of this.ends) {
          if (other.channel === channel || other.channel.closed) continue;
          for (const listener of [...other.listeners]) listener({ data: structuredClone(message) });
        }
      },
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
      close: () => {
        channel.closed = true;
      },
    };
    this.ends.push({ channel, listeners });
    return channel;
  }
}

let deckHost: HTMLElement;
let presenterHost: HTMLElement;
let source: PlayerSource;
let player: Player | undefined;
let lease: LeaseMount | undefined;
let broadcast: BroadcastMount | undefined;
let view: PresenterMount | undefined;
let bus: Bus;

beforeEach(() => {
  history.replaceState(null, "", "/");
  document.title = "";
  deckHost = document.createElement("div");
  presenterHost = document.createElement("div");
  document.body.append(deckHost, presenterHost);
  bus = new Bus();
  source = demoSource();
});

afterEach(() => {
  view?.destroy();
  broadcast?.destroy();
  lease?.destroy();
  player?.destroy();
  view = broadcast = lease = player = undefined;
  deckHost.remove();
  presenterHost.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The deck window: a player, optionally with a lease, and the broadcaster on a channel of the bus. */
function mountDeck(options: { withLease?: boolean; deck?: PlayerSource } = {}) {
  source = options.deck ?? source;
  const channel = bus.end();
  player = mountPlayer(deckHost, source, {
    reducedMotion: true,
    onChange: (state) => {
      lease?.changed(state);
      broadcast?.changed(state);
    },
  });
  if (options.withLease) {
    lease = mountLease({ player, source: () => source, allowScriptedGrant: true });
  }
  broadcast = mountBroadcast({ player, source: () => source, lease, channel });
  return { channel, player, lease };
}

function mountView(options: { now?: () => number; deck?: PlayerSource } = {}) {
  const channel = bus.end();
  view = mountPresenterView({
    host: presenterHost,
    source: options.deck ?? source,
    channel,
    ...(options.now ? { now: options.now } : {}),
  });
  return { channel, view };
}

const state = (scene: string, step: number, holder: "human" | "agent" = "human") => ({
  type: "state" as const,
  scene,
  step,
  holder,
});

const q = <T extends HTMLElement>(selector: string, root: ParentNode = presenterHost) =>
  root.querySelector(selector) as T;
const text = (selector: string) => q(selector).textContent;
const click = (selector: string, root: ParentNode = presenterHost) => q(selector, root).click();
const press = (key: string, init: KeyboardEventInit = {}) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const typed = (channel: FakeChannel) => channel.posted.map((message) => (message as { type: string }).type);

describe("formatElapsed", () => {
  it("shows minutes and seconds, then hours from the first hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(999)).toBe("0:00");
    expect(formatElapsed(59_000)).toBe("0:59");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(59 * 60_000 + 59_999)).toBe("59:59");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_600_000 * 10 + 61_000)).toBe("10:01:01");
  });

  it("never goes below zero when the clock steps back", () => {
    expect(formatElapsed(-5000)).toBe("0:00");
  });
});

describe("the messages", () => {
  it("accepts a state with a scene id, a whole step and a holder, and nothing else", () => {
    expect(readState(state("demand", 2, "agent"))).toEqual(state("demand", 2, "agent"));
    for (const bad of [
      null,
      undefined,
      "state",
      42,
      {},
      { type: "hello" },
      { ...state("demand", 1), scene: 7 },
      { ...state("demand", 1), step: -1 },
      { ...state("demand", 1), step: 1.5 },
      { ...state("demand", 1), step: "1" },
      { ...state("demand", 1), holder: "robot" },
      // Right shape, wrong kind: only a message that says it is a state is one.
      { ...state("demand", 1), type: "hello" },
      { ...state("demand", 1), type: "next" },
      { type: "state", scene: "demand", step: 1 },
    ]) {
      expect(readState(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("reads the four requests and drops extra fields and unknown types", () => {
    for (const type of ["hello", "next", "previous", "takeover"]) {
      expect(readRequest({ type, extra: 1 })).toEqual({ type });
    }
    for (const bad of [null, undefined, "next", {}, { type: "goto" }, { type: "state" }]) {
      expect(readRequest(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("the deck window's side", () => {
  it("tells the presenter where the deck is as soon as it mounts", () => {
    const { channel } = mountDeck();
    expect(channel.posted).toEqual([state("opening", 0)]);
  });

  it("posts each move once, by scene id", () => {
    const { channel, player } = mountDeck();
    player.next();
    player.next();
    player.next();
    expect(channel.posted).toEqual([
      state("opening", 0),
      state("demand", 0),
      state("demand", 1),
      state("demand", 2),
    ]);
  });

  it("does not repeat a state that has not changed, such as a live reload of the same place", () => {
    const { channel, player } = mountDeck();
    player.update(demoSource());
    player.toggleNotes();
    expect(channel.posted).toEqual([state("opening", 0)]);
  });

  it("answers hello with the state again, even if it has not changed", () => {
    const { channel } = mountDeck();
    const peer = bus.end();
    peer.postMessage({ type: "hello" });
    peer.postMessage({ type: "hello" });
    expect(channel.posted).toEqual([state("opening", 0), state("opening", 0), state("opening", 0)]);
  });

  it("does what the presenter's window asks: next and previous", () => {
    const { player } = mountDeck();
    const peer = bus.end();
    peer.postMessage({ type: "next" });
    peer.postMessage({ type: "next" });
    expect(player.state.position).toEqual({ scene: 1, step: 1 });
    peer.postMessage({ type: "previous" });
    expect(player.state.position).toEqual({ scene: 1, step: 0 });
  });

  it("stays put at the ends of the deck", () => {
    const { player, channel } = mountDeck();
    const peer = bus.end();
    peer.postMessage({ type: "previous" });
    expect(player.state.position).toEqual({ scene: 0, step: 0 });
    player.go({ scene: 2, step: 0 });
    peer.postMessage({ type: "next" });
    expect(player.state.position).toEqual({ scene: 2, step: 0 });
    expect(channel.posted.at(-1)).toEqual(state("method", 0));
  });

  it("ignores anything that is not one of the four requests", () => {
    const { player, channel } = mountDeck();
    const peer = bus.end();
    for (const bad of [
      null,
      "next",
      7,
      { type: "goto", scene: "demand" },
      { type: "state", scene: "demand" },
      {},
    ]) {
      peer.postMessage(bad);
    }
    expect(player.state.position).toEqual({ scene: 0, step: 0 });
    expect(channel.posted).toEqual([state("opening", 0)]);
  });

  it("says the person is presenting when the page has no lease", () => {
    const { channel } = mountDeck();
    bus.end().postMessage({ type: "takeover" });
    expect(channel.posted).toEqual([state("opening", 0)]);
  });

  it("follows who holds control, and takeover from the presenter's window ends the agent's turn", () => {
    const { channel, lease } = mountDeck({ withLease: true });
    player?.go({ scene: 1, step: 0 });
    lease?.controller.grant({ scenes: ["demand"] });
    expect(channel.posted.at(-1)).toEqual(state("demand", 0, "agent"));
    bus.end().postMessage({ type: "takeover" });
    expect(lease?.controller.state().holder).toBe("human");
    expect(channel.posted.at(-1)).toEqual(state("demand", 0, "human"));
  });

  it("treats a move from the presenter's window like the person's own: it takes control back first", () => {
    const { channel, lease } = mountDeck({ withLease: true });
    player?.go({ scene: 1, step: 0 });
    lease?.controller.grant({ scenes: ["demand"] });
    bus.end().postMessage({ type: "next" });
    expect(lease?.controller.state().holder).toBe("human");
    expect(player?.state.position).toEqual({ scene: 1, step: 1 });
    expect(channel.posted.at(-1)).toEqual(state("demand", 1, "human"));
  });

  it("reports a move the agent makes under its lease as the agent's", () => {
    const { channel, lease } = mountDeck({ withLease: true });
    player?.go({ scene: 1, step: 0 });
    lease?.controller.grant({ scenes: ["demand"] });
    const granted = lease?.controller.state();
    expect(granted?.holder).toBe("agent");
    void (async () => {
      if (granted?.holder !== "agent") return;
      await lease?.controller.submit({
        leaseId: granted.lease.id,
        epoch: granted.lease.epoch,
        sequence: 1,
        expectedRev: granted.rev,
        action: "next",
      });
    })();
    return vi.waitFor(() => expect(channel.posted.at(-1)).toEqual(state("demand", 1, "agent")));
  });

  describe("the button", () => {
    it("sits in the controls before the read button, and is not one of the player's own actions", () => {
      mountDeck({ withLease: true });
      const button = q<HTMLButtonElement>("[data-presenter-open]", deckHost);
      expect(button.textContent).toBe("Presenter view");
      expect(button.hasAttribute("data-action")).toBe(false);
      expect(button.nextElementSibling?.getAttribute("data-action")).toBe("read");
      expect(button.previousElementSibling?.classList.contains("dc-lease")).toBe(true);
    });

    it("opens the presenter's window on this address with ?presenter and no hash", () => {
      mountDeck();
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      player?.go({ scene: 1, step: 1 });
      click("[data-presenter-open]", deckHost);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith("/?presenter", "depthcue-presenter", "popup,width=1100,height=720");
    });

    it("does not take control back from an agent", () => {
      const { lease } = mountDeck({ withLease: true });
      lease?.controller.grant({ scenes: ["opening"] });
      vi.spyOn(window, "open").mockReturnValue(null);
      click("[data-presenter-open]", deckHost);
      expect(lease?.controller.state().holder).toBe("agent");
    });

    it("opens where the caller says, for a deck served below a path", () => {
      const channel = bus.end();
      player = mountPlayer(deckHost, source, { reducedMotion: true });
      broadcast = mountBroadcast({
        player,
        source: () => source,
        channel,
        presenterUrl: () => "/talk/?presenter",
      });
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      click("[data-presenter-open]", deckHost);
      expect(open).toHaveBeenCalledWith(
        "/talk/?presenter",
        "depthcue-presenter",
        "popup,width=1100,height=720",
      );
    });
  });

  it("needs a mounted player", () => {
    const channel = bus.end();
    const bare = { state: { position: { scene: 0, step: 0 } } } as unknown as Player;
    expect(() => mountBroadcast({ player: bare, source: () => source, channel })).toThrow(/mounted player/);
  });

  it("stops answering, closes its channel and takes its button away when it is destroyed", () => {
    const { channel, player } = mountDeck();
    broadcast?.destroy();
    broadcast = undefined;
    expect(channel.closed).toBe(true);
    expect(channel.listening()).toBe(0);
    expect(deckHost.querySelector("[data-presenter-open]")).toBeNull();
    bus.end().postMessage({ type: "next" });
    expect(player.state.position).toEqual({ scene: 0, step: 0 });
  });

  it("stops listening for hand-overs when it is destroyed", () => {
    const { channel, lease } = mountDeck({ withLease: true });
    const before = channel.posted.length;
    broadcast?.destroy();
    broadcast = undefined;
    lease?.controller.grant({ scenes: ["opening"] });
    expect(channel.posted).toHaveLength(before);
  });
});

describe("the presenter's window", () => {
  it("asks where the deck is, and says it is waiting until it hears", () => {
    const { channel } = mountView();
    expect(channel.posted).toEqual([{ type: "hello" }]);
    expect(text(".dc-pv-holder")).toBe("Waiting for the deck window");
    expect(q(".dc-presenter").dataset.holder).toBe("waiting");
    expect(text(".dc-pv-deck")).toBe("Why channel B now leads");
    expect(document.title).toBe("Why channel B now leads (presenter)");
    expect(q(".dc-pv-moves [data-pv='next']").getAttribute("aria-disabled")).toBe("true");
    expect(q(".dc-pv-moves [data-pv='previous']").getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps asking every two seconds until the deck window answers, then stops", () => {
    vi.useFakeTimers();
    const { channel } = mountView();
    expect(HELLO_EVERY_MS).toBe(2000);
    vi.advanceTimersByTime(1999);
    expect(typed(channel)).toEqual(["hello"]);
    vi.advanceTimersByTime(1);
    expect(typed(channel)).toEqual(["hello", "hello"]);
    vi.advanceTimersByTime(4000);
    expect(typed(channel)).toEqual(["hello", "hello", "hello", "hello"]);
    bus.end().postMessage(state("opening", 0));
    vi.advanceTimersByTime(10_000);
    expect(typed(channel)).toHaveLength(4);
  });

  it("shows the scene on screen: where it is, its title, its notes and who is presenting", () => {
    mountView();
    bus.end().postMessage(state("demand", 1, "agent"));
    expect(text(".dc-pv-where")).toBe("Scene 2 of 3 · step 1 of 2 · Agent-led");
    expect(text(".dc-pv-scene")).toBe("Demand is shifting");
    expect(text(".dc-pv-notes")).toContain("Pause on the chart.");
    expect(q(".dc-pv-notes").dataset.empty).toBe("false");
    expect(text(".dc-pv-holder")).toBe("Agent presenting");
    expect(q(".dc-presenter").dataset.holder).toBe("agent");
  });

  it("calls a scene with no lead human-led", () => {
    const plain = demoSource();
    plain.scenes[0] = sceneWith({ id: "opening", title: "Opening" });
    mountView({ deck: plain });
    bus.end().postMessage(state("opening", 0));
    expect(text(".dc-pv-where")).toBe("Scene 1 of 3 · Human-led");
  });

  it("leaves the step out for a scene that has none, and says so when there are no notes", () => {
    mountView();
    bus.end().postMessage(state("method", 0));
    expect(text(".dc-pv-where")).toBe("Scene 3 of 3 · Human-led");
    expect(text(".dc-pv-notes")).toBe("No notes for this scene.");
    expect(q(".dc-pv-notes").dataset.empty).toBe("true");
    expect(text(".dc-pv-holder")).toBe("You present");
  });

  it("treats notes that are only blank space as no notes", () => {
    const blank = demoSource();
    blank.scenes[0] = sceneWith({ id: "opening", title: "Opening", notes: "  \n\t " });
    mountView({ deck: blank });
    bus.end().postMessage(state("opening", 0));
    expect(text(".dc-pv-notes")).toBe("No notes for this scene.");
    expect(q(".dc-pv-notes").dataset.empty).toBe("true");
  });

  it("trims the space around notes but keeps the line breaks inside", () => {
    const padded = demoSource();
    padded.scenes[0] = sceneWith({ id: "opening", title: "Opening", notes: "\n  one\ntwo  \n" });
    mountView({ deck: padded });
    bus.end().postMessage(state("opening", 0));
    expect(text(".dc-pv-notes")).toBe("one\ntwo");
  });

  it("takes the deck's theme, and follows it when the deck changes", () => {
    mountView();
    expect(q(".dc-presenter").dataset.theme).toBe("paper");
    const dark = demoSource();
    dark.deck = { ...dark.deck, theme: "ink" };
    view?.update(dark);
    expect(q(".dc-presenter").dataset.theme).toBe("ink");
  });

  it("names its landmarks and its notes region for a screen reader, and lets the notes be scrolled by keyboard", () => {
    mountView();
    expect(q(".dc-presenter").tagName).toBe("MAIN");
    const named = (selector: string) => q(selector).getAttribute("aria-label");
    expect(named(".dc-pv-now")).toBe("On screen");
    expect(named(".dc-pv-next")).toBe("Next");
    expect(named(".dc-pv-clock")).toBe("Timer");
    expect(named(".dc-pv-moves")).toBe("Moves");
    expect(named(".dc-pv-time")).toBe("Elapsed time");
    expect(q(".dc-pv-notes").getAttribute("role")).toBe("region");
    expect(named(".dc-pv-notes")).toBe("Notes");
    expect(q(".dc-pv-notes").getAttribute("tabindex")).toBe("0");
    expect(presenterHost.querySelectorAll("h1")).toHaveLength(1);
  });

  it("shows deck text as text and never as markup", () => {
    const evil = demoSource();
    evil.scenes[0] = sceneWith({
      id: "opening",
      title: "<img src=x onerror=alert(1)>",
      notes: "<script>alert(1)</script>\n<b>bold</b>",
    });
    mountView({ deck: evil });
    bus.end().postMessage(state("opening", 0));
    expect(presenterHost.querySelector("img, script, b")).toBeNull();
    expect(text(".dc-pv-scene")).toBe("<img src=x onerror=alert(1)>");
    expect(text(".dc-pv-notes")).toBe("<script>alert(1)</script>\n<b>bold</b>");
  });

  describe("what comes next", () => {
    const at = (scene: string, step: number) => {
      bus.end().postMessage(state(scene, step));
      return {
        label: text(".dc-pv-label"),
        title: q(".dc-pv-next-title").hidden ? "" : text(".dc-pv-next-title"),
        detail: q(".dc-pv-detail").hidden ? "" : text(".dc-pv-detail"),
      };
    };

    it("leads into the next scene with its title and summary", () => {
      mountView();
      expect(at("opening", 0)).toEqual({
        label: "Next scene",
        title: "Demand is shifting",
        detail: "Channel B now leads, 60 to 40.",
      });
    });

    it("says how many blocks the next click reveals", () => {
      mountView();
      expect(at("demand", 0)).toEqual({
        label: "Next click: step 1 of 2",
        title: "",
        detail: "Reveals 1 block on this scene.",
      });
      expect(at("demand", 1).label).toBe("Next click: step 2 of 2");
    });

    it("counts blocks in the plural, and leaves out a summary that is not there", () => {
      const wide = demoSource();
      wide.scenes[1] = sceneWith({
        ...wide.scenes[1],
        id: "demand",
        steps: [{ id: "all", reveal: ["show-claim", "show-evidence"] }],
      });
      mountView({ deck: wide });
      expect(at("demand", 0).detail).toBe("Reveals 2 blocks on this scene.");
      expect(at("demand", 1)).toEqual({ label: "Next scene", title: "How we compared them", detail: "" });
    });

    it("says the deck ends after the last scene, and turns Next off", () => {
      mountView();
      expect(at("method", 0)).toEqual({
        label: "End of the deck",
        title: "",
        detail: "Nothing follows this.",
      });
      expect(q(".dc-pv-moves [data-pv='next']").getAttribute("aria-disabled")).toBe("true");
      expect(q(".dc-pv-moves [data-pv='previous']").hasAttribute("aria-disabled")).toBe(false);
    });

    it("turns Previous off at the very start only", () => {
      mountView();
      at("opening", 0);
      expect(q(".dc-pv-moves [data-pv='previous']").getAttribute("aria-disabled")).toBe("true");
      expect(q(".dc-pv-moves [data-pv='next']").hasAttribute("aria-disabled")).toBe(false);
      at("demand", 0);
      expect(q(".dc-pv-moves [data-pv='previous']").hasAttribute("aria-disabled")).toBe(false);
    });

    it("keeps Previous on inside the first scene once a step has been shown", () => {
      const stepped = demoSource();
      stepped.scenes[0] = sceneWith({
        id: "opening",
        title: "Opening",
        blocks: [
          { id: "a", type: "text", role: "heading", text: "A" },
          { id: "b", type: "text", role: "body", text: "B" },
        ],
        steps: [{ id: "show-b", reveal: ["b"] }],
      });
      mountView({ deck: stepped });
      at("opening", 0);
      expect(q(".dc-pv-moves [data-pv='previous']").getAttribute("aria-disabled")).toBe("true");
      at("opening", 1);
      expect(q(".dc-pv-moves [data-pv='previous']").hasAttribute("aria-disabled")).toBe(false);
    });

    it("hides the title and the detail line when there is nothing to put in them", () => {
      mountView();
      bus.end().postMessage(state("demand", 0));
      expect(q(".dc-pv-next-title").hidden).toBe(true);
      expect(q(".dc-pv-detail").hidden).toBe(false);
      bus.end().postMessage(state("demand", 2));
      expect(q(".dc-pv-next-title").hidden).toBe(false);
      expect(q(".dc-pv-detail").hidden).toBe(true);
      bus.end().postMessage(state("opening", 0));
      expect(q(".dc-pv-next-title").hidden).toBe(false);
      expect(q(".dc-pv-detail").hidden).toBe(false);
    });
  });

  describe("the timer", () => {
    it("counts from when the window opened and reads the clock it was given", () => {
      vi.useFakeTimers();
      let clock = 1_000_000;
      mountView({ now: () => clock });
      expect(text(".dc-pv-time")).toBe("0:00");
      clock += 65_000;
      vi.advanceTimersByTime(1000);
      expect(text(".dc-pv-time")).toBe("1:05");
      clock += 3_540_000;
      vi.advanceTimersByTime(1000);
      expect(text(".dc-pv-time")).toBe("1:00:05");
    });

    it("starts over at 0:00 when Reset is pressed", () => {
      vi.useFakeTimers();
      let clock = 5000;
      mountView({ now: () => clock });
      clock += 125_000;
      vi.advanceTimersByTime(1000);
      expect(text(".dc-pv-time")).toBe("2:05");
      click("[data-pv='reset']");
      expect(text(".dc-pv-time")).toBe("0:00");
      clock += 3000;
      vi.advanceTimersByTime(1000);
      expect(text(".dc-pv-time")).toBe("0:03");
    });

    it("is a timer that a screen reader does not read out every second", () => {
      mountView();
      expect(q(".dc-pv-time").getAttribute("role")).toBe("timer");
      expect(q(".dc-pv-holder").getAttribute("role")).toBe("status");
    });
  });

  describe("the moves", () => {
    it("asks the deck window to move when Next and Previous are pressed", () => {
      const { channel } = mountView();
      bus.end().postMessage(state("demand", 1));
      click("[data-pv='next']");
      click("[data-pv='previous']");
      expect(channel.posted.slice(1)).toEqual([{ type: "next" }, { type: "previous" }]);
    });

    it("does not ask for a move that is off", () => {
      const { channel } = mountView();
      click("[data-pv='next']");
      bus.end().postMessage(state("opening", 0));
      click("[data-pv='previous']");
      bus.end().postMessage(state("method", 0));
      click("[data-pv='next']");
      expect(typed(channel)).toEqual(["hello"]);
    });

    it("moves on the arrow keys and page keys", () => {
      const { channel } = mountView();
      bus.end().postMessage(state("demand", 1));
      for (const key of ["ArrowRight", "PageDown", "ArrowLeft", "PageUp"]) press(key);
      expect(typed(channel).slice(1)).toEqual(["next", "next", "previous", "previous"]);
    });

    it("leaves keys alone when a modifier is held or something else has handled them", () => {
      const { channel } = mountView();
      bus.end().postMessage(state("demand", 1, "agent"));
      press("ArrowRight", { ctrlKey: true });
      press("ArrowRight", { metaKey: true });
      press("ArrowLeft", { altKey: true });
      press("Escape", { ctrlKey: true });
      const handled = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      handled.preventDefault();
      document.dispatchEvent(handled);
      press("Enter");
      press(" ");
      press("a");
      expect(typed(channel)).toEqual(["hello"]);
    });

    it("keeps keys quiet before it knows where the deck is", () => {
      const { channel } = mountView();
      press("ArrowRight");
      press("ArrowLeft");
      press("Escape");
      expect(typed(channel)).toEqual(["hello"]);
    });
  });

  describe("taking over", () => {
    it("shows Take over only while the agent presents", () => {
      mountView();
      const take = q<HTMLButtonElement>("[data-pv='takeover']");
      expect(take.hidden).toBe(true);
      bus.end().postMessage(state("demand", 0, "agent"));
      expect(take.hidden).toBe(false);
      bus.end().postMessage(state("demand", 0, "human"));
      expect(take.hidden).toBe(true);
    });

    it("asks for control back from the button and from Escape, and only then", () => {
      const { channel } = mountView();
      bus.end().postMessage(state("demand", 0, "human"));
      press("Escape");
      bus.end().postMessage(state("demand", 0, "agent"));
      press("Escape");
      click("[data-pv='takeover']");
      expect(typed(channel)).toEqual(["hello", "takeover", "takeover"]);
    });
  });

  describe("what it ignores and how it follows the deck", () => {
    it("ignores messages that are not a state, and a state that is malformed", () => {
      mountView();
      const peer = bus.end();
      peer.postMessage(state("demand", 1, "agent"));
      for (const bad of [
        null,
        "state",
        {},
        { type: "hello" },
        { ...state("opening", 0), step: -3 },
        { ...state("opening", 0), holder: "x" },
      ]) {
        peer.postMessage(bad);
      }
      expect(text(".dc-pv-scene")).toBe("Demand is shifting");
      expect(text(".dc-pv-holder")).toBe("Agent presenting");
    });

    it("says it is waiting when the scene is not in its deck, and keeps asking nothing it cannot use", () => {
      mountView();
      bus.end().postMessage(state("no-such-scene", 0, "agent"));
      expect(text(".dc-pv-holder")).toBe("Waiting for the deck window");
      expect(q<HTMLButtonElement>("[data-pv='takeover']").hidden).toBe(true);
      expect(q(".dc-pv-moves [data-pv='next']").getAttribute("aria-disabled")).toBe("true");
      expect(text(".dc-pv-scene")).toBe("");
    });

    it("picks up the new text of the scene it is on after a live reload", () => {
      mountView();
      bus.end().postMessage(state("demand", 1, "agent"));
      const edited = demoSource();
      edited.deck = { ...edited.deck, title: "Retitled" };
      edited.scenes[1] = {
        ...(edited.scenes[1] as object),
        title: "Demand moved",
        notes: "New notes",
      } as never;
      view?.update(edited);
      expect(text(".dc-pv-deck")).toBe("Retitled");
      expect(document.title).toBe("Retitled (presenter)");
      expect(text(".dc-pv-scene")).toBe("Demand moved");
      expect(text(".dc-pv-notes")).toBe("New notes");
      expect(text(".dc-pv-holder")).toBe("Agent presenting");
    });

    it("asks again when a reload takes away the scene it was showing, and recovers when told", () => {
      const { channel } = mountView();
      bus.end().postMessage(state("demand", 0));
      const edited = demoSource();
      edited.deck = { ...edited.deck, scenes: ["opening", "method"] };
      edited.scenes = edited.scenes.filter((scene) => scene.id !== "demand");
      view?.update(edited);
      expect(text(".dc-pv-holder")).toBe("Waiting for the deck window");
      expect(typed(channel)).toEqual(["hello", "hello"]);
      bus.end().postMessage(state("method", 0));
      expect(text(".dc-pv-scene")).toBe("How we compared them");
    });

    it("does not ask again after a reload that keeps the scene", () => {
      const { channel } = mountView();
      bus.end().postMessage(state("demand", 0));
      view?.update(demoSource());
      expect(typed(channel)).toEqual(["hello"]);
    });
  });

  it("stops everything when it is destroyed, whether or not the deck window had answered", () => {
    for (const answered of [false, true]) {
      vi.useFakeTimers();
      const { channel } = mountView();
      if (answered) bus.end().postMessage(state("demand", 0, "agent"));
      expect(vi.getTimerCount()).toBe(answered ? 1 : 2);
      view?.destroy();
      view = undefined;
      expect(channel.closed).toBe(true);
      expect(channel.listening()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(presenterHost.childElementCount).toBe(0);
      const before = channel.posted.length;
      press("ArrowRight");
      press("Escape");
      vi.advanceTimersByTime(10_000);
      expect(channel.posted).toHaveLength(before);
      vi.useRealTimers();
    }
  });

  it("stops listening for deck messages when it is destroyed", () => {
    mountView();
    const root = q(".dc-presenter");
    view?.destroy();
    view = undefined;
    bus.end().postMessage(state("demand", 1, "agent"));
    expect(root.dataset.holder).toBe("waiting");
  });
});

describe("the two windows together", () => {
  it("moves the deck from the presenter's window and shows the audience's moves", () => {
    const { player } = mountDeck();
    mountView();
    expect(text(".dc-pv-scene")).toBe("Why channel B now leads");
    click("[data-pv='next']");
    expect(player.state.position).toEqual({ scene: 1, step: 0 });
    expect(text(".dc-pv-scene")).toBe("Demand is shifting");
    click("[data-pv='next']");
    expect(text(".dc-pv-where")).toBe("Scene 2 of 3 · step 1 of 2 · Agent-led");
    player.go({ scene: 0, step: 0 });
    expect(text(".dc-pv-scene")).toBe("Why channel B now leads");
    expect(q(".dc-pv-moves [data-pv='previous']").getAttribute("aria-disabled")).toBe("true");
  });

  it("shows a hand-over and takes control back from the presenter's window", () => {
    const { lease } = mountDeck({ withLease: true });
    mountView();
    player?.go({ scene: 1, step: 0 });
    expect(text(".dc-pv-holder")).toBe("You present");
    lease?.controller.grant({ scenes: ["demand"] });
    expect(text(".dc-pv-holder")).toBe("Agent presenting");
    expect(q<HTMLButtonElement>("[data-pv='takeover']").hidden).toBe(false);
    click("[data-pv='takeover']");
    expect(lease?.controller.state().holder).toBe("human");
    expect(text(".dc-pv-holder")).toBe("You present");
    expect(q<HTMLButtonElement>("[data-pv='takeover']").hidden).toBe(true);
  });

  it("shows up when it opens after the deck has already moved", () => {
    const { player } = mountDeck();
    player.go({ scene: 1, step: 2 });
    mountView();
    expect(text(".dc-pv-where")).toBe("Scene 2 of 3 · step 2 of 2 · Agent-led");
  });
});

describe("the browser's channel", () => {
  it("is opened by both windows under the documented name when none is given, and carries their messages", () => {
    const made: string[] = [];
    const groups = new Map<string, Set<Stub>>();
    class Stub {
      private readonly listeners = new Set<Listener>();
      constructor(readonly name: string) {
        made.push(name);
        groups.set(name, (groups.get(name) ?? new Set()).add(this));
      }
      postMessage(data: unknown) {
        for (const other of groups.get(this.name) ?? []) {
          if (other === this) continue;
          for (const listener of [...other.listeners]) listener({ data: structuredClone(data) });
        }
      }
      addEventListener(_type: string, listener: Listener) {
        this.listeners.add(listener);
      }
      removeEventListener(_type: string, listener: Listener) {
        this.listeners.delete(listener);
      }
      close() {
        groups.get(this.name)?.delete(this);
      }
    }
    vi.stubGlobal("BroadcastChannel", Stub);
    player = mountPlayer(deckHost, source, {
      reducedMotion: true,
      onChange: (next) => broadcast?.changed(next),
    });
    broadcast = mountBroadcast({ player, source: () => source });
    view = mountPresenterView({ host: presenterHost, source });
    expect(made).toEqual([CHANNEL_NAME, CHANNEL_NAME]);
    // Pages of other apps on the same origin may use a channel too; the name is what keeps them apart.
    expect(CHANNEL_NAME).toBe("depthcue-presenter");
    expect(text(".dc-pv-scene")).toBe("Why channel B now leads");
    click("[data-pv='next']");
    expect(player.state.position).toEqual({ scene: 1, step: 0 });
    expect(text(".dc-pv-scene")).toBe("Demand is shifting");
  });
});
