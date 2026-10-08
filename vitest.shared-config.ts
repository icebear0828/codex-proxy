import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "path";

const projectRoot = __dirname;

export const rootTestIncludes = [
  "shared/**/*.{test,spec}.ts",
  "tests/unit/**/*.{test,spec}.ts",
  "tests/integration/**/*.{test,spec}.ts",
  "tests/contract/**/*.{test,spec}.ts",
  "tests/e2e/**/*.{test,spec}.ts",
  "packages/electron/__tests__/**/*.{test,spec}.ts",
];

export function createVitestConfig(options: { exclude?: string[] } = {}) {
  return defineConfig({
    resolve: {
      alias: {
        "@src": resolve(projectRoot, "src"),
        "@helpers": resolve(projectRoot, "tests/_helpers"),
        "@fixtures": resolve(projectRoot, "tests/_fixtures"),
      },
    },
    test: {
      environment: "node",
      include: rootTestIncludes,
      exclude: [...configDefaults.exclude, ...(options.exclude ?? [])],
    },
  });
}

export function createPlatformVitestConfig(platform: "windows" | "linux") {
  const expectedNodePlatform = platform === "windows" ? "win32" : "linux";
  if (process.platform !== expectedNodePlatform) {
    throw new Error(`The ${platform} suite must run on ${expectedNodePlatform}; current host is ${process.platform}`);
  }

  return createVitestConfig({
    exclude: platform === "windows"
      ? [
          "packages/electron/__tests__/build.test.ts",
          "packages/electron/__tests__/prepare-pack.test.ts",
          "packages/electron/__tests__/release-pipeline.test.ts",
        ]
      : [],
  });
}
