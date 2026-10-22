import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // The ledger, saga and Ramp suites each boot PGlite, an in-process
    // Postgres. Twenty-odd files doing that in parallel puts the first test in
    // a file well past vitest's 5s default, so the timeout is the harness
    // warming up rather than anything being slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
