import type { ModuleManifest } from "../modules.ts";

export const chartManifest: ModuleManifest = {
  id: "chart",
  title: "Explorable charts",
  fallback: "a plain chart",
  version: "1.0",
  blocks: ["bar-chart"],
  activation: "visible",
  budgetBytes: 3072,
  export: "static",
  commands: {
    highlight: 'Mark one row and read it out. Args: {"row": 0}, counting rows as they are in the data.',
    sort: 'Order the rows. Args: {"by": "value"} for largest first, or {"by": "original"}.',
    clear: "Take the mark off. No args.",
  },
};
