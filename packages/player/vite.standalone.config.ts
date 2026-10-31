import { defineConfig } from "vite";

// The exported deck's script: one classic file with every module inside it, because a page opened from a
// folder cannot load a module script. It lands beside the player's own build and does not empty it.
export default defineConfig({
  build: {
    target: "es2022",
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    outDir: "dist/standalone",
    emptyOutDir: true,
    lib: {
      entry: "src/standalone.ts",
      formats: ["iife"],
      name: "Depthcue",
      fileName: () => "depthcue.js",
      cssFileName: "depthcue",
    },
  },
});
