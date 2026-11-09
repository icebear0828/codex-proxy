/**
 * GET /v1/models shape negotiation.
 *
 * The Codex CLI fetches `${openai_base_url}/models?client_version=<ver>` and
 * only decodes the native `ModelsResponse` shape (`{models: [ModelInfo]}`).
 * If the proxy answers with the OpenAI `{object: "list", data: [...]}`
 * envelope the CLI silently falls back to its built-in (stale) metadata, so
 * `client_version` must switch the response shape. Every other caller keeps
 * the OpenAI list envelope unchanged.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createModelRoutes } from "@src/routes/models.js";
import { applyBackendModelsForPlan, loadStaticModels, resetModelStoreForTesting } from "@src/models/model-store.js";
import type { ClientKeyPool } from "@src/auth/client-key-pool.js";
import type { ApiKeyPool } from "@src/auth/api-key-pool.js";

const mockConfig = {
  model: {
    default: "gpt-6.1-sol",
    aliases: {},
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
  getConfigDir: vi.fn(() => "/tmp/test-models-client-version-config"),
  getDataDir: vi.fn(() => "/tmp/test-models-client-version-data"),
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

const BACKEND_MODELS = [
  {
    slug: "gpt-6.1-sol",
    display_name: "GPT-6.1-Sol",
    description: "Latest workhorse model",
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
    input_modalities: ["text", "image"],
    context_window: 272_000,
    max_context_window: 872_000,
    visibility: "list",
    priority: 1,
    supported_in_api: true,
    shell_type: "unified_exec",
    // Rich Codex-catalog-only fields: these must survive the projection.
    minimal_client_version: "0.153.0",
    model_messages: {
      instructions_template: "You are Codex.",
    },
    availability_nux: { id: "gpt-6.1-sol-nux", markdown: "Try it" },
  },
  {
    slug: "gpt-6-sol",
    display_name: "GPT-6-Sol",
    description: "Previous generation workhorse model",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Default" }],
    input_modalities: ["text"],
    // No minimal_client_version / model_messages on this one: the serializer
    // must not invent them.
  },
];

type CatalogEntry = Record<string, unknown>;

describe("GET /v1/models?client_version= — Codex native catalog shape", () => {
  beforeEach(() => {
    resetModelStoreForTesting();
    loadStaticModels();
    applyBackendModelsForPlan("plus", BACKEND_MODELS);
  });

  it("returns {models: [...]} instead of the OpenAI list envelope", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models?client_version=0.160.0");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.models)).toBe(true);
    expect(body).not.toHaveProperty("object");
    expect(body).not.toHaveProperty("data");
  });

  it("emits every ModelInfo key the Codex CLI decoder requires", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models?client_version=0.160.0");
    const body = (await res.json()) as { models: CatalogEntry[] };

    expect(body.models.length).toBeGreaterThan(0);
    for (const entry of body.models) {
      expect(typeof entry.slug).toBe("string");
      expect(typeof entry.display_name).toBe("string");
      expect(Array.isArray(entry.supported_reasoning_levels)).toBe(true);
      expect(typeof entry.shell_type).toBe("string");
      expect(typeof entry.visibility).toBe("string");
      expect(typeof entry.supported_in_api).toBe("boolean");
      expect(typeof entry.priority).toBe("number");
    }
  });

  it("matches the dedicated /v1/models/catalog/codex payload", async () => {
    const app = createModelRoutes();
    const viaQuery = (await (await app.request("/v1/models?client_version=0.160.0")).json()) as {
      models: CatalogEntry[];
    };
    const viaCatalog = (await (await app.request("/v1/models/catalog/codex")).json()) as {
      models: CatalogEntry[];
    };

    expect(viaQuery.models).toEqual(viaCatalog.models);
  });

  it("passes backend model_messages / availability_nux / minimal_client_version through", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models?client_version=0.160.0");
    const body = (await res.json()) as { models: CatalogEntry[] };

    const sol = body.models.find((m) => m.slug === "gpt-6.1-sol");
    expect(sol).toBeDefined();
    expect(sol).toMatchObject({
      slug: "gpt-6.1-sol",
      display_name: "GPT-6.1-Sol",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      context_window: 272_000,
      minimal_client_version: "0.153.0",
      model_messages: { instructions_template: "You are Codex." },
      availability_nux: { id: "gpt-6.1-sol-nux", markdown: "Try it" },
    });
  });

  it("does not fabricate minimal_client_version / model_messages when the backend omits them", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models?client_version=0.160.0");
    const body = (await res.json()) as { models: CatalogEntry[] };

    const sol = body.models.find((m) => m.slug === "gpt-6-sol");
    expect(sol).toBeDefined();
    expect(sol).not.toHaveProperty("minimal_client_version");
    expect(sol!.model_messages).toBeNull();
    expect(sol!.availability_nux).toBeNull();
  });

  it("still honors client key allowed_models on the catalog shape", async () => {
    const mockClientKeyPool = {
      getByKey: vi.fn((key: string) =>
        key === "test-client-key" ? { allowed_models: ["gpt-6-sol"] } : null,
      ),
    } as unknown as ClientKeyPool;
    const app = createModelRoutes(undefined, mockClientKeyPool);

    const res = await app.request("/v1/models?client_version=0.160.0", {
      headers: { Authorization: "Bearer test-client-key" },
    });
    const body = (await res.json()) as { models: CatalogEntry[] };
    expect(body.models.map((m) => m.slug)).toEqual(["gpt-6-sol"]);
  });

  it("includes runtime-discovered api-key models with catalog defaults", async () => {
    const mockApiKeyPool = {
      getActiveModels: vi.fn(() => ["gpt-9999-runtime"]),
      hasActiveModel: vi.fn(() => true),
    } as unknown as ApiKeyPool;
    const app = createModelRoutes(mockApiKeyPool);

    const res = await app.request("/v1/models?client_version=0.160.0");
    const body = (await res.json()) as { models: CatalogEntry[] };
    const runtime = body.models.find((m) => m.slug === "gpt-9999-runtime");
    expect(runtime).toBeDefined();
    expect(runtime!.visibility).toBe("list");
  });
});

describe("GET /v1/models — OpenAI list shape is unchanged without client_version", () => {
  beforeEach(() => {
    resetModelStoreForTesting();
    loadStaticModels();
    applyBackendModelsForPlan("plus", BACKEND_MODELS);
  });

  it("keeps {object: 'list', data: [...]}", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body).not.toHaveProperty("models");
    expect(body.data.some((m) => m.id === "gpt-6.1-sol")).toBe(true);
  });

  it("does not switch shape for an empty client_version", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models?client_version=");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("list");
  });
});
