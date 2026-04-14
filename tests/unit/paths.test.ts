/**
 * Tests for centralized path management (src/paths.ts).
 * Uses vi.resetModules() + dynamic imports to isolate module state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "path";

// Each test re-imports the module to get a fresh _paths = null state
async function importPaths() {
  const mod = await import("@src/paths.js");
  return mod;
}

describe("paths — CLI mode (default)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("getRootDir returns process.cwd() by default", async () => {
    const { getRootDir } = await importPaths();
    expect(getRootDir()).toBe(process.cwd());
  });

  it("getConfigDir returns cwd/config by default", async () => {
    const { getConfigDir } = await importPaths();
    expect(getConfigDir()).toBe(resolve(process.cwd(), "config"));
  });

  it("getDataDir returns cwd/data by default", async () => {
    const { getDataDir } = await importPaths();
    expect(getDataDir()).toBe(resolve(process.cwd(), "data"));
  });

  it("getBinDir returns cwd/bin by default", async () => {
    const { getBinDir } = await importPaths();
    expect(getBinDir()).toBe(resolve(process.cwd(), "bin"));
  });

  it("getPublicDir returns cwd/public by default", async () => {
    const { getPublicDir } = await importPaths();
    expect(getPublicDir()).toBe(resolve(process.cwd(), "public"));
  });

  it("isEmbedded returns false by default", async () => {
    const { isEmbedded } = await importPaths();
    expect(isEmbedded()).toBe(false);
  });
});

describe("paths — Electron mode (setPaths)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("setPaths overrides all path getters", async () => {
    const { setPaths, getRootDir, getConfigDir, getDataDir, getBinDir, getPublicDir } = await importPaths();
    setPaths({
      rootDir: "/app",
      configDir: "/app/resources/config",
      dataDir: "/app/data",
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(getRootDir()).toBe("/app");
    expect(getConfigDir()).toBe("/app/resources/config");
    expect(getDataDir()).toBe("/app/data");
    expect(getBinDir()).toBe("/app/bin");
    expect(getPublicDir()).toBe("/app/public");
  });

  it("isEmbedded returns true after setPaths", async () => {
    const { setPaths, isEmbedded } = await importPaths();
    setPaths({
      rootDir: "/app",
      configDir: "/app/config",
      dataDir: "/app/data",
      binDir: "/app/bin",
      publicDir: "/app/public",
    });
    expect(isEmbedded()).toBe(true);
  });

});
