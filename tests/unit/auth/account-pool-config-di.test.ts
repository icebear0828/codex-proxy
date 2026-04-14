/**
 * AccountPool tests using Config DI — ZERO vi.mock() calls.
 *
 * Demonstrates Phase 2 approach: constructor DI params + setConfigForTesting()
 * replace all vi.mock("config.js") patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";

// ── Setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  // Set a full config so getConfig() works (for validateProxyApiKey, etc.)
  setConfigForTesting(createMockConfig());
  // Prevent env token injection
  delete process.env.CODEX_JWT_TOKEN;
});

afterEach(() => {
  resetConfigForTesting();
});

// ── Constructor DI ────────────────────────────────────────────────────

describe("constructor DI: rotationStrategy", () => {
  it("uses injected rotation strategy (round_robin)", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "round_robin",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const t1 = createValidJwt({ accountId: "a1", email: "a@test.com" });
    const t2 = createValidJwt({ accountId: "a2", email: "b@test.com" });
    pool.addAccount(t1);
    pool.addAccount(t2);

    // Round-robin: should alternate between accounts
    const first = pool.acquire();
    pool.release(first!.entryId);
    const second = pool.acquire();
    pool.release(second!.entryId);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.entryId).not.toBe(second!.entryId);
  });

  it("uses injected rotation strategy (sticky)", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "sticky",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const t1 = createValidJwt({ accountId: "a1", email: "a@test.com" });
    const t2 = createValidJwt({ accountId: "a2", email: "b@test.com" });
    pool.addAccount(t1);
    pool.addAccount(t2);

    // Sticky: should prefer the most recently used account
    const first = pool.acquire();
    pool.release(first!.entryId);
    const second = pool.acquire();
    pool.release(second!.entryId);
    const third = pool.acquire();
    pool.release(third!.entryId);

    // After first use, sticky should keep returning the same account
    expect(second!.entryId).toBe(first!.entryId);
    expect(third!.entryId).toBe(first!.entryId);
  });
});

describe("constructor DI: initialToken", () => {
  it("adds the initial token on construction", () => {
    const token = createValidJwt({ accountId: "init-1", email: "init@test.com" });
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: token,
      rateLimitBackoffSeconds: 60,
    });

    const accounts = pool.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("init@test.com");
  });

  it("initialToken: null skips initial token (no fallback to config)", () => {
    // Config has a jwt_token, but initialToken: null should override it
    setConfigForTesting(createMockConfig({
      auth: { jwt_token: createValidJwt({ accountId: "cfg-token" }) },
    }));

    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    expect(pool.getAccounts()).toHaveLength(0);
  });
});

describe("constructor DI: rateLimitBackoffSeconds", () => {
  it("uses injected backoff in markRateLimited", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 5, // short backoff for test
    });

    const token = createValidJwt({ accountId: "rl-1" });
    pool.addAccount(token);
    const acq = pool.acquire()!;

    const before = Date.now();
    pool.markRateLimited(acq.entryId);
    const after = Date.now();

    // Account should be rate-limited
    const info = pool.getAccounts()[0];
    expect(info.status).toBe("rate_limited");

    // rate_limit_until should be ~5 seconds from now (jitter adds ±20%)
    const until = new Date(info.usage.rate_limit_until!).getTime();
    const expectedMin = before + 5 * 1000 * 0.7; // generous margin for jitter
    const expectedMax = after + 5 * 1000 * 1.3;
    expect(until).toBeGreaterThanOrEqual(expectedMin);
    expect(until).toBeLessThanOrEqual(expectedMax);
  });

  it("retryAfterSec overrides instance backoff", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 5,
    });

    const token = createValidJwt({ accountId: "rl-2" });
    pool.addAccount(token);
    const acq = pool.acquire()!;

    const before = Date.now();
    pool.markRateLimited(acq.entryId, { retryAfterSec: 120 });

    const info = pool.getAccounts()[0];
    const until = new Date(info.usage.rate_limit_until!).getTime();
    // Should be ~120s, not ~5s
    expect(until).toBeGreaterThan(before + 60_000);
  });
});

// ── setConfigForTesting fallback ──────────────────────────────────────

describe("constructor fallback to getConfig()", () => {
  it("reads rotation_strategy from config when not injected", () => {
    setConfigForTesting(createMockConfig({
      auth: { rotation_strategy: "round_robin" },
    }));

    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      initialToken: null,
    });

    const t1 = createValidJwt({ accountId: "fb-1", email: "a@test.com" });
    const t2 = createValidJwt({ accountId: "fb-2", email: "b@test.com" });
    pool.addAccount(t1);
    pool.addAccount(t2);

    const first = pool.acquire();
    pool.release(first!.entryId);
    const second = pool.acquire();
    pool.release(second!.entryId);

    // Round-robin should alternate
    expect(first!.entryId).not.toBe(second!.entryId);
  });

  it("reads jwt_token from config when initialToken not provided", () => {
    const configToken = createValidJwt({ accountId: "cfg-1", email: "cfg@test.com" });
    setConfigForTesting(createMockConfig({
      auth: { jwt_token: configToken },
    }));

    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
    });

    const accounts = pool.getAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email).toBe("cfg@test.com");
  });
});

// ── validateProxyApiKey via setConfigForTesting ───────────────────────

describe("validateProxyApiKey", () => {
  it("validates against config proxy_api_key", () => {
    setConfigForTesting(createMockConfig({
      server: { proxy_api_key: "my-secret-key" },
    }));

    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    expect(pool.validateProxyApiKey("my-secret-key")).toBe(true);
    expect(pool.validateProxyApiKey("wrong-key")).toBe(false);
  });

  it("validates against per-account proxyApiKey", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const token = createValidJwt({ accountId: "pk-1" });
    pool.addAccount(token);

    const accounts = pool.getAccounts();
    // Per-account key is auto-generated on addAccount
    const entry = pool.getEntry(accounts[0].id)!;
    expect(pool.validateProxyApiKey(entry.proxyApiKey)).toBe(true);
  });
});

// ── Core operations without config mock ──────────────────────────────

describe("acquire / release lifecycle", () => {
  beforeEach(() => {
    setConfigForTesting(createMockConfig({ auth: { max_concurrent_per_account: 1 } }));
  });

  it("acquires and releases accounts", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const token = createValidJwt({ accountId: "lc-1", email: "lc@test.com" });
    pool.addAccount(token);

    const acq = pool.acquire();
    expect(acq).not.toBeNull();
    expect(acq!.token).toBe(token);

    // While locked, no accounts available
    expect(pool.acquire()).toBeNull();

    // Release makes it available again
    pool.release(acq!.entryId, { input_tokens: 10, output_tokens: 20 });
    expect(pool.acquire()).not.toBeNull();
  });

  it("tracks usage across releases", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    const token = createValidJwt({ accountId: "us-1" });
    pool.addAccount(token);

    const acq1 = pool.acquire()!;
    pool.release(acq1.entryId, { input_tokens: 100, output_tokens: 50 });
    const acq2 = pool.acquire()!;
    pool.release(acq2.entryId, { input_tokens: 200, output_tokens: 100 });

    const info = pool.getAccounts()[0];
    expect(info.usage.request_count).toBe(2);
    expect(info.usage.input_tokens).toBe(300);
    expect(info.usage.output_tokens).toBe(150);
  });
});

describe("pool summary", () => {
  it("returns correct status counts", () => {
    const pool = new AccountPool({
      persistence: createMemoryPersistence(),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });

    pool.addAccount(createValidJwt({ accountId: "s1" }));
    pool.addAccount(createValidJwt({ accountId: "s2" }));
    pool.addAccount(createValidJwt({ accountId: "s3" }));

    // Disable one
    const accounts = pool.getAccounts();
    pool.markStatus(accounts[2].id, "disabled");

    const summary = pool.getPoolSummary();
    expect(summary.total).toBe(3);
    expect(summary.active).toBe(2);
    expect(summary.disabled).toBe(1);
  });
});
