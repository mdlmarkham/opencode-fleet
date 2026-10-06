import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests that load the whole plugin entry take seconds under load; the 5s default flaked (#158, #165, #204).
    testTimeout: 30_000,
  },
});
