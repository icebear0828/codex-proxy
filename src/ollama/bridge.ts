import { createHash } from "node:crypto";
import { Hono } from "hono";

export interface OllamaBridgeOptions {
  upstreamBaseUrl: string;
  proxyApiKey: string | null;
  version: string;
  disableVision: boolean;
}

interface ModelInfo {
  id: string;
  displayName?: string;
  inputModalities?: string[];
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort?: string | null;
}

interface OllamaToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: unknown;
  };
}

interface AccumulatedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface FinalMessage {
  content: string;
  thinking: string;
  tool_calls: OllamaToolCall[];
}

class OllamaBridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OllamaBridgeError";
  }
}

const CONTEXT_WINDOW_OVERRIDES = new Map<string, number>([
  ["gpt-5.4", 272000],
  ["gpt-5.4-mini", 272000],
  ["gpt-5.3-codex", 272000],
  ["gpt-5.3-codex-spark", 272000],
  ["gpt-5.2", 272000],
  ["gpt-5.2-codex", 272000],
  ["gpt-5.1-codex-max", 272000],
  ["gpt-5.1-codex-mini", 272000],
]);

const encoder = new TextEncoder();
// Keep in sync with src/proxy/codex-sse.ts — 64 MB accommodates 4K
// image_generation_call events without prematurely aborting the stream.
const MAX_SSE_BUFFER = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  return octets[0] === 127 && octets.every((octet) => octet >= 0 && octet <= 255);
}

