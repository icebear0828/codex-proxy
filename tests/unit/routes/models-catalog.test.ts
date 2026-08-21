/**
 * Unit tests for GET /v1/models/catalog route.
 * Verifies that model.isDefault dynamically tracks config.model.default (including aliases)
 * and honors client key allowed_models restrictions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createModelRoutes } from "@src/routes/models.js";
import { resetModelStoreForTesting, loadStaticModels } from "@src/models/model-store.js";
import type { ClientKeyPool } from "@src/auth/client-key-pool.js";

const mockConfig = {
  model: {
    default: "gpt-5.4",
    aliases: {
      codex: "gpt-5.3-codex",
    },
    custom_models: [],
  },
  server: {
    proxy_api_key: null as string | null,
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-models-catalog-config"),
  getDataDir: vi.fn(() => "/tmp/test-models-catalog-data"),
}));

const FIXTURE_YAML = `
models:
  - id: gpt-5.3-codex
    displayName: GPT-5.3 Codex
    description: Coding specialist
    isDefault: true
    supportedReasoningEfforts:
      - reasoningEffort: medium
        description: Standard
    defaultReasoningEffort: medium
    inputModalities: ["text"]
    supportsPersonality: false
    upgrade: null
  - id: gpt-5.4
    displayName: GPT-5.4
    description: Flagship
    isDefault: false
    supportedReasoningEfforts:
      - reasoningEffort: high
        description: Deep
    defaultReasoningEffort: high
    inputModalities: ["text"]
    supportsPersonality: false
    upgrade: null
aliases:
  codex: gpt-5.3-codex
`;

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.includes("models.yaml")) {
        return FIXTURE_YAML;
      }
      return "";
    }),
    existsSync: vi.fn(() => false),
    writeFile: vi.fn((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null)),
    mkdirSync: vi.fn(),
  };
});

describe("GET /v1/models/catalog", () => {
  beforeEach(() => {
    mockConfig.model.default = "gpt-5.4";
    mockConfig.model.aliases = { codex: "gpt-5.3-codex" };
    mockConfig.server.proxy_api_key = null;
    resetModelStoreForTesting();
    loadStaticModels();
  });

  it("marks the model matching config.model.default as isDefault: true and others as false", async () => {
    mockConfig.model.default = "gpt-5.4";
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog");

    expect(res.status).toBe(200);
    const catalog = (await res.json()) as Array<{ id: string; isDefault: boolean; outputModalities: string[] }>;

    const gpt54 = catalog.find((m) => m.id === "gpt-5.4");
    const gpt53 = catalog.find((m) => m.id === "gpt-5.3-codex");

    expect(gpt54?.isDefault).toBe(true);
    expect(gpt53?.isDefault).toBe(false);
    expect(gpt54?.outputModalities).toEqual(["text"]);
  });

  it("resolves alias when config.model.default is an alias", async () => {
    mockConfig.model.default = "codex";
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog");

    expect(res.status).toBe(200);
    const catalog = (await res.json()) as Array<{ id: string; isDefault: boolean }>;

    const gpt53 = catalog.find((m) => m.id === "gpt-5.3-codex");
    const gpt54 = catalog.find((m) => m.id === "gpt-5.4");

    expect(gpt53?.isDefault).toBe(true);
    expect(gpt54?.isDefault).toBe(false);
  });

  it("preserves catalog isDefault if config.model.default is empty or undefined", async () => {
    mockConfig.model.default = "";
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog");

    expect(res.status).toBe(200);
    const catalog = (await res.json()) as Array<{ id: string; isDefault: boolean }>;

    const gpt53 = catalog.find((m) => m.id === "gpt-5.3-codex");
    const gpt54 = catalog.find((m) => m.id === "gpt-5.4");

    expect(gpt53?.isDefault).toBe(true);
    expect(gpt54?.isDefault).toBe(false);
  });

  it("filters catalog based on client key allowed_models", async () => {
    const mockClientKeyPool = {
      getByKey: vi.fn((key: string) => {
        if (key === "test-client-key") {
          return { allowed_models: ["gpt-5.4"] };
        }
        return null;
      }),
    } as unknown as ClientKeyPool;

    const app = createModelRoutes(undefined, mockClientKeyPool);
    const res = await app.request("/v1/models/catalog", {
      headers: {
        Authorization: "Bearer test-client-key",
      },
    });

    expect(res.status).toBe(200);
    const catalog = (await res.json()) as Array<{ id: string }>;
    expect(catalog.length).toBe(1);
    expect(catalog[0].id).toBe("gpt-5.4");
  });
});
