/**
 * Tests for the CODEX_ARCH auto-detection logic in docker-entrypoint.sh.
 *
 * Strategy: extract just the arch-detection block and run it under `sh`
 * with a mock `uname` injected via PATH.  This avoids needing Docker,
 * /defaults, chown, or gosu.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ARCH_SNIPPET = `
#!/bin/sh
set -e
if [ -z "\${CODEX_ARCH}" ]; then
  UNAME_ARCH=$(uname -m)
  if [ "$UNAME_ARCH" = "aarch64" ]; then
    CODEX_ARCH="arm64"
  elif [ "$UNAME_ARCH" = "x86_64" ]; then
    CODEX_ARCH="x64"
  else
    CODEX_ARCH="$UNAME_ARCH"
  fi
  export CODEX_ARCH
fi
echo "$CODEX_ARCH"
`;

function runArch(env: Record<string, string>): string {
  return execFileSync("sh", ["-c", ARCH_SNIPPET], {
    env: { ...env },
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
}

const tmpBase = mkdtempSync(join(tmpdir(), "entrypoint-arch-"));

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

function mockUnamePath(arch: string): string {
  const dir = mkdtempSync(join(tmpBase, "mock-"));
  writeFileSync(join(dir, "uname"), `#!/bin/sh\necho "${arch}"\n`, { mode: 0o755 });
  return dir;
}

describe("docker-entrypoint CODEX_ARCH detection", () => {
  it("maps aarch64 → arm64", () => {
    const mockDir = mockUnamePath("aarch64");
    const result = runArch({ PATH: `${mockDir}:/usr/bin:/bin` });
    expect(result).toBe("arm64");
  });

  it("maps x86_64 → x64", () => {
    const mockDir = mockUnamePath("x86_64");
    const result = runArch({ PATH: `${mockDir}:/usr/bin:/bin` });
    expect(result).toBe("x64");
  });

  it("passes through unknown arch as-is", () => {
    const mockDir = mockUnamePath("riscv64");
    const result = runArch({ PATH: `${mockDir}:/usr/bin:/bin` });
    expect(result).toBe("riscv64");
  });

  it("preserves CODEX_ARCH when already set", () => {
    const mockDir = mockUnamePath("x86_64");
    const result = runArch({ PATH: `${mockDir}:/usr/bin:/bin`, CODEX_ARCH: "custom-arch" });
    expect(result).toBe("custom-arch");
  });

  it("detects arch when CODEX_ARCH is empty string", () => {
    const mockDir = mockUnamePath("aarch64");
    const result = runArch({ PATH: `${mockDir}:/usr/bin:/bin`, CODEX_ARCH: "" });
    expect(result).toBe("arm64");
  });
});
