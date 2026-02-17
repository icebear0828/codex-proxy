#!/usr/bin/env tsx
/**
 * apply-update.ts — Compares extracted fingerprint with current config and applies updates.
 *
 * Usage:
 *   npx tsx scripts/apply-update.ts [--dry-run]
 *
 * --dry-run: Show what would change without modifying files.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import yaml from "js-yaml";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG_PATH = resolve(ROOT, "config/default.yaml");
const FINGERPRINT_PATH = resolve(ROOT, "config/fingerprint.yaml");
const EXTRACTED_PATH = resolve(ROOT, "data/extracted-fingerprint.json");
const MODELS_PATH = resolve(ROOT, "src/routes/models.ts");
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

interface ExtractedFingerprint {
  app_version: string;
  build_number: string;
  api_base_url: string | null;
  originator: string | null;
  models: string[];
  wham_endpoints: string[];
  user_agent_contains: string;
  prompts: {
    desktop_context_hash: string | null;
    desktop_context_path: string | null;
    title_generation_hash: string | null;
    title_generation_path: string | null;
    pr_generation_hash: string | null;
    pr_generation_path: string | null;
    automation_response_hash: string | null;
    automation_response_path: string | null;
  };
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

  // Models — check for additions/removals
  const modelsTs = readFileSync(MODELS_PATH, "utf-8");
  const currentModels = [...modelsTs.matchAll(/id:\s*"(gpt-[^"]+)"/g)].map((m) => m[1]);
  const extractedModels = extracted.models.filter((m) => m.includes("codex") || currentModels.includes(m));

  const newModels = extractedModels.filter((m) => !currentModels.includes(m));
  const removedModels = currentModels.filter((m) => !extractedModels.includes(m));

  if (newModels.length > 0) {
    changes.push({
      type: "semi-auto",
      category: "models_added",
      description: `New models found: ${newModels.join(", ")}`,
      current: currentModels.join(", "),
      updated: extractedModels.join(", "),
      file: MODELS_PATH,
    });
  }

  if (removedModels.length > 0) {
    changes.push({
      type: "semi-auto",
      category: "models_removed",
      description: `Models removed: ${removedModels.join(", ")}`,
      current: currentModels.join(", "),
      updated: extractedModels.join(", "),
      file: MODELS_PATH,
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
        type: "semi-auto",
        category: `prompt_${name}`,
        description: `New prompt file: ${name}.md (not in config/prompts/)`,
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
        type: "semi-auto",
        category: `prompt_${name}`,
        description: `System prompt changed: ${name}`,
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
    let configContent = readFileSync(CONFIG_PATH, "utf-8");

    for (const change of configChanges) {
      switch (change.category) {
        case "version":
          configContent = configContent.replace(
            /app_version:\s*"[^"]+"/,
            `app_version: "${change.updated}"`,
          );
          break;
        case "build":
          configContent = configContent.replace(
            /build_number:\s*"[^"]+"/,
            `build_number: "${change.updated}"`,
          );
          break;
        case "originator":
          configContent = configContent.replace(
            /originator:\s*"[^"]+"/,
            `originator: "${change.updated}"`,
          );
          break;
      }
    }

    writeFileSync(CONFIG_PATH, configContent);
    console.log(`  [APPLIED] config/default.yaml updated`);
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
