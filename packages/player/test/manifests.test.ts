import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ID_PATTERN } from "@depthcue/core";
import { describe, expect, it } from "vitest";
import { firstPartyModules } from "../src/modules/index.ts";
import { firstPartyManifests } from "../src/modules/manifests.ts";

const budgets = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../budgets.json"), "utf8")) as {
  budgets: Array<{ name: string; file: string; metric: string; limitBytes: number }>;
};

describe("the first-party modules", () => {
  it("are listed once for the editor and once, with their code, for the player", () => {
    expect(firstPartyModules.map((entry) => entry.manifest)).toEqual([...firstPartyManifests]);
  });

  it("each have a usable manifest", () => {
    const ids = new Set<string>();
    for (const manifest of firstPartyManifests) {
      expect(manifest.id, manifest.id).toMatch(new RegExp(ID_PATTERN));
      expect(ids.has(manifest.id), `${manifest.id} is listed twice`).toBe(false);
      ids.add(manifest.id);
      expect(manifest.title.trim(), manifest.id).not.toBe("");
      expect(manifest.version, manifest.id).toMatch(/^\d+\.\d+$/);
      expect(manifest.blocks.length, manifest.id).toBeGreaterThan(0);
      expect(["visible", "idle"]).toContain(manifest.activation);
      expect(manifest.budgetBytes, manifest.id).toBeGreaterThan(0);
      for (const [name, help] of Object.entries(manifest.commands)) {
        expect(name, manifest.id).toMatch(/^[a-z][a-zA-Z]*$/);
        expect(help.trim(), `${manifest.id}.${name}`).not.toBe("");
      }
    }
  });

  it("never claim the same block type, so a block has one module", () => {
    const claimed = firstPartyManifests.flatMap((manifest) => manifest.blocks);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("each have a row in budgets.json at the size the manifest promises", () => {
    for (const manifest of firstPartyManifests) {
      const row = budgets.budgets.find((budget) => budget.name === `module ${manifest.id}`);
      expect(
        row,
        `Add a "module ${manifest.id}" row to budgets.json; a module may not skip its budget.`,
      ).toBeDefined();
      expect(row?.file).toBe(`packages/player/dist/${manifest.id}.js`);
      expect(row?.metric).toBe("brotli");
      expect(row?.limitBytes).toBe(manifest.budgetBytes);
    }
  });
});
