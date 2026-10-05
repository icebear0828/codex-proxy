import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityUpstream } from "@src/proxy/antigravity-upstream.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

const PRODUCTION_BASE_URL = "https://cloudcode-pa.googleapis.com";
const DAILY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

function baseRequest(instructions: string): CodexResponsesRequest {
  return {
    model: "antigravity:gemini-3.8-flash-medium",
    instructions,
    input: [{ role: "user", content: "First prompt" }],
    stream: true,
    store: false,
  };
}

function stubFetch(options: { accountInfo?: unknown; loadCodeAssistStatuses?: number[] } = {}) {
  const accountInfo = options.accountInfo ?? {
    cloudaicompanionProject: "project-1",
    paidTier: { id: "free-tier" },
    currentTier: { id: "free-tier" },
  };
  const loadCodeAssistStatuses = [...(options.loadCodeAssistStatuses ?? [])];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes(":loadCodeAssist")) {
      const status = loadCodeAssistStatuses.shift() ?? 200;
      return new Response(JSON.stringify(accountInfo), { status });
    }
    if (url.includes(":streamGenerateContent")) {
      return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("Unexpected test request", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestUrl(fetchMock: ReturnType<typeof stubFetch>, index: number): string {
  const input = fetchMock.mock.calls[index]?.[0];
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? "";
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
    expect(requestUrl(fetchMock, 1)).toBe(PRODUCTION_BASE_URL + "/v1internal:loadCodeAssist");
    expect(requestUrl(fetchMock, 2)).toBe(PRODUCTION_BASE_URL + "/v1internal:streamGenerateContent?alt=sse");
    const [, init] = fetchMock.mock.calls[2] as [RequestInfo | URL, RequestInit];
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
    const [, nextInit] = fetchMock.mock.calls[3] as [RequestInfo | URL, RequestInit];
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

    const [, init] = fetchMock.mock.calls[2] as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      request: { systemInstruction: { parts: Array<{ text: string }> } };
    };
    expect(body.request.systemInstruction.parts).toEqual([
      { text: "You are Antigravity, an AI coding assistant." },
      { text: "Preserve the user instructions." },
    ]);
  });

  it("uses the daily endpoint for a Google AI Pro account", async () => {
    const fetchMock = stubFetch({
      accountInfo: {
        cloudaicompanionProject: { projectId: "pro-project" },
        paidTier: { id: "g1-pro-tier" },
        currentTier: { id: "free-tier" },
      },
    });
    const upstream = new AntigravityUpstream("refresh-token");

    await upstream.createResponse(baseRequest(""), new AbortController().signal);

    expect(requestUrl(fetchMock, 1)).toBe(PRODUCTION_BASE_URL + "/v1internal:loadCodeAssist");
    expect(requestUrl(fetchMock, 2)).toBe(DAILY_BASE_URL + "/v1internal:streamGenerateContent?alt=sse");
    const [, init] = fetchMock.mock.calls[2] as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as { project: string };
    expect(body.project).toBe("pro-project");
  });

  it("uses the daily endpoint for a Google AI Ultra account with a saved project ID", async () => {
    const fetchMock = stubFetch({ accountInfo: { paidTier: "g1-ultra-tier" } });
    const upstream = new AntigravityUpstream("refresh-token", "saved-project");

    await upstream.createResponse(baseRequest(""), new AbortController().signal);

    expect(requestUrl(fetchMock, 2)).toBe(DAILY_BASE_URL + "/v1internal:streamGenerateContent?alt=sse");
  });

  it("keeps an explicitly configured base URL for paid accounts", async () => {
    const fetchMock = stubFetch({ accountInfo: { paidTier: { id: "g1-pro-tier" } } });
    const upstream = new AntigravityUpstream("refresh-token", "saved-project", "https://custom.example/");

    await upstream.createResponse(baseRequest(""), new AbortController().signal);

    expect(requestUrl(fetchMock, 1)).toBe("https://custom.example/v1internal:loadCodeAssist");
    expect(requestUrl(fetchMock, 2)).toBe("https://custom.example/v1internal:streamGenerateContent?alt=sse");
  });

  it("retries loadCodeAssist on the daily endpoint after a production 429", async () => {
    const fetchMock = stubFetch({
      accountInfo: { cloudaicompanionProject: "paid-project", paidTier: "g1-pro-tier" },
      loadCodeAssistStatuses: [429, 200],
    });
    const upstream = new AntigravityUpstream("refresh-token");

    await upstream.createResponse(baseRequest(""), new AbortController().signal);

    expect(requestUrl(fetchMock, 1)).toBe(PRODUCTION_BASE_URL + "/v1internal:loadCodeAssist");
    expect(requestUrl(fetchMock, 2)).toBe(DAILY_BASE_URL + "/v1internal:loadCodeAssist");
    expect(requestUrl(fetchMock, 3)).toBe(DAILY_BASE_URL + "/v1internal:streamGenerateContent?alt=sse");
  });

  it("retries endpoint-level resource exhaustion through the daily Cloud Code endpoint", async () => {
    const streamUrls: string[] = [];
    const streamBodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({
          cloudaicompanionProject: "project-1",
          paidTier: { id: "free-tier" },
          currentTier: { id: "free-tier" },
        }), { status: 200 });
      }
      if (url.includes(":streamGenerateContent")) {
        streamUrls.push(url);
        streamBodies.push(typeof init?.body === "string" ? init.body : "");
        if (url.startsWith(PRODUCTION_BASE_URL)) {
          return new Response(JSON.stringify({ error: { message: "Resource has been exhausted" } }), { status: 429 });
        }
        return new Response("data: {}\n\n", { status: 200 });
      }
      return new Response("Unexpected test request", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AntigravityUpstream("refresh-token", "project-1");
    const response = await upstream.createResponse(baseRequest("Keep the user instructions."), new AbortController().signal);

    expect(response.status).toBe(200);
    expect(streamUrls).toEqual([
      PRODUCTION_BASE_URL + "/v1internal:streamGenerateContent?alt=sse",
      DAILY_BASE_URL + "/v1internal:streamGenerateContent?alt=sse",
    ]);
    expect(streamBodies[0]).toBe(streamBodies[1]);
  });

  it("does not retry model-capacity exhaustion through another endpoint", async () => {
    let generationCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({ cloudaicompanionProject: "project-1" }), { status: 200 });
      }
      generationCalls++;
      return new Response(JSON.stringify({ error: { message: "Resource has been exhausted: capacity on this model" } }), { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AntigravityUpstream("refresh-token", "project-1");
    await expect(upstream.createResponse(baseRequest("Try the model."), new AbortController().signal)).rejects.toThrow();

    expect(generationCalls).toBe(1);
  });
});
