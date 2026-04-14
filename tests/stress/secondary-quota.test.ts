/**
 * Stress test: secondary quota rotation under concurrent load.
 *
 * Validates that the secondary rate limit (e.g. weekly cap) is properly
 * considered during account rotation — accounts with secondary exhaustion
 * are skipped, backoff uses max(primary, secondary) reset_at, and all-
 * exhausted yields 401 (isAuthenticated=false when no active accounts).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTransportPost,
  resetTransportState,
  getMockTransport,
} from "@helpers/e2e-setup.js";
import { buildTextStreamChunks } from "@helpers/sse.js";
import { createValidJwt } from "@helpers/jwt.js";
import type { TlsTransportResponse } from "@src/tls/transport.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createChatRoutes } from "@src/routes/chat.js";
import { createModelRoutes } from "@src/routes/models.js";
import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CookieJar } from "@src/proxy/cookie-jar.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { loadStaticModels } from "@src/models/model-store.js";

// ── App lifecycle ───────────────────────────────────────────────────

interface TestContext {
  app: Hono;
  accountPool: AccountPool;
  cookieJar: CookieJar;
  proxyPool: ProxyPool;
  /** token → account index mapping */
  tokenMap: Map<string, number>;
  /** entry IDs by index */
  entryIds: string[];
}

function buildApp(accountCount: number): TestContext {
  loadStaticModels();
  const accountPool = new AccountPool();
  const cookieJar = new CookieJar();
  const proxyPool = new ProxyPool();
  const tokenMap = new Map<string, number>();
  const entryIds: string[] = [];

  for (let i = 0; i < accountCount; i++) {
    const token = createValidJwt({
      accountId: `acct-sq-${i}`,
      email: `sq${i}@test.com`,
      planType: "plus",
    });
    const id = accountPool.addAccount(token);
    tokenMap.set(token, i);
    entryIds.push(id);
  }

  const app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createChatRoutes(accountPool, cookieJar, proxyPool));
  app.route("/", createModelRoutes());
  app.route("/", createWebRoutes(accountPool));
  return { app, accountPool, cookieJar, proxyPool, tokenMap, entryIds };
}

// ── Helpers ─────────────────────────────────────────────────────────

function chatRequest(app: Hono, body: unknown) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function defaultBody(overrides?: Record<string, unknown>) {
  return {
    model: "codex",
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...overrides,
  };
}

/** Build a TlsTransportResponse with rate-limit headers injected. */
function makeRateLimitResponse(
  sseText: string,
  rlHeaders: Record<string, string>,
): TlsTransportResponse {
  const headers = new Headers({ "content-type": "text/event-stream" });
  for (const [k, v] of Object.entries(rlHeaders)) {
    headers.set(k, v);
  }
  const encoder = new TextEncoder();
  return {
    status: 200,
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseText));
        controller.close();
      },
    }),
    setCookieHeaders: [],
  };
}

/** Build a 429 error response with rate-limit headers. */
function make429Response(
  rlHeaders: Record<string, string>,
  retryAfter = 60,
): TlsTransportResponse {
  const headers = new Headers({
    "content-type": "application/json",
    "retry-after": String(retryAfter),
  });
  for (const [k, v] of Object.entries(rlHeaders)) {
    headers.set(k, v);
  }
  const encoder = new TextEncoder();
  const body = JSON.stringify({
    detail: { clears_in: retryAfter, message: "Rate limited" },
  });
  return {
    status: 429,
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    setCookieHeaders: [],
  };
}

const nowUnix = () => Math.floor(Date.now() / 1000);

/** Extract account index from transport headers. */
function resolveAccountIndex(
  headers: Record<string, string>,
  tokenMap: Map<string, number>,
): number {
  const auth = headers["Authorization"] ?? headers["authorization"] ?? "";
  const token = auth.replace("Bearer ", "");
  return tokenMap.get(token) ?? -1;
}

/** Standard healthy rate-limit headers. */
function healthyHeaders(): Record<string, string> {
  return {
    "x-codex-primary-used-percent": "30",
    "x-codex-primary-window-minutes": "60",
    "x-codex-primary-reset-at": String(nowUnix() + 3600),
    "x-codex-secondary-used-percent": "20",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(nowUnix() + 604800),
  };
}

