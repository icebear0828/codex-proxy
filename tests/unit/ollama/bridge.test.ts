import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaBridgeApp } from "@src/ollama/bridge.js";

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function createApp(disableVision = false) {
  return createOllamaBridgeApp({
    upstreamBaseUrl: "http://upstream.test",
    proxyApiKey: "proxy-secret",
    version: "0.18.3-test",
    disableVision,
  });
}

async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Ollama bridge routes", () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the configured Ollama version without wildcard CORS by default", async () => {
    const app = createApp();

    const res = await app.request("/api/version");

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({ version: "0.18.3-test" });
  });

  it("only permits CORS for loopback origins", async () => {
    const app = createApp();

    const localhost = await app.request("/api/version", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(localhost.status).toBe(200);
    expect(localhost.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(localhost.headers.get("vary")).toBe("Origin");

    const loopbackPreflight = await app.request("/api/chat", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    expect(loopbackPreflight.status).toBe(204);
    expect(loopbackPreflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    expect(loopbackPreflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(loopbackPreflight.headers.get("access-control-allow-headers")).toContain("Authorization");

    const externalPreflight = await app.request("/api/chat", {
      method: "OPTIONS",
      headers: { Origin: "https://example.com" },
    });
    expect(externalPreflight.status).toBe(403);
    expect(externalPreflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("maps the model catalog to Ollama tags", async () => {
    fetchMock.mockResolvedValueOnce(json([
      {
        id: "gpt-5.4-mini",
        displayName: "GPT 5.4 mini",
        inputModalities: ["text", "image"],
        supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
      },
    ]));
    const app = createApp();

    const res = await app.request("/api/tags");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("http://upstream.test/v1/models/catalog", expect.any(Object));
    const upstreamHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(upstreamHeaders.get("authorization")).toBe("Bearer proxy-secret");
    const body = await res.json() as { models: Array<Record<string, unknown>> };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      name: "gpt-5.4-mini",
      model: "gpt-5.4-mini",
      size: 0,
      details: {
        family: "gpt-5.4",
        format: "codex-proxy",
      },
    });
    expect(body.models[0].digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns model show metadata and can suppress vision capability", async () => {
    fetchMock.mockResolvedValueOnce(json({
      id: "gpt-5.4-mini",
      displayName: "GPT 5.4 mini",
      inputModalities: ["text", "image"],
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      defaultReasoningEffort: "medium",
    }));
    const app = createApp(true);

    const res = await app.request("/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4-mini" }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://upstream.test/v1/models/gpt-5.4-mini/info",
      expect.any(Object),
    );
    const body = await res.json() as Record<string, unknown>;
    expect(body.capabilities).toEqual(["completion", "tools", "thinking"]);
    expect(body.parameters).toBe("num_ctx 272000\nreasoning medium");
    expect(body.model_info).toMatchObject({
      "gpt-5.4.context_length": 272000,
      upstream_id: "gpt-5.4-mini",
      input_modalities: ["text", "image"],
    });
  });

  it("converts non-streaming Ollama chat requests and responses", async () => {
    fetchMock.mockResolvedValueOnce(json({
      model: "gpt-5.4-mini",
      created: 1_700_000_000,
      choices: [{
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "final answer",
          reasoning_content: "short reasoning",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"codex\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 7, completion_tokens: 11 },
    }));
    const app = createApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        think: "high",
        format: "json",
        options: { temperature: 0.2, top_p: 0.8, num_predict: 123 },
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "look", images: ["iVBORw0KGgo="] },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "prev_call", function: { name: "lookup", arguments: { query: "old" } } }],
          },
          { role: "tool", tool_name: "lookup", content: { ok: true } },
        ],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    });

    expect(res.status).toBe(200);
    const upstreamBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.4-mini",
      stream: false,
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 123,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
    });
    expect(upstreamBody.tools).toEqual([{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }]);
    expect(upstreamBody.messages).toEqual([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "prev_call",
          type: "function",
          function: { name: "lookup", arguments: "{\"query\":\"old\"}" },
        }],
      },
      { role: "tool", tool_call_id: "prev_call", content: "{\"ok\":true}" },
    ]);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.4-mini",
      created_at: "2023-11-14T22:13:20.000Z",
      message: {
        role: "assistant",
        content: "final answer",
        thinking: "short reasoning",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: { query: "codex" } },
        }],
      },
      done: true,
      done_reason: "tool_calls",
      prompt_eval_count: 7,
      eval_count: 11,
    });
  });

  it("converts OpenAI SSE chat chunks to Ollama NDJSON", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think " } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\"" } }] } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":\"x\"}" } }] } }] })}`,
      "",
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    fetchMock.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const app = createApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const upstreamBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(upstreamBody.stream).toBe(true);

    const chunks = await readNdjson(res);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      model: "gpt-5.4-mini",
      message: { role: "assistant", content: "", thinking: "think " },
      done: false,
    });
    expect(chunks[1]).toMatchObject({
      model: "gpt-5.4-mini",
      message: { role: "assistant", content: "hello" },
      done: false,
    });
    expect(chunks[2]).toMatchObject({
      model: "gpt-5.4-mini",
      message: {
        role: "assistant",
        content: "hello",
        thinking: "think ",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: { q: "x" } },
        }],
      },
      done: true,
      done_reason: "tool_calls",
      prompt_eval_count: 3,
      eval_count: 4,
    });
  });

  it("passes through /v1 requests and injects the proxy API key", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "ok" }, 201, { "Cache-Control": "no-store" }));
    const app = createApp();

    const res = await app.request("/v1/chat/completions?timeout=10&trace=yes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ model: "codex" }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ id: "ok" });
    expect(fetchMock).toHaveBeenCalledWith("http://upstream.test/v1/chat/completions?timeout=10&trace=yes", expect.any(Object));
    const init = fetchMock.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer proxy-secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ model: "codex" }));
  });

  it("returns 400 for invalid JSON and missing chat fields", async () => {
    const app = createApp();

    const invalidJson = await app.request("/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: "Invalid JSON body" });

    const missingFields = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex" }),
    });
    expect(missingFields.status).toBe(400);
    expect(await missingFields.json()).toEqual({ error: "Missing required fields: model, messages" });
  });

  it("surfaces upstream failures with the upstream status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("model unavailable", { status: 503 }));
    const app = createApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "codex", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "model unavailable" });
  });

  it("aborts malformed upstream SSE when the pending buffer grows too large", async () => {
    // Buffer cap is 64 MB — needs to accommodate 4K image_generation events.
    fetchMock.mockResolvedValueOnce(new Response(`data: ${"x".repeat(65 * 1024 * 1024)}`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const app = createApp();

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow("SSE buffer exceeded");
  });
});
