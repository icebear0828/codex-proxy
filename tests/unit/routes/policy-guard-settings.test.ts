/**
 * Tests for the safety-policy guard admin endpoints.
 *
 * GET  /admin/policy-guard-settings          — read config
 * POST /admin/policy-guard-settings          — update config
 * GET  /admin/policy-guard-quarantines       — list refused conversations
 * POST /admin/policy-guard-quarantines/reset — release one conversation / all
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (before any imports) ---

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  policy_guard: {
    enabled: false,
    error_codes: ["cyber_policy"],
    message_patterns: ["cybersecurity risk"],
    status_codes: [] as number[],
    ttl_seconds: 3600,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(),
  getTransportInfo: vi.fn(() => ({})),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
}));

vi.mock("@src/update-checker.js", () => ({
  getUpdateState: vi.fn(() => ({})),
  checkForUpdate: vi.fn(),
  isUpdateInProgress: vi.fn(() => false),
}));

vi.mock("@src/self-update.js", () => ({
  getProxyInfo: vi.fn(() => ({})),
  canSelfUpdate: vi.fn(() => false),
  checkProxySelfUpdate: vi.fn(),
  applyProxySelfUpdate: vi.fn(),
  isProxyUpdateInProgress: vi.fn(() => false),
  getCachedProxyUpdateResult: vi.fn(() => null),
  getDeployMode: vi.fn(() => "git"),
}));

vi.mock("@hono/node-server/serve-static", () => ({
  serveStatic: vi.fn(() => vi.fn()),
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

import { createWebRoutes } from "@src/routes/web.js";
import { mutateYaml } from "@src/utils/yaml-mutate.js";
import {
  recordConversationQuarantine,
  _resetAllConversationQuarantines,
} from "@src/proxy/conversation-quarantine.js";

const mockPool = {
  getAll: vi.fn(() => []),
  acquire: vi.fn(),
  release: vi.fn(),
} as unknown as Parameters<typeof createWebRoutes>[0];

function post(path: string, body: unknown): Promise<Response> {
  return createWebRoutes(mockPool).request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetAllConversationQuarantines();
  mockConfig.policy_guard = {
    enabled: false,
    error_codes: ["cyber_policy"],
    message_patterns: ["cybersecurity risk"],
    status_codes: [],
    ttl_seconds: 3600,
  };
});

describe("GET /admin/policy-guard-settings", () => {
  it("returns the guard config", async () => {
    const res = await createWebRoutes(mockPool).request("/admin/policy-guard-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      error_codes: ["cyber_policy"],
      message_patterns: ["cybersecurity risk"],
      status_codes: [],
      ttl_seconds: 3600,
    });
  });
});

describe("POST /admin/policy-guard-settings", () => {
  it("persists a full patch and reloads config", async () => {
    const res = await post("/admin/policy-guard-settings", {
      enabled: true,
      error_codes: ["cyber_policy", "session_blocked_by_cyber_policy"],
      message_patterns: ["网络安全策略屏蔽"],
      status_codes: [400, 403],
      ttl_seconds: 600,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mutateYaml).toHaveBeenCalledOnce();
  });

  it("accepts a partial patch", async () => {
    const res = await post("/admin/policy-guard-settings", { enabled: true });
    expect(res.status).toBe(200);
  });

  it("rejects a non-boolean enabled", async () => {
    expect((await post("/admin/policy-guard-settings", { enabled: "yes" })).status).toBe(400);
  });

  it("rejects an empty-string pattern", async () => {
    expect((await post("/admin/policy-guard-settings", { message_patterns: [""] })).status).toBe(400);
  });

  it("rejects a non-string code entry", async () => {
    expect((await post("/admin/policy-guard-settings", { error_codes: [42] })).status).toBe(400);
  });

  it("rejects an out-of-range status code", async () => {
    expect((await post("/admin/policy-guard-settings", { status_codes: [99] })).status).toBe(400);
    expect((await post("/admin/policy-guard-settings", { status_codes: [600] })).status).toBe(400);
  });

  it("accepts an empty status_codes list (no restriction)", async () => {
    expect((await post("/admin/policy-guard-settings", { status_codes: [] })).status).toBe(200);
  });

  it("rejects a non-positive ttl", async () => {
    expect((await post("/admin/policy-guard-settings", { ttl_seconds: 0 })).status).toBe(400);
  });

  it("rejects a non-object body", async () => {
    expect((await post("/admin/policy-guard-settings", [])).status).toBe(400);
  });
});

describe("GET /admin/policy-guard-quarantines", () => {
  it("lists an active quarantine with its code and age", async () => {
    recordConversationQuarantine({
      conversationId: "conv-abc",
      input: [{ role: "user", content: "hello" }],
      code: "cyber_policy",
      message: "blocked by policy",
    });

    const res = await createWebRoutes(mockPool).request("/admin/policy-guard-quarantines");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.quarantines).toHaveLength(1);
    expect(data.quarantines[0]).toMatchObject({
      conversation_id: "conv-abc",
      code: "cyber_policy",
      message: "blocked by policy",
    });
    expect(data.quarantines[0].age_seconds).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty list when nothing is quarantined", async () => {
    const res = await createWebRoutes(mockPool).request("/admin/policy-guard-quarantines");
    expect((await res.json()).quarantines).toEqual([]);
  });

  it("truncates an oversized upstream message", async () => {
    recordConversationQuarantine({
      conversationId: "conv-long",
      input: [],
      code: "cyber_policy",
      message: "x".repeat(5000),
    });
    const res = await createWebRoutes(mockPool).request("/admin/policy-guard-quarantines");
    const [entry] = (await res.json()).quarantines;
    expect(entry.message.length).toBe(500);
  });
});

describe("POST /admin/policy-guard-quarantines/reset", () => {
  it("releases one conversation by id", async () => {
    recordConversationQuarantine({
      conversationId: "conv-1", input: [], code: "cyber_policy", message: "a",
    });
    recordConversationQuarantine({
      conversationId: "conv-2", input: [], code: "cyber_policy", message: "b",
    });

    const res = await post("/admin/policy-guard-quarantines/reset", { conversation_id: "conv-1" });
    expect(res.status).toBe(200);
    expect((await res.json()).released).toBe(1);

    const list = await createWebRoutes(mockPool).request("/admin/policy-guard-quarantines");
    const remaining = (await list.json()).quarantines;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].conversation_id).toBe("conv-2");
  });

  it("releases everything with all: true", async () => {
    recordConversationQuarantine({
      conversationId: "conv-1", input: [], code: "cyber_policy", message: "a",
    });
    recordConversationQuarantine({
      conversationId: "conv-2", input: [], code: "cyber_policy", message: "b",
    });

    const res = await post("/admin/policy-guard-quarantines/reset", { all: true });
    expect((await res.json()).released).toBe(2);

    const list = await createWebRoutes(mockPool).request("/admin/policy-guard-quarantines");
    expect((await list.json()).quarantines).toEqual([]);
  });

  it("rejects a request without a target", async () => {
    expect((await post("/admin/policy-guard-quarantines/reset", {})).status).toBe(400);
  });

  it("rejects a non-object body", async () => {
    expect((await post("/admin/policy-guard-quarantines/reset", "conv-1")).status).toBe(400);
  });
});
