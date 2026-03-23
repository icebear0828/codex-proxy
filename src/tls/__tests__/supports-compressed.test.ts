import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "child_process";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: () => false, // force system curl fallback
}));

vi.mock("../../config.js", () => ({
  getConfig: () => ({
    tls: { curl_binary: "auto", proxy_url: null, force_http11: false },
  }),
}));

vi.mock("../../paths.js", () => ({
  getBinDir: () => "/nonexistent",
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("supportsCompressed", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns true when system curl supports --compressed", async () => {
    mockedExecFileSync.mockImplementation(() => Buffer.from(""));
    const { supportsCompressed, resetCurlBinaryCache } = await import("../curl-binary.js");
    resetCurlBinaryCache();
    expect(supportsCompressed()).toBe(true);
  });

  it("returns false when system curl probe throws", async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("curl: option --compressed: the installed libcurl has no support for this");
    });
    const { supportsCompressed, resetCurlBinaryCache } = await import("../curl-binary.js");
    resetCurlBinaryCache();
    expect(supportsCompressed()).toBe(false);
  });

  it("resetCurlBinaryCache resets supportsCompressed to true", async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("no support");
    });
    const { supportsCompressed, resetCurlBinaryCache } = await import("../curl-binary.js");
    resetCurlBinaryCache();
    // After reset + re-resolve with failing probe → false
    expect(supportsCompressed()).toBe(false);
    // Reset should restore default
    resetCurlBinaryCache();
    // Now make probe succeed
    mockedExecFileSync.mockImplementation(() => Buffer.from(""));
    expect(supportsCompressed()).toBe(true);
  });
});
