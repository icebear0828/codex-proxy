import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(ROOT, ".github", "scripts", "generate-release-notes.sh");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function runNotes(cwd: string, tag: string): string {
  return execFileSync("bash", [SCRIPT, tag], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeText(cwd: string, path: string, text: string): void {
  const fullPath = join(cwd, path);
  mkdirSync(resolve(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, text);
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
}

function createRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "codex-proxy-release-notes-test-"));
  git(cwd, ["init", "-b", "master"]);
  git(cwd, ["config", "user.name", "Test User"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  writeText(cwd, "README.md", "initial\n");
  writeText(cwd, "package.json", "{\"version\":\"1.0.0\"}\n");
  writeText(cwd, "package-lock.json", "{\"version\":\"1.0.0\",\"packages\":{\"\":{\"version\":\"1.0.0\"},\"packages/electron\":{\"version\":\"1.0.0\"}}}\n");
  writeText(cwd, "packages/electron/package.json", "{\"version\":\"1.0.0\"}\n");
  writeText(cwd, "src/app.txt", "base\n");
  commitAll(cwd, "chore: initial release");
  git(cwd, ["tag", "v1.0.0"]);
  return cwd;
}

describe("generate-release-notes.sh", () => {
  beforeAll(() => {
    expect(existsSync(SCRIPT), `script missing: ${SCRIPT}`).toBe(true);
  });

  it("wires the release workflow through the script with dev history available", () => {
    const workflow = readFileSync(resolve(ROOT, ".github", "workflows", "release.yml"), "utf-8");

    expect(workflow).toContain("Fetch dev for stable release notes");
    expect(workflow).toContain("git fetch origin dev:refs/remotes/origin/dev || true");
    expect(workflow).toContain("bash .github/scripts/generate-release-notes.sh \"$TAG\" > /tmp/release-notes.md");
  });

  it("uses normal stable tag history when the release tag contains the real commits", () => {
    const cwd = createRepo();
    writeText(cwd, "src/app.txt", "direct fix\n");
    commitAll(cwd, "fix: direct stable fix (#1)");
    writeText(cwd, "README.md", "docs only\n");
    commitAll(cwd, "docs: update readme");
    git(cwd, ["tag", "v1.0.1"]);

    const notes = runNotes(cwd, "v1.0.1");

    expect(notes).toContain("- fix: direct stable fix (#1)");
    expect(notes).not.toContain("docs: update readme");
  });

  it("falls back to dev history when a stable tag only contains a squash promotion", () => {
    const cwd = createRepo();
    git(cwd, ["checkout", "-b", "dev"]);
    writeText(cwd, "src/app.txt", "real fix\n");
    commitAll(cwd, "fix: real user-facing fix (#10)");
    writeText(cwd, "src/helper.txt", "cleanup\n");
    commitAll(cwd, "refactor: internal helper cleanup (#11)");
    git(cwd, ["update-ref", "refs/remotes/origin/dev", "dev"]);

    git(cwd, ["checkout", "master"]);
    git(cwd, ["read-tree", "--reset", "-u", "dev"]);
    commitAll(cwd, "fix: promote dev release fixes to master");
    writeText(cwd, "README.md", "synced readme\n");
    writeText(cwd, "package.json", "{\"version\":\"1.0.1\"}\n");
    writeText(cwd, "package-lock.json", "{\"version\":\"1.0.1\",\"packages\":{\"\":{\"version\":\"1.0.1\"},\"packages/electron\":{\"version\":\"1.0.1\"}}}\n");
    writeText(cwd, "packages/electron/package.json", "{\"version\":\"1.0.1\"}\n");
    commitAll(cwd, "chore: bump version to 1.0.1 [skip ci]");
    git(cwd, ["tag", "v1.0.1"]);

    const notes = runNotes(cwd, "v1.0.1");

    expect(notes).toContain("- fix: real user-facing fix (#10)");
    expect(notes).toContain("- refactor: internal helper cleanup (#11)");
    expect(notes).not.toContain("promote dev release fixes");
  });
});
