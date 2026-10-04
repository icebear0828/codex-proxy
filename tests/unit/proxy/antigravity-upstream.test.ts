import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityUpstream } from "@src/proxy/antigravity-upstream.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

function baseRequest(instructions: string): CodexResponsesRequest {
  return {
    model: "antigravity:gemini-3.8-flash-medium",
    instructions,
    input: [{ role: "user", content: "First prompt" }],
    stream: true,
    store: false,
  };
}

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    access_token: "access-token",
    expires_in: 3600,
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AntigravityUpstream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes Claude Code identity and includes required Cloud Code fields", async () => {
    const fetchMock = stubFetch();
    const upstream = new AntigravityUpstream("refresh-token", "project-1");
    const req = baseRequest(
      "You are Claude Code, Anthropic's official CLI for Claude.\nPreserve the rest of this prompt.",
    );

    await upstream.createResponse(req, new AbortController().signal);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      model: string;
      request: {
        sessionId: string;
        systemInstruction: { parts: Array<{ text: string }> };
        toolConfig: { functionCallingConfig: { mode: string } };
      };
    };

    expect(body.model).toBe("gemini-3.8-flash-medium");
    expect(body.request.systemInstruction.parts).toEqual([
      { text: "You are Antigravity, an AI coding assistant." },
      { text: "You are an AI agent.\nPreserve the rest of this prompt." },
    ]);
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(body.request.sessionId).toMatch(/^-[0-9]+$/);

    const nextTurn: CodexResponsesRequest = {
      ...req,
      input: [...req.input, { role: "user", content: "Follow-up" }],
    };
    await upstream.createResponse(nextTurn, new AbortController().signal);
    const [, nextInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const nextBody = JSON.parse(nextInit.body as string) as typeof body;
    expect(nextBody.request.sessionId).toBe(body.request.sessionId);
  });

  it("removes the leading Codex model identity without requiring a final period", async () => {
    const fetchMock = stubFetch();
    const upstream = new AntigravityUpstream("refresh-token", "project-1");
    await upstream.createResponse(
      baseRequest("You are Codex, a coding agent based on GPT-5\nPreserve the user instructions."),
      new AbortController().signal,
    );

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      request: { systemInstruction: { parts: Array<{ text: string }> } };
    };
    expect(body.request.systemInstruction.parts).toEqual([
      { text: "You are Antigravity, an AI coding assistant." },
      { text: "Preserve the user instructions." },
    ]);
  });
});
