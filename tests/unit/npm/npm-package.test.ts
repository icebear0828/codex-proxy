import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const STAGE_SCRIPT = resolve(ROOT, "scripts", "npm", "stage-npm-packages.mjs");
const LOADER = readFileSync(resolve(ROOT, "native", "index.js"), "utf8");
const TEMPLATE = JSON.parse(
  readFileSync(resolve(ROOT, "packages", "npm", "package.json"), "utf-8"),
) as Record<string, unknown>;

// The staging script is plain ESM with no dependencies; import its exported
// tables directly so this test cannot drift from what CI actually stages.
type AddonPackage = {
  name: string;
  os: "win32" | "darwin" | "linux";
  cpu: "x64" | "arm64";
  libc: "glibc" | "musl" | null;
  file: string;
};
type StageModule = {
  ADDON_PACKAGES: AddonPackage[];
  MAIN_PACKAGE_NAME: string;
  buildMainManifest: (template: unknown, version: string) => unknown;
  buildAddonManifest: (addon: AddonPackage, version: string) => unknown;
};
const { ADDON_PACKAGES, MAIN_PACKAGE_NAME, buildMainManifest, buildAddonManifest } =
  (await import(STAGE_SCRIPT)) as StageModule;

const loaderFallbacks = new Set(
  [...LOADER.matchAll(/require\('(codex-tls-[^']+)'\)/g)].map((match) => match[1]),
);

describe("npm distribution staging", () => {
  it("publishes an addon package for every loader fallback we claim to support", () => {
    // Every platform package name must be a name the generated loader can
    // require() when the local .node file is absent — otherwise the addon
    // would never be picked up from the optional dependency install.
    for (const addon of ADDON_PACKAGES) {
      expect(loaderFallbacks.has(addon.name), addon.name).toBe(true);
    }
  });

  it("names addon packages and files after the loader's triple convention", () => {
    for (const addon of ADDON_PACKAGES) {
      const triple = addon.name.replace("codex-tls-", "");
      expect(addon.file).toBe(`codex-tls.${triple}.node`);
    }
  });

  it("declares valid npm platform fields", () => {
    for (const addon of ADDON_PACKAGES) {
      expect(["win32", "darwin", "linux"]).toContain(addon.os);
      expect(["x64", "arm64"]).toContain(addon.cpu);
      if (addon.os === "linux") {
        expect(["glibc", "musl"]).toContain(addon.libc);
      } else {
        expect(addon.libc).toBeNull();
      }
    }
  });

  it("covers the platforms codex-proxy ships today", () => {
    const names = ADDON_PACKAGES.map((addon) => addon.name).sort();
    expect(names).toEqual([
      "codex-tls-darwin-arm64",
      "codex-tls-darwin-x64",
      "codex-tls-linux-arm64-gnu",
      "codex-tls-linux-arm64-musl",
      "codex-tls-linux-x64-gnu",
      "codex-tls-linux-x64-musl",
      "codex-tls-win32-arm64-msvc",
      "codex-tls-win32-x64-msvc",
    ]);
    // The main package's os/cpu filter allows exactly these os+cpu pairs —
    // every installable platform must have an addon, or the loader hard-fails
    // at startup (there is no no-addon fallback).
    expect(new Set(ADDON_PACKAGES.map((a) => `${a.os}/${a.cpu}`))).toEqual(
      new Set(["win32/x64", "win32/arm64", "linux/x64", "linux/arm64", "darwin/x64", "darwin/arm64"]),
    );
  });

  it("wires every addon package into the main manifest as an exact optional dependency", () => {
    const version = "9.9.9";
    const manifest = buildMainManifest(TEMPLATE, version) as Record<string, any>;
    expect(manifest.version).toBe(version);
    const optional = manifest.optionalDependencies as Record<string, string>;
    expect(Object.keys(optional).sort()).toEqual(ADDON_PACKAGES.map((addon) => addon.name).sort());
    for (const addon of ADDON_PACKAGES) {
      expect(optional[addon.name]).toBe(version);
    }
    // Publish never leaks the template placeholder version.
    expect(manifest.version).toBe(version);
    expect(manifest.version).not.toBe(TEMPLATE.version);
  });

  it("scopes the main package and pins node:sqlite-capable engines", () => {
    expect(MAIN_PACKAGE_NAME).toBe("@icebear0828/codex-proxy");
    expect(TEMPLATE.engines).toEqual({ node: ">=22.13" });
    expect(TEMPLATE.bin).toEqual({ "codex-proxy": "bin/codex-proxy.mjs" });
  });

  it("restricts addon packages to their own platform files", () => {
    for (const addon of ADDON_PACKAGES) {
      const manifest = buildAddonManifest(addon, "1.0.0") as Record<string, any>;
      expect(manifest.os).toEqual([addon.os]);
      expect(manifest.cpu).toEqual([addon.cpu]);
      if (addon.libc) expect(manifest.libc).toEqual([addon.libc]);
      else expect(manifest.libc).toBeUndefined();
      expect(manifest.files).toContain(addon.file);
      // Without a main entry, require('codex-tls-<triple>') cannot resolve.
      expect(manifest.main).toBe(addon.file);
    }
  });
});
