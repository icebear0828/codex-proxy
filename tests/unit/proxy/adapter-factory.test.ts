import { describe, expect, it, vi } from "vitest";
import { createAdapterForEntry } from "@src/proxy/adapter-factory.js";
import type { ApiKeyEntry } from "@src/auth/api-key-pool.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function entry(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    id: "entry-1",
    provider: "anthropic",
    model: "claude-test",
    apiKey: "sk-test",
    baseUrl: "https://compatible.example.com/v1",
    label: null,
    capabilities: ["chat"],
    format: "openai",
    status: "active",
    addedAt: "2026-05-30T00:00:00.000Z",
    lastUsedAt: null,
    ...overrides,
  };
}

function request(model: string): CodexResponsesRequest {
  return {
    model,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
  };
}

describe("createAdapterForEntry", () => {
  it("uses OpenAI-compatible requests when entry format is openai", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAdapterForEntry(entry());
    await adapter.createResponse(request("claude-test"), new AbortController().signal);

    expect(adapter.tag).toBe("anthropic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://compatible.example.com/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "claude-test" });

    vi.unstubAllGlobals();
  });
});
