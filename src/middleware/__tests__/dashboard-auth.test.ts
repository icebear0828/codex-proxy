import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockConfig = {
  server: { proxy_api_key: "test-key" as string | null },
  session: { ttl_minutes: 60, cleanup_interval_minutes: 5 },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "192.168.1.100" } }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...args),
}));

vi.mock("../../auth/dashboard-session.js", async () => {
  const validSessions = new Set<string>();
  return {
    validateSession: vi.fn((id: string) => validSessions.has(id)),
    _addTestSession: (id: string) => validSessions.add(id),
    _clearTestSessions: () => validSessions.clear(),
  };
});

import { dashboardAuth } from "../dashboard-auth.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const sessionMod = await import("../../auth/dashboard-session.js") as {
  validateSession: ReturnType<typeof vi.fn>;
  _addTestSession: (id: string) => void;
  _clearTestSessions: () => void;
};

function createApp(): Hono {
  const app = new Hono();
  app.use("*", dashboardAuth);
  // Catch-all handler to confirm middleware passed through
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

describe("dashboard-auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = "test-key";
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.100" } });
    sessionMod._clearTestSessions();
  });

  it("passes through when proxy_api_key is not set", async () => {
    mockConfig.server.proxy_api_key = null;
    const app = createApp();
    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);
  });

  it("passes through for localhost requests", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "127.0.0.1" } });
    const app = createApp();
    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);
  });

  it("passes through for ::1 localhost", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "::1" } });
    const app = createApp();
    const res = await app.request("/admin/rotation-settings");
    expect(res.status).toBe(200);
  });

  it("passes through for GET / (HTML shell)", async () => {
    const app = createApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  it("passes through for GET /desktop", async () => {
    const app = createApp();
    const res = await app.request("/desktop");
    expect(res.status).toBe(200);
  });

  it("passes through for /assets/* (static files)", async () => {
    const app = createApp();
    const res = await app.request("/assets/index-abc123.js");
    expect(res.status).toBe(200);
  });

  it("passes through for /health", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });

  it("passes through for /v1/* API routes", async () => {
    const app = createApp();
    const res = await app.request("/v1/chat/completions");
    expect(res.status).toBe(200);
  });

  it("passes through for /v1beta/* API routes", async () => {
    const app = createApp();
    const res = await app.request("/v1beta/models");
    expect(res.status).toBe(200);
  });

  it("passes through for dashboard auth endpoints", async () => {
    const app = createApp();
    for (const path of ["/auth/dashboard-login", "/auth/dashboard-logout", "/auth/dashboard-status"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
    }
  });

  it("returns 401 for /auth/accounts without session", async () => {
    const app = createApp();
    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 401 for /admin/* without session", async () => {
    const app = createApp();
    const res = await app.request("/admin/rotation-settings");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /auth/status without session", async () => {
    const app = createApp();
    const res = await app.request("/auth/status");
    expect(res.status).toBe(401);
  });

  it("passes through with valid session cookie", async () => {
    sessionMod._addTestSession("valid-session-id");
    const app = createApp();
    const res = await app.request("/auth/accounts", {
      headers: { Cookie: "_codex_session=valid-session-id" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with invalid session cookie", async () => {
    const app = createApp();
    const res = await app.request("/auth/accounts", {
      headers: { Cookie: "_codex_session=invalid-id" },
    });
    expect(res.status).toBe(401);
  });
});
