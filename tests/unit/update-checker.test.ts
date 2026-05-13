/**
 * Tests that update-checker keeps runtime state and YAML version baseline aligned.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockMkdirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockMutateClientConfig = vi.fn();
const mockMutateYaml = vi.fn();
const mockFork = vi.fn(() => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  mutateClientConfig: mockMutateClientConfig,
  reloadAllConfigs: vi.fn(),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/fake/config"),
  getDataDir: vi.fn(() => "/fake/data"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitterInt: vi.fn((ms: number) => ms),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: mockMutateYaml,
}));

vi.mock("@src/tls/curl-fetch.js", () => ({
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

vi.mock("child_process", () => ({
  fork: mockFork,
}));

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({
      client: { app_version: "1.0.0", build_number: "100" },
    })),
  },
}));

import { curlFetchGet } from "@src/tls/curl-fetch.js";

const APPCAST_XML = `<?xml version="1.0"?>
<rss><channel><item>
  <enclosure sparkle:shortVersionString="2.0.0" sparkle:version="200" url="https://example.com/download"/>
</item></channel></rss>`;

type YamlMutator = (data: Record<string, unknown>) => void;

function getClientYamlMutator(): YamlMutator {
  const call = mockMutateYaml.mock.calls.find((entry) => entry[0] === "/fake/config/default.yaml");
  if (!call) {
    throw new Error("config/default.yaml mutator was not called");
  }
  return call[1] as YamlMutator;
}

describe("update-checker syncs version state and config YAML", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    delete process.env.CODEX_DESKTOP_PATH;
    delete process.env.CODEX_APP_PATH;
  });

  it("applyVersionUpdate writes to data/version-state.json", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    // Dynamic import to get fresh module state
    const { checkForUpdate } = await import("@src/update-checker.js");
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

  it("syncs app version and build number to config/default.yaml", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("@src/update-checker.js");
    await checkForUpdate();

    const mutate = getClientYamlMutator();
    const yamlData: Record<string, unknown> = {
      client: {
        app_version: "1.0.0",
        build_number: "100",
        chromium_version: "144",
      },
    };
    mutate(yamlData);

    expect(yamlData.client).toEqual({
      app_version: "2.0.0",
      build_number: "200",
      chromium_version: "144",
    });
  });

  it("updates runtime config via mutateClientConfig", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("@src/update-checker.js");
    await checkForUpdate();

    expect(mockMutateClientConfig).toHaveBeenCalledWith({
      app_version: "2.0.0",
      build_number: "200",
    });
  });

  it("syncs matching extracted chromium version to state, YAML, and runtime config", async () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith("extracted-fingerprint.json"));
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith("extracted-fingerprint.json")) {
        return JSON.stringify({
          app_version: "2.0.0",
          build_number: "200",
          chromium_version: "146",
        });
      }
      return "";
    });
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("@src/update-checker.js");
    await checkForUpdate();

    const versionWrite = mockWriteFileSync.mock.calls.find(
      (call) => (call[0] as string).includes("version-state.json"),
    );
    if (!versionWrite) {
      throw new Error("version-state.json was not written");
    }
    expect(JSON.parse(versionWrite[1] as string)).toEqual({
      app_version: "2.0.0",
      build_number: "200",
      chromium_version: "146",
    });

    const mutate = getClientYamlMutator();
    const yamlData: Record<string, unknown> = {
      client: {
        app_version: "1.0.0",
        build_number: "100",
        chromium_version: "144",
      },
    };
    mutate(yamlData);
    expect(yamlData.client).toEqual({
      app_version: "2.0.0",
      build_number: "200",
      chromium_version: "146",
    });

    expect(mockMutateClientConfig).toHaveBeenCalledWith({
      app_version: "2.0.0",
      build_number: "200",
      chromium_version: "146",
    });
  });

  it("does not fork the full-update script without a configured Codex source path", async () => {
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("@src/update-checker.js");
    await checkForUpdate();

    expect(mockFork).not.toHaveBeenCalled();
  });

  it("passes the configured Codex source path to full-update", async () => {
    process.env.CODEX_DESKTOP_PATH = "/Applications/Codex.app";
    vi.mocked(curlFetchGet).mockResolvedValue({
      ok: true,
      status: 200,
      body: APPCAST_XML,
    });

    const { checkForUpdate } = await import("@src/update-checker.js");
    await checkForUpdate();

    expect(mockFork).toHaveBeenCalledOnce();
    const [, args] = mockFork.mock.calls[0];
    expect(args).toEqual(["--path", "/Applications/Codex.app"]);
  });
});
