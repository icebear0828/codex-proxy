import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { Hono } from "hono";
import { createValidJwt } from "@helpers/jwt.js";
import { createMockConfig } from "@helpers/config.js";
import type { CodexQuota } from "@src/auth/types.js";

let tmpData: string;

vi.mock("@src/paths.js", () => ({
  getConfigDir: () => resolve(tmpData, "config"),
  getDataDir: () => tmpData,
  getBinDir: () => resolve(tmpData, "bin"),
  getPublicDir: () => resolve(tmpData, "public"),
  getDesktopPublicDir: () => resolve(tmpData, "public-desktop"),
  isEmbedded: () => false,
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

import { setConfigForTesting, resetConfigForTesting } from "@src/config.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import { createAccountRoutes } from "@src/routes/accounts.js";

function accountsJsonPath(): string {
  return resolve(tmpData, "accounts.json");
}

function accountsSqlitePath(): string {
  return resolve(tmpData, "accounts.sqlite");
}

function buildApp(pool: AccountPool, scheduler: RefreshScheduler): Hono {
  const app = new Hono();
  app.route("/", createAccountRoutes(pool, scheduler));
  return app;
}

function makeQuota(): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      used_percent: 42,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
  };
}

describe("accounts SQLite persistence E2E", () => {
  beforeEach(() => {
    tmpData = mkdtempSync(resolve(tmpdir(), "codex-accounts-sqlite-e2e-"));
    setConfigForTesting(createMockConfig({
      auth: {
        refresh_enabled: false,
        jwt_token: null,
      },
    }));
  });

  afterEach(() => {
    resetConfigForTesting();
    rmSync(tmpData, { recursive: true, force: true });
  });

  it("imports accounts through HTTP, reloads from SQLite, then falls back to mirrored JSON", async () => {
    const pool = new AccountPool();
    const scheduler = new RefreshScheduler(pool);
    const app = buildApp(pool, scheduler);

    const res = await app.request("/auth/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: [
          {
            token: createValidJwt({ accountId: "sqlite-e2e-1", email: "e2e1@test.com" }),
            label: "E2E 1",
          },
          {
            token: createValidJwt({ accountId: "sqlite-e2e-2", email: "e2e2@test.com" }),
            label: "E2E 2",
          },
          {
            token: createValidJwt({ accountId: "sqlite-e2e-3", email: "e2e3@test.com" }),
            label: "E2E 3",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      added: 3,
      updated: 0,
      failed: 0,
    });
    scheduler.destroy();
    pool.destroy();

    expect(existsSync(accountsSqlitePath())).toBe(true);
    expect(existsSync(accountsJsonPath())).toBe(true);

    const sqliteReload = new AccountPool();
    expect(sqliteReload.getAccounts().map((account) => account.label).sort()).toEqual([
      "E2E 1",
      "E2E 2",
      "E2E 3",
    ]);
    sqliteReload.destroy();

    rmSync(accountsSqlitePath());

    const jsonFallback = new AccountPool();
    expect(jsonFallback.getAccounts().map((account) => account.label).sort()).toEqual([
      "E2E 1",
      "E2E 2",
      "E2E 3",
    ]);
    jsonFallback.destroy();

    const mirrored = JSON.parse(readFileSync(accountsJsonPath(), "utf-8")) as {
      accounts: Array<{ label: string | null }>;
    };
    expect(mirrored.accounts.map((account) => account.label).sort()).toEqual([
      "E2E 1",
      "E2E 2",
      "E2E 3",
    ]);
  });

  it("persists existing account mutation paths through SQLite reload", () => {
    const pool = new AccountPool();
    const keepId = pool.addAccount(
      createValidJwt({ accountId: "sqlite-mutation-keep", email: "keep@test.com", planType: "plus" }),
      "rt-keep",
    );

    pool.setLabel(keepId, "Mutation Label");
    pool.markStatus(keepId, "disabled");
    pool.markStatus(keepId, "active");
    pool.updateCachedQuota(keepId, makeQuota());

    const acquired = pool.acquire({ preferredEntryId: keepId });
    expect(acquired?.entryId).toBe(keepId);
    pool.release(keepId, { input_tokens: 123, output_tokens: 45, cached_tokens: 12 });

    const deleteId = pool.addAccount(
      createValidJwt({ accountId: "sqlite-mutation-delete", email: "delete@test.com", planType: "plus" }),
      "rt-delete",
    );
    expect(pool.removeAccount(deleteId)).toBe(true);
    pool.destroy();

    const reloaded = new AccountPool();
    const keep = reloaded.getEntry(keepId);

    expect(keep).toMatchObject({
      id: keepId,
      label: "Mutation Label",
      status: "active",
      refreshToken: "rt-keep",
      usage: {
        request_count: 1,
        input_tokens: 123,
        output_tokens: 45,
        cached_tokens: 12,
        window_request_count: 1,
        window_input_tokens: 123,
        window_output_tokens: 45,
        window_cached_tokens: 12,
      },
    });
    expect(keep?.cachedQuota?.rate_limit.used_percent).toBe(42);
    expect(reloaded.getEntry(deleteId)).toBeUndefined();
    reloaded.destroy();
  });
});
