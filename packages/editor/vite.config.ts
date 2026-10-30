import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The editor bundles core and the player's renderer from source, so it never depends on build order and
// carries only the parts it uses.
export default defineConfig({
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
    rollupOptions: { output: { chunkFileNames: "[name].js" } },
  },
});
