#!/usr/bin/env tsx
/**
 * full-update.ts — One-command update pipeline for Codex Proxy.
 *
 * Steps:
 *   1. Check appcast for new Codex Desktop version
 *   2. If new version: download .zip → extract .app → extract asar → run fingerprint extraction
 *   3. Apply config + prompt updates
 *   4. Check curl-impersonate for updates
 *   5. Cleanup temp files
 *
 * Usage:
 *   npm run update
 *   npx tsx scripts/build/full-update.ts [--dry-run] [--force]
 */

import { execSync, execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

const ROOT = resolve(import.meta.dirname, "..", "..");
const TMP_DIR = resolve(ROOT, "tmp");
const CONFIG_PATH = resolve(ROOT, "config/default.yaml");
const APPCAST_URL =
  "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";

interface AppcastInfo {
  version: string | null;
  build: string | null;
  downloadUrl: string | null;
}

function parseAppcast(xml: string): AppcastInfo {
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) return { version: null, build: null, downloadUrl: null };
  const item = itemMatch[1];
  // Support both attribute syntax (sparkle:version="X") and element syntax (<sparkle:version>X</sparkle:version>)
  const versionMatch =
    item.match(/sparkle:shortVersionString="([^"]+)"/) ??
    item.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/);
  const buildMatch =
    item.match(/sparkle:version="([^"]+)"/) ??
    item.match(/<sparkle:version>([^<]+)<\/sparkle:version>/);
  const urlMatch = item.match(/url="([^"]+)"/);
  return {
    version: versionMatch?.[1] ?? null,
    build: buildMatch?.[1] ?? null,
    downloadUrl: urlMatch?.[1] ?? null,
  };
}

function getCurrentVersion(): { app_version: string; build_number: string } {
  const raw = yaml.load(readFileSync(CONFIG_PATH, "utf-8")) as Record<
    string,
    unknown
  >;
  const client = raw.client as Record<string, string>;
  return {
    app_version: client.app_version,
    build_number: client.build_number,
  };
}

function cleanup(): void {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true });
    console.log("[update] Cleaned up tmp/");
  }
  // Also clean up .asar-out if it was created by extract-fingerprint
  const asarOut = resolve(ROOT, ".asar-out");
  if (existsSync(asarOut)) {
    rmSync(asarOut, { recursive: true });
    console.log("[update] Cleaned up .asar-out/");
  }
}

async function step1_checkAppcast(
  force: boolean,
): Promise<{ needsUpdate: boolean; info: AppcastInfo }> {
  console.log("\n── Step 1: Check appcast for new version ──");

  const current = getCurrentVersion();
  console.log(`  Current: v${current.app_version} (build ${current.build_number})`);

  console.log(`  Fetching ${APPCAST_URL}...`);
  const xml = execFileSync("curl", ["-s", "-L", APPCAST_URL], {
    encoding: "utf-8",
    timeout: 15000,
  });

  const info = parseAppcast(xml);
  console.log(
    `  Latest:  v${info.version ?? "?"} (build ${info.build ?? "?"})`,
  );

  if (!info.version || !info.build || !info.downloadUrl) {
    console.log("  Could not parse appcast. Skipping download.");
    return { needsUpdate: false, info };
  }

  const needsUpdate =
    force ||
    info.version !== current.app_version ||
    info.build !== current.build_number;

  if (needsUpdate) {
    console.log(
      force ? "  Force update requested." : "  New version available!",
    );
  } else {
    console.log("  Already up to date.");
  }

  return { needsUpdate, info };
}

function step2_downloadAndExtract(downloadUrl: string): string {
  console.log("\n── Step 2: Download and extract Codex.app ──");

  mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = resolve(TMP_DIR, "codex-update.zip");

  console.log(`  Downloading ${downloadUrl}...`);
  execSync(`curl -L -o "${zipPath}" "${downloadUrl}"`, {
    stdio: "inherit",
    timeout: 600_000,
  });

  console.log("  Extracting .zip...");
  // Use unzip on Unix, or PowerShell on Windows
  if (process.platform === "win32") {
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${TMP_DIR}' -Force"`,
      { stdio: "inherit", timeout: 120_000 },
    );
  } else {
    execSync(`unzip -qo "${zipPath}" -d "${TMP_DIR}"`, {
      stdio: "inherit",
      timeout: 120_000,
    });
  }

  // Find the .app bundle
  const appPath = resolve(TMP_DIR, "Codex.app");
  if (!existsSync(appPath)) {
    const entries = readdirSync(TMP_DIR);
    const appEntry = entries.find((e) => e.endsWith(".app"));
    if (appEntry) {
      return resolve(TMP_DIR, appEntry);
    }
    throw new Error(
      `Codex.app not found in extracted archive. Contents: ${entries.join(", ")}`,
    );
  }

  console.log(`  Found: ${appPath}`);
  return appPath;
}

function step3_extractFingerprint(appPath: string): void {
  console.log("\n── Step 3: Extract fingerprint + prompts ──");

  execSync(`npx tsx scripts/build/extract-fingerprint.ts --path "${appPath}"`, {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 120_000,
  });
}

function step4_applyUpdate(dryRun: boolean): void {
  console.log("\n── Step 4: Apply config + prompt updates ──");

  const args = dryRun ? "--dry-run" : "";
  execSync(`npx tsx scripts/build/apply-update.ts ${args}`, {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 30000,
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Codex Proxy — Full Update Pipeline      ║");
  console.log("╚══════════════════════════════════════════╝");

  if (dryRun) console.log("  (DRY RUN — no changes will be applied)");

  try {
    // Step 1: Check appcast
    const { needsUpdate, info } = await step1_checkAppcast(force);

    if (needsUpdate && info.downloadUrl) {
      // Step 2: Download and extract
      const appPath = step2_downloadAndExtract(info.downloadUrl);

      // Step 3: Extract fingerprint
      step3_extractFingerprint(appPath);

      // Step 4: Apply updates
      step4_applyUpdate(dryRun);
    } else if (!needsUpdate) {
      // Even if no new version, still run apply-update in case
      // there are pending extracted changes
      const extractedPath = resolve(ROOT, "data/extracted-fingerprint.json");
      if (existsSync(extractedPath)) {
        step4_applyUpdate(dryRun);
      }
    }

    // Cleanup
    cleanup();

    console.log("\n══════════════════════════════════════════");
    console.log("  Update pipeline complete!");
    console.log("══════════════════════════════════════════\n");
  } catch (err) {
    cleanup();
    throw err;
  }
}

main().catch((err) => {
  console.error("[update] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
