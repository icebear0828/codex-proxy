/**
 * Tests for the shared routable Codex host model resolver.
 *
 * Uses the real ModelStore (mocked fs/paths/config) so the resolver is exercised
 * against a real catalog + aliases + custom_models, matching how Images routing
 * and the admin settings endpoint consume it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "fs";

const mockConfiguredAliases: Record<string, string> = {};
const mockCustomModels: Array<string | { id: string }> = [];

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
      default: "gpt-5.4",
      aliases: mockConfiguredAliases,
      custom_models: mockCustomModels,
    },
  })),
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

import { loadStaticModels } from "@src/models/model-store.js";
import {
  getRoutableCodexHostModelAllowedModels,
  isImageHostModelClientId,
  resolveRoutableCodexHostModel,
} from "@src/models/routable-model-resolver.js";

const FIXTURE_YAML = `
models:
  - id: gpt-5.4
    displayName: GPT-5.4
    description: Latest flagship
    isDefault: true
    supportedReasoningEfforts:
      - { reasoningEffort: medium, description: "Medium" }
    defaultReasoningEffort: medium
    inputModalities: [text]
    supportsPersonality: true
    upgrade: null
  - id: gpt-5.5
    displayName: GPT-5.5
    description: GPT-5.5 host
    isDefault: false
    supportedReasoningEfforts:
      - { reasoningEffort: medium, description: "Medium" }
    defaultReasoningEffort: medium
    inputModalities: [text]
    outputModalities: [text, image]
    supportsPersonality: true
    upgrade: null
`;

describe("routable-model-resolver", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockConfiguredAliases)) {
      delete mockConfiguredAliases[key];
    }
    mockCustomModels.length = 0;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(FIXTURE_YAML);
    loadStaticModels("/tmp/test-config");
  });

  describe("resolveRoutableCodexHostModel", () => {
    it("resolves a catalog model ID to its canonical value", () => {
      expect(resolveRoutableCodexHostModel("gpt-5.4")).toBe("gpt-5.4");
      expect(resolveRoutableCodexHostModel("  gpt-5.5  ")).toBe("gpt-5.5");
    });

    it("resolves a registered custom model ID", () => {
      mockCustomModels.push("my-custom-model");
      loadStaticModels("/tmp/test-config");
      expect(resolveRoutableCodexHostModel("my-custom-model")).toBe("my-custom-model");
    });

    it("resolves a registered alias to its canonical catalog model", () => {
      mockConfiguredAliases["img-host"] = "gpt-5.4";
      loadStaticModels("/tmp/test-config");
      expect(resolveRoutableCodexHostModel("img-host")).toBe("gpt-5.4");
    });

    it("preserves reasoning-effort / service-tier suffixes", () => {
      expect(resolveRoutableCodexHostModel("gpt-5.4-high")).toBe("gpt-5.4-high");
      expect(resolveRoutableCodexHostModel("gpt-5.4-fast")).toBe("gpt-5.4-fast");
    });

    it("rejects gpt-image-2 case-insensitively", () => {
      expect(resolveRoutableCodexHostModel("gpt-image-2")).toBeNull();
      expect(resolveRoutableCodexHostModel("GPT-IMAGE-2")).toBeNull();
      expect(resolveRoutableCodexHostModel("  gpt-image-2  ")).toBeNull();
    });

    it("returns null for an empty or whitespace-only input", () => {
      expect(resolveRoutableCodexHostModel("")).toBeNull();
      expect(resolveRoutableCodexHostModel("   ")).toBeNull();
    });

    it("returns null for an unknown model instead of falling back to default", () => {
      expect(resolveRoutableCodexHostModel("totally-unknown")).toBeNull();
    });

    it("returns null for an alias that targets an unknown model", () => {
      mockConfiguredAliases["bad-alias"] = "not-in-catalog";
      loadStaticModels("/tmp/test-config");
      expect(resolveRoutableCodexHostModel("bad-alias")).toBeNull();
    });
  });

  describe("getRoutableCodexHostModelAllowedModels", () => {
    it("returns catalog models plus resolvable aliases, sorted and free of gpt-image-2", () => {
      mockConfiguredAliases["img-host"] = "gpt-5.4";
      mockConfiguredAliases["bad-alias"] = "not-in-catalog";
      loadStaticModels("/tmp/test-config");

      const allowed = getRoutableCodexHostModelAllowedModels();
      expect(allowed).toContain("gpt-5.4");
      expect(allowed).toContain("gpt-5.5");
      expect(allowed).toContain("img-host");
      expect(allowed).not.toContain("bad-alias");
      expect(allowed).not.toContain("gpt-image-2");
      expect([...allowed].sort()).toEqual(allowed);
    });

    it("includes registered custom models", () => {
      mockCustomModels.push("my-custom-model");
      loadStaticModels("/tmp/test-config");
      expect(getRoutableCodexHostModelAllowedModels()).toContain("my-custom-model");
    });

    it("excludes a custom model registered under gpt-image-2", () => {
      mockCustomModels.push("gpt-image-2");
      loadStaticModels("/tmp/test-config");
      expect(getRoutableCodexHostModelAllowedModels()).not.toContain("gpt-image-2");
    });
  });

  describe("isImageHostModelClientId", () => {
    it("matches gpt-image-2 case-insensitively and rejects real models", () => {
      expect(isImageHostModelClientId("gpt-image-2")).toBe(true);
      expect(isImageHostModelClientId("GPT-IMAGE-2")).toBe(true);
      expect(isImageHostModelClientId(" gpt-image-2 ")).toBe(true);
      expect(isImageHostModelClientId("gpt-5.5")).toBe(false);
    });
  });
});
