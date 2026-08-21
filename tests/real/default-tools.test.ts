/**
 * Real upstream validation for model.default_tools.
 *
 * Run against a proxy configured with:
 *   model.default_tools: [web_search]
 *
 * The request deliberately omits `tools`; forcing web_search through
 * `tool_choice` proves that the proxy injected the hosted tool before the
 * request reached the real Codex Responses API.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  PROXY_URL,
  checkProxy,
  headers,
  skip,
} from "./_helpers.js";

const REAL_DEFAULT_TOOL = process.env.REAL_DEFAULT_TOOL ?? "";
const IMAGE_MODEL = process.env.REAL_IMAGE_MODEL ?? "gpt-5.4-mini";
const REQUEST_TIMEOUT_MS = 90_000;
const IMAGE_TIMEOUT_MS = 180_000;

interface DefaultToolResult {
  status: number;
  eventTypes: Set<string>;
  outputText: string;
  errorPayload?: unknown;
}

async function runDefaultWebSearch(iteration: number): Promise<DefaultToolResult> {
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "gpt-5.4",
      stream: true,
      input: [{
        role: "user",
        content: `Search the web for the current UTC date. This is validation iteration ${iteration}. Reply with the date only.`,
      }],
      tool_choice: "required",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    let errorPayload: unknown;
    try {
      errorPayload = await res.json();
    } catch {
      errorPayload = await res.text();
    }
    return {
      status: res.status,
      eventTypes: new Set(),
      outputText: "",
      errorPayload,
    };
  }

  const eventTypes = new Set<string>();
  let outputText = "";
  const text = await res.text();
  let currentEvent = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
      eventTypes.add(currentEvent);
      continue;
    }
    if (!line.startsWith("data: ")) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (currentEvent === "response.output_text.delta" && typeof payload.delta === "string") {
      outputText += payload.delta;
    }
  }

  return { status: res.status, eventTypes, outputText };
}

function isRasterImage(base64: string): boolean {
  const prefix = Buffer.from(base64.slice(0, 24), "base64").toString("binary").slice(0, 12);
  return prefix.startsWith("\x89PNG")
    || prefix.startsWith("\xff\xd8\xff")
    || (prefix.startsWith("RIFF") && prefix.includes("WEBP"));
}

async function runAnthropicDefaultImage(iteration: number): Promise<string> {
  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": headers().Authorization.replace("Bearer ", ""),
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: `Generate a simple blue circle on a white background. Validation iteration ${iteration}.`,
      }],
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });

  const body = await res.json() as {
    content?: Array<{ type?: string; name?: string; input?: { result?: string } }>;
    error?: unknown;
  };
  expect(res.status, JSON.stringify(body.error ?? body)).toBe(200);
  const imageTool = body.content?.find(
    (block) => block.type === "tool_use" && block.name === "image_generation",
  );
  expect(imageTool?.input?.result).toBeTypeOf("string");
  return imageTool?.input?.result ?? "";
}

async function runGeminiDefaultImage(iteration: number): Promise<string> {
  const res = await fetch(`${PROXY_URL}/v1beta/models/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ text: `Generate a simple green square on a white background. Validation iteration ${iteration}.` }],
      }],
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });

  const body = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    error?: unknown;
  };
  expect(res.status, JSON.stringify(body.error ?? body)).toBe(200);
  const imagePart = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData);
  expect(imagePart?.inlineData?.mimeType).toBe("image/png");
  expect(imagePart?.inlineData?.data).toBeTypeOf("string");
  return imagePart?.inlineData?.data ?? "";
}

beforeAll(async () => {
  await checkProxy();
});

describe("real: default hosted tools", () => {
  it("injects web_search and completes 3 consecutive real upstream calls", async () => {
    if (skip() || REAL_DEFAULT_TOOL !== "web_search") return;

    for (let iteration = 1; iteration <= 3; iteration++) {
      const result = await runDefaultWebSearch(iteration);
      expect(result.status, JSON.stringify(result.errorPayload)).toBe(200);
      expect(result.eventTypes.has("response.web_search_call.completed")).toBe(true);
      expect(result.eventTypes.has("response.completed")).toBe(true);
      expect(result.outputText.trim().length).toBeGreaterThan(0);
      console.log(`[real/default-tools] iteration ${iteration}/3 passed`);
    }
  }, REQUEST_TIMEOUT_MS * 3 + 30_000);

  it("injects image_generation into Anthropic and returns 3 raster images", async () => {
    if (skip() || REAL_DEFAULT_TOOL !== "image_generation") return;

    for (let iteration = 1; iteration <= 3; iteration++) {
      const result = await runAnthropicDefaultImage(iteration);
      expect(result.length).toBeGreaterThan(1000);
      expect(isRasterImage(result)).toBe(true);
      console.log(`[real/default-tools] Anthropic image iteration ${iteration}/3 passed`);
    }
  }, IMAGE_TIMEOUT_MS * 3 + 30_000);

  it("injects image_generation into Gemini and returns 3 raster images", async () => {
    if (skip() || REAL_DEFAULT_TOOL !== "image_generation") return;

    for (let iteration = 1; iteration <= 3; iteration++) {
      const result = await runGeminiDefaultImage(iteration);
      expect(result.length).toBeGreaterThan(1000);
      expect(isRasterImage(result)).toBe(true);
      console.log(`[real/default-tools] Gemini image iteration ${iteration}/3 passed`);
    }
  }, IMAGE_TIMEOUT_MS * 3 + 30_000);
});
