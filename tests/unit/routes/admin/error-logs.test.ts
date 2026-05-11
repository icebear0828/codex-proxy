/**
 * Tests for /admin/error-logs routes (read + report).
 *
 * Covers the four endpoints exposed to the dashboard + the renderer
 * report path. Auth is enforced by the global dashboardAuth middleware
 * applied higher up, so we mount the route in isolation here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { Hono } from "hono";

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
