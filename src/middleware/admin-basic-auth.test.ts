import { describe, expect, it } from "vitest";
import {
  isProtectedManagementPath,
  parseBasicAuthHeader,
} from "./admin-basic-auth.js";

describe("isProtectedManagementPath", () => {
  it("bypasses OpenAI-compatible API routes", () => {
    expect(isProtectedManagementPath("/v1/chat/completions")).toBe(false);
    expect(isProtectedManagementPath("/v1/models")).toBe(false);
  });

  it("bypasses Gemini-compatible API routes", () => {
    expect(isProtectedManagementPath("/v1beta/models")).toBe(false);
    expect(isProtectedManagementPath("/v1beta/models/gpt-5.4:generateContent")).toBe(false);
  });

  it("keeps health checks public", () => {
    expect(isProtectedManagementPath("/health")).toBe(false);
  });

  it("protects dashboard and management endpoints", () => {
    expect(isProtectedManagementPath("/")).toBe(true);
    expect(isProtectedManagementPath("/auth/status")).toBe(true);
    expect(isProtectedManagementPath("/admin/settings")).toBe(true);
    expect(isProtectedManagementPath("/api/proxies")).toBe(true);
    expect(isProtectedManagementPath("/debug/models")).toBe(true);
  });
});

describe("parseBasicAuthHeader", () => {
  it("parses valid Basic credentials", () => {
    const header = `Basic ${Buffer.from("admin:secret").toString("base64")}`;

    expect(parseBasicAuthHeader(header)).toEqual({
      username: "admin",
      password: "secret",
    });
  });

  it("handles scheme case-insensitively", () => {
    const header = `basic ${Buffer.from("admin:secret").toString("base64")}`;

    expect(parseBasicAuthHeader(header)).toEqual({
      username: "admin",
      password: "secret",
    });
  });

  it("rejects malformed values", () => {
    expect(parseBasicAuthHeader(undefined)).toBeNull();
    expect(parseBasicAuthHeader("Bearer token")).toBeNull();
    expect(parseBasicAuthHeader("Basic invalid")).toBeNull();
  });
});
