/**
 * Validates electron-builder.yml configuration.
 *
 * Ensures all referenced files/directories exist and the config
 * is structurally valid — catches the kind of path issues that
 * have historically broken electron releases.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

const PKG_DIR = resolve(import.meta.dirname, "..");
const ROOT_DIR = resolve(PKG_DIR, "..", "..");

interface BuilderConfig {
  appId: string;
  productName: string;
  electronVersion: string;
  publish: { provider: string; owner: string; repo: string };
  directories: { output: string };
  files: Array<string | { from: string; to: string; filter?: string[] }>;
  asarUnpack: string[];
  extraResources: Array<{ from: string; to: string; filter?: string[] }>;
  win: { target: Array<{ target: string; arch: string[] }>; icon: string };
  mac: { target: Array<{ target: string; arch: string[] }>; icon: string };
  linux: { target: Array<{ target: string; arch: string[] }>; icon: string };
}

const config = yaml.load(
  readFileSync(resolve(PKG_DIR, "electron-builder.yml"), "utf-8"),
) as BuilderConfig;

describe("electron-builder.yml", () => {
  it("has valid YAML structure", () => {
    expect(config.appId).toBe("com.codex-proxy.app");
    expect(config.productName).toBe("Codex Proxy");
    expect(config.electronVersion).toBeDefined();
  });

  it("has valid publish config", () => {
    expect(config.publish.provider).toBe("github");
    expect(config.publish.owner).toBeDefined();
    expect(config.publish.repo).toBeDefined();
  });

  it("references existing icon file", () => {
    const iconPath = resolve(PKG_DIR, config.mac.icon);
    expect(existsSync(iconPath)).toBe(true);
  });

  it("icon file is referenced consistently across platforms", () => {
    expect(config.win.icon).toBe(config.mac.icon);
    expect(config.linux.icon).toBe(config.mac.icon);
  });

  it("files list includes dist-electron bundle", () => {
    const hasDistElectron = config.files.some(
      (f) => typeof f === "string" && f.includes("dist-electron"),
    );
    expect(hasDistElectron).toBe(true);
  });

  it("files list includes config and public globs", () => {
    // After prepare-pack copies root dirs into packages/electron/,
    // electron-builder picks them up via simple glob patterns
    const globs = config.files.filter((f): f is string => typeof f === "string");
    expect(globs).toContain("config/**/*");
    expect(globs).toContain("public/**/*");
  });

  it("root source directories for prepare-pack actually exist", () => {
    // prepare-pack.mjs copies these from root before packing
    const requiredDirs = ["config", "public", "bin"];
    for (const dir of requiredDirs) {
      const rootPath = resolve(ROOT_DIR, dir);
      expect(
        existsSync(rootPath),
        `Root directory ${dir}/ should exist at ${rootPath}`,
      ).toBe(true);
    }
  });

  it("extraResources bin/ maps to correct root directory", () => {
    const binResource = config.extraResources.find(
      (r) => r.to === "bin/" || r.to === "bin",
    );
    expect(binResource).toBeDefined();
    // bin/ is copied from root by prepare-pack before packing
    const rootBin = resolve(ROOT_DIR, "bin");
    expect(
      existsSync(rootBin),
      `Root bin/ directory should exist at ${rootBin}`,
    ).toBe(true);
  });

  it("extraResources native/ maps to correct root directory", () => {
    const nativeResource = config.extraResources.find(
      (r) => r.to === "native/" || r.to === "native",
    );
    expect(nativeResource).toBeDefined();
    // native/ is copied from root by prepare-pack before packing
    const rootNative = resolve(ROOT_DIR, "native");
    expect(
      existsSync(rootNative),
      `Root native/ directory should exist at ${rootNative}`,
    ).toBe(true);
  });

  it("root native/ contains required runtime files", () => {
    const rootNative = resolve(ROOT_DIR, "native");
    expect(existsSync(resolve(rootNative, "index.js"))).toBe(true);
    expect(existsSync(resolve(rootNative, "package.json"))).toBe(true);
  });

  it("asarUnpack includes all runtime directories", () => {
    const unpacked = config.asarUnpack;
    expect(unpacked).toContain("config/**/*");
    expect(unpacked).toContain("public/**/*");
  });

  it("electronVersion matches installed version", () => {
    const installedPkg = resolve(
      ROOT_DIR,
      "node_modules",
      "electron",
      "package.json",
    );
    if (existsSync(installedPkg)) {
      const installed = JSON.parse(readFileSync(installedPkg, "utf-8")) as {
        version: string;
      };
      expect(config.electronVersion).toBe(installed.version);
    }
  });

  it("package.json has required fields for electron-builder", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(PKG_DIR, "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBeDefined();
    expect(pkg.version).toBeDefined();
    expect(pkg.description).toBeDefined();
    expect(pkg.main).toBe("dist-electron/main.cjs");
  });
});
