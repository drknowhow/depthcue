import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    minify: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: { index: "src/index.ts", app: "src/app.ts" },
      formats: ["es"],
      cssFileName: "player",
    },
    // A fixed chunk name lets budgets.json point at the shared player code.
    // A chunk of the table helpers alone (src/table.ts, which the scene drawing shares with the table module) is named
    // apart, so it never takes `table.js` from the table module, which a deck without a table must not load.
    rollupOptions: {
      output: {
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => /[\\/]src[\\/]table\.ts$/.test(id)) &&
          !chunk.moduleIds.some((id) => /[\\/]modules[\\/]/.test(id))
            ? "table-format.js"
            : "[name].js",
      },
    },
  },
});
