import { memoryDraftStore } from "@depthcue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKS_FAILED, openStore } from "../src/store.ts";
import { FakeServer } from "./helpers.ts";

/*
 * The store when a read of the deck waited for Depthcue's own templates, as the editor's build does until their chunk is
 * in (the tests themselves run core's modules, which have no chunk to wait on, so the wait is made here). `loadBuiltIns`
 * never rejects: a fetch that failed leaves the records empty, so the read is still waiting after it, and the store says
 * to reload the page instead of showing the deck's own error.
 */
const built = vi.hoisted(() => ({ arrives: false, loaded: false, loads: 0 }));

vi.mock("../src/brandchecks.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/brandchecks.ts")>()),
  waitedForBuiltIns: () => !built.loaded,
  loadBuiltIns: async () => {
    built.loads += 1;
    if (built.arrives) built.loaded = true;
  },
}));

beforeEach(() => {
  built.arrives = false;
  built.loaded = false;
  built.loads = 0;
});

describe("Depthcue's own templates that the editor cannot fetch", () => {
  it("stop a deck from opening, saying to reload the page", async () => {
    await expect(openStore(new FakeServer(), () => memoryDraftStore())).rejects.toThrow(CHECKS_FAILED);
    expect(built.loads).toBe(1);
  });

  it("let the deck open once they arrive", async () => {
    built.arrives = true;
    const store = await openStore(new FakeServer(), () => memoryDraftStore());
    try {
      expect(built.loads).toBe(1);
      expect(store.session.doc.deck.id).toBeTruthy();
    } finally {
      store.dispose();
    }
  });
});
