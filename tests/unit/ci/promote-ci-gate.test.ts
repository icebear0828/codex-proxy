import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { expect, it } from "vitest";
import { describePosix } from "@helpers/platform-test.js";

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

function runWithWorkflowRunPages(pages: unknown[]): string {
  const binDir = mkdtempSync(join(tmpdir(), "codex-proxy-promote-ci-pages-"));
  const fixture = join(binDir, "workflow-runs-pages.json");
  writeFileSync(fixture, JSON.stringify(pages));
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

function createChangelogSyncCandidate(options: {
  subject?: string;
  addExtraFile?: boolean;
} = {}): { repoDir: string; parentSha: string; candidateSha: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "codex-proxy-sync-candidate-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf-8" }).trim();

  git(["init", "--quiet"]);
  git(["config", "user.name", "CI Gate Test"]);
  git(["config", "user.email", "ci-gate-test@example.invalid"]);
  writeFileSync(join(repoDir, "CHANGELOG.md"), "## [v2.1.x]\n");
  git(["add", "--", "CHANGELOG.md"]);
  git(["commit", "--quiet", "-m", "fix: verified code parent"]);
  const parentSha = git(["rev-parse", "HEAD"]);

  writeFileSync(join(repoDir, "CHANGELOG.md"), "## [v2.1.x]\n\n- Synced entry.\n");
  const changedFiles = ["CHANGELOG.md"];
  if (options.addExtraFile) {
    writeFileSync(join(repoDir, "README.md"), "unexpected change\n");
    changedFiles.push("README.md");
  }
  git(["add", "--", ...changedFiles]);
  git(["commit", "--quiet", "-m", options.subject ?? "docs: sync changelog release series [skip ci]"]);

  return { repoDir, parentSha, candidateSha: git(["rev-parse", "HEAD"]) };
}

function runWithWorkflowRunsAt(
  workflowRuns: unknown[],
  repoDir: string,
  sha: string,
): string {
  const binDir = mkdtempSync(join(tmpdir(), "codex-proxy-promote-ci-repo-"));
  const fixture = join(binDir, "workflow-runs.json");
  writeFileSync(fixture, JSON.stringify({ workflow_runs: workflowRuns }));
  const gh = join(binDir, "gh");
  writeFileSync(gh, `#!/bin/sh\ncat ${JSON.stringify(fixture)}\n`);
  chmodSync(gh, 0o755);
  return execFileSync("bash", [SCRIPT, sha, "icebear0828/codex-proxy"], {
    cwd: repoDir,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  }).trim();
}

describePosix("promote CI gate", () => {
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

  it("uses run number to break ties when quality runs share a creation timestamp", () => {
    expect(runWithWorkflowRuns([
      {
        path: ".github/workflows/ci-quality.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "failure",
        created_at: "2026-08-15T17:56:53Z",
        run_number: 21,
        run_attempt: 1,
        id: 9021,
      },
      {
        path: ".github/workflows/ci-quality.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-15T17:56:53Z",
        run_number: 20,
        run_attempt: 1,
        id: 9020,
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

  it("accepts a changelog-only sync commit when its parent quality gate is green", () => {
    const candidate = createChangelogSyncCandidate();
    expect(runWithWorkflowRunsAt([{
      path: ".github/workflows/ci-quality.yml",
      head_sha: candidate.parentSha,
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-15T17:56:53Z",
    }], candidate.repoDir, candidate.candidateSha)).toBe("green");
  });

  it("does not inherit parent CI for a changelog sync commit that changes other files", () => {
    const candidate = createChangelogSyncCandidate({ addExtraFile: true });
    expect(runWithWorkflowRunsAt([{
      path: ".github/workflows/ci-quality.yml",
      head_sha: candidate.parentSha,
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-15T17:56:53Z",
    }], candidate.repoDir, candidate.candidateSha)).toBe("missing-checks");
  });

  it("does not inherit parent CI for a different changelog commit subject", () => {
    const candidate = createChangelogSyncCandidate({ subject: "docs: edit changelog [skip ci]" });
    expect(runWithWorkflowRunsAt([{
      path: ".github/workflows/ci-quality.yml",
      head_sha: candidate.parentSha,
      status: "completed",
      conclusion: "success",
      created_at: "2026-08-15T17:56:53Z",
    }], candidate.repoDir, candidate.candidateSha)).toBe("missing-checks");
  });

  it("rejects a changelog sync commit when its parent quality gate failed", () => {
    const candidate = createChangelogSyncCandidate();
    expect(runWithWorkflowRunsAt([{
      path: ".github/workflows/ci-quality.yml",
      head_sha: candidate.parentSha,
      status: "completed",
      conclusion: "failure",
      created_at: "2026-08-15T17:56:53Z",
    }], candidate.repoDir, candidate.candidateSha)).toBe("not-green");
  });

  it("finds a quality-gate run returned on a later API page", () => {
    expect(runWithWorkflowRunPages([
      { workflow_runs: Array.from({ length: 100 }, (_, index) => ({
        path: ".github/workflows/release.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "failure",
        created_at: `2026-08-15T10:${String(index).padStart(2, "0")}:00Z`,
      })) },
      { workflow_runs: [{
        path: ".github/workflows/ci-quality.yml",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-15T17:56:53Z",
      }] },
    ])).toBe("green");
  });
});
