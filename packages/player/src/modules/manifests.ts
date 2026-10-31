import type { ModuleManifest } from "../modules.ts";
import { chartManifest } from "./chart-manifest.ts";

/**
 * What the first-party modules say about themselves. It has no code to load, so the editor can list the modules
 * without pulling any of them in.
 */
export const firstPartyManifests: readonly ModuleManifest[] = [chartManifest];
