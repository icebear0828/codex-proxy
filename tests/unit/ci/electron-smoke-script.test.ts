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
import { existsSync, statSync } from "fs";
import { resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "..", "..", ".github", "scripts", "electron-smoke.sh");

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
    const root = resolve(__dirname, "..", "..", "..");
    const result = run({
      RUNNER_OS: "Linux",
      RELEASE_DIR: root,
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
});
