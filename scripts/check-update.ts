#!/usr/bin/env tsx
/**
 * check-update.ts — Polls the Codex Sparkle appcast feed for new versions.
 *
 * Usage:
 *   npx tsx scripts/check-update.ts [--watch]
 *
 * With --watch: polls every 30 minutes and keeps running.
 * Without: runs once and exits.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = resolve(ROOT, "config/default.yaml");
const STATE_PATH = resolve(ROOT, "data/update-state.json");
const APPCAST_URL = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface UpdateState {
  last_check: string;
  latest_version: string | null;
  latest_build: string | null;
  download_url: string | null;
  update_available: boolean;
  current_version: string;
  current_build: string;
}

interface CurrentConfig {
  app_version: string;
  build_number: string;
}

function loadCurrentConfig(): CurrentConfig {
  const raw = yaml.load(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  const client = raw.client as Record<string, string>;
  return {
    app_version: client.app_version,
    build_number: client.build_number,
  };
}

/**
 * Parse appcast XML to extract version info.
 * Uses regex-based parsing to avoid heavy XML dependencies.
 */
function parseAppcast(xml: string): {
  version: string | null;
  build: string | null;
  downloadUrl: string | null;
} {
  // Extract the latest <item> (first one is usually the latest)
  const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
  if (!itemMatch) {
    return { version: null, build: null, downloadUrl: null };
  }
  const item = itemMatch[1];

  // sparkle:shortVersionString = display version
  const versionMatch = item.match(/sparkle:shortVersionString="([^"]+)"/);
  // sparkle:version = build number
  const buildMatch = item.match(/sparkle:version="([^"]+)"/);
  // url = download URL from enclosure
  const urlMatch = item.match(/url="([^"]+)"/);

  return {
    version: versionMatch?.[1] ?? null,
    build: buildMatch?.[1] ?? null,
    downloadUrl: urlMatch?.[1] ?? null,
  };
}

async function checkOnce(): Promise<UpdateState> {
  const current = loadCurrentConfig();

  console.log(`[check-update] Current: v${current.app_version} (build ${current.build_number})`);
  console.log(`[check-update] Fetching ${APPCAST_URL}...`);

  const res = await fetch(APPCAST_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch appcast: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  const { version, build, downloadUrl } = parseAppcast(xml);

  if (!version || !build) {
    console.warn("[check-update] Could not parse version from appcast");
    return {
      last_check: new Date().toISOString(),
      latest_version: null,
      latest_build: null,
      download_url: null,
      update_available: false,
      current_version: current.app_version,
      current_build: current.build_number,
    };
  }

  const updateAvailable =
    version !== current.app_version || build !== current.build_number;

  const state: UpdateState = {
    last_check: new Date().toISOString(),
    latest_version: version,
    latest_build: build,
    download_url: downloadUrl,
    update_available: updateAvailable,
    current_version: current.app_version,
    current_build: current.build_number,
  };

  if (updateAvailable) {
    console.log(`\n  *** UPDATE AVAILABLE ***`);
    console.log(`  New version: ${version} (build ${build})`);
    console.log(`  Current:     ${current.app_version} (build ${current.build_number})`);
    if (downloadUrl) {
      console.log(`  Download:    ${downloadUrl}`);
    }
    console.log(`\n  Run: npm run extract -- --path <new-codex-path>`);
    console.log(`  Then: npm run apply-update\n`);
  } else {
    console.log(`[check-update] Up to date: v${version} (build ${build})`);
  }

  // Write state
  mkdirSync(resolve(ROOT, "data"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`[check-update] State written to ${STATE_PATH}`);

  return state;
}

async function main() {
  const watch = process.argv.includes("--watch");

  await checkOnce();

  if (watch) {
    console.log(`[check-update] Watching for updates every ${POLL_INTERVAL_MS / 60000} minutes...`);
    setInterval(async () => {
      try {
        await checkOnce();
      } catch (err) {
        console.error("[check-update] Poll error:", err);
      }
    }, POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("[check-update] Fatal:", err);
  process.exit(1);
});
