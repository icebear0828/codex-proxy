/**
 * Real upstream tests — token refresh & quota monitoring.
 *
 * Verifies:
 * 1. Live quota fetch from upstream
 * 2. Passive quota collection via response headers
 * 3. Account probe/refresh
 * 4. Quota warnings endpoint
 * 5. Token expiry tracking
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers,
  listAccounts, getActiveAccounts, sendQuickRequest,
} from "./_helpers.js";

// ── Types ──────────────────────────────────────────────────────────

interface QuotaResponse {
  quota: {
    plan_type: string;
    rate_limit: {
      allowed: boolean;
      limit_reached: boolean;
      used_percent: number | null;
      reset_at: number | null;
    };
    secondary_rate_limit: {
      limit_reached: boolean;
      used_percent: number | null;
      reset_at: number | null;
    } | null;
  };
  raw: Record<string, unknown>;
}

interface WarningsResponse {
  warnings: Array<{
    accountId: string;
    email: string | null;
    window: "primary" | "secondary";
    level: "warning" | "critical";
    usedPercent: number;
    resetAt: number | null;
  }>;
  updatedAt: string | null;
}

interface ProbeResult {
  id: string;
  email: string | null;
  previousStatus: string;
  result: "alive" | "dead" | "skipped";
  error?: string;
  durationMs?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function fetchQuota(id: string): Promise<{ status: number; body: QuotaResponse | { error: string } }> {
  const res = await fetch(`${PROXY_URL}/auth/accounts/${id}/quota`, {
    headers: headers(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json();
  return { status: res.status, body: body as QuotaResponse | { error: string } };
}

async function probeRefresh(id: string): Promise<{ status: number; body: ProbeResult }> {
  const res = await fetch(`${PROXY_URL}/auth/accounts/${id}/refresh`, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return { status: res.status, body: await res.json() as ProbeResult };
}

async function getWarnings(): Promise<WarningsResponse> {
  const res = await fetch(`${PROXY_URL}/auth/quota/warnings`, {
    headers: headers(),
    signal: AbortSignal.timeout(5000),
  });
  return res.json() as Promise<WarningsResponse>;
}

// ── Setup ───────────────────────────────────────────────────────────

beforeAll(async () => {
  await checkProxy();
});

// ── Tests ───────────────────────────────────────────────────────────

describe("real: live quota fetch", () => {
  it("GET /auth/accounts/:id/quota returns upstream quota", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) {
      console.warn("[real] No active accounts, skipping");
      return;
    }

    const { status, body } = await fetchQuota(active[0].id);
    expect(status).toBe(200);

    const quota = body as QuotaResponse;
    expect(quota.quota).toBeDefined();
    expect(quota.quota.plan_type).toBeTruthy();
    expect(typeof quota.quota.rate_limit.allowed).toBe("boolean");
    expect(typeof quota.quota.rate_limit.limit_reached).toBe("boolean");
    expect(quota.raw).toBeDefined();
  }, TIMEOUT);

  it("quota has valid rate_limit structure", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) return;

    const { status, body } = await fetchQuota(active[0].id);
    if (status !== 200) return;

    const rl = (body as QuotaResponse).quota.rate_limit;
    if (rl.used_percent !== null) {
      expect(rl.used_percent).toBeGreaterThanOrEqual(0);
    }
    if (rl.reset_at !== null) {
      expect(rl.reset_at).toBeGreaterThan(1700000000);
    }
  }, TIMEOUT);

  it("quota includes secondary rate limit for plus/team accounts", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    const plusOrTeam = active.find((a) => a.planType === "plus" || a.planType === "team");
    if (!plusOrTeam) {
      console.warn("[real] No plus/team account available, skipping secondary quota test");
      return;
    }

    const { status, body } = await fetchQuota(plusOrTeam.id);
    if (status !== 200) return;

    const quota = (body as QuotaResponse).quota;
    expect(quota.secondary_rate_limit).toBeDefined();
    if (quota.secondary_rate_limit) {
      expect(typeof quota.secondary_rate_limit.limit_reached).toBe("boolean");
    }
  }, TIMEOUT);
});

describe("real: passive quota collection", () => {
  it("request populates cached quota via response headers", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) return;

    const { status } = await sendQuickRequest();
    expect(status).toBe(200);

    const after = await getActiveAccounts();
    const withQuota = after.filter((a) => a.quota != null);
    expect(withQuota.length).toBeGreaterThanOrEqual(1);

    const q = withQuota[0].quota!;
    expect(q.plan_type).toBeTruthy();
    expect(typeof q.rate_limit.limit_reached).toBe("boolean");
  }, TIMEOUT);

  it("request updates window counters", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) return;

    await sendQuickRequest();

    const after = await getActiveAccounts();
    const withWindow = after.filter((a) => a.usage.window_reset_at != null);
    if (withWindow.length > 0) {
      expect(withWindow[0].usage.window_reset_at).toBeGreaterThan(1700000000);
      if (withWindow[0].usage.limit_window_seconds != null) {
        expect(withWindow[0].usage.limit_window_seconds).toBeGreaterThan(0);
      }
    }
  }, TIMEOUT);
});

describe("real: account refresh / probe", () => {
  it("probe refreshes token and returns alive", async () => {
    if (skip()) return;

    const candidate = (await listAccounts()).find((a) => a.status === "active");
    if (!candidate) {
      console.warn("[real] No active accounts for refresh probe, skipping");
      return;
    }

    const { status, body } = await probeRefresh(candidate.id);
    expect(status).toBe(200);
    expect(["alive", "skipped"]).toContain(body.result);

    if (body.result === "alive") {
      expect(body.durationMs).toBeGreaterThan(0);
      const refreshed = (await listAccounts()).find((a) => a.id === candidate.id);
      expect(refreshed?.status).toBe("active");
    }

    if (body.result === "skipped") {
      expect(body.error).toBeTruthy();
    }
  }, TIMEOUT);

  it("probe on non-existent account returns 404", async () => {
    if (skip()) return;

    const { status } = await probeRefresh("nonexistent-id-12345");
    expect(status).toBe(404);
  }, 10_000);
});

describe("real: token expiry tracking", () => {
  it("active accounts have expiresAt metadata", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) return;

    for (const acct of active) {
      if (acct.expiresAt) {
        const ts = new Date(acct.expiresAt);
        expect(ts.getTime()).toBeGreaterThan(0);
        // Should not be way in the past for active accounts
        expect(ts.getTime()).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
      }
    }
  }, 10_000);
});

describe("real: quota warnings", () => {
  it("GET /auth/quota/warnings returns valid structure", async () => {
    if (skip()) return;

    const result = await getWarnings();
    expect(Array.isArray(result.warnings)).toBe(true);

    for (const w of result.warnings) {
      expect(w.accountId).toBeTruthy();
      expect(["primary", "secondary"]).toContain(w.window);
      expect(["warning", "critical"]).toContain(w.level);
      expect(w.usedPercent).toBeGreaterThanOrEqual(0);
    }
  }, 10_000);
});
