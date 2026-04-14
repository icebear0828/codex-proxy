import { defineConfig } from "vitest/config";
import { resolve } from "path";

const projectRoot = resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(projectRoot, "src"),
      "@helpers": resolve(__dirname, "_helpers"),
      "@fixtures": resolve(__dirname, "_fixtures"),
    },
  },
  test: {
    root: projectRoot,
    include: ["tests/stress/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 1 } },
  },
});
