import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["components/**/*.{ts,tsx}", "lib/**/*.ts"],
      exclude: ["lib/types.ts"],
      reporter: ["text", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
