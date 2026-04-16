import { describe, it, expect } from "vitest";
import { extractAnthropicClientConversationId } from "@src/routes/shared/anthropic-session-id.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";

function makeRequest(): AnthropicMessagesRequest {
  return {
    model: "gpt-5.4-mini",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  };
}

describe("extractAnthropicClientConversationId", () => {
  it("优先使用 x-claude-code-session-id 头", () => {
    const req = {
      ...makeRequest(),
      metadata: {
        user_id: JSON.stringify({ session_id: "body-session" }),
      },
    };
    expect(extractAnthropicClientConversationId(req, "header-session")).toBe("header-session");
  });

  it("头不存在时回退到 metadata.user_id.session_id", () => {
    const req = {
      ...makeRequest(),
      metadata: {
        user_id: JSON.stringify({
          session_id: "body-session",
          device_id: "device-1",
        }),
      },
    };
    expect(extractAnthropicClientConversationId(req, undefined)).toBe("body-session");
  });

  it("无可用 session_id 时返回 null", () => {
    expect(extractAnthropicClientConversationId(makeRequest(), undefined)).toBeNull();
    expect(extractAnthropicClientConversationId({
      ...makeRequest(),
      metadata: { user_id: "not-json" },
    }, undefined)).toBeNull();
  });

  it("metadata 缺少 Claude 设备字段时不启用回退解析", () => {
    expect(extractAnthropicClientConversationId({
      ...makeRequest(),
      metadata: {
        user_id: JSON.stringify({ session_id: "generic-session" }),
      },
    }, undefined)).toBeNull();
  });
});
