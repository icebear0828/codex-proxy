#!/usr/bin/env node
// Offline installer shipped inside the GitHub Release npm bundle: the
// directory holds the main package tarball plus one addon tarball per
// platform. Detect this machine's triple, then install exactly those two
// globally so `codex-proxy` works exactly like an npm registry install —
// without anyone needing registry access.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir);

function findTarball(regex) {
  const match = files.find((file) => regex.test(file));
  if (!match) throw new Error(`missing tarball matching ${regex}`);
  return join(dir, match);
}

const main = findTarball(/^[^-]*-codex-proxy-.*\.tgz$/);

function triple() {
  const { platform, arch } = process;
  if (platform === "win32") {
    if (arch === "x64") return "win32-x64-msvc";
    if (arch === "arm64") return "win32-arm64-msvc";
  } else if (platform === "darwin") {
    if (arch === "x64") return "darwin-x64";
    if (arch === "arm64") return "darwin-arm64";
  } else if (platform === "linux") {
    const header = process.report?.getReport?.().header ?? {};
    const musl = Boolean(header.muslVersion);
    if (arch === "x64") return musl ? "linux-x64-musl" : "linux-x64-gnu";
    if (arch === "arm64") return musl ? "linux-arm64-musl" : "linux-arm64-gnu";
  }
  throw new Error(`unsupported platform: ${platform} ${arch}`);
}

const addon = findTarball(new RegExp(`^[^-]*-codex-tls-${triple()}-.*\\.tgz$`));

console.log(`Installing codex-proxy (${triple()}) globally...`);
// shell:true so npm.cmd resolves on Windows; npm inherits this process's
// stdio so install progress and errors are visible.
const result = spawnSync("npm", ["install", "-g", main, addon], {
  stdio: "inherit",
  shell: true,
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Done. Run `codex-proxy` to start.");
