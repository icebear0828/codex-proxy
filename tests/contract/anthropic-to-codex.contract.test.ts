/**
 * Contract tests for Anthropic Messages → Codex Responses translation.
 *
 * Each fixture defines an Anthropic request input and the expected subset of
 * fields in the Codex output. Tests verify that the translation function
 * produces output matching the golden contract — any drift is a snapshot
 * failure that must be explicitly approved.
 *
 * This catches regressions from upstream payload changes (new roles, new
 * content block types, thinking format changes) before they hit users as 400s.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((input: string) => ({
    modelId: input,
    serviceTier: null,
    reasoningEffort: null,
  })),
  getModelInfo: vi.fn(() => undefined),
}));

import { translateAnthropicToCodexRequest } from "@src/translation/anthropic-to-codex.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";

interface ContractFixture {
  name: string;
  description: string;
  input: Record<string, unknown>;
  expectedOutput: Record<string, unknown>;
}

const fixturesPath = resolve(__dirname, "fixtures/anthropic-to-codex.json");
const fixtures: ContractFixture[] = JSON.parse(readFileSync(fixturesPath, "utf-8"));

// Pre-compute all translation results once (pure function, no side effects)
const results = fixtures.map((f) => ({
  fixture: f,
  result: translateAnthropicToCodexRequest(f.input as AnthropicMessagesRequest),
}));

describe("Anthropic → Codex contract", () => {
  it.each(results)("$fixture.name: $fixture.description", ({ fixture, result }) => {
    expect(result).toMatchObject(fixture.expectedOutput);
  });

  it("always produces stream: true and store: false", () => {
    for (const { result } of results) {
      expect(result.stream).toBe(true);
      expect(result.store).toBe(false);
    }
  });

  it("always produces a non-empty input array", () => {
    for (const { result } of results) {
      expect(result.input.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("never leaks thinking/redacted_thinking blocks into output", () => {
    for (const { result } of results) {
      const serialized = JSON.stringify(result.input);
      expect(serialized).not.toContain('"type":"thinking"');
      expect(serialized).not.toContain('"type":"redacted_thinking"');
    }
  });

  it("never contains billing header content in instructions", () => {
    for (const { result } of results) {
      if (result.instructions) {
        expect(result.instructions).not.toContain("x-anthropic-billing-header");
        expect(result.instructions).not.toContain("cc_version=");
        expect(result.instructions).not.toContain("cch=");
      }
    }
  });
});
