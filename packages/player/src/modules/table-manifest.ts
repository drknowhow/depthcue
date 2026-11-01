import type { ModuleManifest } from "../modules.ts";

export const tableManifest: ModuleManifest = {
  id: "table",
  title: "Table row marker",
  fallback: "a plain table",
  version: "1.0",
  blocks: ["table"],
  activation: "idle",
  budgetBytes: 3072,
  export: "static",
  commands: {
    highlight: 'Mark one row and read it out. Args: {"row": 0}, counting data rows from 0, not the header.',
    clear: "Take the mark off. No args.",
  },
};
