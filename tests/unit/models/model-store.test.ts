/**
 * Tests for ModelStore — model catalog + aliases + suffix parsing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFile } from "fs";
import { resolve } from "path";

const mockConfiguredAliases: Record<string, string> = {};
const mockCustomModels: Array<
  string | {
    id: string;
    display_name?: string;
    description?: string;
    supported_reasoning_efforts?: string[];
    default_reasoning_effort?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    supports_personality?: boolean;
    context_window?: number;
    max_context_window?: number;
    max_output_tokens?: number;
    truncation_policy_limit?: number;
  }
> = [];

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFile: vi.fn((_path: string, _data: string, _enc: string, cb: (err: Error | null) => void) => cb(null)),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      aliases: mockConfiguredAliases,
      custom_models: mockCustomModels,
    },
  })),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

// Read the actual fixture file content at module evaluation time
import { readFileSync as realReadFileSync } from "fs";

import {
  loadStaticModels,
  isRecognizedModelName,
  isRequestableModel,
  parseModelName,
  resolveModelId,
  getModelInfo,
  getModelCatalog,
  getModelAliases,
  applyBackendModels,
  getModelPlanTypes,
  KNOWN_OFFICIAL_MODELS,
  applyBackendModelsForPlan,
} from "@src/models/model-store.js";

// Minimal YAML content that js-yaml can parse
const FIXTURE_YAML = `
models:
  - id: gpt-5.4
    displayName: GPT-5.4
    description: Latest flagship
    isDefault: true
    supportedReasoningEfforts:
      - { reasoningEffort: minimal, description: "Minimal" }
      - { reasoningEffort: low, description: "Low" }
      - { reasoningEffort: medium, description: "Medium" }
      - { reasoningEffort: high, description: "High" }
    defaultReasoningEffort: medium
    inputModalities: [text, image]
    contextWindow: 272000
    maxContextWindow: 1000000
    maxOutputTokens: 128000
    truncationPolicyLimit: 10000
    supportsPersonality: true
    upgrade: null
  - id: gpt-5.3-codex
    displayName: GPT-5.3 Codex
    description: Codex model
    isDefault: false
    supportedReasoningEfforts:
      - { reasoningEffort: low, description: "Low" }
      - { reasoningEffort: medium, description: "Medium" }
      - { reasoningEffort: high, description: "High" }
    defaultReasoningEffort: medium
    inputModalities: [text]
    contextWindow: 400000
    maxOutputTokens: 128000
    supportsPersonality: false
    upgrade: null
  - id: gpt-5.3-codex-high
    displayName: GPT-5.3 Codex High
    description: High tier
    isDefault: false
    supportedReasoningEfforts:
      - { reasoningEffort: high, description: "High" }
    defaultReasoningEffort: high
    inputModalities: [text]
    supportsPersonality: false
    upgrade: null
  - id: gpt-5.3-codex-spark
    displayName: Spark
    description: Ultra-lightweight
    isDefault: false
    supportedReasoningEfforts:
      - { reasoningEffort: minimal, description: "Minimal" }
      - { reasoningEffort: low, description: "Low" }
    defaultReasoningEffort: low
    inputModalities: [text]
    outputModalities: [image]
    supportsPersonality: false
    upgrade: null
aliases:
  codex: "gpt-5.4"
  codex-mini: "gpt-5.3-codex-spark"
  claude-opus-4-7: "gpt-5.5"
  claude-sonnet-4-6: "gpt-5.4"
  claude-haiku-4-5: "gpt-5.3-codex"
`;

describe("ModelStore", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockConfiguredAliases)) {
      delete mockConfiguredAliases[key];
    }
    mockCustomModels.length = 0;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(FIXTURE_YAML);
    loadStaticModels("/tmp/test-config");
  });

  describe("loadStaticModels", () => {
    it("loads models from YAML", () => {
      const catalog = getModelCatalog();
      expect(catalog.length).toBe(4 + KNOWN_OFFICIAL_MODELS.size);
      expect(catalog[0].id).toBe("gpt-5.4");
    });

    it("ignores aliases bundled in models.yaml", () => {
      expect(getModelAliases()).toEqual({});
    });

    it("loads only model.aliases from local config", () => {
      mockConfiguredAliases["claude-sonnet-4-6"] = "openai:gpt-4o";
      mockConfiguredAliases["my-free-model"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");

      const aliases = getModelAliases();
      expect(aliases).toEqual({
        "claude-sonnet-4-6": "openai:gpt-4o",
        "my-free-model": "gpt-5.4",
      });
      expect(resolveModelId("my-free-model")).toBe("gpt-5.4");
    });

    it("loads data/models-cache.yaml as the cold-start catalog snapshot", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) => {
        const filePath = String(path);
        if (filePath.endsWith("models-cache.yaml")) {
          return `
models:
  - id: auto
    displayName: auto
    description: ChatGPT selector
    isDefault: false
    supportedReasoningEfforts:
      - { reasoningEffort: medium, description: "Medium" }
    defaultReasoningEffort: medium
    inputModalities: [text]
    supportsPersonality: false
    upgrade: null
  - id: cached-only
    displayName: Cached Only
    description: Cached snapshot model
    isDefault: true
    supportedReasoningEfforts:
      - { reasoningEffort: medium, description: "Medium" }
    defaultReasoningEffort: medium
    inputModalities: [text]
    supportsPersonality: false
    upgrade: null
aliases:
  cached-alias: cached-only
`;
        }
        return FIXTURE_YAML;
      });

      loadStaticModels("/tmp/test-config");

      expect(getModelCatalog().map((m) => m.id)).toEqual(["cached-only", ...KNOWN_OFFICIAL_MODELS.keys()]);
      expect(getModelInfo("auto")).toBeUndefined();
      expect(getModelAliases()).toEqual({});
      expect(getModelInfo("cached-only")!.source).toBe("backend");
    });

    it("loads per-plan cache snapshots and preserves unfetched plans after one plan refreshes", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) => {
        const filePath = String(path);
        if (filePath.endsWith("models-cache.yaml")) {
          return `
planSnapshots:
  plus:
    - id: auto
      displayName: auto
      description: ChatGPT selector
      isDefault: false
      supportedReasoningEfforts:
        - { reasoningEffort: medium, description: "Medium" }
      defaultReasoningEffort: medium
      inputModalities: [text]
      supportsPersonality: false
      upgrade: null
    - id: cached-plus
      displayName: Cached Plus
      description: Cached plus model
      isDefault: false
      supportedReasoningEfforts:
        - { reasoningEffort: medium, description: "Medium" }
      defaultReasoningEffort: medium
      inputModalities: [text]
      supportsPersonality: false
      upgrade: null
  team:
    - id: cached-team
      displayName: Cached Team
      description: Cached team model
      isDefault: false
      supportedReasoningEfforts:
        - { reasoningEffort: medium, description: "Medium" }
      defaultReasoningEffort: medium
      inputModalities: [text]
      supportsPersonality: false
      upgrade: null
aliases: {}
`;
        }
        return FIXTURE_YAML;
      });

      loadStaticModels("/tmp/test-config");
      expect(getModelInfo("auto")).toBeUndefined();
      applyBackendModelsForPlan("plus", [{ slug: "fresh-plus", display_name: "Fresh Plus" }]);

      expect(getModelInfo("fresh-plus")).toBeDefined();
      expect(getModelInfo("cached-plus")).toBeUndefined();
      expect(getModelInfo("cached-team")).toBeDefined();
      expect(getModelPlanTypes("cached-team")).toEqual(["team"]);
    });

    it("does not revive removed custom models from the backend cache", () => {
      let cachedYaml = "";
      vi.mocked(writeFile).mockImplementation((_path, data, _enc, cb) => {
        cachedYaml = String(data);
        cb(null);
      });

      mockCustomModels.push("local-custom");
      loadStaticModels("/tmp/test-config");
      applyBackendModelsForPlan("plus", [{ slug: "fresh-plus", display_name: "Fresh Plus" }]);

      mockCustomModels.length = 0;
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation((path) => {
        const filePath = String(path);
        if (filePath.endsWith("models-cache.yaml")) return cachedYaml;
        return FIXTURE_YAML;
      });

      loadStaticModels("/tmp/test-config");

      expect(getModelInfo("fresh-plus")).toBeDefined();
      expect(getModelInfo("local-custom")).toBeUndefined();
    });

    it("adds custom models from local config to the catalog", () => {
      mockCustomModels.push(
        "local-simple",
        {
          id: "local-rich",
          display_name: "Local Rich",
          description: "Local rich model",
          supported_reasoning_efforts: ["low", "high"],
          default_reasoning_effort: "high",
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
          supports_personality: true,
          context_window: 12345,
          max_context_window: 23456,
          max_output_tokens: 3456,
          truncation_policy_limit: 4567,
        },
      );
      loadStaticModels("/tmp/test-config");

      const simple = getModelInfo("local-simple");
      expect(simple).toBeDefined();
      expect(simple!.displayName).toBe("local-simple");
      expect(simple!.defaultReasoningEffort).toBe("medium");
      expect(simple!.source).toBe("custom");

      const rich = getModelInfo("local-rich");
      expect(rich).toBeDefined();
      expect(rich!.displayName).toBe("Local Rich");
      expect(rich!.description).toBe("Local rich model");
      expect(rich!.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "low", description: "low" },
        { reasoningEffort: "high", description: "high" },
      ]);
      expect(rich!.defaultReasoningEffort).toBe("high");
      expect(rich!.inputModalities).toEqual(["text", "image"]);
      expect(rich!.outputModalities).toEqual(["text"]);
      expect(rich!.supportsPersonality).toBe(true);
      expect(rich!.contextWindow).toBe(12345);
      expect(rich!.maxContextWindow).toBe(23456);
      expect(rich!.maxOutputTokens).toBe(3456);
      expect(rich!.truncationPolicyLimit).toBe(4567);
      expect(getModelCatalog().some((m) => m.id === "local-rich")).toBe(true);
    });
  });

  describe("resolveModelId", () => {
    it("does not resolve aliases bundled in models.yaml", () => {
      expect(resolveModelId("codex")).toBe("gpt-5.3-codex");
    });

    it("resolves explicit local config aliases", () => {
      mockConfiguredAliases["my-model"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");

      expect(resolveModelId("my-model")).toBe("gpt-5.4");
    });

    it("returns known model ID as-is", () => {
      expect(resolveModelId("gpt-5.4")).toBe("gpt-5.4");
    });

    it("returns custom model IDs as-is", () => {
      mockCustomModels.push("local-simple");
      loadStaticModels("/tmp/test-config");

      expect(resolveModelId("local-simple")).toBe("local-simple");
    });

    it("falls back to config default for unknown model", () => {
      expect(resolveModelId("unknown-model")).toBe("gpt-5.3-codex");
    });
  });

  describe("parseModelName", () => {
    it("returns configured aliases without stripping", () => {
      mockConfiguredAliases["my-model"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");

      const result = parseModelName("my-model");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBeNull();
      expect(result.reasoningEffort).toBeNull();
    });

    it("returns known model ID without stripping", () => {
      const result = parseModelName("gpt-5.3-codex-high");
      expect(result.modelId).toBe("gpt-5.3-codex-high");
      expect(result.serviceTier).toBeNull();
      expect(result.reasoningEffort).toBeNull();
    });

    it("strips -fast suffix as service_tier", () => {
      const result = parseModelName("gpt-5.4-fast");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBe("fast");
      expect(result.reasoningEffort).toBeNull();
    });

    it("strips -flex suffix as service_tier", () => {
      const result = parseModelName("gpt-5.4-flex");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBe("flex");
    });

    it("strips -high suffix as reasoning_effort", () => {
      const result = parseModelName("gpt-5.4-high");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe("high");
    });

    it("strips dual suffix -high-fast", () => {
      const result = parseModelName("gpt-5.4-high-fast");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBe("fast");
      expect(result.reasoningEffort).toBe("high");
    });

    it("strips suffix from configured aliases", () => {
      mockConfiguredAliases["my-model"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");

      const result = parseModelName("my-model-fast");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBe("fast");
    });

    it("strips suffix from custom models", () => {
      mockCustomModels.push("local-simple");
      loadStaticModels("/tmp/test-config");

      const result = parseModelName("local-simple-high-fast");
      expect(result.modelId).toBe("local-simple");
      expect(result.serviceTier).toBe("fast");
      expect(result.reasoningEffort).toBe("high");
    });

    it("falls back to config default for fully unknown name", () => {
      const result = parseModelName("totally-unknown");
      expect(result.modelId).toBe("gpt-5.3-codex");
    });

    it("strips -xhigh suffix as reasoning_effort", () => {
      const result = parseModelName("gpt-5.4-xhigh");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe("xhigh");
    });

    it.each(["max", "ultra"])("strips -%s suffix as reasoning_effort", (effort) => {
      const result = parseModelName(`gpt-5.4-${effort}`);
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe(effort);
    });

    it("strips -low suffix as reasoning_effort", () => {
      const result = parseModelName("gpt-5.4-low");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe("low");
    });

    it("strips -medium suffix as reasoning_effort", () => {
      const result = parseModelName("gpt-5.4-medium");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe("medium");
    });

    it("strips -minimal suffix as reasoning_effort", () => {
      const result = parseModelName("gpt-5.4-minimal");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe("minimal");
    });

    it("strips -none suffix as reasoning_effort", () => {
      const result = parseModelName("gpt-5.4-none");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.reasoningEffort).toBe("none");
    });

    it("strips -low-flex as dual suffix", () => {
      const result = parseModelName("gpt-5.4-low-flex");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBe("flex");
      expect(result.reasoningEffort).toBe("low");
    });
  });

  describe("isRecognizedModelName", () => {
    it("accepts known model IDs with suffixes", () => {
      expect(isRecognizedModelName("gpt-5.4-low")).toBe(true);
      expect(isRecognizedModelName("gpt-5.4-high-fast")).toBe(true);
      expect(isRecognizedModelName("gpt-5.4-max")).toBe(true);
      expect(isRecognizedModelName("gpt-5.4-ultra-fast")).toBe(true);
    });

    it("accepts configured aliases with suffixes", () => {
      mockConfiguredAliases["my-model"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");

      expect(isRecognizedModelName("my-model-high")).toBe(true);
      expect(isRecognizedModelName("my-model-fast")).toBe(true);
    });

    it("accepts custom models with suffixes", () => {
      mockCustomModels.push("local-simple");
      loadStaticModels("/tmp/test-config");

      expect(isRecognizedModelName("local-simple")).toBe(true);
      expect(isRecognizedModelName("local-simple-high-fast")).toBe(true);
    });

    it("accepts known official models (gpt-6-astra, gpt-reserve) and aliases", () => {
      expect(isRecognizedModelName("gpt-6-astra")).toBe(true);
      expect(isRecognizedModelName("gpt-6-astra-aeon")).toBe(true);
      expect(isRecognizedModelName("gpt-6-astra-high")).toBe(true);
      expect(isRecognizedModelName("gpt-6-astra-ultra-fast")).toBe(true);
      expect(isRecognizedModelName("gpt-6")).toBe(true);
      expect(isRecognizedModelName("gpt-6-fast")).toBe(true);
      expect(isRecognizedModelName("gpt-reserve")).toBe(true);
      expect(isRecognizedModelName("gpt-reserve-high")).toBe(true);
    });

    it("rejects unknown model names even with valid-looking suffixes", () => {
      expect(isRecognizedModelName("totally-unknown")).toBe(false);
      expect(isRecognizedModelName("totally-unknown-low")).toBe(false);
      expect(isRecognizedModelName("totally-unknown-high-fast")).toBe(false);
    });

    it("accepts official-shaped models not present in the catalog (e.g. gpt-6)", () => {
      expect(isRecognizedModelName("gpt-6-astra")).toBe(true);
      expect(isRecognizedModelName("gpt-6-astra-high-fast")).toBe(true);
      expect(isRecognizedModelName("gpt-6")).toBe(true);
      expect(isRecognizedModelName("gpt-6-fast")).toBe(true);
      expect(isRecognizedModelName("gpt-reserve")).toBe(true);
      expect(isRecognizedModelName("gpt-reserve-high")).toBe(true);
      expect(isRecognizedModelName("o4-mini-high")).toBe(true);
    });
  });

  describe("isRequestableModel", () => {
    it("accepts the codex sentinel and its suffixed forms", () => {
      expect(isRequestableModel("codex")).toBe(true);
      expect(isRequestableModel("codex-fast")).toBe(true);
      expect(isRequestableModel("codex-high-fast")).toBe(true);
      expect(isRequestableModel("codex-low")).toBe(true);
    });

    it("accepts the configured default model and its suffixed forms", () => {
      expect(isRequestableModel("gpt-5.3-codex")).toBe(true);
      expect(isRequestableModel("gpt-5.3-codex-high-fast")).toBe(true);
    });

    it("accepts known catalog models and aliases with suffixes", () => {
      mockConfiguredAliases["my-model"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");
      expect(isRequestableModel("gpt-5.4")).toBe(true);
      expect(isRequestableModel("gpt-5.4-high-fast")).toBe(true);
      expect(isRequestableModel("my-model-high")).toBe(true);
    });

    it("rejects empty and non-official-shaped model names", () => {
      expect(isRequestableModel("")).toBe(false);
      expect(isRequestableModel("totally-unknown-high-fast")).toBe(false);
    });

    it("accepts any official-shaped model name (support decided upstream)", () => {
      // Recognized-by-shape official models pass through to the upstream backend
      // instead of being rejected here; support is decided at the edge.
      expect(isRequestableModel("gpt-9999")).toBe(true);
      expect(isRequestableModel("codex-foo")).toBe(true);
      expect(isRequestableModel("o1")).toBe(true);
      expect(isRequestableModel("o4-mini-high")).toBe(true);
    });

    it("accepts newly released gpt-6 family without static definitions", () => {
      // gpt-6-astra / gpt-reserve are not in the catalog/aliases/custom, yet they
      // must be requestable so clients aren't 404'd or silently downgraded.
      expect(isRequestableModel("gpt-6-astra")).toBe(true);
      expect(isRequestableModel("gpt-6-astra-high-fast")).toBe(true);
      expect(isRequestableModel("gpt-6")).toBe(true);
      expect(isRequestableModel("gpt-reserve")).toBe(true);
      expect(resolveModelId("gpt-6-astra")).toBe("gpt-6-astra");
    });
  });

  describe("getModelInfo", () => {
    it("returns model info for known official model gpt-6-astra", () => {
      const info = getModelInfo("gpt-6-astra");
      expect(info).toBeDefined();
      expect(info!.displayName).toBe("GPT-6 Astra");
      expect(info!.contextWindow).toBe(1_050_000);
      expect(info!.maxOutputTokens).toBe(128_000);
    });
    it("returns model info by ID", () => {
      const info = getModelInfo("gpt-5.4");
      expect(info).toBeDefined();
      expect(info!.displayName).toBe("GPT-5.4");
      expect(info!.isDefault).toBe(true);
    });

    it("returns static token limits by ID", () => {
      const info = getModelInfo("gpt-5.4");
      expect(info).toBeDefined();
      expect(info!.contextWindow).toBe(272_000);
      expect(info!.maxContextWindow).toBe(1_000_000);
      expect(info!.maxOutputTokens).toBe(128_000);
      expect(info!.truncationPolicyLimit).toBe(10_000);
    });

    it("returns undefined for unknown ID", () => {
      expect(getModelInfo("nonexistent")).toBeUndefined();
    });
  });

  describe("getModelCatalog", () => {
    it("exposes static official models alongside the live catalog", () => {
      const ids = getModelCatalog().map((m) => m.id);
      expect(ids).toContain("gpt-6-astra");
      expect(ids).toContain("gpt-6-astra-aeon");
      expect(ids).toContain("gpt-reserve");
    });
  });

  describe("applyBackendModels", () => {
    it("merges backend model over static (backend wins)", () => {
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "GPT-5.4 (Backend)",
        description: "Updated from backend",
        is_default: true,
        default_reasoning_effort: "high",
        supported_reasoning_efforts: [
          { reasoning_effort: "low" },
          { reasoning_effort: "high" },
        ],
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info).toBeDefined();
      expect(info!.displayName).toBe("GPT-5.4 (Backend)");
      expect(info!.source).toBe("backend");
    });

    it("replaces previous catalog snapshot instead of preserving static-only models", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "GPT-5.4 (Backend)",
      }]);

      expect(getModelInfo("gpt-5.4")).toBeDefined();
      expect(getModelInfo("gpt-5.3-codex")).toBeUndefined();
    });

    it("auto-admits new Codex-compatible models from backend", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-6.0",
        display_name: "GPT-6.0",
      }]);
      // gpt-6.0 matches bare gpt-X.Y pattern → auto-admitted
      const info = getModelInfo("gpt-6.0");
      expect(info).toBeDefined();
    });

    it("filters the ChatGPT-only auto selector from backend models", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "auto",
        display_name: "auto",
      }, {
        slug: "gpt-5.4",
        display_name: "GPT-5.4",
      }]);

      expect(getModelInfo("auto")).toBeUndefined();
      expect(getModelInfo("gpt-5.4")).toBeDefined();
    });

    it("uses normalized default efforts when backend has none", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "Backend 5.4",
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium", description: "Default" },
      ]);
    });

    it("tracks plan types via getModelPlanTypes", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModelsForPlan("plus", [{
        slug: "gpt-5.4",
        display_name: "GPT-5.4 Backend",
      }]);
      const plans = getModelPlanTypes("gpt-5.4");
      expect(plans).toContain("plus");
    });

    it("uses backend default flag only when rebuilding snapshots", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "Backend 5.4",
      }]);
      expect(getModelInfo("gpt-5.4")!.isDefault).toBe(false);
    });

    it("lets backend promote a non-default to default via is_default: true", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.3-codex",
        display_name: "Backend 5.3",
        is_default: true,
      }]);
      expect(getModelInfo("gpt-5.3-codex")!.isDefault).toBe(true);
    });

    it("does not preserve static outputModalities when backend omits output_modalities", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.3-codex-spark",
        display_name: "Backend Spark",
      }]);
      expect(getModelInfo("gpt-5.3-codex-spark")!.outputModalities).toBeUndefined();
    });

    it("lets backend override outputModalities when output_modalities is present", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.3-codex-spark",
        display_name: "Backend Spark",
        output_modalities: ["text", "audio"],
      }]);
      expect(getModelInfo("gpt-5.3-codex-spark")!.outputModalities).toEqual(["text", "audio"]);
    });

    it("lets backend override token limit metadata when present", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "Backend 5.4",
        context_window: 2_000_000,
        max_context_window: 2_500_000,
        max_output_tokens: 256_000,
        truncation_policy: { limit: 10_000 },
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.contextWindow).toBe(2_000_000);
      expect(info!.maxContextWindow).toBe(2_500_000);
      expect(info!.maxOutputTokens).toBe(256_000);
      expect(info!.truncationPolicyLimit).toBe(10_000);
    });

    it("does not preserve static token limit metadata when backend omits it", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "Backend 5.4",
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.contextWindow).toBeUndefined();
      expect(info!.maxContextWindow).toBeUndefined();
      expect(info!.maxOutputTokens).toBeUndefined();
      expect(info!.truncationPolicyLimit).toBeUndefined();
    });
  });

  describe("backend model admission", () => {
    it("admits all backend models regardless of naming pattern", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([
        { slug: "gpt-6.0-codex", display_name: "6.0 Codex" },
        { slug: "gpt-6.0-codex-mini", display_name: "6.0 Mini" },
        { slug: "gpt-oss-120b", display_name: "OSS 120B" },
        { slug: "dall-e-3", display_name: "DALL-E 3" },
        { slug: "whisper-1", display_name: "Whisper" },
        { slug: "totally-new-model", display_name: "Future Model" },
      ]);
      expect(getModelInfo("gpt-6.0-codex")).toBeDefined();
      expect(getModelInfo("gpt-6.0-codex-mini")).toBeDefined();
      expect(getModelInfo("gpt-oss-120b")).toBeDefined();
      expect(getModelInfo("dall-e-3")).toBeDefined();
      expect(getModelInfo("whisper-1")).toBeDefined();
      expect(getModelInfo("totally-new-model")).toBeDefined();
    });
  });

  // ── Tier 5: Branch coverage additions ────────────────────────────

  describe("normalizeBackendModel — reasoning efforts", () => {
    it("extracts efforts from supported_reasoning_levels with effort key", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "GPT-5.4 Backend",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "high", description: "High" },
        ],
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info).toBeDefined();
      expect(info!.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "low", description: "Low" },
        { reasoningEffort: "high", description: "High" },
      ]);
    });

    it("uses effort key fallback from supported_reasoning_efforts", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "GPT-5.4 Backend",
        supported_reasoning_efforts: [
          { effort: "medium" },
          { effort: "high" },
        ],
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
      ]);
    });

    it("defaults to medium when no explicit efforts or levels provided", () => {
      loadStaticModels("/tmp/test-config");
      // Apply a NEW backend model that's not in YAML (so no static fallback)
      applyBackendModels([{
        slug: "gpt-6.0-codex",
        display_name: "GPT-6.0 Codex",
        // No supported_reasoning_efforts or supported_reasoning_levels
      }]);
      const info = getModelInfo("gpt-6.0-codex");
      expect(info).toBeDefined();
      expect(info!.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "medium", description: "Default" },
      ]);
    });
  });

  describe("applyBackendModels — backend snapshot fields", () => {
    it("uses backend-normalized fallback fields instead of YAML gap filling", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "",
        description: "",
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.displayName).toBe("");
      expect(info!.description).toBe("");
    });
  });

  describe("applyBackendModelsForPlan — model removal", () => {
    it("removes old plan record when model is no longer in backend list", () => {
      loadStaticModels("/tmp/test-config");

      // First apply: plus plan has gpt-5.4 + gpt-5.3-codex
      applyBackendModelsForPlan("plus", [
        { slug: "gpt-5.4", display_name: "GPT-5.4" },
        { slug: "gpt-5.3-codex", display_name: "Codex" },
      ]);
      expect(getModelPlanTypes("gpt-5.4")).toContain("plus");
      expect(getModelPlanTypes("gpt-5.3-codex")).toContain("plus");

      // Second apply: plus plan now only has gpt-5.4 (gpt-5.3-codex removed)
      applyBackendModelsForPlan("plus", [
        { slug: "gpt-5.4", display_name: "GPT-5.4" },
      ]);
      expect(getModelPlanTypes("gpt-5.4")).toContain("plus");
      expect(getModelPlanTypes("gpt-5.3-codex")).not.toContain("plus");
      expect(getModelInfo("gpt-5.3-codex")).toBeUndefined();
    });

    it("keeps models present in another fetched plan until every plan drops them", () => {
      loadStaticModels("/tmp/test-config");

      applyBackendModelsForPlan("plus", [
        { slug: "gpt-5.4", display_name: "GPT-5.4" },
        { slug: "gpt-5.3-codex", display_name: "Codex" },
      ]);
      applyBackendModelsForPlan("team", [
        { slug: "gpt-5.3-codex", display_name: "Codex" },
      ]);

      applyBackendModelsForPlan("plus", [
        { slug: "gpt-5.4", display_name: "GPT-5.4" },
      ]);
      expect(getModelPlanTypes("gpt-5.3-codex")).toEqual(["team"]);
      expect(getModelInfo("gpt-5.3-codex")).toBeDefined();

      applyBackendModelsForPlan("team", []);
      expect(getModelPlanTypes("gpt-5.3-codex")).toEqual([]);
      expect(isRecognizedModelName("gpt-5.3-codex")).toBe(true);
      expect(getModelInfo("gpt-5.3-codex")).toBeUndefined();
    });
  });
});
