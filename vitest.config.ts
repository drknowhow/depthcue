import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@depthcue/core": root("packages/core/src/index.ts") },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/**/*.test.mjs", "brand/**/*.test.mjs"],
  },
});
