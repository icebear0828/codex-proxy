/**
 * AccountImportService tests — zero vi.mock().
 * All deps injected via constructor.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { createMockConfig } from "@helpers/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import {
  AccountImportService,
  type ImportDeps,
} from "@src/services/account-import.js";

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
}

function makeScheduler(): {
  scheduleOne(id: string, token: string): void;
  calls: Array<{ id: string; token: string }>;
} {
  const calls: Array<{ id: string; token: string }> = [];
  return {
    scheduleOne(id: string, token: string) {
      calls.push({ id, token });
    },
    calls,
  };
}

/** Default deps: tokens always valid, refresh returns a valid JWT. */
function makeDeps(overrides?: Partial<ImportDeps>): ImportDeps {
  return {
    validateToken: (t) => ({ valid: true }),
    refreshToken: async () => ({
      access_token: createValidJwt({ accountId: "refreshed-acct" }),
      refresh_token: "new_rt",
    }),
    getProxyUrl: () => null,
    ...overrides,
  };
}

describe("AccountImportService", () => {
  describe("importMany", () => {
    it("adds accounts from valid tokens", async () => {
      const pool = makePool();
      const scheduler = makeScheduler();
      const svc = new AccountImportService(pool, scheduler, makeDeps());

      const result = await svc.importMany([
        { token: createValidJwt({ accountId: "a1", email: "a1@test.com" }) },
        { token: createValidJwt({ accountId: "a2", email: "a2@test.com" }) },
      ]);

      expect(result.added).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(pool.getAccounts()).toHaveLength(2);
      expect(scheduler.calls).toHaveLength(2);
    });

    it("counts failed for invalid tokens", async () => {
      const pool = makePool();
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps({
          validateToken: () => ({ valid: false, error: "bad token" }),
        }),
      );

      const result = await svc.importMany([{ token: "invalid" }]);

      expect(result.failed).toBe(1);
      expect(result.added).toBe(0);
      expect(result.errors).toEqual(["bad token"]);
      expect(pool.getAccounts()).toHaveLength(0);
    });

    it("exchanges refresh token when no access token provided", async () => {
      const pool = makePool();
      const scheduler = makeScheduler();
      const refreshedJwt = createValidJwt({ accountId: "rt-acct" });
      const svc = new AccountImportService(
        pool,
        scheduler,
        makeDeps({
          refreshToken: async () => ({
            access_token: refreshedJwt,
            refresh_token: "new_rt",
          }),
        }),
      );

      const result = await svc.importMany([
        { refreshToken: "old_rt" },
      ]);

      expect(result.added).toBe(1);
      expect(result.failed).toBe(0);
      expect(pool.getAccounts()).toHaveLength(1);
    });

    it("prefers new refresh token from exchange over original", async () => {
      const pool = makePool();
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps({
          refreshToken: async () => ({
            access_token: createValidJwt({ accountId: "rt-rot" }),
            refresh_token: "rotated_rt",
          }),
        }),
      );

      await svc.importMany([{ refreshToken: "original_rt" }]);

      const entries = pool.getAllEntries();
      expect(entries[0].refreshToken).toBe("rotated_rt");
    });

    it("stores null RT when exchange returns no new RT (all RTs are one-time)", async () => {
      const pool = makePool();
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps({
          refreshToken: async () => ({
            access_token: createValidJwt({ accountId: "rt-keep" }),
            // No refresh_token in response — old RT is consumed and dead
          }),
        }),
      );

      await svc.importMany([{ refreshToken: "keep_this_rt" }]);

      const entries = pool.getAllEntries();
      expect(entries[0].refreshToken).toBeNull();
    });

    it("counts failed when refresh exchange throws", async () => {
      const svc = new AccountImportService(
        makePool(),
        makeScheduler(),
        makeDeps({
          refreshToken: async () => {
            throw new Error("network error");
          },
        }),
      );

      const result = await svc.importMany([{ refreshToken: "bad_rt" }]);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain("network error");
    });

    it("sets label when provided", async () => {
      const pool = makePool();
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps(),
      );

      await svc.importMany([
        {
          token: createValidJwt({ accountId: "a1", email: "a1@test.com" }),
          label: "Team Alpha",
        },
      ]);

      expect(pool.getAccounts()[0].label).toBe("Team Alpha");
    });

    it("counts updated for duplicate accounts", async () => {
      const pool = makePool();
      const jwt = createValidJwt({ accountId: "dup", email: "dup@test.com" });
      pool.addAccount(jwt); // pre-existing

      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps(),
      );
      const result = await svc.importMany([{ token: jwt }]);

      expect(result.updated).toBe(1);
      expect(result.added).toBe(0);
      expect(pool.getAccounts()).toHaveLength(1);
    });

    it("handles mixed success and failure", async () => {
      const pool = makePool();
      let callCount = 0;
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps({
          validateToken: (t) => {
            callCount++;
            // Fail every other token
            return callCount % 2 === 0
              ? { valid: false, error: "bad" }
              : { valid: true };
          },
        }),
      );

      const result = await svc.importMany([
        { token: createValidJwt({ accountId: "a1" }) }, // valid (call 1)
        { token: "bad-token" },                          // invalid (call 2)
        { token: createValidJwt({ accountId: "a3" }) }, // valid (call 3)
      ]);

      expect(result.added).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  describe("importOne", () => {
    it("adds account from valid token", async () => {
      const pool = makePool();
      const scheduler = makeScheduler();
      const jwt = createValidJwt({ accountId: "one", email: "one@test.com" });
      const svc = new AccountImportService(pool, scheduler, makeDeps());

      const result = await svc.importOne(jwt);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.account.email).toBe("one@test.com");
      }
      expect(scheduler.calls).toHaveLength(1);
    });

    it("returns validation error for invalid token", async () => {
      const svc = new AccountImportService(
        makePool(),
        makeScheduler(),
        makeDeps({
          validateToken: () => ({ valid: false, error: "expired" }),
        }),
      );

      const result = await svc.importOne("bad");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("validation");
        expect(result.error).toBe("expired");
      }
    });

    it("exchanges refresh token when only refreshToken provided", async () => {
      const pool = makePool();
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps(),
      );

      const result = await svc.importOne(undefined, "some_rt");

      expect(result.ok).toBe(true);
      expect(pool.getAccounts()).toHaveLength(1);
    });

    it("returns refresh_failed when exchange throws", async () => {
      const svc = new AccountImportService(
        makePool(),
        makeScheduler(),
        makeDeps({
          refreshToken: async () => {
            throw new Error("401 unauthorized");
          },
        }),
      );

      const result = await svc.importOne(undefined, "bad_rt");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("refresh_failed");
        expect(result.error).toContain("401 unauthorized");
      }
    });

    it("returns validation error when neither token nor refreshToken", async () => {
      const svc = new AccountImportService(
        makePool(),
        makeScheduler(),
        makeDeps(),
      );

      const result = await svc.importOne(undefined, undefined);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe("validation");
        expect(result.error).toContain("Either token or refreshToken");
      }
    });
  });

  describe("warmup", () => {
    it("does not call warmup for importOne (single add)", async () => {
      const pool = makePool();
      let warmupCalled = false;
      const jwt = createValidJwt({ accountId: "warm-one", email: "w@test.com" });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        warmup: async () => { warmupCalled = true; },
      }));

      const result = await svc.importOne(jwt);

      expect(result.ok).toBe(true);
      expect(warmupCalled).toBe(false);
    });

    it("calls warmup for each account in importMany", async () => {
      const pool = makePool();
      const warmupCalls: string[] = [];
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        warmup: async (entryId) => { warmupCalls.push(entryId); },
      }));

      await svc.importMany([
        { token: createValidJwt({ accountId: "w1", email: "w1@test.com" }) },
        { token: createValidJwt({ accountId: "w2", email: "w2@test.com" }) },
      ]);

      expect(warmupCalls).toHaveLength(2);
    });

    it("does not fail import when warmup throws", async () => {
      const pool = makePool();
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        warmup: async () => { throw new Error("warmup network error"); },
      }));

      const result = await svc.importOne(
        createValidJwt({ accountId: "w-fail", email: "wf@test.com" }),
      );

      expect(result.ok).toBe(true);
      expect(pool.getAccounts()).toHaveLength(1);
    });

    it("skips warmup when dep not provided", async () => {
      const pool = makePool();
      // makeDeps() has no warmup by default
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps());

      const result = await svc.importOne(
        createValidJwt({ accountId: "no-warm", email: "nw@test.com" }),
      );

      expect(result.ok).toBe(true);
      expect(pool.getAccounts()).toHaveLength(1);
    });
  });
});
