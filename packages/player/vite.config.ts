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
    rollupOptions: { output: { chunkFileNames: "[name].js" } },
  },
});
