/**
 * AccountMutationService tests — zero vi.mock().
 * All deps injected via constructor.
 */

import { describe, it, expect } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { AccountPool } from "@src/auth/account-pool.js";
import {
  AccountMutationService,
  type MutationDeps,
} from "@src/services/account-mutation.js";

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
}

function makeDeps(): MutationDeps & {
  scheduleCalls: string[];
  cookieCalls: string[];
  warningCalls: string[];
} {
  const scheduleCalls: string[] = [];
  const cookieCalls: string[] = [];
  const warningCalls: string[] = [];
  return {
    scheduleCalls,
    cookieCalls,
    warningCalls,
    clearSchedule(id) { scheduleCalls.push(id); },
    clearCookies(id) { cookieCalls.push(id); },
    clearWarnings(id) { warningCalls.push(id); },
  };
}

describe("AccountMutationService", () => {
  describe("deleteBatch", () => {
    it("removes existing accounts", () => {
      const pool = makePool();
      const id1 = pool.addAccount(createValidJwt({ accountId: "a1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "a2" }));

      const deps = makeDeps();
      const svc = new AccountMutationService(pool, deps);
      const result = svc.deleteBatch([id1, id2]);

      expect(result.deleted).toBe(2);
      expect(result.notFound).toHaveLength(0);
      expect(pool.getAccounts()).toHaveLength(0);
    });

    it("tracks not-found ids", () => {
      const pool = makePool();
      const id = pool.addAccount(createValidJwt({ accountId: "a1" }));

      const svc = new AccountMutationService(pool, makeDeps());
      const result = svc.deleteBatch([id, "nonexistent"]);

      expect(result.deleted).toBe(1);
      expect(result.notFound).toEqual(["nonexistent"]);
    });

    it("calls clearSchedule + clearCookies + clearWarnings for deleted accounts", () => {
      const pool = makePool();
      const id = pool.addAccount(createValidJwt({ accountId: "a1" }));

      const deps = makeDeps();
      const svc = new AccountMutationService(pool, deps);
      svc.deleteBatch([id]);

      expect(deps.scheduleCalls).toEqual([id]);
      expect(deps.cookieCalls).toEqual([id]);
      expect(deps.warningCalls).toEqual([id]);
    });

    it("calls clearSchedule even for not-found ids (schedule cleanup)", () => {
      const pool = makePool();
      const deps = makeDeps();
      const svc = new AccountMutationService(pool, deps);
      svc.deleteBatch(["ghost"]);

      // clearSchedule is called unconditionally (same as original route behavior)
      expect(deps.scheduleCalls).toEqual(["ghost"]);
      // cookies + warnings only for actually deleted accounts
      expect(deps.cookieCalls).toHaveLength(0);
      expect(deps.warningCalls).toHaveLength(0);
    });
  });

  describe("setStatusBatch", () => {
    it("updates status for existing accounts", () => {
      const pool = makePool();
      const id1 = pool.addAccount(createValidJwt({ accountId: "a1" }));
      const id2 = pool.addAccount(createValidJwt({ accountId: "a2" }));

      const svc = new AccountMutationService(pool, makeDeps());
      const result = svc.setStatusBatch([id1, id2], "disabled");

      expect(result.updated).toBe(2);
      expect(result.notFound).toHaveLength(0);
      expect(pool.getAccounts()[0].status).toBe("disabled");
      expect(pool.getAccounts()[1].status).toBe("disabled");
    });

    it("tracks not-found ids", () => {
      const pool = makePool();
      const id = pool.addAccount(createValidJwt({ accountId: "a1" }));

      const svc = new AccountMutationService(pool, makeDeps());
      const result = svc.setStatusBatch([id, "nonexistent"], "active");

      expect(result.updated).toBe(1);
      expect(result.notFound).toEqual(["nonexistent"]);
    });

    it("can re-enable disabled accounts", () => {
      const pool = makePool();
      const id = pool.addAccount(createValidJwt({ accountId: "a1" }));
      pool.markStatus(id, "disabled");

      const svc = new AccountMutationService(pool, makeDeps());
      svc.setStatusBatch([id], "active");

      expect(pool.getAccounts()[0].status).toBe("active");
    });
  });
});
