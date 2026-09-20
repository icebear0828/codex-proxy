#!/usr/bin/env node
// Stage the npm distribution packages:
//   <out>/main/                 — @icebear0828/codex-proxy (launcher + Lite payload, no .node)
//   <out>/addons/<pkg>/         — one package per platform triple (its .node + LICENCE)
//
// Payload mirrors scripts/portable/build-portable.mjs (app/ server wrapper +
// esbuild bundle, config/, public/, bin/) except that native addons live in
// the per-platform packages referenced via optionalDependencies, and the
// shell launchers are replaced by the npm bin entry.
//
// Usage:
//   node scripts/npm/stage-npm-packages.mjs --out dist/npm \
//     [--version x.y.z] [--native native] [--skip-missing-addons]

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const NPM_PKG_DIR = join(ROOT, "packages", "npm");
const BUNDLE = resolve(ROOT, "packages/electron/dist-electron/server.mjs");
const SERVER_WRAPPER = resolve(ROOT, "scripts/portable/server.mjs");
const NOTICES = resolve(ROOT, "scripts/portable/THIRD-PARTY-NOTICES.txt");

// Every loader name below must exist verbatim in native/index.js's
// require('codex-tls-<triple>') fallbacks — enforced by
// tests/unit/npm/npm-package.test.ts. `libc` only applies to linux packages;
// npm skips optional dependencies whose os/cpu/libc don't match the host
// (libc support: npm >= 10.1, bundled with every Node 22).
export const ADDON_PACKAGES = [
  { name: "codex-tls-win32-x64-msvc", os: "win32", cpu: "x64", libc: null, file: "codex-tls.win32-x64-msvc.node" },
  { name: "codex-tls-win32-arm64-msvc", os: "win32", cpu: "arm64", libc: null, file: "codex-tls.win32-arm64-msvc.node" },
  { name: "codex-tls-linux-x64-gnu", os: "linux", cpu: "x64", libc: "glibc", file: "codex-tls.linux-x64-gnu.node" },
  { name: "codex-tls-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl", file: "codex-tls.linux-x64-musl.node" },
  { name: "codex-tls-linux-arm64-gnu", os: "linux", cpu: "arm64", libc: "glibc", file: "codex-tls.linux-arm64-gnu.node" },
  { name: "codex-tls-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl", file: "codex-tls.linux-arm64-musl.node" },
  { name: "codex-tls-darwin-x64", os: "darwin", cpu: "x64", libc: null, file: "codex-tls.darwin-x64.node" },
  { name: "codex-tls-darwin-arm64", os: "darwin", cpu: "arm64", libc: null, file: "codex-tls.darwin-arm64.node" },
];

export const MAIN_PACKAGE_NAME = "@icebear0828/codex-proxy";

function parseArgs(argv) {
  const options = { out: null, version: null, native: join(ROOT, "native"), skipMissingAddons: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") options.out = resolve(argv[++i]);
    else if (arg === "--version") options.version = argv[++i];
    else if (arg === "--native") options.native = resolve(argv[++i]);
    else if (arg === "--skip-missing-addons") options.skipMissingAddons = true;
    else if (arg.startsWith("--out=")) options.out = resolve(arg.slice("--out=".length));
    else if (arg.startsWith("--version=")) options.version = arg.slice("--version=".length);
    else if (arg.startsWith("--native=")) options.native = resolve(arg.slice("--native=".length));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.out) throw new Error("--out is required");
  return options;
}

function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else cpSync(from, to);
  }
}

// Keep a local package boundary around the generated napi loader so Node never
// reinterprets native/index.js as ESM, and never ship .node files in the main
// package — they belong to the per-platform addon packages.
function copyNativeLoader(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of ["index.js", "index.d.ts"]) {
    const from = join(source, name);
    if (!existsSync(from)) throw new Error(`Native loader is missing ${name}: ${from}`);
    cpSync(from, join(destination, name));
  }
  writeFileSync(join(destination, "package.json"), '{"type":"commonjs"}\n');
}

export function buildMainManifest(template, version) {
  return {
    ...template,
    version,
    optionalDependencies: Object.fromEntries(ADDON_PACKAGES.map((addon) => [addon.name, version])),
  };
}

