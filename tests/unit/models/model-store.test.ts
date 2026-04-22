/**
 * Tests for ModelStore — model catalog + aliases + suffix parsing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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
  parseModelName,
  resolveModelId,
  getModelInfo,
  getModelCatalog,
  getModelAliases,
  applyBackendModels,
  getModelPlanTypes,
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
    supportsPersonality: false
    upgrade: null
aliases:
  codex: "gpt-5.4"
  codex-mini: "gpt-5.3-codex-spark"
`;

describe("ModelStore", () => {
  beforeEach(() => {
    vi.mocked(readFileSync).mockReturnValue(FIXTURE_YAML);
    loadStaticModels("/tmp/test-config");
  });

  describe("loadStaticModels", () => {
    it("loads models from YAML", () => {
      const catalog = getModelCatalog();
      expect(catalog.length).toBe(4);
      expect(catalog[0].id).toBe("gpt-5.4");
    });

    it("loads aliases", () => {
      const aliases = getModelAliases();
      expect(aliases["codex"]).toBe("gpt-5.4");
      expect(aliases["codex-mini"]).toBe("gpt-5.3-codex-spark");
    });
  });

  describe("resolveModelId", () => {
    it("resolves alias to model ID", () => {
      expect(resolveModelId("codex")).toBe("gpt-5.4");
    });

    it("returns known model ID as-is", () => {
      expect(resolveModelId("gpt-5.4")).toBe("gpt-5.4");
    });

    it("falls back to config default for unknown model", () => {
      expect(resolveModelId("unknown-model")).toBe("gpt-5.3-codex");
    });
  });

  describe("parseModelName", () => {
    it("returns known alias without stripping", () => {
      const result = parseModelName("codex");
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

    it("strips suffix from alias", () => {
      const result = parseModelName("codex-fast");
      expect(result.modelId).toBe("gpt-5.4");
      expect(result.serviceTier).toBe("fast");
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
    });

    it("accepts aliases with suffixes", () => {
      expect(isRecognizedModelName("codex-high")).toBe(true);
      expect(isRecognizedModelName("codex-fast")).toBe(true);
    });

    it("rejects unknown model names even with valid-looking suffixes", () => {
      expect(isRecognizedModelName("totally-unknown")).toBe(false);
      expect(isRecognizedModelName("totally-unknown-low")).toBe(false);
      expect(isRecognizedModelName("totally-unknown-high-fast")).toBe(false);
    });
  });

  describe("getModelInfo", () => {
    it("returns model info by ID", () => {
      const info = getModelInfo("gpt-5.4");
      expect(info).toBeDefined();
      expect(info!.displayName).toBe("GPT-5.4");
      expect(info!.isDefault).toBe(true);
    });

    it("returns undefined for unknown ID", () => {
      expect(getModelInfo("nonexistent")).toBeUndefined();
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

    it("preserves static-only models", () => {
      // Re-load static first
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "GPT-5.4 (Backend)",
      }]);
      // gpt-5.3-codex should still exist (static-only)
      const info = getModelInfo("gpt-5.3-codex");
      expect(info).toBeDefined();
      expect(info!.source).toBe("static");
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

    it("admits all backend models without client-side filtering", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "research",
        display_name: "Research Model",
      }]);
      // All backend models are trusted — no client-side filtering
      const info = getModelInfo("research");
      expect(info).toBeDefined();
    });

    it("uses YAML efforts when backend has none", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "Backend 5.4",
        // No supported_reasoning_efforts
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.supportedReasoningEfforts.length).toBe(4); // from YAML
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

  describe("applyBackendModels — YAML gap filling", () => {
    it("preserves YAML displayName when backend has empty string", () => {
      loadStaticModels("/tmp/test-config");
      applyBackendModels([{
        slug: "gpt-5.4",
        display_name: "",
        description: "",
      }]);
      const info = getModelInfo("gpt-5.4");
      expect(info!.displayName).toBe("GPT-5.4"); // from YAML
      expect(info!.description).toBe("Latest flagship"); // from YAML
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
    });
  });
});
