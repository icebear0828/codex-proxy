/**
 * Tests for the cross-platform smoke script used by the release
 * pipeline (`.github/scripts/electron-smoke.sh`).
 *
 * We can't unit-test the happy path here — that requires a packed
 * Electron binary on a CI runner. What we *can* test is that the
 * script fails LOUDLY (non-zero exit + clear ::error::) when its
 * preconditions aren't met. A silently-passing smoke script would
 * defeat the whole purpose: PR would go green, broken artifact
 * would still get uploaded.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..", "..", "..");
const SCRIPT = resolve(ROOT, ".github", "scripts", "electron-smoke.sh");
const WINDOWS_SCRIPT = resolve(ROOT, ".github", "scripts", "electron-smoke.ps1");
const RELEASE_WORKFLOW = resolve(ROOT, ".github", "workflows", "release.yml");
const PROMOTE_WORKFLOW = resolve(ROOT, ".github", "workflows", "promote-dev-to-master.yml");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string>, timeoutMs = 10_000): RunResult {
  try {
    const out = execFileSync("bash", [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: out, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      status: typeof e.status === "number" ? e.status : -1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? "",
    };
  }
}

describe("electron-smoke.sh script", () => {
  beforeAll(() => {
    expect(existsSync(SCRIPT), `script missing: ${SCRIPT}`).toBe(true);
  });

  it("is executable", () => {
    const mode = statSync(SCRIPT).mode;
    // Owner-execute bit (0o100) — bash also runs non-+x scripts when invoked
    // explicitly, but +x makes intent clear and matches CI invocation.
    expect(mode & 0o100).toBeTruthy();
  });

  it("passes `bash -n` syntax check", () => {
    expect(() =>
      execFileSync("bash", ["-n", SCRIPT], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("fails loudly when RUNNER_OS is unset", () => {
    // Strip RUNNER_OS specifically; keep the rest of process.env so
    // bash itself can still find /usr/bin/cat etc.
    const env = { ...process.env };
    delete env.RUNNER_OS;
    let result: RunResult;
    try {
      const out = execFileSync("bash", [SCRIPT], {
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      result = { status: 0, stdout: out, stderr: "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      result = {
        status: typeof e.status === "number" ? e.status : -1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("RUNNER_OS not set");
  });

  it("fails loudly when RELEASE_DIR is missing", () => {
    const result = run({
      RUNNER_OS: "Linux",
      RELEASE_DIR: "/tmp/__definitely_not_a_real_dir_xyz_smoke_test__",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("does not exist");
  });

  it("fails loudly when no AppImage is present in RELEASE_DIR", () => {
    // Use the repo root as a "release dir" — no AppImage inside it.
    const result = run({
      RUNNER_OS: "Linux",
      RELEASE_DIR: ROOT,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("AppImage not found");
  });

  it("rejects unsupported RUNNER_OS values with a clear message", () => {
    const result = run({
      RUNNER_OS: "BeOS",
      RELEASE_DIR: resolve(__dirname),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("Unsupported RUNNER_OS");
  });

  it("has a dedicated Windows PowerShell smoke script", () => {
    expect(existsSync(WINDOWS_SCRIPT), `script missing: ${WINDOWS_SCRIPT}`).toBe(true);
    const source = readFileSync(WINDOWS_SCRIPT, "utf-8");
    expect(source).toContain("Start-Process");
    expect(source).toContain("Invoke-WebRequest");
    expect(source).toContain("Stop-Process");
  });
});

function stepBlock(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.includes(`- name: ${name}`));
  if (start < 0) return "";
  const currentIndent = lines[start].match(/^\s*/)?.[0] ?? "";
  const next = lines.findIndex((line, index) =>
    index > start &&
    line.startsWith(`${currentIndent}- name:`)
  );
  return lines.slice(start, next < 0 ? lines.length : next).join("\n");
}

describe("release workflow smoke wiring", () => {
  it("runs stale release asset cleanup through bash on Windows-compatible matrix jobs", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const block = stepBlock(workflow, "Clean stale release assets");

    expect(block).toContain("shell: bash");
    expect(block).toContain("[ -z \"$ASSETS\" ] && exit 0");
  });

  it("uses PowerShell smoke on Windows and bash smoke on non-Windows platforms", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const windowsBlock = stepBlock(workflow, "Smoke test packaged binary (win)");
    const unixBlock = stepBlock(workflow, "Smoke test packaged binary (${{ matrix.platform }}${{ matrix.arch && format('-{0}', matrix.arch) || '' }})");

    expect(windowsBlock).toContain("if: matrix.platform == 'win'");
    expect(windowsBlock).toContain("shell: pwsh");
    expect(windowsBlock).toContain("run: ./.github/scripts/electron-smoke.ps1");
    expect(unixBlock).toContain("if: matrix.platform != 'win'");
    expect(unixBlock).toContain("shell: bash");
    expect(unixBlock).toContain("run: bash .github/scripts/electron-smoke.sh");
  });

  it("gives mac x64 packaged smoke extra startup time", () => {
    const workflow = readFileSync(RELEASE_WORKFLOW, "utf-8");
    const block = workflow.match(
      /- name: Smoke test packaged binary \(mac-x64\)[\s\S]*?run: bash \.github\/scripts\/electron-smoke\.sh/,
    )?.[0] ?? "";

    expect(block).toContain("MAC_ARCH: x64");
    expect(block).toContain("SMOKE_TIMEOUT: 180");
  });
});

describe("promote workflow fast-forward gate", () => {
  it("fails the run instead of reporting success when master cannot fast-forward to dev", () => {
    const workflow = readFileSync(PROMOTE_WORKFLOW, "utf-8");
    const block = stepBlock(workflow, "Check fast-forward possible");

    expect(block).toContain("master has commits not in dev");
    expect(block).toContain("exit 1");
  });
});
