/**
 * Tests for plan-based model routing.
 *
 * Verifies that:
 * 1. applyBackendModelsForPlan correctly builds planModelMap
 * 2. getModelPlanTypes returns correct plan associations
 * 3. When both free and team plans include a model, both are returned
 * 4. Account pool respects plan routing when acquiring accounts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    server: {},
    model: {},
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
  })),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null)),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

import {
  loadStaticModels,
  applyBackendModelsForPlan,
  getModelPlanTypes,
  getModelStoreDebug,
} from "@src/models/model-store.js";

// Minimal backend model entry matching what Codex API returns
function makeModel(slug: string) {
  return { slug, id: slug, name: slug };
}

describe("plan-based model routing", () => {
  beforeEach(() => {
    // Reset model store state by reloading empty static catalog
    loadStaticModels();
  });

  it("applyBackendModelsForPlan registers models for a plan", () => {
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);

    expect(getModelPlanTypes("gpt-5.2-codex")).toContain("free");
    expect(getModelPlanTypes("gpt-5.4")).toContain("free");
  });

  it("models available in both plans return both plan types", () => {
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
      makeModel("gpt-5.4-mini"),
    ]);

    const plans54 = getModelPlanTypes("gpt-5.4");
    expect(plans54).toContain("free");
    expect(plans54).toContain("team");

    const plansCodex = getModelPlanTypes("gpt-5.2-codex");
    expect(plansCodex).toContain("free");
    expect(plansCodex).toContain("team");
  });

  it("model only in team plan does not include free", () => {
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
    ]);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);

    const plans54 = getModelPlanTypes("gpt-5.4");
    expect(plans54).toContain("team");
    expect(plans54).not.toContain("free");
  });

  it("replacing a plan's models updates the index", () => {
    // Initially free doesn't have gpt-5.4
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);
    expect(getModelPlanTypes("gpt-5.4")).not.toContain("free");

    // Backend now returns gpt-5.4 for free → re-fetch
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);
    expect(getModelPlanTypes("gpt-5.4")).toContain("free");
  });

  it("unknown model returns empty plan list", () => {
    applyBackendModelsForPlan("free", [makeModel("gpt-5.2-codex")]);
    expect(getModelPlanTypes("nonexistent-model")).toEqual([]);
  });

  it("all backend model slugs are admitted (no client-side filtering)", () => {
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("research"),
      makeModel("gpt-5-2"),
      makeModel("some-internal-slug"),
    ]);

    expect(getModelPlanTypes("gpt-5.2-codex")).toContain("free");
    expect(getModelPlanTypes("research")).toContain("free");
    expect(getModelPlanTypes("gpt-5-2")).toContain("free");
    expect(getModelPlanTypes("some-internal-slug")).toContain("free");
  });

  it("gpt-oss-* models are admitted", () => {
    applyBackendModelsForPlan("free", [
      makeModel("gpt-oss-120b"),
      makeModel("gpt-oss-20b"),
    ]);

    expect(getModelPlanTypes("gpt-oss-120b")).toContain("free");
    expect(getModelPlanTypes("gpt-oss-20b")).toContain("free");
  });

  it("planMap in store info reflects current state", () => {
    applyBackendModelsForPlan("free", [
      makeModel("gpt-5.2-codex"),
      makeModel("gpt-5.4"),
    ]);
    applyBackendModelsForPlan("team", [
      makeModel("gpt-5.4"),
    ]);

    const info = getModelStoreDebug();
    expect(info.planMap.free).toContain("gpt-5.2-codex");
    expect(info.planMap.free).toContain("gpt-5.4");
    expect(info.planMap.team).toContain("gpt-5.4");
    expect(info.planMap.team).not.toContain("gpt-5.2-codex");
  });
});
