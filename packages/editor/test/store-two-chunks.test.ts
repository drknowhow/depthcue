import { type Diagnostic, memoryDraftStore } from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRAND_CHECKS_LOADING } from "../src/brandchecks.ts";
import { CHECKS_FAILED, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

/*
 * A deck with a brand that gives a block one of Depthcue's own styles waits for two chunks in the editor's build, one
 * after the other: the first read stops at the brand checks, and only the read after them reaches the style, which is
 * unknown until Depthcue's own are in. The tests run core's modules, which wait for nothing, so the waits are made here:
 * the store's reads, the ones that name the brand's files, answer as the build's would.
 */
const chunks = vi.hoisted(() => ({
  checks: false,
  builtIns: false,
  checkLoads: 0,
  builtInLoads: 0,
  fail: false,
}));

vi.mock("@depthcue/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@depthcue/core")>();
  const waiting = (code: string) => ({
    doc: undefined,
    diagnostics: [{ code, severity: "error", message: code, path: "/" } as unknown as Diagnostic],
  });
  return {
    ...core,
    loadDoc: (files: Parameters<typeof core.loadDoc>[0]) => {
      if (!("brandFiles" in files)) return core.loadDoc(files);
      if (!chunks.checks) return waiting("brand-checks-loading");
      if (!chunks.builtIns) return waiting("unknown-style");
      return core.loadDoc(files);
    },
  };
});

vi.mock("../src/brandchecks.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/brandchecks.ts")>()),
  loadBrandChecks: async () => {
    chunks.checkLoads += 1;
    chunks.checks = true;
  },
  loadBuiltIns: async () => {
    chunks.builtInLoads += 1;
    if (!chunks.fail) chunks.builtIns = true;
  },
  waitedForBuiltIns: (diagnostics: readonly Diagnostic[]) =>
    !chunks.builtIns && diagnostics.some((d) => d.code === "unknown-style"),
}));

// helpers.ts fetches the editor's lazy parts before the tests, and the brand part would load Depthcue's own here.
vi.mock("../src/lazy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lazy.ts")>()),
  loadParts: async () => undefined,
}));

beforeEach(() => {
  Object.assign(chunks, { checks: false, builtIns: false, checkLoads: 0, builtInLoads: 0, fail: false });
});

describe("a deck that waits for the brand checks and then for Depthcue's own styles", () => {
  it("opens once both are in, each fetched once", async () => {
    expect(BRAND_CHECKS_LOADING).toBe("brand-checks-loading");
    const store = await openStore(new FakeServer(), () => memoryDraftStore());
    try {
      expect([chunks.checkLoads, chunks.builtInLoads]).toEqual([1, 1]);
      expect(store.session.doc.deck.id).toBeTruthy();
    } finally {
      store.dispose();
    }
  });

  it("says to reload the page when the second does not arrive", async () => {
    chunks.fail = true;
    await expect(openStore(new FakeServer(), () => memoryDraftStore())).rejects.toThrow(CHECKS_FAILED);
    expect([chunks.checkLoads, chunks.builtInLoads]).toEqual([1, 1]);
  });
});
