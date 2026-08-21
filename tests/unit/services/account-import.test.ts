/**
 * AccountImportService tests — zero vi.mock().
 * All deps injected via constructor.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createJwt, createValidJwt } from "@helpers/jwt.js";
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

    it("discovers and stores identity for a valid accountId-less Sub2API token without consuming RT", async () => {
      const pool = makePool();
      const refreshToken = vi.fn();
      const discoverIdentity = vi.fn(async (_token, metadata) => ({
        ...metadata,
        accountId: "workspace-discovered",
        planType: "plus",
        accountIdSource: "upstream_discovery" as const,
      }));
      const token = createJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": {
          poid: "org-portable",
          user_id: "user-portable",
        },
        "https://api.openai.com/profile": { email: "portable@example.com" },
      });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        validateToken: () => ({
          valid: false,
          error: "Token missing chatgpt_account_id claim",
        }),
        refreshToken,
        discoverIdentity,
      }));

      const result = await svc.importMany([{
        token,
        refreshToken: "rt_must_not_be_consumed",
        organizationId: "org-portable",
        userIdHint: "user-portable",
        planTypeHint: "plus",
        sourceFormat: "sub2api",
      }]);

      expect(result).toMatchObject({ added: 1, failed: 0 });
      expect(refreshToken).not.toHaveBeenCalled();
      expect(discoverIdentity).toHaveBeenCalledTimes(1);
      expect(pool.getAllEntries()[0]).toMatchObject({
        accountId: "workspace-discovered",
        organizationId: "org-portable",
        userId: "user-portable",
        planType: "plus",
        refreshToken: "rt_must_not_be_consumed",
        accountIdSource: "upstream_discovery",
      });
    });

    it("uses a file-supplied id_token account ID only as an upstream discovery hint", async () => {
      const pool = makePool();
      const discoverIdentity = vi.fn(async (_token, metadata, options) => ({
        ...metadata,
        accountId: options.accountIdHint ?? null,
        accountIdSource: "upstream_discovery" as const,
      }));
      const accessToken = createJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/profile": { email: "id-fallback@example.com" },
      });
      const idToken = createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-from-id-token",
          user_id: "user-from-id-token",
        },
      });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        validateToken: () => ({ valid: false, error: "missing account ID" }),
        discoverIdentity,
      }));

      const result = await svc.importMany([{ token: accessToken, idToken }]);

      expect(result).toMatchObject({ added: 1, failed: 0 });
      expect(discoverIdentity).toHaveBeenCalledWith(
        accessToken,
        expect.objectContaining({ accountId: null, accountIdSource: null }),
        expect.objectContaining({ accountIdHint: "workspace-from-id-token" }),
      );
      expect(pool.getAllEntries()[0]).toMatchObject({
        accountId: "workspace-from-id-token",
        accountIdSource: "upstream_discovery",
        userId: "user-from-id-token",
      });
    });

    it("does not silently import an accountId-less direct token when identity discovery fails", async () => {
      const pool = makePool();
      const token = createJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { user_id: "user-portable" },
      });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        validateToken: () => ({ valid: false, error: "missing account ID" }),
        discoverIdentity: async () => { throw new Error("HTTP 403"); },
      }));

      const result = await svc.importMany([{ token }]);

      expect(result).toMatchObject({ added: 0, failed: 1 });
      expect(result.errors[0]).toContain("identity discovery failed");
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

    it("accepts a structurally valid RT-exchanged token without accountId without probing upstream", async () => {
      const pool = makePool();
      const discoverIdentity = vi.fn();
      const accountless = createJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": {
          poid: "org-rt",
          user_id: "user-rt",
        },
        "https://api.openai.com/profile": { email: "rt@example.com" },
      });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        validateToken: () => ({ valid: false, error: "missing account ID" }),
        refreshToken: async () => ({
          access_token: accountless,
          refresh_token: "rotated_rt",
        }),
        discoverIdentity,
      }));

      const result = await svc.importMany([{ refreshToken: "old_rt" }]);

      expect(result).toMatchObject({ added: 1, failed: 0 });
      expect(discoverIdentity).not.toHaveBeenCalled();
      expect(pool.getAllEntries()[0]).toMatchObject({
        accountId: null,
        organizationId: "org-rt",
        userId: "user-rt",
        refreshToken: "rotated_rt",
      });
    });

    it("never promotes a file-supplied id_token workspace ID after RT exchange", async () => {
      const pool = makePool();
      const accountless = createJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { user_id: "user-from-access" },
      });
      const unverifiedFileIdToken = createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-unverified-file",
          poid: "org-from-file-id-token",
        },
      });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        refreshToken: async () => ({
          access_token: accountless,
          refresh_token: "rotated_rt",
        }),
      }));

      const result = await svc.importMany([{
        refreshToken: "old_rt",
        idToken: unverifiedFileIdToken,
      }]);

      expect(result).toMatchObject({ added: 1, failed: 0 });
      expect(pool.getAllEntries()[0]).toMatchObject({
        accountId: null,
        accountIdSource: null,
        organizationId: "org-from-file-id-token",
        userId: "user-from-access",
      });
    });

    it("accepts a workspace ID from the token endpoint's fresh id_token", async () => {
      const pool = makePool();
      const accountless = createJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const exchangedIdToken = createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-from-exchange",
          user_id: "user-from-exchange",
        },
      });
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        refreshToken: async () => ({
          access_token: accountless,
          refresh_token: "rotated_rt",
          id_token: exchangedIdToken,
        }),
      }));

      const result = await svc.importMany([{ refreshToken: "old_rt" }]);

      expect(result).toMatchObject({ added: 1, failed: 0 });
      expect(pool.getAllEntries()[0]).toMatchObject({
        accountId: "workspace-from-exchange",
        accountIdSource: "id_token",
        userId: "user-from-exchange",
      });
    });

    it("deduplicates rotating accountId-less tokens by organizationId + userId", async () => {
      const pool = makePool();
      let generation = 0;
      const svc = new AccountImportService(pool, makeScheduler(), makeDeps({
        refreshToken: async () => ({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 3600 + generation++,
            jti: `generation-${generation}`,
            "https://api.openai.com/auth": {
              poid: "org-stable",
              user_id: "user-stable",
            },
          }),
          refresh_token: `rotated-${generation}`,
        }),
      }));

      const first = await svc.importMany([{ refreshToken: "rt-one" }]);
      const second = await svc.importMany([{ refreshToken: "rt-two" }]);

      expect(first.added).toBe(1);
      expect(second.updated).toBe(1);
      expect(second.added).toBe(0);
      expect(pool.getAccounts()).toHaveLength(1);
    });

    it("does not merge two known workspace IDs just because organization + user match", () => {
      const pool = makePool();
      const tokenOne = createValidJwt({ accountId: "workspace-one", userId: "same-user" });
      const tokenTwo = createValidJwt({ accountId: "workspace-two", userId: "same-user" });

      pool.addAccount(tokenOne, null, { organizationId: "same-org" });
      pool.addAccount(tokenTwo, null, { organizationId: "same-org" });

      expect(pool.getAccounts()).toHaveLength(2);
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

    it("redacts credentials from import errors returned to the UI", async () => {
      const leaked = "eyJaaaaaaaaaa.bbbbbbbbbb.cccccccccc";
      const svc = new AccountImportService(
        makePool(),
        makeScheduler(),
        makeDeps({
          refreshToken: async () => {
            throw new Error(`upstream echoed ${leaked} oaistb_rt_secretvalue123`);
          },
        }),
      );

      const result = await svc.importMany([{ refreshToken: "rt_input_secret123" }]);

      expect(result.errors[0]).toContain("[REDACTED_JWT]");
      expect(result.errors[0]).toContain("[REDACTED_REFRESH_TOKEN]");
      expect(result.errors[0]).not.toContain("secretvalue123");
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

    it("persists once after bulk import instead of once per account", async () => {
      const persistence = createMemoryPersistence();
      const saveSpy = vi.spyOn(persistence, "save");
      const pool = new AccountPool({
        persistence,
        rotationStrategy: "least_used",
        initialToken: null,
        rateLimitBackoffSeconds: 300,
      });
      const svc = new AccountImportService(
        pool,
        makeScheduler(),
        makeDeps(),
      );

      const entries = Array.from({ length: 200 }, (_, index) => {
        const number = index + 1;
        return {
          token: createValidJwt({
            accountId: `batch-${number}`,
            email: `b${number}@test.com`,
          }),
          label: `Batch ${number}`,
        };
      });

      const result = await svc.importMany(entries);

      expect(result).toMatchObject({ added: 200, updated: 0, failed: 0 });
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(persistence._store).toHaveLength(200);
      expect(persistence._store.at(0)?.label).toBe("Batch 1");
      expect(persistence._store.at(-1)?.label).toBe("Batch 200");
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
