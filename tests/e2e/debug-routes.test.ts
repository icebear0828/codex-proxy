/**
 * E2E tests for debug/diagnostics routes.
 *
 * - GET /debug/fingerprint
 * - GET /debug/diagnostics
 */

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";

// ── Mock control ──────────────────────────────────────────────────

let mockRemoteAddress = "127.0.0.1";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: mockRemoteAddress } })),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    client: {
      app_version: "1.2024.0",
      build_number: "1",
      platform: "darwin",
      arch: "arm64",
      originator: "desktop",
    },
    api: { base_url: "https://chatgpt.com/backend-api" },
    model: { default: "gpt-5.4" },
    server: { proxy_api_key: null },
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
    },
  })),
  getFingerprint: vi.fn(() => ({
    user_agent_template: "Codex/{version} ({platform}; {arch})",
    header_order: [],
    auth_domains: ["chatgpt.com"],
    auth_domain_exclusions: [],
    default_headers: {},
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/codex-e2e-debug/config"),
  getDataDir: vi.fn(() => "/tmp/codex-e2e-debug/data"),
  getBinDir: vi.fn(() => "/tmp/codex-e2e-debug/bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransportInfo: vi.fn(() => ({
    type: "native",
    initialized: true,
    impersonate: false,
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn(() => ({
    email: "test@test.com",
    chatgpt_plan_type: "free",
    chatgpt_user_id: "uid-test",
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

// ── Imports ──────────────────────────────────────────────────────

import { Hono } from "hono";
import { createHealthRoutes } from "@src/routes/admin/health.js";
import { AccountPool } from "@src/auth/account-pool.js";

// ── Helpers ──────────────────────────────────────────────────────

function buildApp(): { app: Hono; pool: AccountPool } {
  const pool = new AccountPool();
  const routes = createHealthRoutes(pool);
  const app = new Hono();
  app.route("/", routes);
  return { app, pool };
}

// ── Tests ────────────────────────────────────────────────────────

let app: Hono;
let pool: AccountPool;
const origEnv = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  mockRemoteAddress = "127.0.0.1";
  process.env.NODE_ENV = "development";
  ({ app, pool } = buildApp());
});

afterEach(() => {
  pool?.destroy();
});

afterAll(() => {
  process.env.NODE_ENV = origEnv;
});

describe("GET /debug/fingerprint", () => {
  it("returns fingerprint data from localhost", async () => {
    const res = await app.request("/debug/fingerprint");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      headers: { "User-Agent": string };
      client: { app_version: string };
      model: { default: string };
    };
    expect(body.headers["User-Agent"]).toContain("Codex/");
    expect(body.client.app_version).toBe("1.2024.0");
    expect(body.model.default).toBe("gpt-5.4");
  });

  it("returns 404 in production from non-localhost", async () => {
    process.env.NODE_ENV = "production";
    mockRemoteAddress = "203.0.113.1";

    const res = await app.request("/debug/fingerprint");
    expect(res.status).toBe(404);
  });

  it("allows access in production from localhost", async () => {
    process.env.NODE_ENV = "production";
    mockRemoteAddress = "127.0.0.1";

    const res = await app.request("/debug/fingerprint");
    expect(res.status).toBe(200);
  });
});

describe("GET /debug/diagnostics", () => {
  it("returns diagnostic info", async () => {
    const res = await app.request("/debug/diagnostics");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      transport: { type: string; initialized: boolean; impersonate: boolean };
      accounts: { total: number };
      paths: { bin: string; config: string; data: string };
      runtime: { platform: string; node_version: string };
    };
    expect(body.transport.type).toBe("native");
    expect(body.transport.initialized).toBe(true);
    expect(body.transport.impersonate).toBe(false);
    expect(typeof body.accounts.total).toBe("number");
    expect(body.paths.bin).toBe("/tmp/codex-e2e-debug/bin");
    expect(body.runtime.node_version).toContain("v");
  });

  it("returns 404 in production from non-localhost", async () => {
    process.env.NODE_ENV = "production";
    mockRemoteAddress = "203.0.113.1";

    const res = await app.request("/debug/diagnostics");
    expect(res.status).toBe(404);
  });
});
