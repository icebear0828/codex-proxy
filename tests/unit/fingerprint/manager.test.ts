/**
 * Tests for fingerprint manager — header building.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockConfig, createMockFingerprint } from "@helpers/config.js";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(),
  getFingerprint: vi.fn(),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  extractChatGptAccountId: vi.fn((token: string) => {
    if (token.includes("no-acct")) return null;
    return "acct-test-123";
  }),
}));

import { getConfig, getFingerprint } from "@src/config.js";
import {
  buildAnonymousHeaders,
  buildHeaders,
  buildHeadersWithContentType,
} from "@src/fingerprint/manager.js";

const mockConfig = createMockConfig();
const mockFp = createMockFingerprint();

vi.mocked(getConfig).mockReturnValue(mockConfig);
vi.mocked(getFingerprint).mockReturnValue(mockFp);

describe("buildAnonymousHeaders", () => {
  it("includes User-Agent", () => {
    const headers = buildAnonymousHeaders();
    expect(headers["User-Agent"]).toContain("Codex Desktop");
  });

  it("includes dynamic sec-ch-ua based on chromium_version", () => {
    const headers = buildAnonymousHeaders();
    expect(headers["sec-ch-ua"]).toContain("136");
    expect(headers["sec-ch-ua"]).toContain("Chromium");
  });

  it("does NOT include Authorization", () => {
    const headers = buildAnonymousHeaders();
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("includes default headers from fingerprint config", () => {
    const headers = buildAnonymousHeaders();
    expect(headers["Accept-Encoding"]).toBeDefined();
    expect(headers["Accept-Language"]).toBeDefined();
  });
});

describe("buildHeaders", () => {
  it("includes Authorization header", () => {
    const headers = buildHeaders("test-token");
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("includes ChatGPT-Account-Id from JWT", () => {
    const headers = buildHeaders("test-token");
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-test-123");
  });

  it("uses explicit accountId when provided", () => {
    const headers = buildHeaders("test-token", "acct-explicit");
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-explicit");
  });

  it("omits ChatGPT-Account-Id when extraction returns null", () => {
    const headers = buildHeaders("no-acct-token");
    expect(headers["ChatGPT-Account-Id"]).toBeUndefined();
  });

  it("includes originator", () => {
    const headers = buildHeaders("test-token");
    expect(headers["originator"]).toBe("Codex Desktop");
  });

  it("includes User-Agent and sec-ch-ua", () => {
    const headers = buildHeaders("test-token");
    expect(headers["User-Agent"]).toContain("Codex Desktop");
    expect(headers["sec-ch-ua"]).toContain("Chromium");
  });
});


describe("buildHeadersWithContentType", () => {
  it("includes Content-Type: application/json", () => {
    const headers = buildHeadersWithContentType("test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes all standard headers", () => {
    const headers = buildHeadersWithContentType("test-token");
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["originator"]).toBe("Codex Desktop");
    expect(headers["User-Agent"]).toBeDefined();
    expect(headers["sec-ch-ua"]).toBeDefined();
  });
});

describe("Client Profile presets", () => {
  it("generates codex_cli profile headers without browser headers", () => {
    const cliConfig = createMockConfig({
      client: {
        profile: "codex_cli",
        originator: "codex_cli_rs",
        app_version: "0.1.0",
        platform: "darwin",
        arch: "arm64",
      },
    });
    vi.mocked(getConfig).mockReturnValue(cliConfig);

    const headers = buildHeaders("test-token");
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.1.0 (darwin arm64)");
    expect(headers["sec-ch-ua"]).toBeUndefined();
    expect(headers["sec-fetch-dest"]).toBeUndefined();
    expect(headers["Accept-Encoding"]).toBeDefined();
  });

  it("generates opencode profile headers", () => {
    const opencodeConfig = createMockConfig({
      client: {
        profile: "opencode",
        originator: "opencode",
        app_version: "1.0.0",
        platform: "linux",
        arch: "x64",
      },
    });
    vi.mocked(getConfig).mockReturnValue(opencodeConfig);

    const headers = buildHeaders("test-token");
    expect(headers["originator"]).toBe("opencode");
    expect(headers["User-Agent"]).toBe("opencode/1.0.0 (linux x64)");
    expect(headers["sec-ch-ua"]).toBeUndefined();
  });

  it("generates pi profile headers", () => {
    const piConfig = createMockConfig({
      client: {
        profile: "pi",
        originator: "pi",
        app_version: "0.5.0",
        platform: "darwin",
        arch: "arm64",
      },
    });
    vi.mocked(getConfig).mockReturnValue(piConfig);

    const headers = buildHeaders("test-token");
    expect(headers["originator"]).toBe("pi");
    expect(headers["User-Agent"]).toBe("pi/0.5.0 (darwin arm64)");
    expect(headers["sec-ch-ua"]).toBeUndefined();
  });
});

