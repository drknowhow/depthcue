import "./player.css";
import { EXPORT_FORMAT, type ExportData } from "@depthcue/core";
import type { PlayerSource } from "./load.ts";
import { firstPartyModules } from "./modules/index.ts";
import { mountPlayer } from "./player.ts";

/**
 * Entry for an exported deck, built as one classic script. Chrome will not load a module script or answer a
 * `fetch` for a page opened from a folder, so this bundle holds every module and takes the deck from the page:
 * `<script type="application/json" id="depthcue-data">` carries an `ExportData`, and assets resolve beside the page.
 * It has no live reload, no lease and no presenter view, and it never makes a request for the deck itself.
 */
function start(host: HTMLElement) {
  try {
    const script = document.getElementById("depthcue-data");
    if (!script) throw new Error("The page has no deck data.");
    const data = JSON.parse(script.textContent ?? "") as Partial<ExportData>;
    if (data.format !== EXPORT_FORMAT || !data.deck || !Array.isArray(data.scenes)) {
      throw new Error("The deck data is not in a format this page understands.");
    }
    const source: PlayerSource = {
      deck: data.deck,
      scenes: data.scenes,
      assetBase: ".",
      files: data.files ?? {},
    };
    document.title = source.deck.title;
    const player = mountPlayer(host, source, { modules: firstPartyModules });
    // Tools that drive the page, such as the renderer, wait on `settled()` and run module commands through it.
    Object.defineProperty(window, "depthcue", { value: player, configurable: true });
  } catch (error) {
    host.textContent = `The deck could not be shown: ${(error as Error).message}`;
    host.classList.add("dc-failed");
  }
}

const host = document.getElementById("depthcue");
if (host) start(host);
