/**
 * Tests for installFileLogger — tees process.stdout/stderr writes into a
 * daily log file under a configurable directory.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installFileLogger } from "@src/utils/log-file.js";

describe("installFileLogger", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
        // swallow — cleanup is best-effort
      }
    }
  });

  it("tees process.stdout writes into the target file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const handle = installFileLogger({ dir, filename: "test.log" });
    cleanups.push(() => handle.uninstall());

    process.stdout.write("hello stdout\n");

    expect(handle.path).toBe(join(dir, "test.log"));
    expect(readFileSync(handle.path, "utf8")).toContain("hello stdout");
  });

  it("tees process.stderr writes into the target file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const handle = installFileLogger({ dir, filename: "test.log" });
    cleanups.push(() => handle.uninstall());

    process.stderr.write("boom stderr\n");

    expect(readFileSync(handle.path, "utf8")).toContain("boom stderr");
  });

  it("creates nested target directory if it does not exist", () => {
    const base = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = join(base, "nested", "logs");

    const handle = installFileLogger({ dir, filename: "test.log" });
    cleanups.push(() => handle.uninstall());

    process.stdout.write("nested\n");

    expect(statSync(handle.path).isFile()).toBe(true);
    expect(readFileSync(handle.path, "utf8")).toContain("nested");
  });

  it("uninstall restores original write functions and stops teeing", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const originalStdoutWrite = process.stdout.write;
    const handle = installFileLogger({ dir, filename: "test.log" });
    expect(process.stdout.write).not.toBe(originalStdoutWrite);

    process.stdout.write("before\n");
    handle.uninstall();
    expect(process.stdout.write).toBe(originalStdoutWrite);

    process.stdout.write("after\n");

    const contents = readFileSync(handle.path, "utf8");
    expect(contents).toContain("before");
    expect(contents).not.toContain("after");
  });

  it("defaults filename to dev-YYYY-MM-DD.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const handle = installFileLogger({ dir });
    cleanups.push(() => handle.uninstall());

    expect(handle.path).toMatch(/dev-\d{4}-\d{2}-\d{2}\.log$/);
  });

  it("preserves the boolean return value from the underlying write", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const handle = installFileLogger({ dir, filename: "test.log" });
    cleanups.push(() => handle.uninstall());

    const result = process.stdout.write("payload\n");
    expect(typeof result).toBe("boolean");
  });

  it("appends to an existing file instead of truncating", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-proxy-log-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const first = installFileLogger({ dir, filename: "test.log" });
    process.stdout.write("first run\n");
    first.uninstall();

    const second = installFileLogger({ dir, filename: "test.log" });
    cleanups.push(() => second.uninstall());
    process.stdout.write("second run\n");

    const contents = readFileSync(second.path, "utf8");
    expect(contents).toContain("first run");
    expect(contents).toContain("second run");
  });
});
