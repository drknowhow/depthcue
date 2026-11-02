// @vitest-environment node
// The editor's build swaps core's brandcheck.ts and builtins.ts for src/brandchecks.ts. The id it answers must be the one the editor's
// own imports of the stand-in get, or the build carries two copies of it, each with its own idea of whether the checks
// are in. Windows importers come with backslashes, so that case runs here on every machine, CI's Linux included.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lazyBrandChecks, lazyBuiltIns, standIn } from "../vite.config.ts";

const coreSource = fileURLToPath(new URL("../../core/src", import.meta.url)).replaceAll("\\", "/");
const windows = (path: string) => path.replaceAll("/", "\\");

describe("the lazy brand checks plugin", () => {
  it("answers one forward-slash id for core's import of brandcheck.ts, with either kind of slash", () => {
    expect(standIn).not.toContain("\\");
    expect(standIn.endsWith("/packages/editor/src/brandchecks.ts")).toBe(true);
    for (const importer of [`${coreSource}/brand.ts`, windows(`${coreSource}/brand.ts`)]) {
      expect(lazyBrandChecks.resolveId("./brandcheck.ts", importer)).toBe(standIn);
    }
  });

  it("leaves every other import alone", () => {
    expect(lazyBrandChecks.resolveId("./brand.ts", `${coreSource}/index.ts`)).toBeNull();
    expect(lazyBrandChecks.resolveId("./brandcheck.ts", undefined)).toBeNull();
    const elsewhere = coreSource.replace(/core\/src$/, "editor/src");
    expect(lazyBrandChecks.resolveId("./brandcheck.ts", `${elsewhere}/store.ts`)).toBeNull();
    expect(lazyBrandChecks.resolveId("./brandcheck.ts", windows(`${coreSource}/sub/brand.ts`))).toBeNull();
  });
});

describe("the lazy built-ins plugin", () => {
  it("answers the same stand-in for core's import of builtins.ts, with either kind of slash", () => {
    for (const importer of [`${coreSource}/brand.ts`, windows(`${coreSource}/index.ts`)]) {
      expect(lazyBuiltIns.resolveId("./builtins.ts", importer)).toBe(standIn);
    }
  });

  it("leaves every other import alone, and the brand checks' alone too", () => {
    expect(lazyBuiltIns.resolveId("./brand.ts", `${coreSource}/index.ts`)).toBeNull();
    expect(lazyBuiltIns.resolveId("./brandcheck.ts", `${coreSource}/brand.ts`)).toBeNull();
    expect(lazyBrandChecks.resolveId("./builtins.ts", `${coreSource}/brand.ts`)).toBeNull();
    expect(lazyBuiltIns.resolveId("./builtins.ts", undefined)).toBeNull();
    const elsewhere = coreSource.replace(/core\/src$/, "editor/src");
    expect(lazyBuiltIns.resolveId("./builtins.ts", `${elsewhere}/brandchecks.ts`)).toBeNull();
    expect(lazyBuiltIns.resolveId("./builtins.ts", windows(`${coreSource}/sub/brand.ts`))).toBeNull();
  });
});
