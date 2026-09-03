/**
 * UpstreamAdapter — abstract interface for all upstream API backends.
 *
 * Both the existing CodexApi and new API-key-based adapters (OpenAI,
 * Anthropic, Gemini) implement this interface so the proxy handler can
 * treat them uniformly.
 */

import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";

/** Exact JSON endpoints used by Codex clients outside the Responses SSE call. */
export type CodexAuxiliaryJsonPath =
  | "alpha/search"
  | "responses/compact"
  | "images/generations"
  | "images/edits";

export type CodexAuxiliaryRequestContext = Partial<Pick<
  CodexResponsesRequest,
  | "turnState"
  | "turnMetadata"
  | "betaFeatures"
  | "version"
  | "includeTimingMetrics"
  | "codexWindowId"
  | "parentThreadId"
  | "useResponsesLite"
  | "client_metadata"
>>;

export interface UpstreamAdapter {
  /** Short identifier used in logs (e.g. "codex", "openai", "anthropic"). */
  readonly tag: string;
  /**
   * Send a Codex-format request to the upstream API.
   * Returns a raw HTTP Response whose body is an SSE stream.
   * Throws on HTTP error (non-2xx).
   */
  createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
  ): Promise<Response>;
  /**
   * Optional Codex-client JSON passthrough. Implementations must enforce the
   * exact path allowlist and replace downstream authentication with their own.
   */
  forwardCodexJsonRequest?(
    path: CodexAuxiliaryJsonPath,
    body: Record<string, unknown>,
    signal: AbortSignal,
    context?: CodexAuxiliaryRequestContext,
  ): Promise<Response>;
  /**
   * Parse the upstream SSE response into a stream of Codex-normalized events.
   * Each adapter normalizes its native event format to CodexSSEEvent.
   */
  parseStream(response: Response): AsyncGenerator<CodexSSEEvent>;
}

export function supportsCodexAuxiliaryJson(
  adapter: UpstreamAdapter,
): adapter is UpstreamAdapter & Required<Pick<UpstreamAdapter, "forwardCodexJsonRequest">> {
  return typeof adapter.forwardCodexJsonRequest === "function";
}
