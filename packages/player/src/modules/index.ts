import type { ModuleRegistry } from "../modules.ts";
import { chartManifest } from "./chart-manifest.ts";
import { clipManifest } from "./clip-manifest.ts";

/**
 * The modules that ship with the player. Each loads on its own, only when a block calls for it, so a deck
 * with no chart never downloads the chart code. A chunk is named after its file, and `budgets.json` and the
 * manifest's id use that name.
 */
export const firstPartyModules: ModuleRegistry = [
  { manifest: chartManifest, load: () => import("./chart.ts") },
  { manifest: clipManifest, load: () => import("./clip.ts") },
];
