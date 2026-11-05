import "./player.css";
import type { BroadcastMount } from "./broadcast.ts";
import type { LeaseMount } from "./lease.ts";
import { loadDeck, type PlayerSource } from "./load.ts";
import { firstPartyModules } from "./modules/index.ts";
import { mountPlayer, type Player, type PlayerState } from "./player.ts";
import type { PresenterMount } from "./presenter.ts";

/**
 * Entry for a page that shows a deck folder. The page holds `<div id="depthcue" data-deck="." data-live>`:
 * `data-deck` is the folder URL, and `data-live` listens for `/_depthcue/events` to reload on file changes.
 * `data-lease` adds the control lease, which lets a person hand the deck to an agent. It is loaded only then,
 * so a page without the attribute, such as an exported deck, carries none of its code.
 * `data-presenter` adds the presenter view: a button that opens this address with `?presenter`, which shows
 * the notes, a timer and what comes next for the deck that the first window shows. It is loaded the same way.
 */
async function start(host: HTMLElement) {
  const base = host.dataset.deck ?? ".";
  const presenter = host.dataset.presenter !== undefined;
  if (presenter && new URLSearchParams(location.search).has("presenter")) return startPresenter(host, base);
  let player: Player | undefined;
  let current: PlayerSource;
  let lease: LeaseMount | undefined;
  let broadcast: BroadcastMount | undefined;
  try {
    current = await loadDeck(base);
    document.title = current.deck.title;
    player = mountPlayer(host, current, {
      modules: firstPartyModules,
      onChange: (state) => {
        lease?.changed(state);
        broadcast?.changed(state);
      },
      // Pausing or finishing the voice-over is not a move, but the presenter's window shows it.
      onVoice: () => broadcast?.changed(player?.state as PlayerState),
    });
    // Tools that drive the page, such as the renderer, wait on `settled()` and run module commands through it.
    Object.defineProperty(window, "depthcue", { value: player, configurable: true });
    if (host.dataset.lease !== undefined) {
      try {
        const { mountLease } = await import("./lease.ts");
        lease = mountLease({ player, source: () => current });
        // Only what an agent may call. Handing over control is a button for the person, never a method.
        Object.defineProperty(player, "lease", { value: lease.agent, configurable: true });
      } catch (error) {
        // The deck presents fine without it, so a lease that will not load must not take the deck down.
        console.warn(`The control lease did not load: ${(error as Error).message}`);
      }
    }
    if (presenter) {
      try {
        const { mountBroadcast } = await import("./broadcast.ts");
        broadcast = mountBroadcast({ player, source: () => current, lease });
      } catch (error) {
        console.warn(`The presenter view did not load: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    host.textContent = `The deck could not be loaded: ${(error as Error).message}`;
    host.classList.add("dc-failed");
    return;
  }

  if (host.dataset.live !== undefined && typeof EventSource === "function") {
    // A page with a lease says so, so the server knows which page an agent's calls go to.
    const events = new EventSource(lease ? "/_depthcue/events?lease=1" : "/_depthcue/events");
    lease?.link(events);
    followChanges(events, base, (next) => {
      current = next;
      player?.update(next);
    });
  }
}

/** Reloads the deck when the server says its files changed, and hands the new deck to `apply`. */
function followChanges(events: EventSource, base: string, apply: (next: PlayerSource) => void) {
  events.addEventListener("change", async () => {
    try {
      apply(await loadDeck(base));
    } catch {
      // The files can be half-written or briefly invalid while someone edits; keep showing the last good deck.
    }
  });
}

/** The presenter's window. It has no player and no lease, and it does not tell the server it is a page to control. */
async function startPresenter(host: HTMLElement, base: string) {
  let view: PresenterMount;
  try {
    const source = await loadDeck(base);
    const { mountPresenterView } = await import("./presenter.ts");
    view = mountPresenterView({ host, source });
  } catch (error) {
    host.textContent = `The presenter view could not be loaded: ${(error as Error).message}`;
    host.classList.add("dc-failed");
    return;
  }
  if (host.dataset.live !== undefined && typeof EventSource === "function") {
    followChanges(new EventSource("/_depthcue/events"), base, (next) => view.update(next));
  }
}

const host = document.getElementById("depthcue");
if (host) void start(host);
