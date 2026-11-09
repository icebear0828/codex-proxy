/**
 * Unit tests for POST /v1beta/models/{model}:countTokens.
 *
 * countTokens must be answered locally (never upstream) so SDKs can size a
 * prompt before sending it. Covers the 200 path, the invalid-action 400 path,
 * the invalid-body 400 path, auth, and the client-key allow-list.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = {
  model: {
    default: "gpt-6.1-sol",
    aliases: {},
    custom_models: [],
  },
  auth: {
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
  server: {
    proxy_api_key: null as string | null,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-gemini-count-config"),
  getDataDir: vi.fn(() => "/tmp/test-gemini-count-data"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.includes("models.yaml")) {
        return "models: []\naliases: {}\n";
      }
      return "";
    }),
    existsSync: vi.fn(() => false),
    writeFile: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { AccountPool } from "@src/auth/account-pool.js";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import type { ClientKeyPool } from "@src/auth/client-key-pool.js";

function countTokensBody(overrides: Record<string, unknown> = {}) {
  return {
    contents: [{ role: "user", parts: [{ text: "Hello world" }] }],
    ...overrides,
  };
}

function makeClientKeyPool(allowedModels: string[] | undefined): ClientKeyPool {
  return {
    getByKey: (key: string) =>
      key === "test-client-key"
        ? { id: "ck_test", allowed_models: allowedModels }
        : undefined,
    validateAccess: () => ({ allowed: true }),
    acquireSlot: () => true,
    releaseSlot: vi.fn(),
  } as unknown as ClientKeyPool;
}

describe("POST /v1beta/models/{model}:countTokens", () => {
  let pool: AccountPool;

  beforeEach(() => {
    mockConfig.server.proxy_api_key = null;
    pool = new AccountPool();
  });

  it("returns a Gemini-shaped totalTokens without any upstream account", async () => {
    const app = createGeminiRoutes(pool);
    const res = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(countTokensBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.totalTokens).toBe("number");
    expect(body.totalTokens as number).toBeGreaterThan(0);
    // Gemini's shape is a bare object, not `{ candidates: [...] }`.
    expect(body).not.toHaveProperty("candidates");
  });

  it("scales the estimate with the prompt size", async () => {
    const app = createGeminiRoutes(pool);
    const call = async (text: string) => {
      const res = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(countTokensBody({ contents: [{ role: "user", parts: [{ text }] }] })),
      });
      return (await res.json() as { totalTokens: number }).totalTokens;
    };

    const small = await call("hi");
    const large = await call("hello there, this is a much longer prompt used to size a request");
    expect(large).toBeGreaterThan(small);
  });

  it("counts CJK characters roughly one token each", async () => {
    const app = createGeminiRoutes(pool);
    const res = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(countTokensBody({ contents: [{ role: "user", parts: [{ text: "你好世界" }] }] })),
    });

    const body = await res.json() as { totalTokens: number };
    const baseline = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(countTokensBody({ contents: [{ role: "user", parts: [{ text: "" }] }] })),
    });
    expect(body.totalTokens).toBeGreaterThan(
      (await baseline.json() as { totalTokens: number }).totalTokens + 2,
    );
  });

  it("returns 400 INVALID_ARGUMENT for a malformed body", async () => {
    const app = createGeminiRoutes(pool);
    const res = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: number; status: string } };
    expect(body.error.code).toBe(400);
    expect(body.error.status).toBe("INVALID_ARGUMENT");
  });

  it("keeps the existing 400 for an unsupported action", async () => {
    const app = createGeminiRoutes(pool);
    const res = await app.request("/v1beta/models/gpt-6.1-sol:embedContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(countTokensBody()),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("countTokens");
  });

  it("requires the proxy API key when one is configured", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const app = createGeminiRoutes(pool);

    const rejected = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(countTokensBody()),
    });
    expect(rejected.status).toBe(401);

    const accepted = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer proxy-secret",
      },
      body: JSON.stringify(countTokensBody()),
    });
    expect(accepted.status).toBe(200);
  });

  it("honors the client key allow-list", async () => {
    const app = createGeminiRoutes(
      pool,
      undefined,
      undefined,
      undefined,
      makeClientKeyPool(["gpt-6.1-sol"]),
    );

    const denied = await app.request("/v1beta/models/gpt-8-other:countTokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-client-key",
      },
      body: JSON.stringify(countTokensBody()),
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json() as { error: { code: number; status: string } };
    expect(deniedBody.error.status).toBe("PERMISSION_DENIED");

    const allowed = await app.request("/v1beta/models/gpt-6.1-sol:countTokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-client-key",
      },
      body: JSON.stringify(countTokensBody()),
    });
    expect(allowed.status).toBe(200);
  });
});
