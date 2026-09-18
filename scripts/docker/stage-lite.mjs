#!/usr/bin/env node
// Stage the Linux-only content of a No-Node Lite package for the lite Docker
// image. The all-platforms archive carries win32/darwin addons and Windows
// launchers that a Linux container never touches; dropping them shrinks the
// image layer by ~11 MB raw.
//
// Inputs (from the Lite build, see scripts/portable/build-portable.mjs):
//   - the staged package tree (or an extracted archive)
//   - the native addon directory (repo native/ layout: index.js, package.json,
//     and the platform .node files produced by CI)
//
// Output: a directory with only what the Alpine (musl) container needs, for
// both amd64 and arm64 image builds. The glibc addon is deliberately
// excluded; CI asserts it never reaches the build context.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");

function parseArgs(argv) {
  const options = { out: null, native: null, package: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--package" || arg === "--native") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--out") options.out = resolve(value);
      else if (arg === "--package") options.package = resolve(value);
      else options.native = resolve(value);
    } else if (arg.startsWith("--out=")) {
      options.out = resolve(arg.slice("--out=".length));
    } else if (arg.startsWith("--package=")) {
      options.package = resolve(arg.slice("--package=".length));
    } else if (arg.startsWith("--native=")) {
      options.native = resolve(arg.slice("--native=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.out) throw new Error("--out is required");
  if (!options.package) throw new Error("--package is required");
  if (!options.native) throw new Error("--native is required");
  return options;
}

// Directories copied verbatim from the Lite package; every one of them is
// required by the backend's setPaths() layout or serves the dashboard.
const PACKAGE_DIRS = ["app", "public", "config", "bin"];
// Files copied verbatim from the Lite package.
const PACKAGE_FILES = ["codex-proxy.sh", "THIRD-PARTY-NOTICES.txt"];
// Container entrypoint shipped with the repo (not part of the Lite package);
// staged as docker-entrypoint.sh to match what Dockerfile.lite COPYs.
const REPO_ENTRYPOINT = "lite-entrypoint.sh";
// Native loader files plus the musl addon the Alpine image runs on. The glibc
// addon never enters the image context (see docker-publish.yml smoke test).
const NATIVE_FILES = [
  "index.js",
  "index.d.ts",
  "package.json",
  "codex-tls.linux-x64-musl.node",
];
// Second architecture for the dual-platform image build. Optional here so a
// locally staged tree (which usually only has the host arch's addon) still
// stages; docker-publish.yml asserts it exists before publishing.
const OPTIONAL_NATIVE_FILES = ["codex-tls.linux-arm64-musl.node"];

function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const dir of PACKAGE_DIRS) {
    if (!existsSync(join(options.package, dir))) {
      throw new Error(`Lite package is missing ${dir}: ${join(options.package, dir)}`);
    }
  }
  for (const name of PACKAGE_FILES) {
    if (!existsSync(join(options.package, name))) {
      throw new Error(`Lite package is missing ${name}`);
    }
  }
  const missingAddons = NATIVE_FILES.filter(
    (name) => !existsSync(join(options.native, name)),
  );
  if (missingAddons.length > 0) {
    throw new Error(`Native directory is missing: ${missingAddons.join(", ")}`);
  }
  const optionalMissing = OPTIONAL_NATIVE_FILES.filter(
    (name) => !existsSync(join(options.native, name)),
  );
  const repoEntrypoint = join(SCRIPT_DIR, REPO_ENTRYPOINT);
  if (!existsSync(repoEntrypoint)) {
    throw new Error(`Missing lite container entrypoint: ${repoEntrypoint}`);
  }

  rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });
  for (const dir of PACKAGE_DIRS) {
    cpSync(join(options.package, dir), join(options.out, dir), { recursive: true });
  }
  for (const name of PACKAGE_FILES) {
    cpSync(join(options.package, name), join(options.out, name));
  }
  mkdirSync(join(options.out, "native"), { recursive: true });
  for (const name of [...NATIVE_FILES, ...OPTIONAL_NATIVE_FILES]) {
    if (existsSync(join(options.native, name))) {
      cpSync(join(options.native, name), join(options.out, "native", name));
    }
  }
  // Stage the container entrypoint under the name Dockerfile.lite expects and
  // keep it executable (Windows checkouts lose the source mode bit).
  cpSync(repoEntrypoint, join(options.out, "docker-entrypoint.sh"));
  chmodSync(join(options.out, "docker-entrypoint.sh"), 0o755);

  const staged = readdirSync(options.out, { recursive: true }).filter(
    (name) => !name.endsWith(join("/") === "/" ? "/" : "\\") && basename(String(name)),
  );
  console.log(`[docker-lite] staged ${staged.length} entries into ${options.out}`);
  console.log("[docker-lite] contents: app public config bin codex-proxy.sh THIRD-PARTY-NOTICES.txt native/ docker-entrypoint.sh");
}

main();
