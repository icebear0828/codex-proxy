import { describe, expect, it } from "vitest";
import {
  extractProxyApiKey,
  OPENAI_PROXY_KEY_SOURCES,
  GEMINI_PROXY_KEY_SOURCES,
} from "./proxy-auth.js";

function makeRequest(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return {
    header(name: string) {
      return normalizedHeaders.get(name.toLowerCase());
    },
    query(name: string) {
      return query[name];
    },
  };
}

describe("extractProxyApiKey", () => {
  it("extracts Bearer tokens case-insensitively for OpenAI-compatible routes", () => {
    const req = makeRequest({ Authorization: "bearer openclaw-key" });

    expect(extractProxyApiKey(req, OPENAI_PROXY_KEY_SOURCES)).toBe("openclaw-key");
  });

  it("falls back to x-api-key for OpenAI-compatible routes", () => {
    const req = makeRequest({ "x-api-key": "openclaw-key" });

    expect(extractProxyApiKey(req, OPENAI_PROXY_KEY_SOURCES)).toBe("openclaw-key");
  });

  it("supports api-key headers for OpenAI-compatible routes", () => {
    const req = makeRequest({ "api-key": "openclaw-key" });

    expect(extractProxyApiKey(req, OPENAI_PROXY_KEY_SOURCES)).toBe("openclaw-key");
  });

  it("preserves Gemini query param compatibility", () => {
    const req = makeRequest({}, { key: "gemini-key" });

    expect(extractProxyApiKey(req, GEMINI_PROXY_KEY_SOURCES)).toBe("gemini-key");
  });
});
