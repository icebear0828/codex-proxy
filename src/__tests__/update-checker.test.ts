/**
 * Tests that update-checker writes version state to data/ (gitignored),
 * NOT to config/default.yaml (git-tracked).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockMutateClientConfig = vi.fn();

vi.mock("../config.js", () => ({
  mutateClientConfig: mockMutateClientConfig,
  reloadAllConfigs: vi.fn(),
}));

vi.mock("../paths.js", () => ({
  getConfigDir: vi.fn(() => "/fake/config"),
  getDataDir: vi.fn(() => "/fake/data"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("../utils/jitter.js", () => ({
  jitterInt: vi.fn((ms: number) => ms),
}));

vi.mock("../tls/curl-fetch.js", () => ({
  curlFetchGet: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({
      client: { app_version: "1.0.0", build_number: "100" },
    })),
  },
}));

import { curlFetchGet } from "../tls/curl-fetch.js";

const APPCAST_XML = `<?xml version="1.0"?>
<rss><channel><item>
  <enclosure sparkle:shortVersionString="2.0.0" sparkle:version="200" url="https://example.com/download"/>
</item></channel></rss>`;

describe("update-checker writes to data/, not config/", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
  });

  it("applyVersionUpdate writes to data/version-state.json, not config/default.yaml", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    // Dynamic import to get fresh module state
    const { checkForUpdate } = await import("../update-checker.js");
    await checkForUpdate();

    // Should write version-state.json to data/
    const versionWrites = mockWriteFileSync.mock.calls.filter(
      (call) => (call[0] as string).includes("version-state.json"),
    );
    expect(versionWrites.length).toBeGreaterThanOrEqual(1);
    const writePath = versionWrites[0][0] as string;
    expect(writePath).toBe("/fake/data/version-state.json");

    // Parse the written content
    const written = JSON.parse(versionWrites[0][1] as string) as {
      app_version: string;
      build_number: string;
    };
    expect(written.app_version).toBe("2.0.0");
    expect(written.build_number).toBe("200");
  });

  it("never calls mutateYaml on config/default.yaml", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("../update-checker.js");
    await checkForUpdate();

    // No writes should target config/default.yaml
    const configWrites = mockWriteFileSync.mock.calls.filter(
      (call) => (call[0] as string).includes("/fake/config/"),
    );
    expect(configWrites).toHaveLength(0);
  });

  it("updates runtime config via mutateClientConfig", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("../update-checker.js");
    await checkForUpdate();

    expect(mockMutateClientConfig).toHaveBeenCalledWith({
      app_version: "2.0.0",
      build_number: "200",
    });
  });
});
