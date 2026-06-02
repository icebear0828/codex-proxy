/**
 * Shared test fixtures for proxy-handler integration tests.
 *
 * NOTE: vi.mock() blocks and the mockCreateResponse variable CANNOT be shared
 * across files — Vitest hoists mocks per-file. Each test file must duplicate
 * the mock setup. These helpers only cover non-mock utilities.
 */

import { vi } from "vitest";
import { Hono } from "hono";
import type { ProxyRequest } from "@src/routes/shared/proxy-handler-types.js";
import { createMockFormatAdapter } from "@helpers/format-adapter.js";
import { handleProxyRequest } from "@src/routes/shared/proxy-handler.js";

export function createMockAccountPool(overrides: Record<string, unknown> = {}) {
  return {
    acquire: vi.fn(() => ({ entryId: "e1", token: "tok", accountId: "acc1" })),
    release: vi.fn(),
    markRateLimited: vi.fn(),
    applyRateLimit429: vi.fn(),
    updateCachedQuota: vi.fn(),
    syncRateLimitWindow: vi.fn(),
    markStatus: vi.fn(),
    getEntry: vi.fn(() => ({ email: "test@test.com" })),
    recordEmptyResponse: vi.fn(),
    hasAvailableAccounts: vi.fn(() => true),
    getPoolSummary: vi.fn(() => ({
      total: 1, active: 0, expired: 0, quota_exhausted: 0,
      rate_limited: 0, refreshing: 0, disabled: 0, banned: 0,
    })),
    ...overrides,
  };
}

export function createDefaultRequest(): ProxyRequest {
  return {
    codexRequest: {
      model: "codex",
      instructions: "You are helpful",
      input: [{ role: "user" as const, content: "Hello" }],
      stream: true as const,
      store: false as const,
    },
    model: "codex",
    isStreaming: false,
  };
}

export function createStreamingRequest(): ProxyRequest {
  return { ...createDefaultRequest(), isStreaming: true };
}

export function buildTestApp(opts: {
  accountPool?: ReturnType<typeof createMockAccountPool>;
  fmt?: ReturnType<typeof createMockFormatAdapter>;
  req?: ProxyRequest;
  cookieJar?: unknown;
}) {
  const accountPool = opts.accountPool ?? createMockAccountPool();
  const fmt = opts.fmt ?? createMockFormatAdapter();
  const proxyReq = opts.req ?? createDefaultRequest();
  const cookieJar = opts.cookieJar ?? undefined;

  const app = new Hono();
  app.post("/test", (c) =>
    handleProxyRequest({
      c,
      accountPool: accountPool as never,
      cookieJar,
      req: proxyReq,
      fmt,
    }),
  );

  return { app, accountPool, fmt, proxyReq };
}
