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
import { existsSync, mkdirSync, chmodSync, readdirSync, copyFileSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";

const REPO = "lexiforest/curl-impersonate";
const FALLBACK_VERSION = "v1.4.4";
const BIN_DIR = resolve(process.cwd(), "bin");
const CACERT_URL = "https://curl.se/ca/cacert.pem";

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
    // Windows: download libcurl-impersonate package (DLL named libcurl.dll)
    return {
      assetPattern: /libcurl-impersonate-.*\.x86_64-win32\.tar\.gz/,
      binaryName: "libcurl.dll",
      destName: "libcurl.dll",
    };
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
    const relevantAssets = release.assets
      .filter((a) =>
        a.name.startsWith("curl-impersonate-") || a.name.startsWith("libcurl-impersonate-"),
      )
      .map((a) => a.name)
      .join("\n  ");
    throw new Error(
      `No matching asset for pattern ${info.assetPattern}.\nAvailable assets:\n  ${relevantAssets}`,
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
  // Windows: tar interprets D: as remote host; --force-local + forward slashes fix this
  if (process.platform === "win32") {
    const tarArchive = archivePath.replaceAll("\\", "/");
    const tarDest = tmpDir.replaceAll("\\", "/");
    execSync(`tar xzf "${tarArchive}" --force-local -C "${tarDest}"`, { stdio: "inherit" });
  } else {
    execSync(`tar xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "inherit" });
  }

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

  // Also copy shared libraries (.so/.dylib/.dll) if present alongside the binary
  const libDir = resolve(binary, "..");
  if (existsSync(libDir)) {
    const libs = readdirSync(libDir).filter(
      (f) =>
        f.endsWith(".so") || f.includes(".so.") ||
        f.endsWith(".dylib") ||
        (f.endsWith(".dll") && f !== info.destName),
    );
    for (const lib of libs) {
      copyFileSync(resolve(libDir, lib), resolve(BIN_DIR, lib));
      console.log(`[setup] Copied companion library: ${lib}`);
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

/**
 * Download Mozilla CA certificate bundle for BoringSSL (used on Windows).
 * libcurl-impersonate uses BoringSSL which doesn't read the Windows cert store,
 * so we need an explicit CA bundle.
 */
async function downloadCaCert(force: boolean): Promise<void> {
  const caPath = resolve(BIN_DIR, "cacert.pem");
  if (existsSync(caPath) && !force) {
    console.log(`[setup] cacert.pem already exists`);
    return;
  }

  console.log(`[setup] Downloading CA bundle from ${CACERT_URL}...`);
  const resp = await fetch(CACERT_URL);
  if (!resp.ok) {
    console.warn(`[setup] Warning: could not download CA bundle (${resp.status}). HTTPS may fail.`);
    return;
  }

  const content = await resp.text();
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }
  writeFileSync(caPath, content, "utf-8");
  console.log(`[setup] Installed CA bundle to ${caPath}`);
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const force = process.argv.includes("--force");

  // Resolve latest version from GitHub
  const version = await getLatestVersion();
  console.log(`[setup] curl-impersonate setup (${version})`);
  console.log(`[setup] Platform: ${process.platform}-${process.arch}`);

  const info = getPlatformInfo(version);
  const isWindowsDll = process.platform === "win32";
  const destBinary = resolve(BIN_DIR, info.destName);

  if (checkOnly) {
    if (existsSync(destBinary)) {
      if (isWindowsDll) {
        console.log(`[setup] ${info.destName} exists`);
      } else {
        try {
          const ver = execSync(`"${destBinary}" --version`, { encoding: "utf-8" }).trim().split("\n")[0];
          console.log(`[setup] Current: ${ver}`);
        } catch {
          console.log(`[setup] Binary exists but version check failed`);
        }
      }
      console.log(`[setup] Latest:  ${version}`);
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

  const url = await getDownloadUrl(info, version);
  downloadAndExtract(url, info);

  // Verify the binary runs (skip for Windows DLL — no CLI to test)
  if (!isWindowsDll) {
    try {
      const ver = execSync(`"${destBinary}" --version`, { encoding: "utf-8" }).trim().split("\n")[0];
      console.log(`[setup] Verified: ${ver}`);
    } catch {
      console.warn(`[setup] Warning: could not verify binary. It may need shared libraries.`);
    }
  } else {
    console.log(`[setup] Installed libcurl-impersonate DLL for FFI transport`);
    // BoringSSL needs a CA bundle — download it
    await downloadCaCert(force);
  }

  console.log(`[setup] Done! curl-impersonate is ready.`);
}

main().catch((err) => {
  console.error(`[setup] Error: ${err.message}`);
  process.exit(1);
});
