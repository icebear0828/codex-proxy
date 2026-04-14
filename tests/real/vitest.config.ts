import { defineConfig } from "vitest/config";
import { resolve } from "path";

const projectRoot = resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(projectRoot, "..", "src"),
    },
  },
  test: {
    root: resolve(projectRoot, ".."),
    include: ["tests/real/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 1 } },
    globalSetup: [resolve(__dirname, "global-setup.ts")],
  },
});
