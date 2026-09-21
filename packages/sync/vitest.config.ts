import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
    // This package is proven by its integration suite; there is nothing to unit
    // test that is not composition. An empty unit run must not read as failure.
    passWithNoTests: true,
    coverage: { provider: "v8", include: ["src/**"], exclude: ["src/index.ts"] },
  },
});
