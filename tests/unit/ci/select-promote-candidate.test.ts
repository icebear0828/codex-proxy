import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(ROOT, ".github", "scripts", "select-promote-candidate.sh");

const NOW = 1_750_000_000; // fixed epoch for deterministic tests
const HOUR = 3600;
const DAY = 24 * HOUR;

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function hasBash(): boolean {
  try {
    execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

const describeIfBash = hasBash() ? describe : describe.skip;

function commitAt(cwd: string, message: string, epoch: number): string {
  writeFileSync(join(cwd, "file.txt"), `${message}\n${epoch}\n`);
  git(cwd, ["add", "."]);
  const date = `${epoch} +0000`;
  git(cwd, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function createRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "codex-proxy-promote-test-"));
  git(cwd, ["init", "-b", "master"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  commitAt(cwd, "chore: base", NOW - 10 * DAY);
  git(cwd, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
  git(cwd, ["checkout", "-b", "dev"]);
  return cwd;
}

function run(cwd: string, env: Record<string, string> = {}): string[] {
  const out = execFileSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      MASTER_REF: "refs/remotes/origin/master",
      DEV_REF: "dev",
      NOW_EPOCH: String(NOW),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() === "" ? [] : out.trim().split("\n");
}

describeIfBash("select-promote-candidate.sh", () => {
  beforeAll(() => {
    expect(existsSync(SCRIPT), `script missing: ${SCRIPT}`).toBe(true);
  });

  it("returns dev HEAD when it is older than the soak window", () => {
    const cwd = createRepo();
    const sha = commitAt(cwd, "fix: aged change", NOW - 2 * DAY);
    expect(run(cwd)).toEqual([sha]);
  });

  it("returns empty when nothing on dev is ahead of master", () => {
    const cwd = createRepo();
    expect(run(cwd)).toEqual([]);
  });

  it("returns empty when all dev commits are younger than the soak window", () => {
    const cwd = createRepo();
    commitAt(cwd, "fix: too fresh", NOW - 2 * HOUR);
    expect(run(cwd)).toEqual([]);
  });

  it("starvation fix: fresh HEAD does not block an aged ancestor from promoting", () => {
    const cwd = createRepo();
    const aged = commitAt(cwd, "fix: soaked for two days", NOW - 2 * DAY);
    const agedTip = commitAt(cwd, "fix: soaked 25h", NOW - 25 * HOUR);
    commitAt(cwd, "fix: fresh, keeps soaking", NOW - 1 * HOUR);

    const candidates = run(cwd);
    // newest eligible first, fresh commit absent
    expect(candidates[0]).toBe(agedTip);
    expect(candidates).toContain(aged);
    expect(candidates).toHaveLength(2);
  });

  it("FORCE=true bypasses soak and returns dev HEAD", () => {
    const cwd = createRepo();
    const fresh = commitAt(cwd, "fix: fresh hotfix", NOW - 1 * HOUR);
    expect(run(cwd, { FORCE: "true" })).toEqual([fresh]);
  });

  it("caps output at MAX_CANDIDATES", () => {
    const cwd = createRepo();
    for (let i = 0; i < 5; i++) {
      commitAt(cwd, `fix: aged ${i}`, NOW - 5 * DAY + i * HOUR);
    }
    expect(run(cwd, { MAX_CANDIDATES: "3" })).toHaveLength(3);
  });
});