/** Secondary-exhausted rate-limit headers. */
function secondaryExhaustedHeaders(): Record<string, string> {
  return {
    "x-codex-primary-used-percent": "30",
    "x-codex-primary-window-minutes": "60",
    "x-codex-primary-reset-at": String(nowUnix() + 3600),
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(nowUnix() + 604800),
  };
}

/** Primary-exhausted rate-limit headers. */
function primaryExhaustedHeaders(): Record<string, string> {
  return {
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "60",
    "x-codex-primary-reset-at": String(nowUnix() + 3600),
    "x-codex-secondary-used-percent": "20",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(nowUnix() + 604800),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("secondary quota rotation", () => {
  let ctx: TestContext;

  afterEach(() => {
    if (ctx) {
      ctx.cookieJar.destroy();
      ctx.proxyPool.destroy();
      ctx.accountPool.destroy();
    }
  });

  // ── 1. Secondary exhaustion routing ───────────────────────────────

  describe("secondary exhaustion routing", () => {
    beforeEach(() => {
      resetTransportState();
    });

    it("sequential requests avoid secondary-exhausted accounts after priming", async () => {
      ctx = buildApp(3);
      let counter = 0;

      setTransportPost(async (_url, headers) => {
        counter++;
        await new Promise((r) => setTimeout(r, 10));
        const idx = resolveAccountIndex(headers, ctx.tokenMap);
        const rl = idx === 2 ? healthyHeaders() : secondaryExhaustedHeaders();
        return makeRateLimitResponse(
          buildTextStreamChunks(`resp_${counter}`, `Response ${counter}`),
          rl,
        );
      });

      // Phase 1: prime all 3 accounts sequentially so quota cache populates
      for (let i = 0; i < 3; i++) {
        const res = await chatRequest(ctx.app, defaultBody());
        expect(res.status).toBe(200);
      }

      // Verify accounts 0,1 are now marked rate_limited (proactive marking)
      const afterPrime = ctx.accountPool.getAccounts();
      const limited = afterPrime.filter((a) => a.status === "rate_limited");
      expect(limited.length).toBeGreaterThanOrEqual(2);

      // Record account 2's request count after priming
      const acct2Before = afterPrime.find((a) => a.id === ctx.entryIds[2])!;
      const acct2CountBefore = acct2Before.usage.request_count;

      // Phase 2: fire 3 concurrent requests (max_concurrent_per_account=3)
      // All should route to account 2 (the only healthy one)
      const requests = Array.from({ length: 3 }, () =>
        chatRequest(ctx.app, defaultBody()),
      );
      const responses = await Promise.all(requests);

      const successCount = responses.filter((r) => r.status === 200).length;
      expect(successCount).toBe(3);

      // Verify only account 2 got the concurrent requests
      const afterConcurrent = ctx.accountPool.getAccounts();
      const acct2After = afterConcurrent.find((a) => a.id === ctx.entryIds[2])!;
      expect(acct2After.usage.request_count - acct2CountBefore).toBe(3);

      // Accounts 0,1 should still be rate_limited with no new requests
      for (const id of [ctx.entryIds[0], ctx.entryIds[1]]) {
        const acct = afterConcurrent.find((a) => a.id === id)!;
        expect(acct.status).toBe("rate_limited");
      }
    });

    it("high throughput: 20 sequential requests all route to healthy account", async () => {
      ctx = buildApp(3);
      let counter = 0;

      setTransportPost(async (_url, headers) => {
        counter++;
        const idx = resolveAccountIndex(headers, ctx.tokenMap);
        const rl = idx === 2 ? healthyHeaders() : secondaryExhaustedHeaders();
        return makeRateLimitResponse(
          buildTextStreamChunks(`resp_${counter}`, `Response ${counter}`),
          rl,
        );
      });

      // Prime
      for (let i = 0; i < 3; i++) {
        await chatRequest(ctx.app, defaultBody());
      }

      const acct2Before = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[2])!;
      const countBefore = acct2Before.usage.request_count;

      // 20 sequential requests
      for (let i = 0; i < 20; i++) {
        const res = await chatRequest(ctx.app, defaultBody());
        expect(res.status).toBe(200);
      }

      const acct2After = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[2])!;
      expect(acct2After.usage.request_count - countBefore).toBe(20);
    });
  });

  // ── 2. Mixed primary + secondary exhaustion ───────────────────────

  describe("mixed primary + secondary exhaustion", () => {
    beforeEach(() => {
      resetTransportState();
    });

    it("all traffic routes to the only healthy account", async () => {
      ctx = buildApp(3);
      let counter = 0;

      setTransportPost(async (_url, headers) => {
        counter++;
        await new Promise((r) => setTimeout(r, 10));
        const idx = resolveAccountIndex(headers, ctx.tokenMap);
        let rl: Record<string, string>;
        if (idx === 0) rl = primaryExhaustedHeaders();
        else if (idx === 1) rl = secondaryExhaustedHeaders();
        else rl = healthyHeaders();
        return makeRateLimitResponse(
          buildTextStreamChunks(`resp_${counter}`, `Response ${counter}`),
          rl,
        );
      });

      // Prime all 3 sequentially
      for (let i = 0; i < 3; i++) {
        await chatRequest(ctx.app, defaultBody());
      }

      // Verify accounts 0 (primary) and 1 (secondary) are marked
      const accounts = ctx.accountPool.getAccounts();
      const acct0 = accounts.find((a) => a.id === ctx.entryIds[0])!;
      const acct1 = accounts.find((a) => a.id === ctx.entryIds[1])!;
      expect(acct0.status).toBe("rate_limited");
      expect(acct1.status).toBe("rate_limited");

      const acct2Before = accounts.find((a) => a.id === ctx.entryIds[2])!;
      const countBefore = acct2Before.usage.request_count;

      // Fire 3 concurrent — should all go to account 2
      const responses = await Promise.all(
        Array.from({ length: 3 }, () => chatRequest(ctx.app, defaultBody())),
      );
      expect(responses.filter((r) => r.status === 200).length).toBe(3);

      const acct2After = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[2])!;
      expect(acct2After.usage.request_count - countBefore).toBe(3);
    });
  });

  // ── 3. Proactive marking via response headers ─────────────────────

  describe("proactive marking via response headers", () => {
    beforeEach(() => {
      resetTransportState();
    });

    it("account marked after receiving exhausted headers, subsequent requests reroute", async () => {
      ctx = buildApp(2);
      let counter = 0;

      setTransportPost(async (_url, headers) => {
        counter++;
        await new Promise((r) => setTimeout(r, 10));
        const idx = resolveAccountIndex(headers, ctx.tokenMap);
        const rl = idx === 0 ? secondaryExhaustedHeaders() : healthyHeaders();
        return makeRateLimitResponse(
          buildTextStreamChunks(`resp_${counter}`, `Response ${counter}`),
          rl,
        );
      });

      // Fire 2 sequential requests to prime both accounts
      await chatRequest(ctx.app, defaultBody());
      await chatRequest(ctx.app, defaultBody());

      // Account 0 should be proactively marked
      const acct0 = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[0])!;
      expect(acct0.status).toBe("rate_limited");

      // Account 1 should be healthy
      const acct1 = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[1])!;
      expect(acct1.status).toBe("active");

      const acct1CountBefore = acct1.usage.request_count;

      // Fire 3 concurrent (max_concurrent=3 on 1 account) — all to account 1
      const responses = await Promise.all(
        Array.from({ length: 3 }, () => chatRequest(ctx.app, defaultBody())),
      );
      expect(responses.filter((r) => r.status === 200).length).toBe(3);

      const acct1After = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[1])!;
      expect(acct1After.usage.request_count - acct1CountBefore).toBe(3);
    });
  });

  // ── 4. 429 backoff uses max(primary, secondary) reset_at ──────────

  describe("429 backoff uses max reset_at", () => {
    beforeEach(() => {
      resetTransportState();
    });

    it("backoff picks secondary reset_at when cached quota shows secondary exhausted", async () => {
      // Scenario: account 0 has cached quota with secondary limit_reached=true
      // (set by a prior response's proactive marking). A concurrent request
      // on account 0 gets 429 — the error handler should use max(primary, secondary)
      // reset_at for backoff, not just the 429's retry-after.
      //
      // To make acquire() still select account 0 despite limit_reached, we
      // directly call updateCachedQuota AFTER acquire but BEFORE the 429 lands.
      // In practice, this simulates a concurrent response updating the cache.
      ctx = buildApp(2);
      const primaryResetAt = nowUnix() + 60;
      const secondaryResetAt = nowUnix() + 7200; // 2 hours

      let callCount = 0;
      setTransportPost(async (_url, headers) => {
        callCount++;
        const idx = resolveAccountIndex(headers, ctx.tokenMap);
        if (idx === 0) {
          // Simulate concurrent cache update: another response marked the quota
          // as secondary-exhausted between acquire() and this 429.
          ctx.accountPool.updateCachedQuota(ctx.entryIds[0], {
            plan_type: "plus",
            rate_limit: {
              allowed: true,
              limit_reached: false,
              used_percent: 80,
              reset_at: primaryResetAt,
              limit_window_seconds: 3600,
            },
            secondary_rate_limit: {
              limit_reached: true,
              used_percent: 100,
              reset_at: secondaryResetAt,
              limit_window_seconds: 604800,
            },
            code_review_rate_limit: null,
          });
          await new Promise((r) => setTimeout(r, 10));
          return make429Response({
            "x-codex-primary-used-percent": "80",
            "x-codex-primary-reset-at": String(primaryResetAt),
            "x-codex-secondary-used-percent": "100",
            "x-codex-secondary-reset-at": String(secondaryResetAt),
            "x-codex-secondary-window-minutes": "10080",
          });
        }
        return makeRateLimitResponse(
          buildTextStreamChunks(`resp_${callCount}`, "OK"),
          healthyHeaders(),
        );
      });

      // Fire request — account 0 gets 429, handler reads cached quota with
      // secondary limit_reached=true → uses maxResetAt for backoff
      await chatRequest(ctx.app, defaultBody());

      const acct0 = ctx.accountPool.getAccounts().find((a) => a.id === ctx.entryIds[0])!;
      expect(acct0.status).toBe("rate_limited");

      // rate_limit_until should reflect secondaryResetAt (±30% for jitter + timing)
      expect(acct0.usage.rate_limit_until).not.toBeNull();
      const rateLimitUntilSec = new Date(acct0.usage.rate_limit_until!).getTime() / 1000;
      const expectedBackoff = secondaryResetAt - nowUnix();
      const actualBackoff = rateLimitUntilSec - nowUnix();
      expect(actualBackoff).toBeGreaterThan(expectedBackoff * 0.6);
      expect(actualBackoff).toBeLessThan(expectedBackoff * 1.5);
    });
  });

  // ── 5. All accounts exhausted ─────────────────────────────────────

  describe("all accounts exhausted", () => {
    beforeEach(() => {
      resetTransportState();
      vi.mocked(getMockTransport().post).mockClear();
    });

    it("returns 401 when all accounts are rate_limited (not authenticated)", async () => {
      ctx = buildApp(3);

      // Mark all accounts as rate_limited with long backoff
      for (const id of ctx.entryIds) {
        ctx.accountPool.markRateLimited(id, { retryAfterSec: 7200 });
      }

      // Verify all marked
      const accounts = ctx.accountPool.getAccounts();
      expect(accounts.every((a) => a.status === "rate_limited")).toBe(true);

      // Fire 6 concurrent requests — all should get 401 (isAuthenticated=false)
      const responses = await Promise.all(
        Array.from({ length: 6 }, () => chatRequest(ctx.app, defaultBody())),
      );

      for (const res of responses) {
        expect(res.status).toBe(401);
      }

      // Transport should never have been called
      expect(getMockTransport().post).not.toHaveBeenCalled();
    });

    it("concurrent burst returns 401 when all have secondary exhaustion", async () => {
      ctx = buildApp(3);

      // Set cached quota with secondary exhaustion + mark rate_limited
      for (const id of ctx.entryIds) {
        ctx.accountPool.updateCachedQuota(id, {
          plan_type: "plus",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            used_percent: 30,
            reset_at: nowUnix() + 3600,
            limit_window_seconds: 3600,
          },
          secondary_rate_limit: {
            limit_reached: true,
            used_percent: 100,
            reset_at: nowUnix() + 604800,
            limit_window_seconds: 604800,
          },
          code_review_rate_limit: null,
        });
        ctx.accountPool.markRateLimited(id, { retryAfterSec: 604800 });
      }

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => chatRequest(ctx.app, defaultBody())),
      );

      expect(responses.every((r) => r.status === 401)).toBe(true);
      expect(getMockTransport().post).not.toHaveBeenCalled();
    });
  });
});
