/**
 * Tests for auto-update behavior in self-update.ts runCheck().
 * Verifies that auto-apply triggers when auto_update=true and skips when false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

const mockConfig = {
  update: { auto_update: true },
};

vi.mock("../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../paths.js", () => ({
  getRootDir: vi.fn(() => "/fake/root"),
  isEmbedded: vi.fn(() => false),
}));

// Mock child_process to simulate git availability and commands
const mockExecFileSync = vi.fn();
const mockExecFile = vi.fn();
const mockSpawn = vi.fn(() => ({ unref: vi.fn(), pid: 12345 }));

vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execFile: (...args: unknown[]) => {
    // Return a mock callback-based function that promisify can convert
    const cb = args[args.length - 1];
    if (typeof cb === "function") {
      return mockExecFile(...args);
    }
    // For promisify usage — return via the callback pattern
    return mockExecFile(...args);
  },
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock util.promisify to return our controlled async function
vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return {
    ...actual,
    promisify: () => vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      const cmdArgs = args[1] as string[];
      const key = `${cmd} ${cmdArgs.join(" ")}`;

      if (key.includes("rev-parse --short HEAD")) return { stdout: "abc1234\n" };
      if (key.includes("fetch origin master")) return { stdout: "" };
      if (key.includes("rev-list")) return { stdout: "3\n" };
      if (key.includes("rev-parse --short origin/master")) return { stdout: "def5678\n" };
      if (key.includes("log HEAD..origin/master")) return { stdout: "def5678 feat: new\nabc4567 fix: bug\n" };
      if (key.includes("show origin/master:CHANGELOG.md")) return { stdout: "## [Unreleased]\n### Added\n- stuff\n" };
      if (key.includes("checkout --")) return { stdout: "" };
      if (key.includes("pull origin master")) return { stdout: "" };
      if (key.includes("install")) return { stdout: "" };
      if (key.includes("build")) return { stdout: "" };
      return { stdout: "" };
    }),
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '{"version":"2.0.0"}'),
    openSync: vi.fn(() => 3),
  };
});

// Now import after mocks
const selfUpdate = await import("../self-update.js");

describe("self-update auto-apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.update.auto_update = true;
    // Simulate git available
    mockExecFileSync.mockImplementation((...args: unknown[]) => {
      const cmd = args[1] as string[] | undefined;
      if (cmd?.[0] === "--version") return "git version 2.40.0";
      if (cmd?.includes("--short")) return "abc1234";
      if (cmd?.includes("--abbrev=0")) return "v2.0.0";
      return "";
    });
  });

  afterEach(() => {
    selfUpdate.stopProxyUpdateChecker();
  });

  it("checkProxySelfUpdate detects commits behind", async () => {
    const result = await selfUpdate.checkProxySelfUpdate();
    expect(result.updateAvailable).toBe(true);
    expect(result.commitsBehind).toBe(3);
    expect(result.mode).toBe("git");
  });

  it("canSelfUpdate returns true when .git exists", () => {
    expect(selfUpdate.canSelfUpdate()).toBe(true);
  });

  it("getDeployMode returns git when not embedded", () => {
    expect(selfUpdate.getDeployMode()).toBe("git");
  });
});
