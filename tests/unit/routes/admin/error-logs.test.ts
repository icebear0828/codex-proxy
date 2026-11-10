/**
 * Tests for /admin/error-logs routes (read + report).
 *
 * Covers the four endpoints exposed to the dashboard + the renderer
 * report path. Auth is enforced by the global dashboardAuth middleware
 * applied higher up, so we mount the route in isolation here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { Hono } from "hono";

/**
 * Performance assertions are relative to an in-run baseline instead of an
 * absolute millisecond budget: CI runner load varies wildly, so a fixed
 * threshold produces flaky failures unrelated to any code regression.
 *
 * The baseline measures the same endpoints against a small log set; the
 * large-set run must stay within `PERF_BASELINE_FACTOR` × baseline (plus a
 * fixed slack for timer granularity). This catches the super-linear
 * regressions the test actually cares about while tolerating slow runners.
 */
const PERF_BASELINE_FACTOR = 25;
const PERF_ABSOLUTE_SLACK_MS = 100;
let tmpDataDir = "";

const mockConfig = {
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

beforeEach(() => {
  tmpDataDir = mkdtempSync(resolve(tmpdir(), "errlog-routes-"));
  mockConfig.observability.local_error_log = true;
  // Re-enable disk writes under Vitest (suppressed by default in
  // `appendErrorLog` to keep stray test runs from polluting the
  // developer's `data/error-log.jsonl`).
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

async function buildApp() {
  const { createErrorLogRoutes } = await import("@src/routes/admin/error-logs.js");
  const app = new Hono();
  app.route("/", createErrorLogRoutes());
  return app;
}

async function appendFew() {
  const { appendErrorLog } = await import("@src/logs/error-log.js");
  appendErrorLog({ source: "main", error: { name: "TypeError", message: "boom 1", stack: "at a.js:1" } });
  await new Promise((r) => setTimeout(r, 5));
  appendErrorLog({ source: "main", error: { name: "TypeError", message: "boom 2", stack: "at a.js:1" } });
  await new Promise((r) => setTimeout(r, 5));
  appendErrorLog({ source: "server", error: { name: "RangeError", message: "out", stack: "at b.js:5" } });
}

describe("GET /admin/error-logs", () => {
  it("returns grouped errors with count and last_seen", async () => {
    await appendFew();
    const app = await buildApp();
    const res = await app.request("/admin/error-logs");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      groups: Array<{ name: string; count: number; last_seen: string }>;
    };
    expect(body.groups).toHaveLength(2);
    const typeErr = body.groups.find((g) => g.name === "TypeError")!;
    expect(typeErr.count).toBe(2);
    const rangeErr = body.groups.find((g) => g.name === "RangeError")!;
    expect(rangeErr.count).toBe(1);
  });

  it("includes sample context in grouped errors for dashboard diagnostics", async () => {
    const { appendErrorLog } = await import("@src/logs/error-log.js");
    appendErrorLog({
      source: "server",
      error: { name: "StreamUpstreamPrematureClose", message: "closed early" },
      context: {
        requestId: "rid-stream-1",
        accountEntryId: "acct-42",
        variantHash: "vh-cafef00d",
      },
    });

    const app = await buildApp();
    const res = await app.request("/admin/error-logs");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      groups: Array<{ name: string; sample_context?: Record<string, unknown> }>;
    };
    expect(body.groups[0]).toMatchObject({
      name: "StreamUpstreamPrematureClose",
      sample_context: {
        requestId: "rid-stream-1",
        accountEntryId: "acct-42",
        variantHash: "vh-cafef00d",
      },
    });
  });

  it("returns empty groups when no log exists", async () => {
    const app = await buildApp();
    const res = await app.request("/admin/error-logs");
    expect(res.status).toBe(200);
    const body = await res.json() as { groups: unknown[] };
    expect(body.groups).toEqual([]);
  });
});

describe("GET /admin/error-logs/raw", () => {
  it("returns raw entries newest-first with limit", async () => {
    await appendFew();
    const app = await buildApp();
    const res = await app.request("/admin/error-logs/raw?limit=2");
    expect(res.status).toBe(200);

    const body = await res.json() as {
      entries: Array<{ source: string; error: { message: string } }>;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].error.message).toBe("out");
    expect(body.entries[1].error.message).toBe("boom 2");
  });
});

