import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(ROOT, ".github", "scripts", "check-promote-ci.sh");
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function runWithWorkflowRuns(workflowRuns: unknown[]): string {
  const binDir = mkdtempSync(join(tmpdir(), "codex-proxy-promote-ci-") );
  const fixture = join(binDir, "workflow-runs.json");
  writeFileSync(fixture, JSON.stringify({ workflow_runs: workflowRuns }));
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh\ncat ${JSON.stringify(fixture)}\n`,
  );
  chmodSync(gh, 0o755);
  return execFileSync("bash", [SCRIPT, SHA, "icebear0828/codex-proxy"], {
    encoding: "utf-8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  }).trim();
}

describe("promote CI gate", () => {
  it("ignores an old failed release run when the quality gate succeeded", () => {
    expect(runWithWorkflowRuns([
      {
        path: ".github/workflows/release.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-12T17:02:44Z",
      },
      {
        path: ".github/workflows/ci-quality.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-15T17:56:53Z",
      },
    ])).toBe("green");
  });

  it("uses the newest quality-gate run for the candidate", () => {
    expect(runWithWorkflowRuns([
      {
        path: ".github/workflows/ci-quality.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-14T17:56:53Z",
      },
      {
        path: ".github/workflows/ci-quality.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-15T17:56:53Z",
      },
    ])).toBe("not-green");
  });

  it("reports missing quality checks instead of treating unrelated runs as green", () => {
    expect(runWithWorkflowRuns([
      {
        path: ".github/workflows/release.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-15T17:56:53Z",
      },
    ])).toBe("missing-checks");
  });
});
