/**
 * Integration tests for fingerprint header generation.
 * Verifies dynamic sec-ch-ua, header ordering, and auth header injection.
 */

import { vi, describe, it, expect } from "vitest";
import { createMockConfig, createMockFingerprint } from "@helpers/config.js";

const mockConfig = createMockConfig();
const mockFingerprint = createMockFingerprint();

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  getFingerprint: vi.fn(() => mockFingerprint),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  extractChatGptAccountId: vi.fn((token: string) => {
    // Parse the JWT to extract accountId for realistic testing
    try {
      const parts = token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        const auth = payload["https://api.openai.com/auth"] as
          | Record<string, unknown>
          | undefined;
        if (auth && typeof auth.chatgpt_account_id === "string") {
          return auth.chatgpt_account_id;
        }
      }
    } catch {
      // fall through
    }
    return "acct-test-default";
  }),
}));

import { getConfig, getFingerprint } from "@src/config.js";
import {
  buildAnonymousHeaders,
  buildHeaders,
  buildHeadersWithContentType,
} from "@src/fingerprint/manager.js";
import { createValidJwt } from "@helpers/jwt.js";

vi.mocked(getConfig).mockReturnValue(mockConfig);
vi.mocked(getFingerprint).mockReturnValue(mockFingerprint);

describe("fingerprint headers", () => {

  it("sec-ch-ua dynamically generated from chromium_version", () => {
    const headers = buildAnonymousHeaders();
    expect(headers["sec-ch-ua"]).toContain(`"Chromium";v="${mockConfig.client.chromium_version}"`);
    expect(headers["sec-ch-ua"]).toContain("136");
  });

  it("User-Agent matches template", () => {
    const headers = buildAnonymousHeaders();
    const expected = mockFingerprint.user_agent_template
      .replace("{version}", mockConfig.client.app_version)
      .replace("{platform}", mockConfig.client.platform)
      .replace("{arch}", mockConfig.client.arch);
    expect(headers["User-Agent"]).toBe(expected);
  });

  it("header order matches fingerprint config", () => {
    const headers = buildHeaders("tok-test");
    const keys = Object.keys(headers);

    // Find positions of Authorization and User-Agent
    const authIdx = keys.indexOf("Authorization");
    const uaIdx = keys.indexOf("User-Agent");

    // Authorization should come before User-Agent per mockFingerprint.header_order
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(uaIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(uaIdx);

    // Verify the order follows the header_order config for keys that are present
    const headerOrder = mockFingerprint.header_order;
    const orderedKeys = keys.filter((k) => headerOrder.includes(k));
    const expectedOrder = headerOrder.filter((k) => keys.includes(k));
    expect(orderedKeys).toEqual(expectedOrder);
  });

  it("originator header present", () => {
    const headers = buildHeaders("tok-test");
    expect(headers["originator"]).toBe("Codex Desktop");
  });

  it("buildHeadersWithContentType includes Content-Type", () => {
    const headers = buildHeadersWithContentType("tok-test");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("Authorization header from token", () => {
    const headers = buildHeaders("tok123");
    expect(headers["Authorization"]).toBe("Bearer tok123");
  });

  it("ChatGPT-Account-Id from JWT", () => {
    const jwt = createValidJwt({ accountId: "acct-fp-test" });
    const headers = buildHeaders(jwt);
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-fp-test");
  });

  it("anonymous headers have NO Authorization", () => {
    const headers = buildAnonymousHeaders();
    expect("Authorization" in headers).toBe(false);
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("default headers included", () => {
    const headers = buildAnonymousHeaders();
    expect(headers["Accept-Encoding"]).toBeDefined();
    expect(headers["Accept-Language"]).toBeDefined();
    expect(headers["sec-fetch-dest"]).toBe("empty");
    expect(headers["sec-fetch-mode"]).toBe("cors");
    expect(headers["sec-fetch-site"]).toBe("same-origin");
  });
});
