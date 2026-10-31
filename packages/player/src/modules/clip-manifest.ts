import type { ModuleManifest } from "../modules.ts";

export const clipManifest: ModuleManifest = {
  id: "clip",
  title: "Clip cue points",
  fallback: "a plain video",
  version: "1.0",
  blocks: ["clip"],
  activation: "visible",
  budgetBytes: 3072,
  export: "static",
  commands: {
    seek: 'Move the clip to a cue and leave it paused. Args: {"cue": "title"}, an id from the clip\'s cue map.',
    play: 'Play the clip, from a cue if one is named. Args: {} or {"cue": "title"}.',
    pause: "Pause the clip. No args.",
  },
};
