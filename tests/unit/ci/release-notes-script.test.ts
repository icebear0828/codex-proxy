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

  it("uses topological sorting (git describe) rather than semver sorting to avoid pulling in old history from unrelated higher-version tags", () => {
    const cwd = createRepo(); // v1.0.0 is created here (commit C1)

    // Make an intermediary stable fix and tag it v1.0.1 (commit C2)
    writeText(cwd, "src/app.txt", "v1.0.1 fix\n");
    commitAll(cwd, "fix: intermediary stable fix (#50)");
    git(cwd, ["tag", "v1.0.1"]);

    // Create a higher-version beta tag v2.0.0-beta.1 branch off v1.0.0 (contains C1, but not C2)
    git(cwd, ["checkout", "-b", "feature-v2", "v1.0.0"]);
    writeText(cwd, "src/app.txt", "v2 base\n");
    commitAll(cwd, "feat: v2 feature work");
    git(cwd, ["tag", "v2.0.0-beta.1"]);

    // Go back to master (which is at v1.0.1) and make a new commit for v1.0.2-beta.1
    git(cwd, ["checkout", "master"]);
    writeText(cwd, "src/app.txt", "v1.0.2 fix\n");
    commitAll(cwd, "fix: critical v1.0.2 bugfix (#100)");
    git(cwd, ["tag", "v1.0.2-beta.1"]);

    const notes = runNotes(cwd, "v1.0.2-beta.1");

    // The release notes should only contain the commits since the last release (v1.0.1)
    expect(notes).toContain("- fix: critical v1.0.2 bugfix (#100)");
    expect(notes).not.toContain("- fix: intermediary stable fix (#50)");
  });

  it("translates the release notes to Chinese and generates bilingual output", () => {
    const cwd = createRepo();
    writeText(cwd, "src/app.txt", "translation fix\n");
    commitAll(cwd, "fix(translation): preserve anthropic message roles (#1)");
    git(cwd, ["tag", "v1.0.1"]);

    const notes = runNotes(cwd, "v1.0.1");

    // Must contain English header and raw commit
    expect(notes).toContain("## 🌐 English / 英文版");
    expect(notes).toContain("- fix(translation): preserve anthropic message roles (#1)");

    // Must contain Chinese header and translated commit
    expect(notes).toContain("## 🇨🇳 中文版 (翻译)");
    expect(notes).toContain("- 修复(翻译)：保留 anthropic 消息角色 (#1)");
  });
});



