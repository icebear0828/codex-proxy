/**
 * AccountQueryService tests — zero vi.mock().
 * All deps injected via constructor.
 */

import { describe, it, expect } from "vitest";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { AccountPool } from "@src/auth/account-pool.js";
import {
  AccountQueryService,
  type ProxyResolver,
} from "@src/services/account-query.js";

function makePool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
}

function makeProxyResolver(): ProxyResolver {
  return {
    getAssignment: (id) => `proxy-${id}`,
    getAssignmentDisplayName: (id) => `Proxy ${id}`,
  };
}

describe("AccountQueryService", () => {
  describe("listCached", () => {
    it("returns enriched accounts with proxy info", () => {
      const pool = makePool();
      pool.addAccount(createValidJwt({ accountId: "a1", email: "a@test.com" }));

      const svc = new AccountQueryService(pool, makeProxyResolver());
      const result = svc.listCached();

      expect(result).toHaveLength(1);
      expect(result[0].email).toBe("a@test.com");
      expect(result[0].proxyId).toBe("proxy-" + result[0].id);
      expect(result[0].proxyName).toBe("Proxy " + result[0].id);
    });

    it("defaults to 'global' when no proxyResolver", () => {
      const pool = makePool();
      pool.addAccount(createValidJwt({ accountId: "a1" }));

      const svc = new AccountQueryService(pool);
      const result = svc.listCached();

      expect(result[0].proxyId).toBe("global");
      expect(result[0].proxyName).toBe("Global Default");
    });
  });

  describe("listFresh", () => {
    it("returns accounts with cached quota when available", () => {
      const pool = makePool();
      const id = pool.addAccount(createValidJwt({ accountId: "a1" }));

      // Simulate passive quota collection
      pool.updateCachedQuota(id, {
        plan_type: "team",
        rate_limit: { used_percent: 25, limit_reached: false, reset_at: null },
        secondary_rate_limit: null,
      });

      const svc = new AccountQueryService(pool, makeProxyResolver());
      const result = svc.listFresh();

      expect(result).toHaveLength(1);
      expect(result[0].quota).toBeDefined();
      expect(result[0].quota!.plan_type).toBe("team");
      expect(result[0].quota!.rate_limit.used_percent).toBe(25);
    });

    it("returns undefined quota when no cached data", () => {
      const pool = makePool();
      pool.addAccount(createValidJwt({ accountId: "a1" }));

      const svc = new AccountQueryService(pool);
      const result = svc.listFresh();

      expect(result).toHaveLength(1);
      expect(result[0].quota).toBeUndefined();
    });

    it("includes non-active accounts", () => {
      const pool = makePool();
      const id = pool.addAccount(createValidJwt({ accountId: "a1" }));
      pool.markStatus(id, "disabled");

      const svc = new AccountQueryService(pool);
      const result = svc.listFresh();

      expect(result).toHaveLength(1);
      expect(result[0].quota).toBeUndefined();
    });
  });

  describe("exportFull", () => {
    it("returns all entries", () => {
      const pool = makePool();
      pool.addAccount(createValidJwt({ accountId: "a1" }));
      pool.addAccount(createValidJwt({ accountId: "a2" }));

      const svc = new AccountQueryService(pool);
      const result = svc.exportFull();

      expect(result).toHaveLength(2);
      // Full export includes token
      expect(result[0].token).toBeDefined();
    });

    it("filters by ids when provided", () => {
      const pool = makePool();
      const id1 = pool.addAccount(createValidJwt({ accountId: "a1" }));
      pool.addAccount(createValidJwt({ accountId: "a2" }));

      const svc = new AccountQueryService(pool);
      const result = svc.exportFull([id1]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(id1);
    });
  });

  describe("exportMinimal", () => {
    it("returns refreshToken + label, skips entries without RT", () => {
      const pool = makePool();
      // With refresh token
      const id1 = pool.addAccount(
        createValidJwt({ accountId: "a1" }),
        "rt_token_1",
      );
      pool.setLabel(id1, "Team Alpha");
      // Without refresh token
      pool.addAccount(createValidJwt({ accountId: "a2" }));

      const svc = new AccountQueryService(pool);
      const result = svc.exportMinimal();

      expect(result).toHaveLength(1);
      expect(result[0].refreshToken).toBe("rt_token_1");
      expect(result[0].label).toBe("Team Alpha");
    });

    it("omits label key when null", () => {
      const pool = makePool();
      pool.addAccount(createValidJwt({ accountId: "a1" }), "rt_1");

      const svc = new AccountQueryService(pool);
      const result = svc.exportMinimal();

      expect(result[0]).not.toHaveProperty("label");
    });

    it("filters by ids", () => {
      const pool = makePool();
      const id1 = pool.addAccount(createValidJwt({ accountId: "a1" }), "rt_1");
      pool.addAccount(createValidJwt({ accountId: "a2" }), "rt_2");

      const svc = new AccountQueryService(pool);
      const result = svc.exportMinimal([id1]);

      expect(result).toHaveLength(1);
      expect(result[0].refreshToken).toBe("rt_1");
    });
  });
});
