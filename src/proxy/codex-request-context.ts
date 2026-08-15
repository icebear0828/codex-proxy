/** Shared Codex request context headers and client metadata construction. */

import type { CodexResponsesRequest } from "./codex-types.js";

export const X_CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
export const X_CODEX_BETA_FEATURES_HEADER = "x-codex-beta-features";
export const X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER = "x-responsesapi-include-timing-metrics";
export const X_CODEX_PARENT_THREAD_ID_HEADER = "x-codex-parent-thread-id";
export const X_CODEX_WINDOW_ID_HEADER = "x-codex-window-id";

export function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function firstCodexRequestString(
  request: CodexResponsesRequest,
  key: string,
): string | null {
  const direct =
    key === X_CODEX_TURN_METADATA_HEADER
      ? request.turnMetadata
      : key === X_CODEX_BETA_FEATURES_HEADER
        ? request.betaFeatures
        : key === X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER
          ? request.includeTimingMetrics
          : key === X_CODEX_PARENT_THREAD_ID_HEADER
            ? request.parentThreadId
            : key === X_CODEX_WINDOW_ID_HEADER
              ? request.codexWindowId
              : undefined;
  const normalizedDirect = nonEmptyString(direct);
  if (normalizedDirect) return normalizedDirect;
  return nonEmptyString(request.client_metadata?.[key]);
}

export function applyCodexContextHeaders(
  headers: Record<string, string>,
  request: CodexResponsesRequest,
): void {
  if (request.turnState) headers["x-codex-turn-state"] = request.turnState;
  const turnMetadata = firstCodexRequestString(request, X_CODEX_TURN_METADATA_HEADER);
  if (turnMetadata) headers[X_CODEX_TURN_METADATA_HEADER] = turnMetadata;
  const betaFeatures = firstCodexRequestString(request, X_CODEX_BETA_FEATURES_HEADER);
  if (betaFeatures) headers[X_CODEX_BETA_FEATURES_HEADER] = betaFeatures;
  const timingMetrics = firstCodexRequestString(
    request,
    X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER,
  );
  if (timingMetrics) headers[X_RESPONSESAPI_INCLUDE_TIMING_METRICS_HEADER] = timingMetrics;
  if (request.version?.trim()) headers.Version = request.version.trim();
  const parentThreadId = firstCodexRequestString(request, X_CODEX_PARENT_THREAD_ID_HEADER);
  if (parentThreadId) headers[X_CODEX_PARENT_THREAD_ID_HEADER] = parentThreadId;
}

export function buildCodexClientMetadata(
  request: CodexResponsesRequest,
  installationId: string,
  sessionId?: string | null,
  windowId?: string | null,
): Record<string, string> {
  const metadata: Record<string, string> = {
    ...(request.client_metadata ?? {}),
    "x-codex-installation-id": installationId,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(windowId ? { [X_CODEX_WINDOW_ID_HEADER]: windowId } : {}),
  };
  const turnMetadata = firstCodexRequestString(request, X_CODEX_TURN_METADATA_HEADER);
  if (turnMetadata) metadata[X_CODEX_TURN_METADATA_HEADER] = turnMetadata;
  const parentThreadId = firstCodexRequestString(request, X_CODEX_PARENT_THREAD_ID_HEADER);
  if (parentThreadId) metadata[X_CODEX_PARENT_THREAD_ID_HEADER] = parentThreadId;
  return metadata;
}

/** Extract the leading X.Y.Z engine version from a Codex-shaped User-Agent. */
export function codexVersionFromUserAgent(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const slash = userAgent.indexOf("/");
  if (slash < 0) return null;
  return /^(\d+\.\d+\.\d+)/.exec(userAgent.slice(slash + 1).trim())?.[1] ?? null;
}
