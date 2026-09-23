/**
 * Unit tests for rich model metadata exposure:
 *   - GET /v1/models — OpenAI superset with rich backend fields
 *   - GET /v1/models/catalog/codex — Codex CLI `model_catalog_url` payload
 *     ({models: [ModelInfo]}) with required keys always present
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createModelRoutes } from "@src/routes/models.js";
import { applyBackendModelsForPlan, loadStaticModels, resetModelStoreForTesting } from "@src/models/model-store.js";
import type { ClientKeyPool } from "@src/auth/client-key-pool.js";
import type { ApiKeyPool } from "@src/auth/api-key-pool.js";

const mockConfig = {
  model: {
    default: "gpt-5.4",
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
  getConfigDir: vi.fn(() => "/tmp/test-models-rich-config"),
  getDataDir: vi.fn(() => "/tmp/test-models-rich-data"),
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
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    description: "Flagship frontier model",
    is_default: true,
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "high", description: "Deep" },
    ],
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    context_window: 400_000,
    max_context_window: 400_000,
    max_output_tokens: 128_000,
    auto_compact_token_limit: 320_000,
    truncation_policy: { mode: "tokens", limit: 48_000 },
    effective_context_window_percent: 92,
    visibility: "list",
    priority: 3,
    supported_in_api: true,
    shell_type: "unified_exec",
    service_tiers: [{ id: "fast", name: "Fast", description: "Low latency" }],
    default_service_tier: "fast",
    prefer_websockets: false,
    model_specialty: "cyber",
    tool_mode: "direct",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    upgrade: { model: "gpt-6.1", migration_markdown: "# Move", retirement_at: "2027-01-01T00:00:00Z" },
  },
  {
    slug: "gpt-5.3-codex",
    display_name: "GPT-5.3 Codex",
    description: "Coding specialist",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Standard" }],
    input_modalities: ["text"],
  },
];

describe("GET /v1/models — rich metadata", () => {
  beforeEach(() => {
    resetModelStoreForTesting();
    loadStaticModels();
    applyBackendModelsForPlan("plus", BACKEND_MODELS);
  });

  it("exposes rich backend fields alongside the OpenAI base shape", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { object: string; data: Array<Record<string, unknown>> };
    expect(body.object).toBe("list");

    const gpt54 = body.data.find((m) => m.id === "gpt-5.4");
    expect(gpt54).toMatchObject({
      object: "model",
      owned_by: "openai",
      display_name: "GPT-5.4",
      description: "Flagship frontier model",
      default_reasoning_effort: "high",
      supported_reasoning_efforts: [
        { reasoning_effort: "low", description: "Fast" },
        { reasoning_effort: "high", description: "Deep" },
      ],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      context_window: 400_000,
      max_output_tokens: 128_000,
      truncation_policy: { mode: "tokens", limit: 48_000 },
      effective_context_window_percent: 92,
      visibility: "list",
      priority: 3,
      supported_in_api: true,
      shell_type: "unified_exec",
      service_tiers: [{ id: "fast", name: "Fast", description: "Low latency" }],
      default_service_tier: "fast",
      support_verbosity: true,
      default_verbosity: "low",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text",
      upgrade: "gpt-6.1",
      upgrade_info: { model: "gpt-6.1", migration_markdown: "# Move", retirement_at: "2027-01-01T00:00:00Z" },
    });
    expect(gpt54!.auto_compact_token_limit).toBe(320_000);
  });

  it("omits rich fields the backend did not report", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models");
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };

    const codex = body.data.find((m) => m.id === "gpt-5.3-codex");
    expect(codex).toBeDefined();
    expect(codex!.display_name).toBe("GPT-5.3 Codex");
    expect(codex).not.toHaveProperty("context_window");
    expect(codex).not.toHaveProperty("service_tiers");
    expect(codex).not.toHaveProperty("visibility");
    expect(codex).not.toHaveProperty("upgrade");
  });

  it("serves the same rich fields on the single-model route", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/gpt-5.4");
    expect(res.status).toBe(200);

    const model = (await res.json()) as Record<string, unknown>;
    expect(model.id).toBe("gpt-5.4");
    expect(model.display_name).toBe("GPT-5.4");
    expect(model.supported_reasoning_efforts).toHaveLength(2);
    expect(model.service_tiers).toHaveLength(1);
  });
});

describe("GET /v1/models/catalog/codex", () => {
  beforeEach(() => {
    resetModelStoreForTesting();
    loadStaticModels();
    applyBackendModelsForPlan("plus", BACKEND_MODELS);
  });

  it("emits ModelsResponse shape with ModelInfo required keys", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog/codex");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { models: Array<Record<string, unknown>> };
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);

    for (const entry of body.models) {
      // Fields the Codex CLI decoder requires (no serde default, non-Option).
      expect(typeof entry.slug).toBe("string");
      expect(typeof entry.display_name).toBe("string");
      expect(Array.isArray(entry.supported_reasoning_levels)).toBe(true);
      expect(typeof entry.shell_type).toBe("string");
      expect(typeof entry.visibility).toBe("string");
      expect(typeof entry.supported_in_api).toBe("boolean");
      expect(typeof entry.priority).toBe("number");
      expect(typeof entry.support_verbosity).toBe("boolean");
      expect(entry.truncation_policy).toMatchObject({
        mode: expect.any(String),
        limit: expect.any(Number),
      });
    }
  });

  it("passes backend metadata through and defaults the rest", async () => {
    const app = createModelRoutes();
    const res = await app.request("/v1/models/catalog/codex");
    const body = (await res.json()) as { models: Array<Record<string, unknown>> };

    const gpt54 = body.models.find((m) => m.slug === "gpt-5.4");
    expect(gpt54).toMatchObject({
      slug: "gpt-5.4",
      display_name: "GPT-5.4",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast" },
        { effort: "high", description: "Deep" },
      ],
      visibility: "list",
      priority: 3,
      supported_in_api: true,
      truncation_policy: { mode: "tokens", limit: 48_000 },
      effective_context_window_percent: 92,
      context_window: 400_000,
      upgrade: { model: "gpt-6.1", migration_markdown: "# Move", retirement_at: "2027-01-01T00:00:00Z" },
    });

    const codex = body.models.find((m) => m.slug === "gpt-5.3-codex");
    expect(codex).toMatchObject({
      slug: "gpt-5.3-codex",
      visibility: "list",
      supported_in_api: true,
      truncation_policy: { mode: "bytes", limit: 10_000 },
      effective_context_window_percent: 95,
      context_window: null,
      upgrade: null,
    });
  });

  it("includes static and runtime models with defaults", async () => {
    const mockApiKeyPool = {
      getActiveModels: vi.fn(() => ["gpt-9999-runtime"]),
      hasActiveModel: vi.fn(() => true),
    } as unknown as ApiKeyPool;
    const app = createModelRoutes(mockApiKeyPool);
    const res = await app.request("/v1/models/catalog/codex");
    const body = (await res.json()) as { models: Array<Record<string, unknown>> };

    // Static built-in metadata (KNOWN_OFFICIAL_MODELS) is part of the catalog.
    const astra = body.models.find((m) => m.slug === "gpt-6-astra");
    expect(astra).toBeDefined();
    expect(astra!.display_name).toBe("GPT-6 Astra");
    expect(astra!.context_window).toBe(1_050_000);

    const runtime = body.models.find((m) => m.slug === "gpt-9999-runtime");
    expect(runtime).toBeDefined();
    expect(runtime!.display_name).toBe("gpt-9999-runtime");
    expect(runtime!.visibility).toBe("list");
    expect(runtime!.supported_reasoning_levels).toEqual([
      { effort: "medium", description: "Default" },
    ]);
  });

  it("honors client key allowed_models filtering", async () => {
    const mockClientKeyPool = {
      getByKey: vi.fn((key: string) => {
        if (key === "test-client-key") {
          return { allowed_models: ["gpt-5.4"] };
        }
        return null;
      }),
    } as unknown as ClientKeyPool;
    const app = createModelRoutes(undefined, mockClientKeyPool);

    const res = await app.request("/v1/models/catalog/codex", {
      headers: { Authorization: "Bearer test-client-key" },
    });
    const body = (await res.json()) as { models: Array<Record<string, unknown>> };

    expect(body.models.map((m) => m.slug)).toEqual(["gpt-5.4"]);
  });
});
