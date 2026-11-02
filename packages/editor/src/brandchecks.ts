/**
 * The editor's stand-in for two of core's modules that a deck often does not need: brandcheck.ts, the checks of a deck's
 * brand.json and template files, and builtins.ts, Depthcue's own templates and styles. The editor's build puts this
 * module where core imports either (see vite.config.ts), and fetches the real one as a chunk of its own the first time a
 * deck wants it, so neither is in the script every deck loads.
 *
 * The checks. Until they are in, every check answers with the error `brand-checks-loading` and starts the fetch, so
 * nothing passes unchecked: the store, on that error, waits for the chunk and reads the deck again, and says to reload
 * the page when it does not arrive. `unusedBrand` is core's own from brand.ts.
 *
 * The built-ins. They are data, and the lookups that read them (`templatesOf`, `blockStylesOf`) take them from the two
 * records below as they stand, so the records are empty until `loadBuiltIns` has put the real ones in. A deck that names
 * a template or a style of Depthcue's before then is read as naming one that is not there: the error is
 * `unknown-template` or `unknown-style`, which `waitedForBuiltIns` tells from a deck that really has a wrong id. The
 * store, on it, waits for the chunk and reads the deck again.
 *
 * Tests and the CLI run core's modules themselves.
 */
import type { BlockStyle, Diagnostic, Template } from "@depthcue/core";
import { BRAND_FILE, templatePath } from "../../core/src/brand.ts";
import type * as Checks from "../../core/src/brandcheck.ts";

export type { BrandData, BrandRead, Look } from "../../core/src/brandcheck.ts";

/** The code of the error every check answers with until the real checks are in. */
export const BRAND_CHECKS_LOADING = "brand-checks-loading";

let real: typeof Checks | undefined;

/** Fetches a chunk once. A fetch that failed is tried again by the next call, and rejects unless `quiet`. */
function once(load: () => Promise<void>, quiet = false): () => Promise<void> {
  let fetching: Promise<void> | undefined;
  return () =>
    (fetching ??= load().catch((error: unknown) => {
      fetching = undefined;
      if (!quiet) throw error;
    }));
}

/** Fetches the checks once. */
export const loadBrandChecks = once(() =>
  import("../../core/src/brandcheck.ts").then((module) => {
    real = module;
  }),
);
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

/** Depthcue's own templates, empty until `loadBuiltIns` is done. Core reads this record where it merges a deck's kit. */
export const BUILT_IN_TEMPLATES: Record<string, Template> = {};
/** Depthcue's own component styles, empty until `loadBuiltIns` is done. */
export const BUILT_IN_STYLES: Record<string, BlockStyle> = {};

/**
 * Fetches Depthcue's own templates and styles once, and puts them in the records. It never rejects: a fetch that fails
 * leaves the records empty, which `builtInsLoaded` says, and the next call tries again.
 */
export const loadBuiltIns = once(
  () =>
    import("../../core/src/builtins.ts").then((module) => {
      Object.assign(BUILT_IN_TEMPLATES, module.BUILT_IN_TEMPLATES);
      Object.assign(BUILT_IN_STYLES, module.BUILT_IN_STYLES);
    }),
  true,
);

/** True once the records hold Depthcue's own templates and styles. */
export const builtInsLoaded = (): boolean => Object.keys(BUILT_IN_TEMPLATES).length > 0;

/**
 * True when a deck named a template or a style that is not there and Depthcue's own are not in yet, so the answer may
 * change once they are. Once they are in, the same error is the deck's own.
 */
export const waitedForBuiltIns = (diagnostics: readonly Diagnostic[]): boolean =>
  !builtInsLoaded() && diagnostics.some((d) => d.code === "unknown-template" || d.code === "unknown-style");
/** Has no error to answer with, so it throws until the checks are in. The editor does not call it. */
export const looksOf: typeof Checks.looksOf = (...args) => {
  if (!real) throw new Error("The brand checks are not loaded yet; await loadBrandChecks() first.");
  return real.looksOf(...args);
};