export function buildAddonManifest(addon, version) {
  const manifest = {
    name: addon.name,
    version,
    description: `codex-proxy TLS native addon (${addon.name.replace("codex-tls-", "")})`,
    license: "SEE LICENSE IN LICENCE",
    // The addon package ships only the .node binary; make it the entry point
    // so require('codex-tls-<triple>') in native/index.js resolves.
    main: addon.file,
    os: [addon.os],
    cpu: [addon.cpu],
    files: [addon.file, "LICENCE"],
    repository: {
      type: "git",
      url: "git+https://github.com/icebear0828/codex-proxy.git",
    },
  };
  if (addon.libc) manifest.libc = [addon.libc];
  return manifest;
}

function stageMainPackage(out, version, nativeDir) {
  const template = JSON.parse(readFileSync(join(NPM_PKG_DIR, "package.json"), "utf8"));
  const stage = join(out, "main");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const manifest = buildMainManifest(template, version);
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  copyDirectory(join(NPM_PKG_DIR, "bin"), join(stage, "bin"));
  chmodSync(join(stage, "bin", "codex-proxy.mjs"), 0o755);
  cpSync(join(NPM_PKG_DIR, "README.md"), join(stage, "README.md"));

  const app = join(stage, "app");
  mkdirSync(app, { recursive: true });
  if (!existsSync(BUNDLE)) throw new Error(`Missing ${BUNDLE}; run npm --prefix packages/electron run build first`);
  if (!existsSync(join(ROOT, "public", "index.html"))) {
    throw new Error("Missing public/index.html; run npm run build (web assets) first");
  }
  cpSync(BUNDLE, join(app, "server-bundle.mjs"));
  cpSync(SERVER_WRAPPER, join(app, "server.mjs"));
  writeFileSync(join(app, "manifest.json"), JSON.stringify({
    name: "codex-proxy",
    distribution: "npm",
    version,
    minimumNodeMajor: 22,
    modes: ["server", "browser", "auto"],
    webview2: { hostArchitectures: [], runtimeInstall: "none" },
  }, null, 2) + "\n");

  for (const directory of ["config", "public", "bin"]) {
    copyDirectory(join(ROOT, directory), join(stage, directory));
  }
  copyNativeLoader(nativeDir, join(stage, "native"));
  cpSync(NOTICES, join(stage, "THIRD-PARTY-NOTICES.txt"));
  const licence = resolve(ROOT, "LICENCE");
  if (!existsSync(licence)) throw new Error(`Missing ${licence}`);
  cpSync(licence, join(stage, "LICENCE"));
  return stage;
}

function stageAddonPackages(out, version, nativeDir, skipMissing) {
  const addonsRoot = join(out, "addons");
  rmSync(addonsRoot, { recursive: true, force: true });
  const staged = [];
  const missing = [];
  for (const addon of ADDON_PACKAGES) {
    const addonFile = join(nativeDir, addon.file);
    if (!existsSync(addonFile)) {
      missing.push(addon.file);
      continue;
    }
    const stage = join(addonsRoot, addon.name);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "package.json"), JSON.stringify(buildAddonManifest(addon, version), null, 2) + "\n");
    cpSync(addonFile, join(stage, addon.file));
    const licence = resolve(ROOT, "LICENCE");
    if (existsSync(licence)) cpSync(licence, join(stage, "LICENCE"));
    staged.push(addon.name);
  }
  if (missing.length > 0) {
    const message = `Missing native addons: ${missing.join(", ")}`;
    if (!skipMissing) throw new Error(`${message}. Build them first or pass --skip-missing-addons for local testing.`);
    console.warn(`[npm-stage] ${message} — skipped (local mode)`);
  }
  return { addonsRoot, staged, missing };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version ?? JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  mkdirSync(options.out, { recursive: true });

  const mainStage = stageMainPackage(options.out, version, options.native);
  const { staged, missing } = stageAddonPackages(options.out, version, options.native, options.skipMissingAddons);

  console.log(`[npm-stage] version ${version}`);
  console.log(`[npm-stage] main:   ${mainStage} (${MAIN_PACKAGE_NAME})`);
  console.log(`[npm-stage] addons: ${staged.length}/${ADDON_PACKAGES.length} staged (${staged.join(", ") || "none"})`);
  if (missing.length > 0) console.warn(`[npm-stage] missing addons: ${missing.join(", ")}`);
}

// Only run when invoked directly; tests import the exported builders.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