function getAllowedCorsOrigin(request?: Request): string | null {
  const origin = request?.headers.get("Origin");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return isLoopbackHostname(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

function responseHeaders(init: HeadersInit, request?: Request): Headers {
  const headers = new Headers(init);
  const origin = getAllowedCorsOrigin(request);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function inferFamily(modelId: string): string {
  const normalized = modelId.toLowerCase();
  if (normalized.startsWith("gpt-5.4")) return "gpt-5.4";
  if (normalized.startsWith("gpt-5.3")) return "gpt-5.3";
  if (normalized.startsWith("gpt-5.2")) return "gpt-5.2";
  if (normalized.startsWith("gpt-5.1")) return "gpt-5.1";
  if (normalized.startsWith("gpt-oss")) return "gpt-oss";
  if (normalized.startsWith("codex")) return "codex";
  return normalized.split(/[:/-]/, 1)[0] || normalized;
}

function modelDigest(modelId: string): string {
  return createHash("sha256").update(modelId).digest("hex");
}

function modelDetails(modelId: string) {
  const family = inferFamily(modelId);
  return {
    parent_model: "",
    format: "codex-proxy",
    family,
    families: [family],
    parameter_size: "unknown",
    quantization_level: "unknown",
  };
}

function inferContextWindow(modelId: string): number {
  return CONTEXT_WINDOW_OVERRIDES.get(modelId) ?? 131072;
}

function synthesizeCapabilities(info: ModelInfo, disableVision: boolean): string[] {
  const capabilities = new Set<string>(["completion", "tools"]);
  if (!disableVision && (info.inputModalities ?? []).includes("image")) capabilities.add("vision");
  if ((info.supportedReasoningEfforts?.length ?? 0) > 0) capabilities.add("thinking");
  return [...capabilities];
}

function jsonResponse(status: number, body: unknown, request?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders({
      "Content-Type": "application/json",
    }, request),
  });
}

function textResponse(status: number, body: string, request?: Request): Response {
  return new Response(body, {
    status,
    headers: responseHeaders({
      "Content-Type": "text/plain; charset=utf-8",
    }, request),
  });
}

function errorResponse(status: number, message: string, request?: Request): Response {
  return jsonResponse(status, { error: message }, request);
}

function corsNoContent(request: Request): Response {
  const headers = responseHeaders({}, request);
  if (request.headers.has("Origin") && !headers.has("Access-Control-Allow-Origin")) {
    return new Response(null, { status: 403 });
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(null, {
    status: 204,
    headers,
  });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) return {};
  const parsed = safeParseJson(raw);
  if (parsed === null) {
    throw new OllamaBridgeError(400, "Invalid JSON body");
  }
  if (!isRecord(parsed)) {
    throw new OllamaBridgeError(400, "JSON body must be an object");
  }
  return parsed;
}

function makeUpstreamFetch(options: OllamaBridgeOptions) {
  const upstreamVersionBase = `${options.upstreamBaseUrl.replace(/\/+$/, "")}/v1`;
  return async (pathname: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (options.proxyApiKey && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${options.proxyApiKey}`);
    }
    if (init.body !== undefined && init.body !== null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`${upstreamVersionBase}${pathname}`, {
      ...init,
      headers,
    });
  };
}

function parseModelInfo(value: unknown): ModelInfo {
  const raw = asRecord(value);
  const id = getString(raw.id) ?? "unknown";
  const modalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((item): item is string => typeof item === "string")
    : undefined;
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
        .map((item) => asRecord(item))
        .map((item) => ({ reasoningEffort: getString(item.reasoningEffort) ?? "" }))
        .filter((item) => item.reasoningEffort)
    : undefined;
  return {
    id,
    displayName: getString(raw.displayName),
    inputModalities: modalities,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: getString(raw.defaultReasoningEffort) ?? null,
  };
}

async function getCatalog(upstreamFetch: ReturnType<typeof makeUpstreamFetch>): Promise<ModelInfo[]> {
  const response = await upstreamFetch("/models/catalog");
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstream /models/catalog failed: ${response.status} ${text}`);
  }
  const parsed = await response.json() as unknown;
  return Array.isArray(parsed) ? parsed.map(parseModelInfo) : [];
}

async function getModelInfo(
  upstreamFetch: ReturnType<typeof makeUpstreamFetch>,
  model: string,
): Promise<ModelInfo> {
  const response = await upstreamFetch(`/models/${encodeURIComponent(model)}/info`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstream /models/${model}/info failed: ${response.status} ${text}`);
  }
  return parseModelInfo(await response.json() as unknown);
}

function toOllamaTag(info: ModelInfo, startedAt: string) {
  return {
    name: info.id,
    model: info.id,
    modified_at: startedAt,
    size: 0,
    digest: modelDigest(info.id),
    details: modelDetails(info.id),
  };
}

function toShowResponse(model: string, info: ModelInfo, startedAt: string, disableVision: boolean) {
  const architecture = inferFamily(model);
  const contextLength = inferContextWindow(model);
  const capabilities = synthesizeCapabilities(info, disableVision);
  const parameterLines = [`num_ctx ${contextLength}`];
  if ((info.supportedReasoningEfforts?.length ?? 0) > 0) {
    parameterLines.push(`reasoning ${info.defaultReasoningEffort ?? "medium"}`);
  }
  return {
    model,
    remote_model: model,
    license: "Proxied via codex-proxy",
    modelfile: `FROM ${model}`,
    parameters: parameterLines.join("\n"),
    template: "{{ .Prompt }}",
    capabilities,
    modified_at: startedAt,
    details: modelDetails(model),
    model_info: {
      "general.architecture": architecture,
      [`${architecture}.context_length`]: contextLength,
      "general.basename": model,
      upstream_id: info.id,
      display_name: info.displayName ?? model,
      input_modalities: info.inputModalities ?? ["text"],
      context_length: contextLength,
      supported_reasoning_efforts: info.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [],
      default_reasoning_effort: info.defaultReasoningEffort ?? null,
    },
  };
}

function safeParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizeToolCalls(toolCalls: unknown): OllamaToolCall[] {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  return list.map((toolCall, index) => {
    const item = asRecord(toolCall);
    const fn = asRecord(item.function);
    const args = fn.arguments;
    return {
      id: getString(item.id) ?? `tool_${index}`,
      type: "function",
      function: {
        name: getString(fn.name) ?? "tool",
        arguments: typeof args === "string"
          ? safeParseJson(args) ?? args
          : args ?? {},
      },
    };
  });
}

function mapThinkToReasoningEffort(think: unknown): string | null {
  if (typeof think === "string") {
    if (["low", "medium", "high", "xhigh"].includes(think)) return think;
    if (think === "false") return null;
    if (think === "true") return "medium";
  }
  if (think === true) return "medium";
  return null;
}

function mapFormat(format: unknown): Record<string, unknown> | null {
  if (!format) return null;
  if (format === "json") return { type: "json_object" };
  if (isRecord(format)) {
    return {
      type: "json_schema",
      json_schema: {
        name: "ollama_schema",
        schema: format,
        strict: true,
      },
    };
  }
  return null;
}

function normalizeImageToDataUrl(image: unknown): string | null {
  if (typeof image !== "string" || !image) return null;
  if (image.startsWith("data:")) return image;
  if (image.startsWith("http://") || image.startsWith("https://")) return image;
  return `data:image/png;base64,${image}`;
}

function ollamaMessageContentToOpenAI(message: Record<string, unknown>): unknown {
  const text = typeof message.content === "string" ? message.content : "";
  const images = Array.isArray(message.images) ? message.images : [];
  if (images.length === 0) return text;

  const parts: unknown[] = [];
  if (text) parts.push({ type: "text", text });
  for (const image of images) {
    const url = normalizeImageToDataUrl(image);
    if (!url) continue;
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

function ollamaMessagesToOpenAI(messages: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(messages) ? messages : [];
  const toolCallIdByName = new Map<string, string>();
  return list.flatMap((rawMessage, index) => {
    const message = asRecord(rawMessage);
    const role = getString(message.role);

    if (role === "assistant") {
      const openAIMessage: Record<string, unknown> = {
        role: "assistant",
        content: ollamaMessageContentToOpenAI(message),
      };
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        openAIMessage.tool_calls = message.tool_calls.map((rawToolCall, toolIndex) => {
          const toolCall = asRecord(rawToolCall);
          const fn = asRecord(toolCall.function);
          const id = getString(toolCall.id) ?? `tool_${index}_${toolIndex}`;
          toolCallIdByName.set(getString(fn.name) ?? id, id);
          return {
            id,
            type: "function",
            function: {
              name: getString(fn.name) ?? "tool",
              arguments: JSON.stringify(fn.arguments ?? {}),
            },
          };
        });
      }
      return [openAIMessage];
    }

    if (role === "tool") {
      const toolName = getString(message.tool_name) ?? getString(message.name) ?? "tool";
      const toolCallId = getString(message.tool_call_id) ?? toolCallIdByName.get(toolName) ?? `tool_${index}`;
      return [{
        role: "tool",
        tool_call_id: toolCallId,
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      }];
    }

    return [{
      role: role === "system" ? "system" : "user",
      content: ollamaMessageContentToOpenAI(message),
    }];
  });
}

function buildOpenAIRequest(body: Record<string, unknown>): Record<string, unknown> {
  const options = isRecord(body.options) ? body.options : {};
  const request: Record<string, unknown> = {
    model: body.model,
    messages: ollamaMessagesToOpenAI(body.messages),
    stream: body.stream !== false,
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) request.tools = body.tools;
  if (typeof options.temperature === "number") request.temperature = options.temperature;
  if (typeof options.top_p === "number") request.top_p = options.top_p;
  if (typeof options.num_predict === "number") request.max_tokens = options.num_predict;
  const reasoningEffort = mapThinkToReasoningEffort(body.think);
  if (reasoningEffort) request.reasoning_effort = reasoningEffort;
  const responseFormat = mapFormat(body.format);
  if (responseFormat) request.response_format = responseFormat;
  return request;
}

function mapFinishReason(reason: unknown): string {
  if (reason === "length") return "length";
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  return "stop";
}

function buildOllamaFinalChunk(
  model: string,
  usage: { prompt_tokens: number; completion_tokens: number },
  doneReason: string,
  finalMessage: FinalMessage,
) {
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: finalMessage.content,
      ...(finalMessage.thinking ? { thinking: finalMessage.thinking } : {}),
      ...(finalMessage.tool_calls.length ? { tool_calls: finalMessage.tool_calls } : {}),
    },
    done: true,
    done_reason: doneReason,
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: usage.prompt_tokens,
    prompt_eval_duration: 0,
    eval_count: usage.completion_tokens,
    eval_duration: 0,
  };
}

function enqueueJson(controller: ReadableStreamDefaultController<Uint8Array>, value: unknown): void {
  controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
}

async function streamOllamaChat(
  upstreamResponse: Response,
  body: Record<string, unknown>,
  request: Request,
): Promise<Response> {
  if (!upstreamResponse.body) {
    return errorResponse(502, "Upstream response body is empty", request);
  }

  const model = getString(body.model) ?? "unknown";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamResponse.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const usage = { prompt_tokens: 0, completion_tokens: 0 };
      const finalMessage: FinalMessage = { content: "", thinking: "", tool_calls: [] };
      const toolCalls: AccumulatedToolCall[] = [];
      const toolCallByIndex = new Map<number, AccumulatedToolCall>();
      let doneReason = "stop";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_SSE_BUFFER) {
            throw new Error(`SSE buffer exceeded ${MAX_SSE_BUFFER} bytes`);
          }
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const eventBlock = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const lines = eventBlock.split("\n");
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              const parsed = safeParseJson(payload);
              const parsedRecord = asRecord(parsed);
              const usageRecord = asRecord(parsedRecord.usage);
              if (Object.keys(usageRecord).length > 0) {
                if (typeof usageRecord.prompt_tokens === "number") usage.prompt_tokens = usageRecord.prompt_tokens;
                if (typeof usageRecord.completion_tokens === "number") {
                  usage.completion_tokens = usageRecord.completion_tokens;
                }
              }
              const choices = Array.isArray(parsedRecord.choices) ? parsedRecord.choices : [];
              const choice = asRecord(choices[0]);
              if (Object.keys(choice).length === 0) continue;
              const delta = asRecord(choice.delta);
              const reasoningContent = getString(delta.reasoning_content);
              if (reasoningContent) {
                finalMessage.thinking += reasoningContent;
                enqueueJson(controller, {
                  model,
                  created_at: new Date().toISOString(),
                  message: { role: "assistant", content: "", thinking: reasoningContent },
                  done: false,
                });
              }
              const content = getString(delta.content);
              if (content) {
                finalMessage.content += content;
                enqueueJson(controller, {
                  model,
                  created_at: new Date().toISOString(),
                  message: { role: "assistant", content },
                  done: false,
                });
              }
              if (Array.isArray(delta.tool_calls)) {
                for (const rawPartial of delta.tool_calls) {
                  const partial = asRecord(rawPartial);
                  const index = typeof partial.index === "number" ? partial.index : 0;
                  let existing = toolCallByIndex.get(index);
                  const partialFn = asRecord(partial.function);
                  if (!existing) {
                    existing = {
                      id: getString(partial.id) ?? `tool_${index}`,
                      type: "function",
                      function: {
                        name: getString(partialFn.name) ?? "tool",
                        arguments: "",
                      },
                    };
                    toolCallByIndex.set(index, existing);
                    toolCalls[index] = existing;
                  }
                  const partialId = getString(partial.id);
                  if (partialId) existing.id = partialId;
                  const partialName = getString(partialFn.name);
                  if (partialName) existing.function.name = partialName;
                  const partialArgs = getString(partialFn.arguments);
                  if (partialArgs) existing.function.arguments += partialArgs;
                }
              }
              if (choice.finish_reason) doneReason = mapFinishReason(choice.finish_reason);
            }
          }
        }

        const normalizedToolCalls = normalizeToolCalls(toolCalls.filter(Boolean));
        if (normalizedToolCalls.length > 0) finalMessage.tool_calls = normalizedToolCalls;
        enqueueJson(controller, buildOllamaFinalChunk(model, usage, doneReason, finalMessage));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: responseHeaders({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    }, request),
  });
}

async function handleChat(
  body: Record<string, unknown>,
  upstreamFetch: ReturnType<typeof makeUpstreamFetch>,
  request: Request,
): Promise<Response> {
  if (typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return errorResponse(400, "Missing required fields: model, messages", request);
  }

  const openAIRequest = buildOpenAIRequest(body);
  const upstreamResponse = await upstreamFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify(openAIRequest),
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const text = await upstreamResponse.text();
    return errorResponse(upstreamResponse.status || 502, text || "Upstream request failed", request);
  }

  if (body.stream === false) {
    const data = asRecord(await upstreamResponse.json() as unknown);
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice.message);
    const usage = asRecord(data.usage);
    const createdSeconds = typeof data.created === "number" ? data.created : Math.floor(Date.now() / 1000);
    return jsonResponse(200, {
      model: getString(data.model) ?? body.model,
      created_at: new Date(createdSeconds * 1000).toISOString(),
      message: {
        role: "assistant",
        content: getString(message.content) ?? "",
        ...(getString(message.reasoning_content) ? { thinking: getString(message.reasoning_content) } : {}),
        ...(Array.isArray(message.tool_calls) && message.tool_calls.length
          ? { tool_calls: normalizeToolCalls(message.tool_calls) }
          : {}),
      },
      done: true,
      done_reason: mapFinishReason(choice.finish_reason),
      total_duration: 0,
      load_duration: 0,
      prompt_eval_count: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      prompt_eval_duration: 0,
      eval_count: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      eval_duration: 0,
    }, request);
  }

  return streamOllamaChat(upstreamResponse, body, request);
}

async function copyUpstreamResponse(upstreamResponse: Response, request: Request): Promise<Response> {
  const headers = responseHeaders({}, request);
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  const cacheControl = upstreamResponse.headers.get("cache-control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  return new Response(upstreamResponse.body ?? await upstreamResponse.text(), {
    status: upstreamResponse.status,
    headers,
  });
}

async function proxyOpenAIRequest(
  request: Request,
  pathname: string,
  upstreamFetch: ReturnType<typeof makeUpstreamFetch>,
): Promise<Response> {
  const rawBody = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.text();
  const headers: Record<string, string> = {};
  const contentType = request.headers.get("content-type");
  const accept = request.headers.get("accept");
  if (contentType) headers["Content-Type"] = contentType;
  if (accept) headers.Accept = accept;
  const upstreamResponse = await upstreamFetch(pathname, {
    method: request.method,
    headers,
    body: rawBody && rawBody.length > 0 ? rawBody : undefined,
  });
  return copyUpstreamResponse(upstreamResponse, request);
}

export function createOllamaBridgeApp(options: OllamaBridgeOptions): Hono {
  const app = new Hono();
  const upstreamFetch = makeUpstreamFetch(options);
  const startedAt = new Date().toISOString();

  app.options("*", (c) => corsNoContent(c.req.raw));

  app.get("/api/version", (c) => jsonResponse(200, { version: options.version }, c.req.raw));

  app.all("/v1/*", async (c) => {
    const search = new URL(c.req.raw.url).search;
    return proxyOpenAIRequest(c.req.raw, `${c.req.path.slice(3)}${search}`, upstreamFetch);
  });

  app.get("/api/tags", async (c) => {
    const catalog = await getCatalog(upstreamFetch);
    return jsonResponse(200, { models: catalog.map((info) => toOllamaTag(info, startedAt)) }, c.req.raw);
  });

  app.post("/api/show", async (c) => {
    const body = await readJsonBody(c.req.raw);
    const model = getString(body.model)?.trim();
    if (!model) return errorResponse(400, "Missing model", c.req.raw);
    const info = await getModelInfo(upstreamFetch, model);
    return jsonResponse(200, toShowResponse(model, info, startedAt, options.disableVision), c.req.raw);
  });

  app.post("/api/chat", async (c) => {
    const body = await readJsonBody(c.req.raw);
    return handleChat(body, upstreamFetch, c.req.raw);
  });

  app.get("/", (c) => textResponse(200, "codex-proxy ollama bridge", c.req.raw));

  app.notFound((c) => errorResponse(404, `Unsupported path: ${c.req.path}`, c.req.raw));

  app.onError((error, c) => {
    if (error instanceof OllamaBridgeError) {
      return errorResponse(error.status, error.message, c.req.raw);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(500, message, c.req.raw);
  });

  return app;
}
