/**
 * Tests for src/utils/debug-dump.ts.
 *
 * Module-load-time constants (ENABLED / DUMP_PATH) read process.env once
 * at import. Use vi.resetModules() + dynamic import to set the env first.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";

const ORIGINAL_ENV = process.env.CODEX_PROXY_DEBUG_DUMP;

beforeEach(() => {
  delete process.env.CODEX_PROXY_DEBUG_DUMP;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.CODEX_PROXY_DEBUG_DUMP;
  else process.env.CODEX_PROXY_DEBUG_DUMP = ORIGINAL_ENV;
});

describe("debug-dump", () => {
  it("disabled by default — debugDumpPath returns null and writes are no-op", async () => {
    const mod = await import("@src/utils/debug-dump.js");
    expect(mod.debugDumpEnabled()).toBe(false);
    expect(mod.debugDumpPath()).toBeNull();
    // append should not throw and should not produce a file
    expect(() => mod.debugDump("test", { foo: "bar" })).not.toThrow();
  });

  it("when enabled, dump path lives under os.tmpdir() (cross-platform)", async () => {
    process.env.CODEX_PROXY_DEBUG_DUMP = "1";
    const mod = await import("@src/utils/debug-dump.js");
    expect(mod.debugDumpEnabled()).toBe(true);

    const path = mod.debugDumpPath();
    expect(path).not.toBeNull();
    // Hardcoded `/tmp` would silently fail on Windows runners. Verify the
    // resolved path is rooted at whatever os.tmpdir() returns on this OS
    // (typical macOS: /var/folders/.../T; Linux: /tmp; Windows: C:\Users\...\AppData\Local\Temp).
    expect(path!.startsWith(tmpdir())).toBe(true);
    expect(path).toMatch(/codex-proxy-dump-\d+\.jsonl$/);
  });
});
