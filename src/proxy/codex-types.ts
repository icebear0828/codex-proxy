/**
 * Type definitions for the Codex Responses API.
 * Extracted from codex-api.ts for consumers that only need types.
 */

export interface CodexResponsesRequest {
  model: string;
  instructions?: string | null;
  input: CodexInputItem[];
  stream: true;
  store: false;
  /** Optional: reasoning effort + summary mode */
  reasoning?: { effort?: string; summary?: string };
  /** Optional: service tier ("fast" / "flex") */
  service_tier?: string | null;
  /** Optional: tools available to the model */
  tools?: unknown[];
  /** Optional: tool choice strategy */
  tool_choice?: string | { type: string; name: string };
  /** Optional: text output format (JSON mode / structured outputs) */
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
  /** Optional: reference a previous response for multi-turn (WebSocket only). */
  previous_response_id?: string;
  /** Prompt cache key — stable per-conversation UUID for backend prompt caching. */
  prompt_cache_key?: string;
  /** Include additional response data (e.g. "reasoning.encrypted_content"). */
  include?: string[];
  /** When true, use WebSocket transport (enables previous_response_id and server-side storage). */
  useWebSocket?: boolean;
  /** Upstream turn-state token for sticky routing (not serialized to body). */
  turnState?: string;
}

/**
 * Request body for POST /codex/responses/compact (non-streaming JSON).
 * Matches codex-rs CompactionInput — no stream/store fields.
 */
export interface CodexCompactRequest {
  model: string;
  input: CodexInputItem[];
  instructions: string;
  tools?: unknown[];
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  text?: {
    format: {
      type: "text" | "json_object" | "json_schema";
      name?: string;
      schema?: Record<string, unknown>;
      strict?: boolean;
    };
  };
}

/** Response body from POST /codex/responses/compact. */
export interface CodexCompactResponse {
  output: unknown[];
}

/** Structured content part for multimodal Codex input. */
export type CodexContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

export type CodexInputItem =
  | { role: "user"; content: string | CodexContentPart[] }
  | { role: "assistant"; content: string }
  | { role: "system"; content: string }
  | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Parsed SSE event from the Codex Responses stream */
export interface CodexSSEEvent {
  event: string;
  data: unknown;
}

/** Response from GET /backend-api/codex/usage */
export interface CodexUsageRateWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds: number;
  reset_at: number;
}

export interface CodexUsageRateLimit {
  allowed: boolean;
  limit_reached: boolean;
  primary_window: CodexUsageRateWindow | null;
  secondary_window: CodexUsageRateWindow | null;
}

export interface CodexUsageResponse {
  plan_type: string;
  rate_limit: CodexUsageRateLimit;
  code_review_rate_limit: CodexUsageRateLimit | null;
  credits: unknown;
  promo: unknown;
}

export class CodexApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    let detail: string;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const raw = obj.detail ?? (obj.error as Record<string, unknown> | undefined)?.message ?? body;
        detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      } else {
        detail = body;
      }
    } catch {
      detail = body;
    }
    super(`Codex API error (${status}): ${detail}`);
  }
}
