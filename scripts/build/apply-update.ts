#!/usr/bin/env tsx
/**
 * apply-update.ts — Compares extracted fingerprint with current config and applies updates.
 *
 * Usage:
 *   npx tsx scripts/build/apply-update.ts [--dry-run]
 *
 * --dry-run: Show what would change without modifying files.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import yaml from "js-yaml";
import { mutateYaml } from "../../src/utils/yaml-mutate.js";
import type { ExtractedFingerprint } from "./types.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CONFIG_PATH = resolve(ROOT, "config/default.yaml");
const EXTRACTED_PATH = resolve(ROOT, "data/extracted-fingerprint.json");
const PROMPTS_DIR = resolve(ROOT, "config/prompts");

type ChangeType = "auto" | "semi-auto" | "alert";

interface Change {
  type: ChangeType;
  category: string;
  description: string;
  current: string;
  updated: string;
  file: string;
}

function loadExtracted(): ExtractedFingerprint {
  if (!existsSync(EXTRACTED_PATH)) {
    throw new Error(
      `No extracted fingerprint found at ${EXTRACTED_PATH}.\n` +
      `Run: npm run extract -- --path <codex-path>`
    );
  }
  return JSON.parse(readFileSync(EXTRACTED_PATH, "utf-8"));
}

function loadCurrentConfig(): Record<string, unknown> {
  return yaml.load(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
}

function detectChanges(extracted: ExtractedFingerprint): Change[] {
  const changes: Change[] = [];
  const config = loadCurrentConfig();
  const client = config.client as Record<string, string>;

  // Version
  if (extracted.app_version !== client.app_version) {
    changes.push({
      type: "auto",
      category: "version",
      description: "App version changed",
      current: client.app_version,
      updated: extracted.app_version,
      file: CONFIG_PATH,
    });
  }

  // Build number
  if (extracted.build_number !== client.build_number) {
    changes.push({
      type: "auto",
      category: "build",
      description: "Build number changed",
      current: client.build_number,
      updated: extracted.build_number,
      file: CONFIG_PATH,
    });
  }

  // Chromium version
  if (extracted.chromium_version && extracted.chromium_version !== client.chromium_version) {
    changes.push({
      type: "auto",
      category: "chromium_version",
      description: "Chromium version changed",
      current: client.chromium_version ?? "unknown",
      updated: extracted.chromium_version,
      file: CONFIG_PATH,
    });
  }

  // TLS impersonate profile (derived from Chromium version)
  const tls = config.tls as Record<string, string>;
  if (extracted.chromium_version) {
    const expectedProfile = `chrome${extracted.chromium_version}`;
    if (tls.impersonate_profile && tls.impersonate_profile !== expectedProfile) {
      changes.push({
        type: "auto",
        category: "impersonate_profile",
        description: "TLS impersonate profile changed",
        current: tls.impersonate_profile,
        updated: expectedProfile,
        file: CONFIG_PATH,
      });
    }
  }

  // Originator
  if (extracted.originator && extracted.originator !== client.originator) {
    changes.push({
      type: "auto",
      category: "originator",
      description: "Originator header changed",
      current: client.originator,
      updated: extracted.originator,
      file: CONFIG_PATH,
    });
  }

  // API base URL
  const api = config.api as Record<string, string>;
  if (extracted.api_base_url && extracted.api_base_url !== api.base_url) {
    changes.push({
      type: "alert",
      category: "api_url",
      description: "API base URL changed (CRITICAL)",
      current: api.base_url,
      updated: extracted.api_base_url,
      file: CONFIG_PATH,
    });
  }

  // WHAM endpoints — check for new ones
  const knownEndpoints = [
    "/wham/tasks", "/wham/environments", "/wham/accounts/check",
    "/wham/usage",
  ];
  const newEndpoints = extracted.wham_endpoints.filter(
    (ep) => !knownEndpoints.some((k) => ep.startsWith(k))
  );
  if (newEndpoints.length > 0) {
    changes.push({
      type: "alert",
      category: "endpoints",
      description: `New WHAM endpoints found: ${newEndpoints.join(", ")}`,
      current: "(known set)",
      updated: newEndpoints.join(", "),
      file: "src/proxy/wham-api.ts",
    });
  }

  // System prompts — check hash changes
  const promptConfigs = [
    { name: "desktop-context", hash: extracted.prompts.desktop_context_hash, path: extracted.prompts.desktop_context_path },
    { name: "title-generation", hash: extracted.prompts.title_generation_hash, path: extracted.prompts.title_generation_path },
    { name: "pr-generation", hash: extracted.prompts.pr_generation_hash, path: extracted.prompts.pr_generation_path },
    { name: "automation-response", hash: extracted.prompts.automation_response_hash, path: extracted.prompts.automation_response_path },
  ];

  for (const { name, hash, path } of promptConfigs) {
    if (!hash || !path) continue;

    const configPromptPath = resolve(PROMPTS_DIR, `${name}.md`);
    if (!existsSync(configPromptPath)) {
      changes.push({
        type: "auto",
        category: `prompt_${name}`,
        description: `New prompt file: ${name}.md (auto-copy from extracted)`,
        current: "(missing)",
        updated: hash,
        file: configPromptPath,
      });
      continue;
    }

    const currentContent = readFileSync(configPromptPath, "utf-8");
    const currentHash = `sha256:${createHash("sha256").update(currentContent).digest("hex").slice(0, 16)}`;

    if (currentHash !== hash) {
      changes.push({
        type: "auto",
        category: `prompt_${name}`,
        description: `System prompt changed: ${name} (auto-updated)`,
        current: currentHash,
        updated: hash,
        file: configPromptPath,
      });
    }
  }

  return changes;
}

function applyAutoChanges(changes: Change[], dryRun: boolean): void {
  const autoChanges = changes.filter((c) => c.type === "auto");

  if (autoChanges.length === 0) {
    console.log("\n  No auto-applicable changes.");
    return;
  }

  // Group config changes
  const configChanges = autoChanges.filter((c) => c.file === CONFIG_PATH);

  if (configChanges.length > 0 && !dryRun) {
    mutateYaml(CONFIG_PATH, (data) => {
      const client = data.client as Record<string, unknown>;
      const tls = data.tls as Record<string, unknown>;
      for (const change of configChanges) {
        switch (change.category) {
          case "version":
            client.app_version = change.updated;
            break;
          case "build":
            client.build_number = change.updated;
            break;
          case "originator":
            client.originator = change.updated;
            break;
          case "chromium_version":
            client.chromium_version = change.updated;
            break;
          case "impersonate_profile":
            tls.impersonate_profile = change.updated;
            break;
        }
      }
    });
    console.log(`  [APPLIED] config/default.yaml updated`);
  }

  // Auto-apply prompt changes (copy from extracted to config/prompts/)
  const promptChanges = autoChanges.filter((c) => c.category.startsWith("prompt_"));
  for (const change of promptChanges) {
    if (dryRun) continue;
    const name = change.category.replace("prompt_", "");
    const sourcePath = resolve(ROOT, `data/extracted-prompts/${name}.md`);
    if (existsSync(sourcePath)) {
      const source = readFileSync(sourcePath, "utf-8");

      // Safety: refuse to overwrite with empty/corrupted content
      const trimmed = source.trim();
      if (trimmed.length < 50) {
        console.warn(`  [SKIPPED] config/prompts/${name}.md — extracted content too short (${trimmed.length} chars)`);
        continue;
      }
      const garbageLines = trimmed.split("\n").filter((l) => /^[,`'"]\s*$/.test(l.trim()));
      if (garbageLines.length > 3) {
        console.warn(`  [SKIPPED] config/prompts/${name}.md — ${garbageLines.length} garbled lines detected`);
        continue;
      }

      mkdirSync(PROMPTS_DIR, { recursive: true });
      writeFileSync(change.file, source);
      console.log(`  [APPLIED] config/prompts/${name}.md updated`);
    }
  }
}

function displayReport(changes: Change[], dryRun: boolean): void {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║  Update Analysis ${dryRun ? "(DRY RUN)" : ""}                    ║`);
  console.log("╠══════════════════════════════════════════╣");

  if (changes.length === 0) {
    console.log("║  No changes detected — up to date!       ║");
    console.log("╚══════════════════════════════════════════╝");
    return;
  }

  console.log("╚══════════════════════════════════════════╝\n");

  // Auto changes
  const auto = changes.filter((c) => c.type === "auto");
  if (auto.length > 0) {
    console.log(`  AUTO-APPLY (${auto.length}):`);
    for (const c of auto) {
      const action = dryRun ? "WOULD APPLY" : "APPLIED";
      console.log(`    [${action}] ${c.description}`);
      console.log(`      ${c.current} → ${c.updated}`);
    }
  }

  // Semi-auto changes
  const semi = changes.filter((c) => c.type === "semi-auto");
  if (semi.length > 0) {
    console.log(`\n  SEMI-AUTO (needs review) (${semi.length}):`);
    for (const c of semi) {
      console.log(`    [REVIEW] ${c.description}`);
      console.log(`      File: ${c.file}`);
      console.log(`      Current: ${c.current}`);
      console.log(`      New:     ${c.updated}`);
    }
  }

  // Alerts
  const alerts = changes.filter((c) => c.type === "alert");
  if (alerts.length > 0) {
    console.log(`\n  *** ALERTS (${alerts.length}) ***`);
    for (const c of alerts) {
      console.log(`    [ALERT] ${c.description}`);
      console.log(`      File: ${c.file}`);
      console.log(`      Current: ${c.current}`);
      console.log(`      New:     ${c.updated}`);
    }
  }

  // Prompt diffs
  const promptChanges = changes.filter((c) => c.category.startsWith("prompt_"));
  if (promptChanges.length > 0) {
    console.log("\n  PROMPT CHANGES:");
    console.log("  To apply prompt updates, copy from data/extracted-prompts/ to config/prompts/:");
    for (const c of promptChanges) {
      const name = c.category.replace("prompt_", "");
      console.log(`    cp data/extracted-prompts/${name}.md config/prompts/${name}.md`);
    }
  }

  console.log("");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("[apply-update] Loading extracted fingerprint...");
  const extracted = loadExtracted();
  console.log(`  Extracted: v${extracted.app_version} (build ${extracted.build_number})`);

  console.log("[apply-update] Comparing with current config...");
  const changes = detectChanges(extracted);

  displayReport(changes, dryRun);

  if (!dryRun) {
    applyAutoChanges(changes, dryRun);
  }

  // Summary
  const auto = changes.filter((c) => c.type === "auto").length;
  const semi = changes.filter((c) => c.type === "semi-auto").length;
  const alerts = changes.filter((c) => c.type === "alert").length;

  console.log(`[apply-update] Summary: ${auto} auto, ${semi} semi-auto, ${alerts} alerts`);

  if (semi > 0 || alerts > 0) {
    console.log("[apply-update] Manual review needed for semi-auto and alert items above.");
  }

  if (dryRun && auto > 0) {
    console.log("[apply-update] Run without --dry-run to apply auto changes.");
  }
}

main().catch((err) => {
  console.error("[apply-update] Fatal:", err);
  process.exit(1);
});
