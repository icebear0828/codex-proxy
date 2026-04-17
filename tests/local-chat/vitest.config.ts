import { defineConfig } from "vitest/config";
import { resolve } from "path";

const projectRoot = resolve(__dirname, "..", "..");

export default defineConfig({
  resolve: {
    alias: {
      "@src": resolve(projectRoot, "src"),
      "@helpers": resolve(projectRoot, "tests", "_helpers"),
      "@fixtures": resolve(projectRoot, "tests", "_fixtures"),
    },
  },
  test: {
    root: projectRoot,
    include: ["tests/local-chat/**/*.{test,spec}.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 1 } },
  },
});
