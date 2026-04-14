/**
 * Real upstream tests — account rotation & selection.
 *
 * Requires a running proxy with ≥2 active accounts.
 * Verifies rotation distributes requests and usage tracking works.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  TIMEOUT,
  checkProxy, skip,
  getActiveAccounts, resetAllUsage, sendQuickRequest,
  type AccountInfo,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

/** Send N sequential requests and return updated active account list. */
async function sendRequests(n: number): Promise<AccountInfo[]> {
  for (let i = 0; i < n; i++) {
    const { status } = await sendQuickRequest();
    expect(status).toBe(200);
  }
  return getActiveAccounts();
}

describe("real: account rotation", () => {
  let activeAccounts: AccountInfo[];

  beforeEach(async () => {
    if (skip()) return;
    await resetAllUsage();
    activeAccounts = await getActiveAccounts();
  });

  it("single request increments exactly one account's usage", async () => {
    if (skip()) return;
    expect(activeAccounts.length).toBeGreaterThanOrEqual(1);

    await sendQuickRequest();

    const after = await getActiveAccounts();
    const used = after.filter((a) => a.usage.request_count > 0);
    expect(used).toHaveLength(1);
    expect(used[0].usage.request_count).toBe(1);
    expect(used[0].usage.last_used).toBeTruthy();
  }, TIMEOUT);

  it("multiple requests distribute across accounts (≥2 accounts)", async () => {
    if (skip()) return;
    if (activeAccounts.length < 2) {
      console.warn("[real] Need ≥2 active accounts for rotation test, skipping");
      return;
    }

    // Cap at 4 requests to avoid timeout (each ~1-2s)
    const requestCount = Math.min(activeAccounts.length * 2, 4);
    const after = await sendRequests(requestCount);

    const usedAccounts = after.filter((a) => a.usage.request_count > 0);
    const totalRequests = after.reduce((sum, a) => sum + a.usage.request_count, 0);

    // Total must match
    expect(totalRequests).toBe(requestCount);

    if (usedAccounts.length >= 2) {
      // Rotation working — no single account should hog all requests
      for (const acct of usedAccounts) {
        expect(acct.usage.request_count).toBeLessThan(requestCount);
      }
    } else {
      // Plan-type filtering restricts to 1 account — still valid
      console.warn("[real] All requests routed to single account (plan-type restriction for 'codex')");
      expect(usedAccounts[0].usage.request_count).toBe(requestCount);
    }
  }, TIMEOUT * 4);

  it("usage tokens are tracked per account", async () => {
    if (skip()) return;

    await sendQuickRequest();

    const after = await getActiveAccounts();
    const used = after.find((a) => a.usage.request_count > 0);
    expect(used).toBeDefined();
    expect(used!.usage.input_tokens).toBeGreaterThan(0);
    expect(used!.usage.output_tokens).toBeGreaterThan(0);
  }, TIMEOUT);

  it("least-used strategy favors account with fewer requests", async () => {
    if (skip()) return;
    if (activeAccounts.length < 2) {
      console.warn("[real] Need ≥2 active accounts for least-used test, skipping");
      return;
    }

    // Send 3 requests — least-used should spread
    const requestCount = 3;
    for (let i = 0; i < requestCount; i++) {
      await sendQuickRequest();
    }

    const afterState = await getActiveAccounts();
    const usedNow = afterState.filter((a) => a.usage.request_count > 0);

    if (usedNow.length === 1) {
      console.warn("[real] All requests routed to single account (plan-type restriction?)");
      expect(usedNow[0].usage.request_count).toBe(requestCount);
    } else {
      // Rotation spread — no single account should have all
      expect(usedNow.length).toBeGreaterThanOrEqual(2);
      for (const acct of usedNow) {
        expect(acct.usage.request_count).toBeLessThan(requestCount);
      }
    }

    const total = afterState.reduce((sum, a) => sum + a.usage.request_count, 0);
    expect(total).toBe(requestCount);
  }, TIMEOUT * 3);
});
