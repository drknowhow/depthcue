import "./player.css";
import { loadDeck } from "./load.ts";
import { mountPlayer, type Player } from "./player.ts";

/**
 * Entry for a page that shows a deck folder. The page holds `<div id="depthcue" data-deck="." data-live>`:
 * `data-deck` is the folder URL, and `data-live` listens for `/_depthcue/events` to reload on file changes.
 */
async function start(host: HTMLElement) {
  const base = host.dataset.deck ?? ".";
  let player: Player | undefined;
  try {
    const source = await loadDeck(base);
    document.title = source.deck.title;
    player = mountPlayer(host, source);
  } catch (error) {
    host.textContent = `The deck could not be loaded: ${(error as Error).message}`;
    host.classList.add("dc-failed");
    return;
  }

  if (host.dataset.live !== undefined && typeof EventSource === "function") {
    const events = new EventSource("/_depthcue/events");
    events.addEventListener("change", async () => {
      try {
        player?.update(await loadDeck(base));
      } catch {
        // The files can be half-written or briefly invalid while someone edits; keep showing the last good deck.
      }
    });
  }
}

const host = document.getElementById("depthcue");
if (host) void start(host);
