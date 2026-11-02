import { builtInsLoaded, loadBrandChecks, loadBuiltIns } from "./brandchecks.ts";

/**
 * Parts of the editor that most sessions never open. Each is a chunk of its own that is fetched the first time it is
 * wanted; once it is in, `ready` holds it and using it is as quick as anything else. A fetch that fails is said in plain
 * words where the person is looking, the rest of the editor goes on working, and the next use tries again.
 */
export interface Part<T> {
  /** The part's module, once it is in. */
  readonly ready: T | undefined;
  /** Fetches the part once and answers with it, or with undefined when it did not arrive. */
  load(): Promise<T | undefined>;
}

export function part<T>(fetch: () => Promise<T>): Part<T> {
  let ready: T | undefined;
  let loading: Promise<T | undefined> | undefined;
  return {
    get ready() {
      return ready;
    },
    load: () =>
      (loading ??= fetch().then(
        (module) => (ready = module),
        () => (loading = undefined),
      )),
  };
}

/** What the person reads when a part did not arrive. */
export const notLoaded = (what: string) =>
  `Could not load ${what}. Check that depthcue edit is still running, then try again.`;

/** Runs `then` with the part at once when it is in, or when it arrives. `failed` runs when it does not. */
export function withPart<T>(from: Part<T>, then: (module: T) => void, failed: () => void): void {
  const { ready } = from;
  if (ready) then(ready);
  else void from.load().then((module) => (module ? then(module) : failed()));
}

/** The parts, by name. `mountEditor` takes others in their place, so a test can hold one back or make it fail. */
export const PARTS = {
  review: part(() => import("./reviewdrawer.ts")),
  storyboard: part(() => import("./storyboard.ts")),
  comments: part(() => import("./commentpins.ts")),
  cues: part(() => import("./cuespanel.ts")),
  pptx: part(() => import("./pptxdownload.ts")),
  // The picker, the slots and the styles list Depthcue's own templates and styles too, so they wait for those as well.
  brand: part(() =>
    Promise.all([import("./branduse.ts"), loadBuiltIns()]).then(([module]) => {
      if (!builtInsLoaded()) throw new Error("Depthcue's own templates and styles did not arrive.");
      return module;
    }),
  ),
  // Defining the brand: the Brand panel, Save as template and the template editor. They check colors as they are
  // chosen, so they wait for the brand checks as well.
  define: part(() =>
    Promise.all([import("./branddefine.ts"), loadBuiltIns(), loadBrandChecks()]).then(([module]) => {
      if (!builtInsLoaded()) throw new Error("Depthcue's own templates and styles did not arrive.");
      return module;
    }),
  ),
};

export type Parts = typeof PARTS;

/** Fetches every part, as a session that has used them all has. The editor's tests start from there. */
export const loadParts = (): Promise<unknown> =>
  Promise.all(Object.values(PARTS).map((entry) => entry.load()));
