import { getConfig } from "../config.js";
import { redactJson } from "./redact.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function summarizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return redactJson(headers) as Record<string, unknown>;
}

function shouldCaptureBody(): boolean {
  try {
    return getConfig().logs.capture_body;
  } catch {
    return false;
  }
}

function withBodyOrSummary(summary: Record<string, unknown>, body: unknown): Record<string, unknown> {
  if (!shouldCaptureBody()) return summary;
  return {
    ...summary,
    body: redactJson(body),
  };
}

export function summarizeRequestForLog(route: string, body: unknown, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const summary: Record<string, unknown> = redactJson(meta) as Record<string, unknown>;

  if (route === "chat") {
    if (isRecord(body)) {
      summary.body_type = "chat.completions";
      summary.messages = toCount(body.messages);
      summary.model = typeof body.model === "string" ? body.model : undefined;
      summary.stream = typeof body.stream === "boolean" ? body.stream : undefined;
      summary.max_tokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
      summary.reasoning_effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;
      summary.tools = toCount(body.tools);
      summary.response_format = isRecord(body.response_format) ? body.response_format.type : undefined;
      summary.previous_response_id = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
      summary.headers = isRecord(meta.headers) ? summarizeHeaders(meta.headers) : undefined;
    }
    return withBodyOrSummary(summary, body);
  }

  if (route === "messages") {
    if (isRecord(body)) {
      summary.body_type = "anthropic.messages";
      summary.messages = toCount(body.messages);
      summary.model = typeof body.model === "string" ? body.model : undefined;
      summary.stream = typeof body.stream === "boolean" ? body.stream : undefined;
      summary.max_tokens = typeof body.max_tokens === "number" ? body.max_tokens : undefined;
      summary.thinking = isRecord(body.thinking) ? body.thinking.type : undefined;
      summary.tools = toCount(body.tools);
      summary.headers = isRecord(meta.headers) ? summarizeHeaders(meta.headers) : undefined;
    }
    return withBodyOrSummary(summary, body);
  }

  if (route === "responses") {
    if (isRecord(body)) {
      summary.body_type = "responses";
      summary.input_items = toCount(body.input);
      summary.model = typeof body.model === "string" ? body.model : undefined;
      summary.stream = typeof body.stream === "boolean" ? body.stream : undefined;
      summary.instructions_bytes = typeof body.instructions === "string" ? body.instructions.length : undefined;
      summary.tools = toCount(body.tools);
      summary.previous_response_id = typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
      summary.text_format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format.type : undefined;
      summary.headers = isRecord(meta.headers) ? summarizeHeaders(meta.headers) : undefined;
    }
    return withBodyOrSummary(summary, body);
  }

  if (route === "images") {
    if (isRecord(body)) {
      summary.body_type = "images.generations";
      summary.model = typeof body.model === "string" ? body.model : undefined;
      summary.prompt_chars = typeof body.prompt === "string" ? body.prompt.length : undefined;
      summary.size = typeof body.size === "string" ? body.size : undefined;
      summary.output_format = typeof body.output_format === "string" ? body.output_format : undefined;
      summary.background = typeof body.background === "string" ? body.background : undefined;
      summary.moderation = typeof body.moderation === "string" ? body.moderation : undefined;
      summary.partial_images = typeof body.partial_images === "number" ? body.partial_images : undefined;
      summary.n = typeof body.n === "number" ? body.n : undefined;
      summary.response_format = typeof body.response_format === "string"
        ? body.response_format
        : isRecord(body.response_format)
          ? body.response_format.type
          : undefined;
      summary.headers = isRecord(meta.headers) ? summarizeHeaders(meta.headers) : undefined;
    }
    return withBodyOrSummary(summary, body);
  }

  return withBodyOrSummary(redactJson(summary) as Record<string, unknown>, body);
}
