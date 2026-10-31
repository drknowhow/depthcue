import "./player.css";
import type { LeaseMount } from "./lease.ts";
import { loadDeck, type PlayerSource } from "./load.ts";
import { firstPartyModules } from "./modules/index.ts";
import { mountPlayer, type Player } from "./player.ts";

/**
 * Entry for a page that shows a deck folder. The page holds `<div id="depthcue" data-deck="." data-live>`:
 * `data-deck` is the folder URL, and `data-live` listens for `/_depthcue/events` to reload on file changes.
 * `data-lease` adds the control lease, which lets a person hand the deck to an agent. It is loaded only then,
 * so a page without the attribute, such as an exported deck, carries none of its code.
 */
async function start(host: HTMLElement) {
  const base = host.dataset.deck ?? ".";
  let player: Player | undefined;
  let current: PlayerSource;
  let lease: LeaseMount | undefined;
  try {
    current = await loadDeck(base);
    document.title = current.deck.title;
    player = mountPlayer(host, current, {
      modules: firstPartyModules,
      onChange: (state) => lease?.changed(state),
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
  } catch (error) {
    host.textContent = `The deck could not be loaded: ${(error as Error).message}`;
    host.classList.add("dc-failed");
    return;
  }

  if (host.dataset.live !== undefined && typeof EventSource === "function") {
    const events = new EventSource("/_depthcue/events");
    events.addEventListener("change", async () => {
      try {
        const next = await loadDeck(base);
        current = next;
        player?.update(next);
      } catch {
        // The files can be half-written or briefly invalid while someone edits; keep showing the last good deck.
      }
    });
  }
}

const host = document.getElementById("depthcue");
if (host) void start(host);
