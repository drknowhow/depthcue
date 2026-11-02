import { memoryDraftStore } from "@depthcue/core";
import { describe, expect, it, vi } from "vitest";
import { builtInsLoaded } from "../src/brandchecks.ts";
import { openStore } from "../src/store.ts";
import { FakeServer, retitle } from "./helpers.ts";

// helpers.ts fetches every lazy part before the tests, and the brand part brings Depthcue's own templates with it. This
// file starts without them, so it keeps the parts out.
vi.mock("../src/lazy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lazy.ts")>()),
  loadParts: async () => undefined,
}));

// Its own file: the stand-in's records are module state, and a test that ran before this one would have filled them.
describe("a review and Depthcue's own templates", () => {
  it("fetches them with the review, for a reviewed deck that names one the deck now does not", async () => {
    const server = new FakeServer();
    const store = await openStore(server, () => memoryDraftStore());
    try {
      await store.review.sync();
      // A deck nobody has started to review has no baseline that could name one.
      expect(store.review.state).toMatchObject({ review: undefined, ready: true });
      expect(builtInsLoaded()).toBe(false);

      server.agentEdit([retitle("A better title")]);
      await store.syncFromDisk();
      await store.review.sync();
      expect(store.review.state.review).toBeDefined();
      // The chunk is in before the review can be used, so an accept or a revert that brings the template back finds it.
      expect(builtInsLoaded()).toBe(true);
    } finally {
      store.dispose();
    }
  });
});