describe("GET /admin/error-logs/count", () => {
  it("returns total + unread counts (all unread when no cursor)", async () => {
    await appendFew();
    const app = await buildApp();
    const res = await app.request("/admin/error-logs/count");
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; unread: number };
    expect(body.total).toBe(3);
    expect(body.unread).toBe(3);
  });

  it("reflects the cursor when set", async () => {
    await appendFew();
    const { setReadCursor } = await import("@src/logs/error-log.js");
    // Set cursor to "now" — everything older than now is read.
    setReadCursor(new Date(Date.now() + 10_000).toISOString());

    const app = await buildApp();
    const res = await app.request("/admin/error-logs/count");
    const body = await res.json() as { total: number; unread: number };
    expect(body.total).toBe(3);
    expect(body.unread).toBe(0);
  });
});

describe("POST /admin/error-logs/seen", () => {
  it("advances the cursor to the latest entry's ts so unread becomes 0", async () => {
    await appendFew();
    const app = await buildApp();

    const before = await app.request("/admin/error-logs/count");
    expect(((await before.json()) as { unread: number }).unread).toBe(3);

    const seenRes = await app.request("/admin/error-logs/seen", { method: "POST" });
    expect(seenRes.status).toBe(200);

    const after = await app.request("/admin/error-logs/count");
    expect(((await after.json()) as { unread: number }).unread).toBe(0);
  });

  it("is idempotent (no entries → still 200)", async () => {
    const app = await buildApp();
    const res = await app.request("/admin/error-logs/seen", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /admin/error-logs", () => {
  it("clears current, rotated backup, and cursor files so grouped logs and counts become empty", async () => {
    await appendFew();
    writeFileSync(
      resolve(tmpDataDir, "error-log.1.jsonl"),
      JSON.stringify({
        ts: "2026-05-01T00:00:00.000Z",
        version: "0.0.0-test",
        platform: "darwin",
        source: "server",
        error: { name: "StreamUpstreamPrematureClose", message: "closed early" },
      }) + "\n",
      "utf-8",
    );
    const { setReadCursor } = await import("@src/logs/error-log.js");
    setReadCursor("2025-01-01T00:00:00.000Z");
    const app = await buildApp();

    expect(existsSync(resolve(tmpDataDir, "error-log.jsonl"))).toBe(true);
    expect(existsSync(resolve(tmpDataDir, "error-log.1.jsonl"))).toBe(true);
    expect(existsSync(resolve(tmpDataDir, "error-log.cursor"))).toBe(true);

    const before = await app.request("/admin/error-logs/count");
    expect(((await before.json()) as { total: number; unread: number })).toEqual({
      total: 4,
      unread: 4,
    });

    const clearRes = await app.request("/admin/error-logs", { method: "DELETE" });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual({ ok: true });
    expect(existsSync(resolve(tmpDataDir, "error-log.jsonl"))).toBe(false);
    expect(existsSync(resolve(tmpDataDir, "error-log.1.jsonl"))).toBe(false);
    expect(existsSync(resolve(tmpDataDir, "error-log.cursor"))).toBe(false);

    const grouped = await app.request("/admin/error-logs");
    expect((await grouped.json()) as { groups: unknown[] }).toEqual({ groups: [] });

    const after = await app.request("/admin/error-logs/count");
    expect(((await after.json()) as { total: number; unread: number })).toEqual({
      total: 0,
      unread: 0,
    });
  });
});

describe("POST /admin/error-logs/report", () => {
  it("appends a renderer-reported error to the log with sanitized context", async () => {
    const app = await buildApp();
    const payload = {
      source: "renderer",
      error: { name: "TypeError", message: "render boom", stack: "at App.tsx:42" },
      context: {
        url: "http://127.0.0.1:8080/#/settings",
        api_key: "ak_should_not_persist_plaintext_xxxxxxx",
      },
    };
    const res = await app.request("/admin/error-logs/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);

    const file = resolve(tmpDataDir, "error-log.jsonl");
    const line = readFileSync(file, "utf-8").trim();
    const entry = JSON.parse(line) as {
      source: string;
      error: { message: string };
      context: { api_key: string; url: string };
    };
    expect(entry.source).toBe("renderer");
    expect(entry.error.message).toBe("render boom");
    expect(entry.context.url).toBe("http://127.0.0.1:8080/#/settings");
    expect(entry.context.api_key).not.toContain("should_not_persist_plaintext");
  });

  it("rejects unknown source values", async () => {
    const app = await buildApp();
    const res = await app.request("/admin/error-logs/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "bogus",
        error: { name: "E", message: "m" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed payload (missing error)", async () => {
    const app = await buildApp();
    const res = await app.request("/admin/error-logs/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "renderer" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("large log performance and limit tests", () => {
  /** Measure one endpoint round-trip and return its duration in ms. */
  async function timeRequest(app: Hono, path: string, init?: RequestInit): Promise<{ ms: number; res: Response }> {
    const start = performance.now();
    const res = await app.request(path, init);
    return { ms: performance.now() - start, res };
  }

  function writeLogSet(current: number, backup: number) {
    const backupFile = resolve(tmpDataDir, "error-log.1.jsonl");
    const currentFile = resolve(tmpDataDir, "error-log.jsonl");
    const now = Date.now();
    const make = (count: number, offsetMs: number, source: string, name: string) => {
      let content = "";
      for (let i = 0; i < count; i++) {
        content += JSON.stringify({
          ts: new Date(now - offsetMs + i * 10).toISOString(),
          version: "0.0.0-test",
          platform: "darwin",
          source,
          error: { name, message: `err ${i}`, stack: `at ${source}.js:1` },
        }) + "\n";
      }
      return content;
    };
    writeFileSync(backupFile, make(backup, 200000, "server", "BackupError"), "utf-8");
    writeFileSync(currentFile, make(current, 100000, "main", "CurrentError"), "utf-8");
  }

  it("processes seen, count, and lists efficiently with 15,000+ entries", async () => {
    // Baseline: same endpoints, tiny log set, same process/runner.
    writeLogSet(10, 10);
    const baselineApp = await buildApp();
    const baseCount = await timeRequest(baselineApp, "/admin/error-logs/count");
    expect(baseCount.res.status).toBe(200);
    const baseSeen = await timeRequest(baselineApp, "/admin/error-logs/seen", { method: "POST" });
    expect(baseSeen.res.status).toBe(200);
    const baseGrouped = await timeRequest(baselineApp, "/admin/error-logs");
    expect(baseGrouped.res.status).toBe(200);
    const budget = (base: number) => base * PERF_BASELINE_FACTOR + PERF_ABSOLUTE_SLACK_MS;
    // The baseline `seen` call persists a read cursor in the shared tmpdir;
    // remove it so the large-set phase starts from the same cursor-less
    // state the original scenario expects (unread = all entries).
    const cursorFile = resolve(tmpDataDir, "error-log.cursor");
    if (existsSync(cursorFile)) unlinkSync(cursorFile);

    // Large set: 8000 current + 8000 backup entries.
    writeLogSet(8000, 8000);
    vi.resetModules();
    const app = await buildApp();

    // 1. Check count performance and correctness
    const count = await timeRequest(app, "/admin/error-logs/count");
    expect(count.res.status).toBe(200);
    const countBody = await count.res.json() as { total: number; unread: number };
    expect(countBody.total).toBe(16000);
    expect(countBody.unread).toBe(16000);
    expect(count.ms).toBeLessThan(budget(baseCount.ms));

    // 2. Check seen performance and correctness
    const seen = await timeRequest(app, "/admin/error-logs/seen", { method: "POST" });
    expect(seen.res.status).toBe(200);
    const seenBody = await seen.res.json() as { ok: boolean; cursor: string };
    expect(seenBody.ok).toBe(true);
    expect(seenBody.cursor).toBeTruthy();
    expect(seen.ms).toBeLessThan(budget(baseSeen.ms));

    // Verify unread becomes 0
    const countAfterRes = await app.request("/admin/error-logs/count");
    const countAfterBody = await countAfterRes.json() as { unread: number };
    expect(countAfterBody.unread).toBe(0);

    // 3. Check grouped errors list limit (should default to processing at most 1000 items)
    const grouped = await timeRequest(app, "/admin/error-logs");
    expect(grouped.res.status).toBe(200);
    const groupedBody = await grouped.res.json() as { groups: Array<{ name: string; count: number }> };

    // Default limit should apply. The total count across groups should sum to the limit (1000)
    const totalGroupedCount = groupedBody.groups.reduce((acc, g) => acc + g.count, 0);
    expect(totalGroupedCount).toBe(1000);
    expect(grouped.ms).toBeLessThan(budget(baseGrouped.ms));
  });
});

