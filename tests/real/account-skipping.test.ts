/**
 * Real upstream tests — abnormal account skipping.
 *
 * Verifies the proxy correctly skips disabled accounts,
 * falling back to healthy accounts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers,
  listAccounts, getActiveAccounts, setAccountStatus, resetUsage, sendQuickRequest,
  isolateAccount,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

// ── Helpers ─────────────────────────────────────────────────────────

interface HealthResult {
  summary: { total: number; alive: number; dead: number; skipped: number };
  results: Array<{ id: string; result: string; error?: string }>;
}

async function healthCheck(ids?: string[]): Promise<HealthResult> {
  const res = await fetch(`${PROXY_URL}/auth/accounts/health-check`, {
    method: "POST",
    headers: headers(),
    body: ids ? JSON.stringify({ ids }) : "{}",
    signal: AbortSignal.timeout(120_000),
  });
  return res.json() as Promise<HealthResult>;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("real: disabled account skipping", () => {
  it("disabled accounts are not selected for requests", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    // Pick a victim that has RT (safe to disable/restore)
    const victim = active.find((a) => a.hasRefreshToken);
    if (!victim || active.length < 2) {
      console.warn("[real] Need ≥2 active accounts (≥1 with RT) to test disabled skipping, skipping");
      return;
    }

    try {
      await setAccountStatus([victim.id], "disabled");
      for (const a of active.filter((x) => x.id !== victim.id)) await resetUsage(a.id);

      const { status } = await sendQuickRequest();
      expect(status).toBe(200);

      const afterAccounts = await listAccounts();
      const victimAfter = afterAccounts.find((a) => a.id === victim.id)!;
      expect(victimAfter.status).toBe("disabled");

      const usedActive = afterAccounts.filter((a) => a.status === "active" && a.usage.request_count > 0);
      expect(usedActive.length).toBeGreaterThanOrEqual(1);
    } finally {
      await setAccountStatus([victim.id], "active");
    }
  }, TIMEOUT * 2);

  it("all accounts disabled returns 503 or 401", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) {
      console.warn("[real] No active accounts, skipping");
      return;
    }

    // Only disable accounts with RT (safe to restore)
    const withRt = active.filter((a) => a.hasRefreshToken);
    const withoutRt = active.filter((a) => !a.hasRefreshToken);
    // If there are no-RT accounts we can't safely disable them all
    if (withoutRt.length > 0) {
      console.warn(`[real] ${withoutRt.length} active accounts without RT — only disabling ${withRt.length} with RT`);
    }

    try {
      await setAccountStatus(withRt.map((a) => a.id), "disabled");
      // If no-RT accounts remain active, this won't be a full blackout — skip
      if (withoutRt.length > 0) {
        console.warn("[real] Cannot fully blackout — no-RT accounts still active, skipping");
        return;
      }
      const { status } = await sendQuickRequest();
      expect([401, 503]).toContain(status);
    } finally {
      await setAccountStatus(withRt.map((a) => a.id), "active");
    }
  }, TIMEOUT);
});

describe("real: account health check", () => {
  it("health check reports alive for active accounts", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length === 0) {
      console.warn("[real] No active accounts, skipping");
      return;
    }

    const result = await healthCheck([active[0].id]);
    expect(result.summary.total).toBe(1);
    expect(result.results[0].result).toBe("alive");
  }, TIMEOUT);

  it("health check on all accounts returns summary", async () => {
    if (skip()) return;

    const allAccounts = await listAccounts();
    if (allAccounts.length === 0) return;

    const result = await healthCheck();
    expect(result.summary.total).toBe(allAccounts.length);
    expect(result.summary.alive + result.summary.dead + result.summary.skipped)
      .toBe(result.summary.total);
  }, 120_000);
});

describe("real: rate-limited account recovery", () => {
  it("rate-limited accounts have valid rate_limit_until timestamp", async () => {
    if (skip()) return;

    const accounts = await listAccounts();
    for (const acct of accounts) {
      if (acct.usage.rate_limit_until) {
        const ts = new Date(acct.usage.rate_limit_until);
        expect(ts.getTime()).toBeGreaterThan(0);
      }
    }
  }, 10_000);

  it("requests succeed when at least one account is healthy", async () => {
    if (skip()) return;

    const active = await getActiveAccounts();
    if (active.length < 1) {
      console.warn("[real] No active accounts, skipping");
      return;
    }

    const { status } = await sendQuickRequest();
    expect(status).toBe(200);
  }, TIMEOUT);
});
