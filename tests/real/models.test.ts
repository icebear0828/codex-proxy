/**
 * Real upstream tests — model listing, health, and diagnostics.
 *
 * Verifies:
 * 1. /v1/models returns a valid model list
 * 2. /health reflects pool state
 * 3. /debug/diagnostics returns complete structure
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── /v1/models ───────────────────────────────────────────────────────

describe("real: /v1/models", () => {
  it("returns model list with expected structure", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/models`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.object).toBe("list");

    const data = body.data as Array<{ id: string; object: string; owned_by?: string }>;
    expect(data.length).toBeGreaterThan(0);

    // Every model entry should have id and object
    for (const model of data) {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe("string");
      expect(model.object).toBe("model");
    }

    // Should include at least one codex-related model
    const hasCodex = data.some((m) => m.id.includes("codex") || m.id.includes("gpt"));
    expect(hasCodex).toBe(true);
  }, TIMEOUT);

  it("returns individual model by id", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/models/codex`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // May be 200 or 404 depending on config — just verify structure
    if (res.status === 200) {
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBeDefined();
      expect(body.object).toBe("model");
    } else {
      expect(res.status).toBe(404);
    }
  }, TIMEOUT);
});

// ── Gemini model list ────────────────────────────────────────────────

describe("real: Gemini model list", () => {
  it("/v1beta/models returns Gemini-format model list", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1beta/models`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const models = body.models as Array<{ name: string; displayName?: string }>;
    expect(models.length).toBeGreaterThan(0);

    for (const model of models) {
      expect(model.name).toBeDefined();
      expect(model.name.startsWith("models/")).toBe(true);
    }
  }, TIMEOUT);
});

// ── /health ──────────────────────────────────────────────────────────

describe("real: /health", () => {
  it("returns ok status with pool info", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/health`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.authenticated).toBe("boolean");

    const pool = body.pool as { total: number; active: number };
    expect(pool).toBeDefined();
    expect(typeof pool.total).toBe("number");
    expect(typeof pool.active).toBe("number");
    expect(pool.total).toBeGreaterThanOrEqual(pool.active);
    expect(pool.total).toBeGreaterThan(0); // at least one account needed for these tests
  }, TIMEOUT);
});

// ── /v1/models/catalog ──────────────────────────────────────────────

describe("real: /v1/models/catalog", () => {
  it("returns full catalog with reasoning efforts", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/models/catalog`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThan(0);

    const first = body[0];
    expect(first.id).toBeDefined();
    expect(typeof first.displayName).toBe("string");
    expect(Array.isArray(first.supportedReasoningEfforts)).toBe(true);
    expect(typeof first.defaultReasoningEffort).toBe("string");
  }, TIMEOUT);
});

// ── /v1/models/:modelId/info ────────────────────────────────────────

describe("real: /v1/models/:modelId/info", () => {
  it("returns extended model info", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/models/codex/info`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (res.status === 200) {
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBeDefined();
      expect(typeof body.displayName).toBe("string");
      expect(Array.isArray(body.supportedReasoningEfforts)).toBe(true);
      expect(Array.isArray(body.inputModalities)).toBe(true);
    } else {
      expect(res.status).toBe(404);
    }
  }, TIMEOUT);
});

// ── /debug/diagnostics ───────────────────────────────────────────────

describe("real: /debug/diagnostics", () => {
  it("returns complete diagnostic structure", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/debug/diagnostics`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // diagnostics is localhost-only in production, may 403 if running remotely
    if (res.status === 403) {
      console.warn("[diagnostics] Blocked (not localhost), skipping");
      return;
    }

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    // Transport info
    const transport = body.transport as Record<string, unknown>;
    expect(transport).toBeDefined();
    expect(typeof transport.type).toBe("string");
    expect(typeof transport.initialized).toBe("boolean");

    // Curl info
    expect(body.curl).toBeDefined();

    // Account info
    const accounts = body.accounts as Record<string, unknown>;
    expect(accounts).toBeDefined();
    expect(typeof accounts.total).toBe("number");
    expect(typeof accounts.active).toBe("number");

    // Runtime info
    const runtime = body.runtime as Record<string, unknown>;
    expect(runtime).toBeDefined();
    expect(typeof runtime.platform).toBe("string");
    expect(typeof runtime.node_version).toBe("string");

    // Paths info
    expect(body.paths).toBeDefined();
  }, TIMEOUT);
});

// ── /debug/fingerprint ──────────────────────────────────────────────

describe("real: /debug/fingerprint", () => {
  it("returns client fingerprint info", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/debug/fingerprint`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (res.status === 403) {
      console.warn("[fingerprint] Blocked (not localhost), skipping");
      return;
    }

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body.headers).toBeDefined();
    expect(body.client).toBeDefined();

    const client = body.client as Record<string, unknown>;
    expect(typeof client.app_version).toBe("string");
    expect(typeof client.platform).toBe("string");
  }, TIMEOUT);
});
