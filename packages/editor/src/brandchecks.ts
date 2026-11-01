/**
 * The editor's stand-in for core's brandcheck.ts, the checks of a deck's brand.json and template files. A deck without
 * a brand never runs them, so the editor's build puts this module where core imports brandcheck.ts (see vite.config.ts)
 * and fetches the real one, as a chunk of its own, the first time a check is wanted. Until it is in, every check answers
 * with the error `brand-checks-loading` and starts the fetch, so nothing passes unchecked: the store, on that error,
 * waits for the chunk and reads the deck again, and says to reload the page when it does not arrive. `unusedBrand` is
 * core's own from brand.ts. Tests and the CLI run core's module itself.
 */
import type { Diagnostic } from "@depthcue/core";
import { BRAND_FILE, templatePath } from "../../core/src/brand.ts";
import type * as Checks from "../../core/src/brandcheck.ts";

export type { BrandData, BrandRead, Look } from "../../core/src/brandcheck.ts";

/** The code of the error every check answers with until the real checks are in. */
export const BRAND_CHECKS_LOADING = "brand-checks-loading";

let real: typeof Checks | undefined;
let fetching: Promise<void> | undefined;

/** Fetches the checks once. A fetch that failed is tried again by the next call. */
export function loadBrandChecks(): Promise<void> {
  fetching ??= import("../../core/src/brandcheck.ts").then(
    (module) => {
      real = module;
    },
    (error: unknown) => {
      fetching = undefined;
      throw error;
    },
  );
  return fetching;
}

/** True when a check answered that it had to wait for the brand checks, so its answer is still to come. */
export const waitedForBrandChecks = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((d) => d.code === BRAND_CHECKS_LOADING);

function waiting(file: string): Diagnostic {
  loadBrandChecks().catch(() => {}); // the next check starts it again
  return {
    severity: "error",
    code: BRAND_CHECKS_LOADING,
    file,
    path: "",
    message: "The editor is still loading its checks of the deck's brand.",
    fix: "Try again in a moment.",
  };
}

export const readBrand: typeof Checks.readBrand = (...args) =>
  real ? real.readBrand(...args) : { diagnostics: [waiting(BRAND_FILE)] };

export const checkBrand: typeof Checks.checkBrand = (...args) =>
  real ? real.checkBrand(...args) : [waiting(BRAND_FILE)];

export const checkBrandFile: typeof Checks.checkBrandFile = (...args) =>
  real ? real.checkBrandFile(...args) : [waiting(args[1] ?? BRAND_FILE)];

export const checkTemplateFile: typeof Checks.checkTemplateFile = (...args) =>
  real ? real.checkTemplateFile(...args) : [waiting(args[2] ?? templatePath(args[1]))];

export const checkTemplate: typeof Checks.checkTemplate = (...args) =>
  real ? real.checkTemplate(...args) : [waiting(args[4])];

/** Core's own, from brand.ts: a deck without a brand needs it, at the severity it asks for, with no chunk to wait on. */
export { unusedBrand } from "../../core/src/brand.ts";

/** Has no error to answer with, so it throws until the checks are in. The editor does not call it. */
export const looksOf: typeof Checks.looksOf = (...args) => {
  if (!real) throw new Error("The brand checks are not loaded yet; await loadBrandChecks() first.");
  return real.looksOf(...args);
};
