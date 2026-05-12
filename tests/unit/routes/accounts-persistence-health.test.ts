/**
 * GET /auth/accounts must surface the registry's persistence-health state
 * via the `persistence_health` field. The dashboard reads this to render
 * the "Auto-save paused" banner when accounts.json failed to load and
 * was quarantined.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 4)}@test.com`,
    chatgpt_plan_type: "team",
    chatgpt_user_id: `uid-${token.slice(0, 8)}`,
  })),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

import { Hono } from "hono";
import { AccountPool } from "@src/auth/account-pool.js";
import { createAccountRoutes } from "@src/routes/accounts.js";
import type { AccountPersistence } from "@src/auth/account-persistence.js";

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};

function makeApp(persistence: AccountPersistence): { app: Hono; pool: AccountPool } {
  const pool = new AccountPool({
    persistence,
    rotationStrategy: "round_robin",
    initialToken: null,
    rateLimitBackoffSeconds: 60,
  });
  const routes = createAccountRoutes(pool, mockScheduler as never);
  const app = new Hono();
  app.route("/", routes);
  return { app, pool };
}

describe("GET /auth/accounts persistence_health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports ok=true when load succeeded", async () => {
    const persistence: AccountPersistence = {
      load: () => ({ entries: [], needsPersist: false }),
      save: vi.fn(),
    };
    const { app } = makeApp(persistence);

    const resp = await app.request("/auth/accounts");
    expect(resp.status).toBe(200);
    const body = await resp.json() as { persistence_health: { ok: boolean } };
    expect(body.persistence_health).toEqual({ ok: true });
  });

  it("reports ok=false + reason=load_failed_quarantined when rename succeeded", async () => {
    const persistence: AccountPersistence = {
      load: () => ({
        entries: [],
        needsPersist: false,
        loadFailed: true,
        health: { quarantined: true, backupPath: "/tmp/accounts.json.corrupt-X.bak" },
      }),
      save: vi.fn(),
    };
    const { app, pool } = makeApp(persistence);

    expect(pool.isPersistDisabled()).toBe(true);

    const resp = await app.request("/auth/accounts");
    const body = await resp.json() as {
      persistence_health: { ok: boolean; reason?: string; message?: string; quarantined?: boolean; backupPath?: string | null };
    };
    expect(body.persistence_health.ok).toBe(false);
    expect(body.persistence_health.reason).toBe("load_failed_quarantined");
    expect(body.persistence_health.quarantined).toBe(true);
    expect(body.persistence_health.backupPath).toBe("/tmp/accounts.json.corrupt-X.bak");
    expect(body.persistence_health.message).toMatch(/quarantined/);
  });

  it("reports reason=load_failed_unquarantined when rename failed — message must NOT promise a .bak file that does not exist", async () => {
    const persistence: AccountPersistence = {
      load: () => ({
        entries: [],
        needsPersist: false,
        loadFailed: true,
        health: { quarantined: false, backupPath: null },
      }),
      save: vi.fn(),
    };
    const { app } = makeApp(persistence);

    const resp = await app.request("/auth/accounts");
    const body = await resp.json() as {
      persistence_health: { ok: boolean; reason?: string; message?: string; quarantined?: boolean; backupPath?: string | null };
    };
    expect(body.persistence_health.ok).toBe(false);
    expect(body.persistence_health.reason).toBe("load_failed_unquarantined");
    expect(body.persistence_health.quarantined).toBe(false);
    expect(body.persistence_health.backupPath).toBeNull();
    // Quarantine rename failed, so do NOT instruct the user to recover from
    // a .bak that does not exist — the original corrupt file is still there.
    expect(body.persistence_health.message).not.toMatch(/\.bak/);
  });

  it("falls back to a generic quarantined reason if older persistence implementations omit health", async () => {
    const persistence: AccountPersistence = {
      load: () => ({ entries: [], needsPersist: false, loadFailed: true }),
      save: vi.fn(),
    };
    const { app } = makeApp(persistence);

    const resp = await app.request("/auth/accounts");
    const body = await resp.json() as { persistence_health: { ok: boolean; reason?: string } };
    expect(body.persistence_health.ok).toBe(false);
    // Without explicit health info, assume quarantine succeeded (the safest
    // assumption for the file-based implementation), but the dashboard still
    // shows the banner so the user investigates.
    expect(body.persistence_health.reason).toBe("load_failed_quarantined");
  });
});
