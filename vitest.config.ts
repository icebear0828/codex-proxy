import { defineConfig } from "vitest/config";
import { resolve } from "path";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@src": resolve(__dirname, "src"),
      "@helpers": resolve(__dirname, "tests/_helpers"),
      "@fixtures": resolve(__dirname, "tests/_fixtures"),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.ts",
      "tests/unit/**/*.{test,spec}.ts",
      "tests/integration/**/*.{test,spec}.ts",
      "tests/e2e/**/*.{test,spec}.ts",
      "packages/electron/__tests__/**/*.{test,spec}.ts",
    ],
  },
});
