#!/usr/bin/env tsx
/**
 * Run the public Codex Desktop fingerprint update pipeline.
 *
 * This script intentionally requires a local Codex.app or extracted ASAR path.
 * The public repo does not ship the old private downloader, so automatic
 * download/install remains outside this entrypoint.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..");

interface CliOptions {
  codexPath: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let codexPath: string | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--path") {
      const next = argv[index + 1];
      if (!next) throw new Error("--path requires a value");
      codexPath = next;
      index++;
      continue;
    }
    if (arg.startsWith("--path=")) {
      codexPath = arg.slice("--path=".length);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { codexPath, dryRun };
}

function runTsxStep(label: string, args: string[]): Promise<void> {
  const command = process.execPath;
  const childArgs = ["--import", "tsx", ...args];
  console.log(`[full-update] ${label}: ${command} ${childArgs.join(" ")}`);

  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, childArgs, {
      cwd: ROOT,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", rejectStep);
    child.on("exit", (code) => {
      if (code === 0) {
        resolveStep();
      } else {
        rejectStep(new Error(`${label} exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.codexPath) {
    throw new Error(
      "Missing --path <Codex.app or extracted ASAR dir>. " +
      "Run npm run check-update to inspect the appcast, then rerun with --path.",
    );
  }

  const resolvedPath = resolve(process.cwd(), options.codexPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }

  await runTsxStep("extract", ["scripts/build/extract-fingerprint.ts", "--path", resolvedPath]);
  await runTsxStep("apply", [
    "scripts/build/apply-update.ts",
    ...(options.dryRun ? ["--dry-run"] : []),
  ]);
}

main().catch((error: unknown) => {
  console.error("[full-update] Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
