import type { ModuleRegistry } from "../modules.ts";
import { chartManifest } from "./chart-manifest.ts";

/**
 * The modules that ship with the player. Each loads on its own, only when a block calls for it, so a deck
 * with no chart never downloads the chart code.
 */
export const firstPartyModules: ModuleRegistry = [
  { manifest: chartManifest, load: () => import("./chart.ts") },
];
