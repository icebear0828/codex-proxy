/**
 * Stress test: account rotation fairness + deadlock detection.
 * Run with: npm run test:stress
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
    server: { proxy_api_key: null },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => ({ email: "test@test.com", chatgpt_plan_type: "free" })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

import { AccountPool } from "@src/auth/account-pool.js";

describe("account rotation stress", () => {
  it("distributes requests fairly across M accounts with N concurrent", () => {
    const M = 5;
    const N = 100;
    const pool = new AccountPool();

    for (let i = 0; i < M; i++) {
      pool.addAccount(`token-${i}`);
    }

    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const acq = pool.acquire();
      expect(acq).not.toBeNull();
      counts.set(acq!.entryId, (counts.get(acq!.entryId) ?? 0) + 1);
      pool.release(acq!.entryId, { input_tokens: 1, output_tokens: 1 });
    }

    // Each account should get roughly N/M requests (20 each)
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(N / M - 5);
      expect(count).toBeLessThanOrEqual(N / M + 5);
    }

    pool.destroy();
  });

  it("handles acquire/release without deadlock", () => {
    const pool = new AccountPool();
    pool.addAccount("token-0");
    pool.addAccount("token-1");

    // Rapid acquire-release cycles
    for (let i = 0; i < 1000; i++) {
      const acq = pool.acquire();
      expect(acq).not.toBeNull();
      pool.release(acq!.entryId);
    }

    pool.destroy();
  });
});
