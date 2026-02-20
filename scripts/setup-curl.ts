#!/usr/bin/env tsx
/**
 * Download curl-impersonate (lexiforest fork) prebuilt binary.
 *
 * Usage:  npm run setup
 *         tsx scripts/setup-curl.ts
 *
 * Detects platform + arch, downloads the matching release from GitHub,
 * extracts curl-impersonate into bin/.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, chmodSync, readdirSync, copyFileSync, rmSync } from "fs";
import { resolve, join } from "path";

const REPO = "lexiforest/curl-impersonate";
const FALLBACK_VERSION = "v1.4.4";
const BIN_DIR = resolve(process.cwd(), "bin");

interface PlatformInfo {
  /** Pattern to match the asset name in GitHub Releases */
  assetPattern: RegExp;
  /** Name of the binary inside the archive */
  binaryName: string;
  /** Name to save the binary as in bin/ */
  destName: string;
}

function getPlatformInfo(version: string): PlatformInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux") {
    const archStr = arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
    return {
      assetPattern: new RegExp(`^curl-impersonate-${version.replaceAll(".", "\\.")}\\.${archStr}\\.tar\\.gz$`),
      binaryName: "curl-impersonate",
      destName: "curl-impersonate",
    };
  }

  if (platform === "darwin") {
    const archStr = arch === "arm64" ? "arm64-macos" : "x86_64-macos";
    return {
      assetPattern: new RegExp(`^curl-impersonate-${version.replaceAll(".", "\\.")}\\.${archStr}\\.tar\\.gz$`),
      binaryName: "curl-impersonate",
      destName: "curl-impersonate",
    };
  }

  if (platform === "win32") {
    throw new Error(
      "curl-impersonate CLI binary is not available for Windows.\n" +
      "The proxy will fall back to system curl.\n" +
      "For full TLS fingerprint matching, run the proxy on Linux or macOS.",
    );
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/** Fetch the latest release tag from GitHub. */
async function getLatestVersion(): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
  console.log(`[setup] Checking latest release...`);
  const resp = await fetch(apiUrl, {
    headers: { "Accept": "application/vnd.github+json" },
  });
  if (!resp.ok) {
    console.warn(`[setup] Could not fetch latest release (${resp.status}), using fallback ${FALLBACK_VERSION}`);
    return FALLBACK_VERSION;
  }
  const release = (await resp.json()) as { tag_name: string };
  return release.tag_name;
}

async function getDownloadUrl(info: PlatformInfo, version: string): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/tags/${version}`;
  console.log(`[setup] Fetching release info from ${apiUrl}`);

  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`);
  }

  const release = (await resp.json()) as { assets: { name: string; browser_download_url: string }[] };

  const asset = release.assets.find((a) => info.assetPattern.test(a.name));

  if (!asset) {
    const cliAssets = release.assets
      .filter((a) => a.name.startsWith("curl-impersonate-") && !a.name.startsWith("libcurl"))
      .map((a) => a.name)
      .join("\n  ");
    throw new Error(
      `No matching asset for pattern ${info.assetPattern}.\nAvailable CLI assets:\n  ${cliAssets}`,
    );
  }

  console.log(`[setup] Found asset: ${asset.name}`);
  return asset.browser_download_url;
}

function downloadAndExtract(url: string, info: PlatformInfo): void {
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }

  const tmpDir = resolve(BIN_DIR, ".tmp-extract");
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true });
  }
  mkdirSync(tmpDir, { recursive: true });

  const archivePath = resolve(tmpDir, "archive.tar.gz");

  console.log(`[setup] Downloading ${url}...`);
  execSync(`curl -L -o "${archivePath}" "${url}"`, { stdio: "inherit" });

  console.log(`[setup] Extracting...`);
  execSync(`tar xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "inherit" });

  // Find the binary in extracted files (may be in a subdirectory)
  const binary = findFile(tmpDir, info.binaryName);
  if (!binary) {
    const files = listFilesRecursive(tmpDir);
    throw new Error(
      `Could not find ${info.binaryName} in extracted archive.\nFiles found:\n  ${files.join("\n  ")}`,
    );
  }

  const destPath = resolve(BIN_DIR, info.destName);
  copyFileSync(binary, destPath);

  // Also copy shared libraries (.so/.dylib) if present alongside the binary
  const libDir = resolve(binary, "..");
  if (existsSync(libDir)) {
    const libs = readdirSync(libDir).filter(
      (f) => f.endsWith(".so") || f.includes(".so.") || f.endsWith(".dylib"),
    );
    for (const lib of libs) {
      copyFileSync(resolve(libDir, lib), resolve(BIN_DIR, lib));
    }
  }

  chmodSync(destPath, 0o755);

  // Cleanup
  rmSync(tmpDir, { recursive: true });
  console.log(`[setup] Installed ${info.destName} to ${destPath}`);
}

function findFile(dir: string, name: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const force = process.argv.includes("--force");

  // Resolve latest version from GitHub
  const version = await getLatestVersion();
  console.log(`[setup] curl-impersonate setup (${version})`);
  console.log(`[setup] Platform: ${process.platform}-${process.arch}`);

  if (process.platform === "win32") {
    console.warn(
      "[setup] curl-impersonate CLI binary is not available for Windows.\n" +
      "[setup] The proxy will use system curl. For full TLS fingerprint matching,\n" +
      "[setup] deploy on Linux or macOS.",
    );
    return;
  }

  const destBinary = resolve(BIN_DIR, "curl-impersonate");

  if (checkOnly) {
    if (existsSync(destBinary)) {
      try {
        const ver = execSync(`"${destBinary}" --version`, { encoding: "utf-8" }).trim().split("\n")[0];
        console.log(`[setup] Current: ${ver}`);
        console.log(`[setup] Latest:  ${version}`);
      } catch {
        console.log(`[setup] Binary exists but version check failed`);
      }
    } else {
      console.log(`[setup] Not installed. Latest: ${version}`);
    }
    return;
  }

  if (existsSync(destBinary) && !force) {
    console.log(`[setup] ${destBinary} already exists. Use --force to re-download.`);
    return;
  }

  if (force && existsSync(destBinary)) {
    rmSync(destBinary);
    console.log(`[setup] Removed existing binary for forced re-download.`);
  }

  const info = getPlatformInfo(version);
  const url = await getDownloadUrl(info, version);
  downloadAndExtract(url, info);

  // Verify the binary runs
  try {
    const ver = execSync(`"${destBinary}" --version`, { encoding: "utf-8" }).trim().split("\n")[0];
    console.log(`[setup] Verified: ${ver}`);
  } catch {
    console.warn(`[setup] Warning: could not verify binary. It may need shared libraries.`);
  }

  console.log(`[setup] Done! curl-impersonate is ready.`);
}

main().catch((err) => {
  console.error(`[setup] Error: ${err.message}`);
  process.exit(1);
});
