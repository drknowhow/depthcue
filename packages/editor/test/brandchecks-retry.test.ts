import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_STYLES, BUILT_IN_TEMPLATES, builtInsLoaded, loadBuiltIns } from "../src/brandchecks.ts";

// Its own file: the fetch of Depthcue's own templates fails the first two times, as a browser's does when the network
// drops or the server has a newer build, and the stand-in's records are module state. Core's own modules import the
// built-ins statically, so the module cannot fail to load here; it throws when the stand-in reads its templates, which
// is the same to `loadBuiltIns`: the promise of the fetch rejects.
const fetches = vi.hoisted(() => ({ made: 0, failures: 2 }));

vi.mock("../../core/src/builtins.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/src/builtins.ts")>();
  return {
    ...real,
    get BUILT_IN_TEMPLATES() {
      fetches.made += 1;
      if (fetches.made <= fetches.failures) {
        throw new TypeError("Failed to fetch dynamically imported module: builtins.js");
      }
      return real.BUILT_IN_TEMPLATES;
    },
  };
});

describe("fetching Depthcue's own templates and styles when the fetch fails", () => {
  it("resolves, with the records empty, and lets a later call try again", async () => {
    await expect(loadBuiltIns()).resolves.toBeUndefined();
    expect(builtInsLoaded()).toBe(false);
    expect(BUILT_IN_TEMPLATES).toEqual({});
    expect(BUILT_IN_STYLES).toEqual({});
    expect(fetches.made).toBe(1);

    // The failure is not kept: the next call fetches again, and fails again, still without rejecting.
    await expect(loadBuiltIns()).resolves.toBeUndefined();
    expect(fetches.made).toBe(2);
    expect(builtInsLoaded()).toBe(false);

    // The third fetch arrives, and puts them in.
    await expect(loadBuiltIns()).resolves.toBeUndefined();
    expect(fetches.made).toBe(3);
    expect(builtInsLoaded()).toBe(true);
    const real = await vi.importActual<typeof import("../../core/src/builtins.ts")>(
      "../../core/src/builtins.ts",
    );
    expect(BUILT_IN_TEMPLATES).toEqual(real.BUILT_IN_TEMPLATES);
    expect(BUILT_IN_STYLES).toEqual(real.BUILT_IN_STYLES);

    // Once they are in, no call fetches again.
    await loadBuiltIns();
    expect(fetches.made).toBe(3);
  });
});
