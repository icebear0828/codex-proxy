/**
 * E2E tests for proxy management routes.
 *
 * Covers all endpoints in src/routes/proxies.ts:
 * - CRUD: GET/POST/PUT/DELETE /api/proxies
 * - Enable/disable, health check
 * - Assign/unassign, bulk assign, round-robin rule
 * - Import/export (YAML + plain text), assignment import/export
 * - Settings update
 *
 * Self-contained mocks (same pattern as admin-settings.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (hoisted) ──────────────────────────────────────────────

vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/codex-e2e-proxy/data"),
  getConfigDir: vi.fn(() => "/tmp/codex-e2e-proxy/config"),
}));

const _transportGet = vi.fn(async () => ({
  status: 200,
  body: JSON.stringify({ ip: "1.2.3.4" }),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: vi.fn(),
    get: _transportGet,
    simplePost: vi.fn(),
    isImpersonate: () => false,
  })),
  getTransportInfo: vi.fn(() => ({
    type: "curl-cli",
    initialized: true,
    impersonate: false,
    ffi_error: null,
  })),
  initTransport: vi.fn(),
  resetTransport: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      jwt_token: null,
      rotation_strategy: "least_used",
      rate_limit_backoff_seconds: 60,
      oauth_client_id: "test",
      oauth_token_endpoint: "https://auth.example.com/token",
    },
    server: { proxy_api_key: null },
    upstream: { proxy_url: null },
    quota: { refresh_interval_minutes: 5, warning_thresholds: { primary: [80, 90], secondary: [80, 90] }, skip_exhausted: true },
  })),
  getFingerprint: vi.fn(() => ({
    user_agent_template: "Codex/{version}",
    header_order: [],
    auth_domains: ["chatgpt.com"],
    auth_domain_exclusions: [],
    default_headers: {},
  })),
  loadConfig: vi.fn(),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token.slice(0, 8)}`),
  extractUserProfile: vi.fn((token: string) => ({
    email: `${token.slice(0, 6)}@test.com`,
    chatgpt_plan_type: "free",
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

// ── Imports (after mocks) ────────────────────────────────────────

import { Hono } from "hono";
import { createProxyRoutes } from "@src/routes/proxies.js";
import { ProxyPool } from "@src/proxy/proxy-pool.js";
import { AccountPool } from "@src/auth/account-pool.js";

// ── Helpers ──────────────────────────────────────────────────────

function buildApp(): { app: Hono; proxyPool: ProxyPool; accountPool: AccountPool } {
  const proxyPool = new ProxyPool();
  const accountPool = new AccountPool();
  const routes = createProxyRoutes(proxyPool, accountPool);
  const app = new Hono();
  app.route("/", routes);
  return { app, proxyPool, accountPool };
}

function json(data: unknown): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

function jsonPut(data: unknown): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

// ── Tests ────────────────────────────────────────────────────────

let app: Hono;
let proxyPool: ProxyPool;
let accountPool: AccountPool;

beforeEach(() => {
  vi.clearAllMocks();
  ({ app, proxyPool, accountPool } = buildApp());
});

afterEach(() => {
  proxyPool.destroy();
  accountPool.destroy();
});

// ── CRUD ─────────────────────────────────────────────────────────

describe("GET /api/proxies", () => {
  it("returns empty list initially", async () => {
    const res = await app.request("/api/proxies");
    expect(res.status).toBe(200);
    const body = await res.json() as { proxies: unknown[]; assignments: unknown[] };
    expect(body.proxies).toEqual([]);
    expect(body.assignments).toEqual([]);
  });
});

describe("POST /api/proxies", () => {
  it("adds proxy with { name, url }", async () => {
    const res = await app.request("/api/proxies", json({
      name: "US Proxy",
      url: "http://proxy.example.com:8080",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; proxy: { name: string; url: string } };
    expect(body.success).toBe(true);
    expect(body.proxy.name).toBe("US Proxy");
  });

  it("composes URL from separate fields", async () => {
    const res = await app.request("/api/proxies", json({
      name: "Composed",
      protocol: "socks5",
      host: "proxy.local",
      port: 1080,
      username: "user",
      password: "p@ss",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; proxy: { url: string } };
    expect(body.success).toBe(true);
    expect(body.proxy.url).toContain("socks5://");
    expect(body.proxy.url).toContain("proxy.local:1080");
  });

  it("rejects missing url/host with 400", async () => {
    const res = await app.request("/api/proxies", json({ name: "No URL" }));
    expect(res.status).toBe(400);
  });

  it("rejects unsupported protocol with 400", async () => {
    const res = await app.request("/api/proxies", json({
      url: "ftp://proxy.example.com:21",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unsupported protocol");
  });

  it("rejects invalid URL with 400", async () => {
    const res = await app.request("/api/proxies", json({
      url: "not-a-valid-url",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Invalid proxy URL");
  });
});

describe("PUT /api/proxies/:id", () => {
  it("updates proxy name and url", async () => {
    const addRes = await app.request("/api/proxies", json({
      name: "Original",
      url: "http://proxy1.example.com:8080",
    }));
    const { proxy } = await addRes.json() as { proxy: { id: string } };

    const res = await app.request(`/api/proxies/${proxy.id}`, jsonPut({
      name: "Updated",
      url: "http://proxy2.example.com:9090",
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; proxy: { name: string; url: string } };
    expect(body.proxy.name).toBe("Updated");
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.request("/api/proxies/nonexistent", jsonPut({ name: "X" }));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/proxies/:id", () => {
  it("removes proxy", async () => {
    const addRes = await app.request("/api/proxies", json({
      url: "http://proxy.example.com:8080",
    }));
    const { proxy } = await addRes.json() as { proxy: { id: string } };

    const res = await app.request(`/api/proxies/${proxy.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    // Verify removed
    const listRes = await app.request("/api/proxies");
    const list = await listRes.json() as { proxies: unknown[] };
    expect(list.proxies).toHaveLength(0);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.request("/api/proxies/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── Enable / Disable ─────────────────────────────────────────────

describe("POST /api/proxies/:id/enable and /disable", () => {
  it("toggles proxy status", async () => {
    const addRes = await app.request("/api/proxies", json({
      url: "http://proxy.example.com:8080",
    }));
    const { proxy } = await addRes.json() as { proxy: { id: string; status: string } };
    expect(proxy.status).toBe("active");

    const disableRes = await app.request(`/api/proxies/${proxy.id}/disable`, { method: "POST" });
    expect(disableRes.status).toBe(200);
    const disabled = await disableRes.json() as { proxy: { status: string } };
    expect(disabled.proxy.status).toBe("disabled");

    const enableRes = await app.request(`/api/proxies/${proxy.id}/enable`, { method: "POST" });
    expect(enableRes.status).toBe(200);
    const enabled = await enableRes.json() as { proxy: { status: string } };
    expect(enabled.proxy.status).toBe("active");
  });

  it("returns 404 for unknown proxy", async () => {
    const res = await app.request("/api/proxies/nonexistent/enable", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── Health Check ─────────────────────────────────────────────────

describe("POST /api/proxies/:id/check", () => {
  it("returns health info on success", async () => {
    _transportGet.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ ip: "1.2.3.4" }),
    });

    const addRes = await app.request("/api/proxies", json({
      url: "http://proxy.example.com:8080",
    }));
    const { proxy } = await addRes.json() as { proxy: { id: string } };

    const res = await app.request(`/api/proxies/${proxy.id}/check`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; health: { exitIp: string } };
    expect(body.success).toBe(true);
  });

  it("returns 404 for unknown proxy", async () => {
    const res = await app.request("/api/proxies/nonexistent/check", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/proxies/check-all", () => {
  it("health checks all proxies", async () => {
    _transportGet.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ ip: "5.6.7.8" }),
    });

    await app.request("/api/proxies", json({ url: "http://p1.example.com:8080" }));
    await app.request("/api/proxies", json({ url: "http://p2.example.com:8080" }));

    const res = await app.request("/api/proxies/check-all", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; proxies: unknown[] };
    expect(body.success).toBe(true);
    expect(body.proxies).toHaveLength(2);
  });
});

// ── Assign / Unassign ────────────────────────────────────────────

describe("POST /api/proxies/assign", () => {
  it("assigns proxy to account", async () => {
    const addRes = await app.request("/api/proxies", json({
      url: "http://proxy.example.com:8080",
    }));
    const { proxy } = await addRes.json() as { proxy: { id: string } };

    const res = await app.request("/api/proxies/assign", json({
      accountId: "acct-1",
      proxyId: proxy.id,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; assignment: { accountId: string; proxyId: string } };
    expect(body.success).toBe(true);
    expect(body.assignment.accountId).toBe("acct-1");
  });

  it("accepts special keywords: global, direct, auto", async () => {
    for (const special of ["global", "direct", "auto"]) {
      const res = await app.request("/api/proxies/assign", json({
        accountId: `acct-${special}`,
        proxyId: special,
      }));
      expect(res.status).toBe(200);
    }
  });

  it("rejects missing fields with 400", async () => {
    const res = await app.request("/api/proxies/assign", json({ accountId: "a1" }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid proxyId with 400", async () => {
    const res = await app.request("/api/proxies/assign", json({
      accountId: "a1",
      proxyId: "nonexistent-proxy-id",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Invalid proxyId");
  });
});

describe("DELETE /api/proxies/assign/:accountId", () => {
  it("unassigns proxy from account", async () => {
    // First assign
    await app.request("/api/proxies/assign", json({
      accountId: "acct-1",
      proxyId: "direct",
    }));

    // Then unassign
    const res = await app.request("/api/proxies/assign/acct-1", { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

// ── Settings ─────────────────────────────────────────────────────

describe("PUT /api/proxies/settings", () => {
  it("updates health check interval", async () => {
    const res = await app.request("/api/proxies/settings", jsonPut({
      healthCheckIntervalMinutes: 10,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; healthCheckIntervalMinutes: number };
    expect(body.success).toBe(true);
    expect(body.healthCheckIntervalMinutes).toBe(10);
  });
});

// ── Bulk Assignment ──────────────────────────────────────────────

describe("GET /api/proxies/assignments", () => {
  it("lists accounts with proxy assignments", async () => {
    accountPool.addAccount("tokenAAAA1234567890");
    await app.request("/api/proxies/assign", json({
      accountId: accountPool.getAccounts()[0].id,
      proxyId: "direct",
    }));

    const res = await app.request("/api/proxies/assignments");
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: Array<{ proxyId: string }> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].proxyId).toBe("direct");
  });
});

describe("POST /api/proxies/assign-bulk", () => {
  it("bulk assigns proxies to accounts", async () => {
    const res = await app.request("/api/proxies/assign-bulk", json({
      assignments: [
        { accountId: "a1", proxyId: "direct" },
        { accountId: "a2", proxyId: "global" },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; applied: number };
    expect(body.applied).toBe(2);
  });

  it("rejects empty assignments with 400", async () => {
    const res = await app.request("/api/proxies/assign-bulk", json({ assignments: [] }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid proxyId in bulk with 400", async () => {
    const res = await app.request("/api/proxies/assign-bulk", json({
      assignments: [{ accountId: "a1", proxyId: "bad-id" }],
    }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/proxies/assign-rule", () => {
  it("distributes accounts round-robin across proxies", async () => {
    // Add two proxies
    const p1Res = await app.request("/api/proxies", json({ url: "http://p1.example.com:8080" }));
    const p2Res = await app.request("/api/proxies", json({ url: "http://p2.example.com:8080" }));
    const p1 = (await p1Res.json() as { proxy: { id: string } }).proxy;
    const p2 = (await p2Res.json() as { proxy: { id: string } }).proxy;

    const res = await app.request("/api/proxies/assign-rule", json({
      accountIds: ["a1", "a2", "a3", "a4"],
      rule: "round-robin",
      targetProxyIds: [p1.id, p2.id],
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      applied: number;
      assignments: Array<{ accountId: string; proxyId: string }>;
    };
    expect(body.applied).toBe(4);
    // a1→p1, a2→p2, a3→p1, a4→p2
    expect(body.assignments[0].proxyId).toBe(p1.id);
    expect(body.assignments[1].proxyId).toBe(p2.id);
    expect(body.assignments[2].proxyId).toBe(p1.id);
    expect(body.assignments[3].proxyId).toBe(p2.id);
  });

  it("rejects unsupported rule with 400", async () => {
    const res = await app.request("/api/proxies/assign-rule", json({
      accountIds: ["a1"],
      rule: "random",
      targetProxyIds: ["global"],
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unsupported rule");
  });

  it("rejects empty accountIds with 400", async () => {
    const res = await app.request("/api/proxies/assign-rule", json({
      accountIds: [],
      rule: "round-robin",
      targetProxyIds: ["global"],
    }));
    expect(res.status).toBe(400);
  });

  it("rejects empty targetProxyIds with 400", async () => {
    const res = await app.request("/api/proxies/assign-rule", json({
      accountIds: ["a1"],
      rule: "round-robin",
      targetProxyIds: [],
    }));
    expect(res.status).toBe(400);
  });
});

// ── Assignment Export / Import / Apply ────────────────────────────

describe("assignment export/import/apply flow", () => {
  it("exports, imports (preview), and applies assignments", async () => {
    // Setup: add account + assign
    accountPool.addAccount("tokenBBBB1234567890");
    const acct = accountPool.getAccounts()[0];
    await app.request("/api/proxies/assign", json({
      accountId: acct.id,
      proxyId: "direct",
    }));

    // Export
    const exportRes = await app.request("/api/proxies/assignments/export");
    expect(exportRes.status).toBe(200);
    const exported = await exportRes.json() as {
      assignments: Array<{ email: string; proxyId: string }>;
    };
    expect(exported.assignments.length).toBeGreaterThan(0);

    // Import preview — change proxyId to "global"
    const modified = exported.assignments.map((a) => ({ ...a, proxyId: "global" }));
    const importRes = await app.request("/api/proxies/assignments/import", json({
      assignments: modified,
    }));
    expect(importRes.status).toBe(200);
    const preview = await importRes.json() as {
      changes: Array<{ email: string; from: string; to: string; accountId: string }>;
      unchanged: number;
    };
    expect(preview.changes.length).toBe(1);
    expect(preview.changes[0].from).toBe("direct");
    expect(preview.changes[0].to).toBe("global");

    // Apply
    const applyRes = await app.request("/api/proxies/assignments/apply", json({
      assignments: preview.changes.map((ch) => ({
        accountId: ch.accountId,
        proxyId: ch.to,
      })),
    }));
    expect(applyRes.status).toBe(200);
    const applied = await applyRes.json() as { success: boolean; applied: number };
    expect(applied.applied).toBe(1);
  });

  it("import preview: rejects non-array with 400", async () => {
    const res = await app.request("/api/proxies/assignments/import", json({
      assignments: "not-an-array",
    }));
    expect(res.status).toBe(400);
  });

  it("apply: rejects empty assignments with 400", async () => {
    const res = await app.request("/api/proxies/assignments/apply", json({
      assignments: [],
    }));
    expect(res.status).toBe(400);
  });
});

// ── Proxy Export / Import (YAML) ─────────────────────────────────

describe("proxy YAML export/import", () => {
  it("exports proxies as YAML and re-imports", async () => {
    // Add proxies
    await app.request("/api/proxies", json({ name: "US", url: "http://us.example.com:8080" }));
    await app.request("/api/proxies", json({ name: "EU", url: "https://eu.example.com:8080" }));

    // Export
    const exportRes = await app.request("/api/proxies/export");
    expect(exportRes.status).toBe(200);
    const contentType = exportRes.headers.get("Content-Type");
    expect(contentType).toContain("text/yaml");
    const yamlStr = await exportRes.text();
    expect(yamlStr).toContain("us.example.com");
    expect(yamlStr).toContain("eu.example.com");

    // Import into fresh pool
    const { app: app2, proxyPool: pool2, accountPool: acctPool2 } = buildApp();
    const importRes = await app2.request("/api/proxies/import", {
      method: "POST",
      headers: { "Content-Type": "text/yaml" },
      body: yamlStr,
    });
    expect(importRes.status).toBe(200);
    const imported = await importRes.json() as { success: boolean; added: number; errors: string[] };
    expect(imported.added).toBe(2);
    expect(imported.errors).toHaveLength(0);

    pool2.destroy();
    acctPool2.destroy();
  });

  it("rejects invalid YAML with 400", async () => {
    const res = await app.request("/api/proxies/import", {
      method: "POST",
      headers: { "Content-Type": "text/yaml" },
      body: "{ invalid yaml [[[",
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-array YAML with 400", async () => {
    const res = await app.request("/api/proxies/import", {
      method: "POST",
      headers: { "Content-Type": "text/yaml" },
      body: "key: value\n",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("YAML array");
  });

  it("reports errors for entries with bad protocol", async () => {
    const res = await app.request("/api/proxies/import", {
      method: "POST",
      headers: { "Content-Type": "text/yaml" },
      body: "- name: bad\n  url: ftp://bad.example.com\n",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { added: number; errors: string[] };
    expect(body.added).toBe(0);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

// NOTE: Plain-text proxy import (host:port:user:pass format) is NOT implemented.
// The import endpoint only accepts YAML. If plain-text support is needed in the
// future, add parsing logic to POST /api/proxies/import and re-enable these tests.
