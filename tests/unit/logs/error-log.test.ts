/**
 * Tests for the local error-log writer (src/logs/error-log.ts).
 *
 * The writer's job: append uncaught/reported errors to a JSONL file
 * under data/, sanitizing secrets, rotating once at a size cap, and
 * leaving everything no-op when the user has disabled local error
 * logging in config. A read-cursor on the side tracks "unread" state
 * so the dashboard badge can show new-since-last-visit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

let tmpDataDir = "";

interface MockConfig {
  observability: { local_error_log: boolean; max_log_bytes: number };
  client: { app_version: string };
}

const mockConfig: MockConfig = {
  observability: { local_error_log: true, max_log_bytes: 10 * 1024 * 1024 },
  client: { app_version: "0.0.0-test" },
};

vi.mock("@src/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/paths.js")>();
  return {
    ...actual,
    getDataDir: () => tmpDataDir,
  };
});

vi.mock("@src/config.js", () => ({
  getConfig: () => mockConfig,
}));

async function importErrorLog() {
  return await import("@src/logs/error-log.js");
}

beforeEach(async () => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "errlog-"));
  mockConfig.observability.local_error_log = true;
  mockConfig.observability.max_log_bytes = 10 * 1024 * 1024;
  // Opt into actually writing during this test file — `appendErrorLog`
  // suppresses disk writes under Vitest by default to keep tests that
  // exercise it incidentally (proxy-handler integration tests) from
  // polluting `data/error-log.jsonl`.
  process.env.VITEST_FORCE_APPEND_ERROR_LOG = "1";
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(tmpDataDir)) {
    rmSync(tmpDataDir, { recursive: true, force: true });
  }
  delete process.env.VITEST_FORCE_APPEND_ERROR_LOG;
  vi.clearAllMocks();
});

describe("appendErrorLog", () => {
  it("writes a JSONL line with auto-populated ts / version / platform", async () => {
    const { appendErrorLog } = await importErrorLog();
    appendErrorLog({
      source: "main",
      error: { name: "TypeError", message: "boom", stack: "at foo:1:1" },
    });

    const file = resolve(tmpDataDir, "error-log.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.source).toBe("main");
    expect(entry.version).toBe("0.0.0-test");
    expect(entry.platform).toBe(process.platform);
    expect(typeof entry.ts).toBe("string");
    expect(new Date(entry.ts as string).toString()).not.toBe("Invalid Date");
    const error = entry.error as { name: string; message: string; stack: string };
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("boom");
    expect(error.stack).toBe("at foo:1:1");
  });

  it("sanitizes secret-bearing context keys via redactJson", async () => {
    const { appendErrorLog } = await importErrorLog();
    appendErrorLog({
      source: "server",
      error: { name: "Error", message: "fail" },
      context: {
        path: "/v1/responses",
        authorization: "Bearer sk-very-secret-token-1234567890",
        api_key: "ak_supersecret",
        nested: { cookie: "session=abcdef123456" },
      },
    });

    const file = resolve(tmpDataDir, "error-log.jsonl");
    const entry = JSON.parse(readFileSync(file, "utf-8").trim()) as {
      context: { path: string; authorization: string; api_key: string; nested: { cookie: string } };
    };

    expect(entry.context.path).toBe("/v1/responses");
    // redact.ts keeps first 3 + last 2 chars and replaces the middle.
    expect(entry.context.authorization).not.toContain("sk-very-secret-token");
    expect(entry.context.api_key).not.toContain("supersecret");
    expect(entry.context.nested.cookie).not.toContain("session=abcdef");
  });

  it("is a no-op when observability.local_error_log is false", async () => {
    mockConfig.observability.local_error_log = false;
    const { appendErrorLog } = await importErrorLog();
    appendErrorLog({
      source: "main",
      error: { name: "Error", message: "should not be written" },
    });

    const file = resolve(tmpDataDir, "error-log.jsonl");
    expect(existsSync(file)).toBe(false);
  });

  it("rotates to error-log.1.jsonl when current file exceeds max_log_bytes", async () => {
    // Force a tiny rotation threshold so we can trigger it cheaply.
    mockConfig.observability.max_log_bytes = 1024; // 1 KB
    const { appendErrorLog } = await importErrorLog();

    // Each entry is roughly ~200 bytes; 8 entries should overflow 1KB.
    for (let i = 0; i < 12; i++) {
      appendErrorLog({
        source: "main",
        error: { name: "Error", message: `boom ${i}`, stack: "at line\nat next-line" },
      });
    }

    const current = resolve(tmpDataDir, "error-log.jsonl");
    const backup = resolve(tmpDataDir, "error-log.1.jsonl");
    expect(existsSync(current)).toBe(true);
    expect(existsSync(backup)).toBe(true);

    // After rotation, the current file should be smaller than the threshold
    // (it carries the most recent entry written after the swap).
    const currentLines = readFileSync(current, "utf-8").trim().split("\n");
    const backupLines = readFileSync(backup, "utf-8").trim().split("\n");
    expect(currentLines.length).toBeGreaterThan(0);
    expect(backupLines.length).toBeGreaterThan(0);
    // Total entries preserved across both files.
    expect(currentLines.length + backupLines.length).toBe(12);
  });
});

describe("readErrorLog", () => {
  it("returns entries newest-first across current + backup files", async () => {
    const { appendErrorLog, readErrorLog } = await importErrorLog();
    // Force rotation by lowering threshold mid-test.
    mockConfig.observability.max_log_bytes = 400;

    for (let i = 0; i < 6; i++) {
      appendErrorLog({
        source: "main",
        error: { name: "E", message: `entry ${i}` },
      });
    }

    const all = readErrorLog();
    expect(all.length).toBe(6);
    // Newest first: last appended (entry 5) should be index 0.
    expect(all[0].error.message).toBe("entry 5");
    expect(all[all.length - 1].error.message).toBe("entry 0");
  });

  it("respects limit", async () => {
    const { appendErrorLog, readErrorLog } = await importErrorLog();
    for (let i = 0; i < 5; i++) {
      appendErrorLog({ source: "main", error: { name: "E", message: `${i}` } });
    }
    const subset = readErrorLog(2);
    expect(subset.length).toBe(2);
    expect(subset[0].error.message).toBe("4");
    expect(subset[1].error.message).toBe("3");
  });

  it("returns empty array when no log exists", async () => {
    const { readErrorLog } = await importErrorLog();
    expect(readErrorLog()).toEqual([]);
  });
});

describe("groupErrorLog", () => {
  it("groups by error.name + first non-empty stack line", async () => {
    const { groupErrorLog } = await importErrorLog();

    const entries = [
      {
        ts: "2026-05-10T00:00:00Z", version: "v", platform: "darwin", source: "main" as const,
        error: { name: "TypeError", message: "boom A", stack: "at frame.js:1:1\nat outer:2" },
      },
      {
        ts: "2026-05-10T00:00:01Z", version: "v", platform: "darwin", source: "main" as const,
        error: { name: "TypeError", message: "boom A different msg", stack: "at frame.js:1:1\nat outer:3" },
      },
      {
        ts: "2026-05-10T00:00:02Z", version: "v", platform: "darwin", source: "server" as const,
        error: { name: "RangeError", message: "different err", stack: "at other.js:5" },
      },
    ];

    const groups = groupErrorLog(entries);
    expect(groups).toHaveLength(2);

    const typeErr = groups.find((g) => g.name === "TypeError")!;
    expect(typeErr.count).toBe(2);
    expect(typeErr.first_seen).toBe("2026-05-10T00:00:00Z");
    expect(typeErr.last_seen).toBe("2026-05-10T00:00:01Z");

    const rangeErr = groups.find((g) => g.name === "RangeError")!;
    expect(rangeErr.count).toBe(1);
  });
});

describe("read cursor + unread count", () => {
  it("getReadCursor returns null when no cursor file exists", async () => {
    const { getReadCursor } = await importErrorLog();
    expect(getReadCursor()).toBeNull();
  });

  it("setReadCursor + getReadCursor roundtrip", async () => {
    const { setReadCursor, getReadCursor } = await importErrorLog();
    setReadCursor("2026-05-10T12:00:00Z");
    expect(getReadCursor()).toBe("2026-05-10T12:00:00Z");
  });

  it("getUnreadCount returns count of entries strictly newer than cursor", async () => {
    const { appendErrorLog, setReadCursor, getUnreadCount } = await importErrorLog();
    appendErrorLog({ source: "main", error: { name: "E", message: "1" } });
    // Tiny sleep so timestamps differ; ts uses ISO ms granularity.
    await new Promise((r) => setTimeout(r, 5));
    appendErrorLog({ source: "main", error: { name: "E", message: "2" } });

    // Cursor = first entry's ts. Only the 2nd entry should count as unread.
    // We don't have direct access to the first ts here, so we read the log
    // back, snapshot the older ts, and use it as the cursor.
    const file = resolve(tmpDataDir, "error-log.jsonl");
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    const firstTs = JSON.parse(lines[0]).ts as string;
    setReadCursor(firstTs);

    expect(getUnreadCount()).toBe(1);
  });

  it("getUnreadCount returns total when cursor is null", async () => {
    const { appendErrorLog, getUnreadCount } = await importErrorLog();
    appendErrorLog({ source: "main", error: { name: "E", message: "1" } });
    appendErrorLog({ source: "main", error: { name: "E", message: "2" } });
    expect(getUnreadCount()).toBe(2);
  });

  it("getReadCursor handles cursor file with stray whitespace", async () => {
    const { getReadCursor } = await importErrorLog();
    // Pre-write a cursor file directly so we don't have to expose internals.
    writeFileSync(resolve(tmpDataDir, "error-log.cursor"), "  2026-05-10T12:00:00Z  \n");
    expect(getReadCursor()).toBe("2026-05-10T12:00:00Z");
  });
});

describe("uncaught handlers", () => {
  it("handleUncaughtException records an Error instance", async () => {
    const { handleUncaughtException, readErrorLog } = await importErrorLog();
    const err = new TypeError("oops");
    handleUncaughtException(err, "main");

    const entries = readErrorLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("main");
    expect(entries[0].error.name).toBe("TypeError");
    expect(entries[0].error.message).toBe("oops");
    expect(entries[0].error.stack).toBeDefined();
  });

  it("handleUncaughtException records non-Error throws too (string)", async () => {
    const { handleUncaughtException, readErrorLog } = await importErrorLog();
    handleUncaughtException("plain string error", "server");
    const entries = readErrorLog();
    expect(entries[0].source).toBe("server");
    expect(entries[0].error.name).toBe("Error");
    expect(entries[0].error.message).toBe("plain string error");
  });

  it("handleUnhandledRejection records the rejection reason", async () => {
    const { handleUnhandledRejection, readErrorLog } = await importErrorLog();
    handleUnhandledRejection(new RangeError("nope"), "main");
    const entries = readErrorLog();
    expect(entries[0].error.name).toBe("RangeError");
    expect(entries[0].error.message).toBe("nope");
  });
});

describe("appendErrorLog — early-boot resilience", () => {
  it("still writes the entry when getConfig() throws (e.g. quarantine fires before loadConfig)", async () => {
    // Reset module + override the config mock to simulate the early-boot
    // case where loadConfig() has not yet populated the config singleton.
    // The pre-fix readAppVersion call would re-throw and silently swallow
    // the entry (outer try wraps appendFileSync, not entry construction).
    vi.resetModules();
    vi.doMock("@src/config.js", () => ({
      getConfig: () => {
        throw new Error("config not loaded");
      },
    }));

    const { appendErrorLog, readErrorLog } = await importErrorLog();
    appendErrorLog({
      source: "server",
      error: { name: "AccountsFileLoadFailed", message: "boot-time corruption" },
      context: { reason: "json_parse_failed" },
    });

    const entries = readErrorLog();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const latest = entries[entries.length - 1]!;
    expect(latest.error.name).toBe("AccountsFileLoadFailed");
    expect(latest.version).toBe("unknown");

    vi.doUnmock("@src/config.js");
  });
});
