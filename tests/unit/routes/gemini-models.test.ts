/**
 * Unit tests for GET /v1beta/models.
 * Verifies the Gemini model list follows the live backend catalog (no stale
 * hardcoded static fallback) and still honors client key allowed_models.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createGeminiRoutes } from "@src/routes/gemini.js";
import {
  applyBackendModelsForPlan,
  loadStaticModels,
  resetModelStoreForTesting,
} from "@src/models/model-store.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { ClientKeyPool } from "@src/auth/client-key-pool.js";

const MASTER_KEY = "test-master-key";

const mockConfig = {
  model: {
    default: "gpt-6.1-sol",
    aliases: {},
    custom_models: [],
  },
  server: {
    proxy_api_key: MASTER_KEY as string | null,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-gemini-models-config"),
  getDataDir: vi.fn(() => "/tmp/test-gemini-models-data"),
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
    writeFile: vi.fn((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null)),
    mkdirSync: vi.fn(),
  };
});

function makeAccountPool(): AccountPool {
  return {
    validateProxyApiKey: (key: string) => key === MASTER_KEY,
    isAuthenticated: () => true,
  } as unknown as AccountPool;
}

function makeClientKeyPool(allowedModels: string[]): ClientKeyPool {
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

function modelNames(payload: unknown): string[] {
  const body = payload as { models?: Array<{ name: string }> };
  return (body.models ?? []).map((m) => m.name);
}

describe("GET /v1beta/models (live catalog)", () => {
  beforeEach(() => {
    mockConfig.model.default = "gpt-6.1-sol";
    mockConfig.model.aliases = {};
    mockConfig.server.proxy_api_key = MASTER_KEY;
    resetModelStoreForTesting();
    loadStaticModels();
    applyBackendModelsForPlan("plus", [
      {
        slug: "gpt-6.1-sol",
        display_name: "GPT-6.1 Sol",
        description: "Live backend model",
      },
    ]);
  });

  it("only exposes live backend models, not stale static fallbacks", async () => {
    const app = createGeminiRoutes(makeAccountPool());
    const res = await app.request("/v1beta/models", {
      headers: { Authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.status).toBe(200);
    const names = modelNames(await res.json());
    expect(names).toEqual(["models/gpt-6.1-sol"]);
    expect(names).not.toContain("models/gpt-reserve");
    expect(names).not.toContain("models/gpt-6-astra-aeon");
  });

  it("still honors client key allowed_models", async () => {
    const app = createGeminiRoutes(
      makeAccountPool(),
      undefined,
      undefined,
      undefined,
      makeClientKeyPool(["gpt-6.1-sol"]),
    );
    const res = await app.request("/v1beta/models", {
      headers: { Authorization: "Bearer test-client-key" },
    });

    expect(res.status).toBe(200);
    const names = modelNames(await res.json());
    expect(names).toEqual(["models/gpt-6.1-sol"]);
    expect(names).not.toContain("models/gpt-reserve");
    expect(names).not.toContain("models/gpt-6-astra-aeon");
  });
});
