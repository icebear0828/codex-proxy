/**
 * Tests that model-store writes cache to data/ (gitignored),
 * NOT to config/models.yaml (git-tracked).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    server: {},
    model: { default: "gpt-5.2-codex" },
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/fake/config"),
  getDataDir: vi.fn(() => "/fake/data"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []\naliases: {}"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn((_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null)),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => "models: []"),
  },
}));

import { writeFile, mkdirSync, existsSync } from "fs";
import { loadStaticModels, applyBackendModels } from "@src/models/model-store.js";

describe("model cache writes to data/, not config/", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    loadStaticModels();
  });

  it("syncStaticModels writes to data/models-cache.yaml", () => {
    applyBackendModels([{ slug: "gpt-5.4", name: "GPT 5.4" }]);

    expect(writeFile).toHaveBeenCalledOnce();
    const writePath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(writePath).toContain("/fake/data/models-cache.yaml");
  });

  it("syncStaticModels never writes to config/models.yaml", () => {
    applyBackendModels([{ slug: "gpt-5.4", name: "GPT 5.4" }]);

    const writePath = vi.mocked(writeFile).mock.calls[0][0] as string;
    expect(writePath).not.toContain("/fake/config/");
  });

  it("ensures data dir exists before writing cache", () => {
    applyBackendModels([{ slug: "gpt-5.4", name: "GPT 5.4" }]);

    expect(mkdirSync).toHaveBeenCalledWith("/fake/data", { recursive: true });
  });
});
