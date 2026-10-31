import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@depthcue/core": root("packages/core/src/index.ts"),
      "@depthcue/player": root("packages/player/src/index.ts"),
      "@depthcue/cli/deck-api": root("packages/cli/src/deck-api.ts"),
      "@depthcue/cli/render": root("packages/cli/src/render.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tools/**/*.test.mjs", "brand/**/*.test.mjs"],
    // The browser tests share the machine with every other test file, and a window-to-window round trip in
    // Chrome has taken longer than the 1 s poll and 5 s test defaults. A real hang still fails, just later.
    testTimeout: 20_000,
    expect: { poll: { timeout: 10_000 } },
  },
});
