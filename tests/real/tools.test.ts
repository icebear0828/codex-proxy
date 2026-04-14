/**
 * Real upstream tests — function calling / tool use.
 *
 * Verifies tool definitions are correctly translated and upstream returns
 * tool calls in all 3 API formats.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PROXY_URL, TIMEOUT,
  checkProxy, skip, headers, anthropicHeaders, collectSSE, parseDataLines,
} from "./_helpers.js";

beforeAll(async () => {
  await checkProxy();
});

const TOOL_TIMEOUT = 45_000;

const WEATHER_TOOL_OPENAI = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

const WEATHER_TOOL_ANTHROPIC = {
  name: "get_weather",
  description: "Get the current weather for a location",
  input_schema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" },
    },
    required: ["location"],
  },
};

const WEATHER_TOOL_RESPONSES = {
  type: "function" as const,
  name: "get_weather",
  description: "Get the current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "City name" },
    },
    required: ["location"],
  },
};

const WEATHER_TOOL_GEMINI = {
  functionDeclarations: [
    {
      name: "get_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
  ],
};

const TOOL_PROMPT = "What's the weather in Tokyo? Use the get_weather tool.";

// ── OpenAI format: /v1/chat/completions ──────────────────────────────

describe("real: tool use via /v1/chat/completions", () => {
  it("non-streaming: returns tool_calls in response", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [WEATHER_TOOL_OPENAI],
        tool_choice: "auto",
        stream: false,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const choices = body.choices as Array<{
      message: {
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
      finish_reason: string;
    }>;

    expect(choices.length).toBeGreaterThanOrEqual(1);
    const msg = choices[0].message;

    // Model should call the tool
    expect(msg.tool_calls).toBeDefined();
    expect(msg.tool_calls!.length).toBeGreaterThanOrEqual(1);

    const call = msg.tool_calls![0];
    expect(call.function.name).toBe("get_weather");
    expect(call.id).toBeDefined();

    // Arguments should be valid JSON containing "location"
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    expect(args.location).toBeDefined();
    expect(typeof args.location).toBe("string");

    expect(choices[0].finish_reason).toBe("tool_calls");
  }, TOOL_TIMEOUT);

  it("streaming: returns tool_calls in SSE chunks", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [WEATHER_TOOL_OPENAI],
        tool_choice: "auto",
        stream: true,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const dataLines = await collectSSE(res);

    // Find chunks with tool_calls delta
    const toolChunks = dataLines
      .filter((l) => l !== "[DONE]")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((chunk) => {
        const choices = chunk.choices as Array<{ delta: { tool_calls?: unknown[] } }> | undefined;
        return choices?.[0]?.delta?.tool_calls;
      });

    expect(toolChunks.length).toBeGreaterThanOrEqual(1);
  }, TOOL_TIMEOUT);
});

// ── Anthropic format: /v1/messages ───────────────────────────────────

describe("real: tool use via /v1/messages", () => {
  it("non-streaming: returns tool_use content block", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 1024,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [WEATHER_TOOL_ANTHROPIC],
        stream: false,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    const content = body.content as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    const toolUse = content.find((b) => b.type === "tool_use");

    expect(toolUse).toBeDefined();
    expect(toolUse!.name).toBe("get_weather");
    expect(toolUse!.id).toBeDefined();
    expect(toolUse!.input).toBeDefined();
    expect(typeof toolUse!.input!.location).toBe("string");

    expect(body.stop_reason).toBe("tool_use");
  }, TOOL_TIMEOUT);

  it("streaming: returns tool_use events", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/messages`, {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: "codex",
        max_tokens: 1024,
        messages: [{ role: "user", content: TOOL_PROMPT }],
        tools: [WEATHER_TOOL_ANTHROPIC],
        stream: true,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    // Should have content_block_start with tool_use type
    expect(events).toContain("content_block_start");

    const dataLines = parseDataLines(text);
    const toolBlock = dataLines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find(
        (d): d is Record<string, unknown> =>
          d !== null &&
          d.type === "content_block_start" &&
          (d.content_block as Record<string, unknown> | undefined)?.type === "tool_use",
      );

    expect(toolBlock).toBeDefined();
  }, TOOL_TIMEOUT);
});

// ── Gemini format: /v1beta/models ───────────────────────────────────

describe("real: tool use via Gemini", () => {
  it("non-streaming: returns functionCall in candidates", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1beta/models/codex:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: TOOL_PROMPT }] }],
        tools: [WEATHER_TOOL_GEMINI],
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    const candidates = body.candidates as Array<{
      content: { parts: Array<{ functionCall?: { name: string; args?: Record<string, unknown> } }> };
    }>;
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    const fcPart = candidates[0].content.parts.find((p) => p.functionCall);
    expect(fcPart).toBeDefined();
    expect(fcPart!.functionCall!.name).toBe("get_weather");
    expect(fcPart!.functionCall!.args).toBeDefined();
    expect(typeof fcPart!.functionCall!.args!.location).toBe("string");
  }, TOOL_TIMEOUT);

  it("streaming: returns functionCall in SSE chunks", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1beta/models/codex:streamGenerateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: TOOL_PROMPT }] }],
        tools: [WEATHER_TOOL_GEMINI],
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const dataLines = await collectSSE(res);
    expect(dataLines.length).toBeGreaterThanOrEqual(1);

    // Find a chunk containing functionCall
    const fcChunk = dataLines
      .filter((l) => l !== "[DONE]")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((d): d is Record<string, unknown> => {
        if (!d) return false;
        const candidates = d.candidates as Array<{
          content?: { parts?: Array<{ functionCall?: unknown }> };
        }> | undefined;
        return candidates?.[0]?.content?.parts?.some((p) => p.functionCall) ?? false;
      });

    expect(fcChunk).toBeDefined();
  }, TOOL_TIMEOUT);
});

// ── Responses format: /v1/responses ──────────────────────────────────

describe("real: tool use via /v1/responses", () => {
  it("non-streaming: returns function_call output", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: "Use the provided tools when asked about weather.",
        input: [{ role: "user", content: [{ type: "input_text", text: TOOL_PROMPT }] }],
        tools: [WEATHER_TOOL_RESPONSES],
        stream: false,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    const output = body.output as Array<{ type: string; name?: string; call_id?: string; arguments?: string }>;
    const fnCall = output.find((o) => o.type === "function_call");

    expect(fnCall).toBeDefined();
    expect(fnCall!.name).toBe("get_weather");
    expect(fnCall!.call_id).toBeDefined();

    const args = JSON.parse(fnCall!.arguments!) as Record<string, unknown>;
    expect(args.location).toBeDefined();
  }, TOOL_TIMEOUT);

  it("streaming: returns function_call events", async () => {
    if (skip()) return;

    const res = await fetch(`${PROXY_URL}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "codex",
        instructions: "Use the provided tools when asked about weather.",
        input: [{ role: "user", content: [{ type: "input_text", text: TOOL_PROMPT }] }],
        tools: [WEATHER_TOOL_RESPONSES],
        stream: true,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUT),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));

    // Should contain function_call events
    const hasFnCall = events.some(
      (e) => e === "response.function_call_arguments.done" || e === "response.output_item.added",
    );
    expect(hasFnCall).toBe(true);
  }, TOOL_TIMEOUT);
});
