import { describe, expect, it } from "vitest";
import {
  X_OPENCODE_SESSION_HEADER,
  applyOpenCodeHeaders,
  isOpenCodeUpstream,
} from "@src/proxy/opencode-headers.js";

describe("isOpenCodeUpstream", () => {
  it("recognizes opencode.ai and Console Go zen/go endpoints", () => {
    expect(isOpenCodeUpstream("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeUpstream("https://api.opencode.ai/zen/go")).toBe(true);
    expect(isOpenCodeUpstream("https://console.opencode.ai/v1")).toBe(true);
  });

  it("rejects non-OpenCode endpoints", () => {
    expect(isOpenCodeUpstream("https://api.openai.com/v1")).toBe(false);
    expect(isOpenCodeUpstream("https://provider.example.com/v1")).toBe(false);
    expect(isOpenCodeUpstream("https://opencode.evil.com/v1")).toBe(false);
    expect(isOpenCodeUpstream("")).toBe(false);
  });
});

describe("applyOpenCodeHeaders", () => {
  const baseUrl = "https://opencode.ai/zen/go/v1";
  const plainUrl = "https://api.openai.com/v1";

  it("forwards client session id and original User-Agent verbatim", () => {
    const headers: Record<string, string> = { "User-Agent": "proxy-default/1.0" };
    applyOpenCodeHeaders(headers, baseUrl, {
      clientUserAgent: "codex_cli_rs/0.41.0",
      opencodeSessionId: "session-abc",
    }, "fallback-session");
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBe("session-abc");
    expect(headers["User-Agent"]).toBe("codex_cli_rs/0.41.0");
  });

  it("falls back to the stable per-conversation id when the client sends none", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, baseUrl, {}, "stable-conversation-id");
    expect(headers[X_OPENCODE_SESSION_HEADER]).toBe("stable-conversation-id");
  });

  it("does not overwrite the User-Agent when the client sends none", () => {
    const headers: Record<string, string> = { "User-Agent": "proxy-default/1.0" };
    applyOpenCodeHeaders(headers, baseUrl, {}, "stable-conversation-id");
    expect(headers["User-Agent"]).toBe("proxy-default/1.0");
  });

  it("is a no-op for non-OpenCode upstreams", () => {
    const headers: Record<string, string> = {};
    applyOpenCodeHeaders(headers, plainUrl, {
      clientUserAgent: "codex_cli_rs/0.41.0",
      opencodeSessionId: "session-abc",
    }, "fallback-session");
    expect(headers).toEqual({});
  });
});
