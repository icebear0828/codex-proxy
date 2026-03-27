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
import { existsSync, mkdirSync, chmodSync, readdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = "lexiforest/curl-impersonate";
const SELF_REPO = "icebear0828/codex-proxy";
const LIBS_TAG = "curl-libs";
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

interface FfiLibInfo {
  /** Pattern to match the libcurl-impersonate asset in GitHub Releases */
  assetPattern: RegExp;
  /** Name of the shared library inside the archive */
  libraryName: string;
  /** Name to save the library as in bin/ */
  destName: string;
}

/** Parse --arch flag from CLI args to override process.arch (for cross-compilation). */
function getTargetArch(): string {
  const idx = process.argv.indexOf("--arch");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return process.arch;
}

function getPlatformInfo(version: string): PlatformInfo {
  const platform = process.platform;
  const arch = getTargetArch();

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
    // Windows: download libcurl-impersonate package
    // v1.5+ renamed libcurl.dll → libcurl-impersonate.dll
    return {
      assetPattern: /libcurl-impersonate-.*\.x86_64-win32\.tar\.gz/,
      binaryName: "libcurl-impersonate.dll",
      destName: "libcurl.dll",
    };
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Get FFI shared library info for platforms that support it.
 * Returns null if the platform already uses the shared lib as its primary download (Windows).
 */
function getFfiLibInfo(version: string): FfiLibInfo | null {
  const platform = process.platform;
  const arch = getTargetArch();

  if (platform === "darwin") {
    const archStr = arch === "arm64" ? "arm64-macos" : "x86_64-macos";
    return {
      assetPattern: new RegExp(`^libcurl-impersonate-${version.replaceAll(".", "\\.")}\\.${archStr}\\.tar\\.gz$`),
      libraryName: "libcurl-impersonate.dylib",
      destName: "libcurl-impersonate.dylib",
    };
  }

  if (platform === "linux") {
    const archStr = arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
    return {
      assetPattern: new RegExp(`^libcurl-impersonate-${version.replaceAll(".", "\\.")}\\.${archStr}\\.tar\\.gz$`),
      libraryName: "libcurl-impersonate.so",
      destName: "libcurl-impersonate.so",
    };
  }

  // Windows already downloads the DLL as its primary binary
  return null;
}

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Accept": "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

/** Fetch the latest release tag from GitHub. */
async function getLatestVersion(): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
  console.log(`[setup] Checking latest release...`);
  const resp = await fetch(apiUrl, { headers: githubHeaders() });
  if (!resp.ok) {
    console.warn(`[setup] Could not fetch latest release (${resp.status}), using fallback ${FALLBACK_VERSION}`);
    return FALLBACK_VERSION;
  }
  const release = (await resp.json()) as { tag_name: string };
  return release.tag_name;
}

async function getDownloadUrl(info: Pick<PlatformInfo, "assetPattern">, version: string): Promise<string> {
  const apiUrl = `https://api.github.com/repos/${REPO}/releases/tags/${version}`;
  console.log(`[setup] Fetching release info from ${apiUrl}`);

  const resp = await fetch(apiUrl, { headers: githubHeaders() });
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

function downloadAndExtract(url: string, info: { binaryName?: string; libraryName?: string; destName: string }): void {
  const searchName = info.binaryName ?? info.libraryName ?? info.destName;
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
  if (process.platform === "win32") {
    // Windows bsdtar (default on CI) handles D: paths fine without --force-local
    // GNU tar (e.g. Git Bash) needs --force-local; try without first, fallback with
    const tarArchive = archivePath.replaceAll("\\", "/");
    const tarDest = tmpDir.replaceAll("\\", "/");
    try {
      execSync(`tar xzf "${tarArchive}" -C "${tarDest}"`, { stdio: "inherit" });
    } catch {
      execSync(`tar xzf "${tarArchive}" --force-local -C "${tarDest}"`, { stdio: "inherit" });
    }
  } else {
    execSync(`tar xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "inherit" });
  }

  // Find the binary in extracted files (may be in a subdirectory)
  const binary = findFile(tmpDir, searchName);
  if (!binary) {
    const files = listFilesRecursive(tmpDir);
    throw new Error(
      `Could not find ${searchName} in extracted archive.\nFiles found:\n  ${files.join("\n  ")}`,
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

/** Path to the C wrapper source (shared with CI workflow). */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CURL_WRAPPER_PATH = resolve(SCRIPT_DIR, "curl_wrapper.c");

/**
 * Try to download a pre-built shared library from the project's GitHub Releases.
 * Returns true if successful, false if not available.
 */
async function downloadPrebuiltLib(ffiLib: FfiLibInfo): Promise<boolean> {
  const platform = process.platform;
  const arch = getTargetArch();

  // Map to the asset naming convention used by build-curl-libs.yml
  // e.g. libcurl-impersonate-arm64-macos.dylib, libcurl-impersonate-x86_64-linux-gnu.so
  let assetArch: string;
  if (platform === "darwin") {
    assetArch = arch === "arm64" ? "arm64-macos" : "x86_64-macos";
  } else {
    assetArch = arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  }

  const ext = platform === "darwin" ? "dylib" : "so";
  const assetName = `libcurl-impersonate-${assetArch}.${ext}`;
  const url = `https://github.com/${SELF_REPO}/releases/download/${LIBS_TAG}/${assetName}`;

  console.log(`[setup] Trying pre-built library: ${assetName}`);
  try {
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) {
      console.log(`[setup] Pre-built not available (${resp.status})`);
      return false;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const destPath = resolve(BIN_DIR, ffiLib.destName);
    if (!existsSync(BIN_DIR)) mkdirSync(BIN_DIR, { recursive: true });
    writeFileSync(destPath, buffer);
    chmodSync(destPath, 0o755);
    console.log(`[setup] Installed pre-built ${ffiLib.destName}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[setup] Pre-built download failed (${msg})`);
    return false;
  }
}

/**
 * Build a shared library (dylib/so) from the downloaded static .a library.
 * Compiles a C wrapper that re-exports curl_ symbols with default visibility.
 */
function buildSharedLib(staticLibPath: string, destPath: string): void {
  const tmpDir = resolve(BIN_DIR, ".tmp-build");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const wrapperO = resolve(tmpDir, "curl_wrapper.o");

  const arch = getTargetArch();
  const isDarwin = process.platform === "darwin";

  // -arch is Apple clang only; Linux clang uses -target or just compiles native
  const archFlag = isDarwin ? `-arch ${arch === "arm64" ? "arm64" : "x86_64"}` : "";

  console.log(`[setup] Compiling wrapper (${arch})...`);
  execSync(`clang -c ${archFlag} -fvisibility=default "${CURL_WRAPPER_PATH}" -o "${wrapperO}"`, { stdio: "inherit" });

  const linkLibs = isDarwin
    ? "-lz -lc++ -liconv -framework Security -framework SystemConfiguration -framework CoreFoundation -framework CoreServices -licucore"
    : "-lz -lstdc++ -lpthread -ldl";

  // -Wl,-all_load is macOS ld; Linux ld uses --whole-archive
  const wholeArchive = isDarwin
    ? `-Wl,-all_load "${staticLibPath}"`
    : `-Wl,--whole-archive "${staticLibPath}" -Wl,--no-whole-archive`;

  console.log(`[setup] Linking shared library...`);
  execSync(
    `clang -shared ${archFlag} -o "${destPath}" "${wrapperO}" ${wholeArchive} ${linkLibs}`,
    { stdio: "inherit" },
  );

  rmSync(tmpDir, { recursive: true });
  console.log(`[setup] Built ${destPath}`);
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
  const targetArch = getTargetArch();
  console.log(`[setup] Platform: ${process.platform}-${targetArch}${targetArch !== process.arch ? ` (cross: host=${process.arch})` : ""}`);

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

  // Install FFI shared library (macOS/Linux) for connection pooling
  // Strategy: pre-built download → local compile from .a → skip (CLI fallback)
  const ffiLib = getFfiLibInfo(version);
  if (ffiLib) {
    const ffiDest = resolve(BIN_DIR, ffiLib.destName);
    const shouldInstallFfi = !existsSync(ffiDest) || force;

    if (shouldInstallFfi) {
      // Step 1: Try pre-built binary from project releases (no clang needed)
      const gotPrebuilt = await downloadPrebuiltLib(ffiLib);

      if (!gotPrebuilt) {
        // Step 2: Fallback — download static .a and compile locally
        console.log(`[setup] Falling back to local build (requires clang)...`);
        try {
          const ffiUrl = await getDownloadUrl(ffiLib, version);
          const tmpDir = resolve(BIN_DIR, ".tmp-ffi");
          if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
          mkdirSync(tmpDir, { recursive: true });
          const archivePath = resolve(tmpDir, "archive.tar.gz");
          execSync(`curl -L -o "${archivePath}" "${ffiUrl}"`, { stdio: "inherit" });
          execSync(`tar xzf "${archivePath}" -C "${tmpDir}"`, { stdio: "inherit" });

          const staticLib = findFile(tmpDir, "libcurl-impersonate.a");
          if (!staticLib) {
            const files = listFilesRecursive(tmpDir);
            throw new Error(`No .a found in archive. Files: ${files.join(", ")}`);
          }

          buildSharedLib(staticLib, ffiDest);
          rmSync(tmpDir, { recursive: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[setup] Warning: could not build FFI library (${msg}). CLI transport will still work.`);
        }
      }
    } else {
      console.log(`[setup] ${ffiLib.destName} already exists`);
    }

    // BoringSSL needs a CA bundle
    await downloadCaCert(force);
  }

  console.log(`[setup] Done! curl-impersonate is ready.`);
}

main().catch((err) => {
  console.error(`[setup] Error: ${err.message}`);
  process.exit(1);
});
