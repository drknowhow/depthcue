import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, normalizePath, type Plugin } from "vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const coreSource = resolve(source("../core/src"));
// The id the editor's own imports of the module get. A path spelled another way, with backslashes on Windows, would be
// a second copy of the module, with its own idea of whether the checks are in.
const standIn = normalizePath(source("src/brandchecks.ts"));

/**
 * Core's checks of a brand's files, in a chunk of their own that the editor fetches only for a deck with a brand: where
 * core imports brandcheck.ts, the editor's build takes src/brandchecks.ts instead, which loads the real module when a
 * check first asks for it.
 */
const lazyBrandChecks: Plugin = {
  name: "depthcue-lazy-brand-checks",
  enforce: "pre",
  resolveId(id, importer) {
    if (id === "./brandcheck.ts" && importer && resolve(dirname(importer)) === coreSource) {
      return standIn;
    }
    return null;
  },
};

// The editor bundles core and the player's renderer from source, so it never depends on build order and
// carries only the parts it uses.
export default defineConfig({
  plugins: [lazyBrandChecks],
  resolve: {
    alias: {
      "@depthcue/core": source("../core/src/index.ts"),
      "@depthcue/player": source("../player/src/index.ts"),
    },
  },
  build: {
    target: "es2022",
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: { editor: "src/main.ts" },
      formats: ["es"],
      cssFileName: "editor",
    },
    rollupOptions: {
      // The brand checks import the core modules they share with the editor from editor.js, which only works if
      // editor.js may export more than main.ts does. Strict signatures would move those modules to a third file.
      preserveEntrySignatures: "allow-extension",
      output: { chunkFileNames: "[name].js" },
    },
  },
});
