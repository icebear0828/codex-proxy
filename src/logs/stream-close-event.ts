/**
 * Structured logging for stream-close events.
 *
 * Premature stream close (upstream-side) and client abort (downstream-side) are
 * recurring failure modes that previously left only an ad-hoc `console.warn`
 * trail in the dev tee log. This helper persists every close event through
 * both observability channels:
 *
 *   - `appendErrorLog` → `data/error-log.jsonl` → Errors tab + unread badge
 *   - `enqueueLogEntry` → in-memory audit log (admin /api/logs)
 *
 * Same context shape for both so the dashboard and the audit feed can be
 * cross-referenced by rid + ts when diagnosing a recurrence.
 */

import { appendErrorLog } from "./error-log.js";
import { enqueueLogEntry } from "./entry.js";

export type StreamCloseKind =
  | "client-abort"
  | "client-write-failed"
  | "upstream-error"
  | "upstream-premature";

/** Caller-provided diagnostic context that travels with a streaming request.
 *  Optional fields are filled in opportunistically — missing context still
 *  produces a useful Errors-tab entry, callers should pass what they have. */
export interface StreamCloseContextBase {
  requestId?: string | null;
  tag?: string | null;
  provider?: string | null;
  path?: string | null;
  model?: string | null;
  accountEntryId?: string | null;
  variantHash?: string | null;
  responseId?: string | null;
}

export interface StreamCloseEvent extends StreamCloseContextBase {
  kind: StreamCloseKind;
  /** Free-form description from the underlying error (e.g. WS code, EOF msg). */
  detail?: string | null;
  /** WS close code surfaced from `ws-pool` / `ws-transport` when known. */
  closeCode?: number | null;
  /** UpstreamPrematureCloseError carries these — fill them in when available. */
  eventCount?: number | null;
  hadReasoning?: boolean | null;
  /** Stream-write diagnostics from `response-processor` when the client side closed. */
  writtenChunks?: number | null;
  writtenBytes?: number | null;
  lastSentEvent?: string | null;
  sentTerminal?: boolean | null;
  /** CodexApiError.status when the error was a typed upstream error. */
  upstreamStatus?: number | string | null;
}

const ERROR_NAMES: Readonly<Record<StreamCloseKind, string>> = {
  "client-abort": "StreamClientAbort",
  "client-write-failed": "StreamClientWriteFailed",
  "upstream-error": "StreamUpstreamError",
  "upstream-premature": "StreamUpstreamPrematureClose",
};

const BASE_MESSAGES: Readonly<Record<StreamCloseKind, string>> = {
  "client-abort": "Client aborted stream",
  "client-write-failed": "Client disconnected mid-stream (write failed)",
  "upstream-error": "Upstream stream errored",
  "upstream-premature": "Upstream stream closed before terminal event",
};

function prune<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj) as Array<[keyof T, T[keyof T]]>) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Persist a stream-close event into both the local error log (Errors tab)
 *  and the in-memory audit log. Never throws — logging failures inside the
 *  helpers swallow themselves. */
export function recordStreamCloseEvent(evt: StreamCloseEvent): void {
  const name = ERROR_NAMES[evt.kind];
  const base = BASE_MESSAGES[evt.kind];
  const message = evt.detail ? `${base}: ${evt.detail}` : base;
  const numericStatus =
    typeof evt.upstreamStatus === "number" ? evt.upstreamStatus : null;

  appendErrorLog({
    source: "server",
    error: { name, message },
    context: prune({
      kind: evt.kind,
      requestId: evt.requestId,
      tag: evt.tag,
      provider: evt.provider,
      path: evt.path,
      model: evt.model,
      accountEntryId: evt.accountEntryId,
      variantHash: evt.variantHash,
      responseId: evt.responseId,
      eventCount: evt.eventCount,
      hadReasoning: evt.hadReasoning,
      closeCode: evt.closeCode,
      writtenChunks: evt.writtenChunks,
      writtenBytes: evt.writtenBytes,
      lastSentEvent: evt.lastSentEvent,
      sentTerminal: evt.sentTerminal,
      upstreamStatus: evt.upstreamStatus,
      detail: evt.detail,
    }),
  });

  enqueueLogEntry({
    requestId: evt.requestId ?? "stream-close",
    direction: "egress",
    method: "POST",
    path: evt.path ?? "/codex/responses",
    model: evt.model ?? null,
    provider: evt.provider ?? "codex",
    status: numericStatus,
    stream: true,
    error: message,
    request: prune({
      kind: evt.kind,
      tag: evt.tag,
      accountEntryId: evt.accountEntryId,
      variantHash: evt.variantHash,
      responseId: evt.responseId,
      eventCount: evt.eventCount,
      hadReasoning: evt.hadReasoning,
      closeCode: evt.closeCode,
      writtenChunks: evt.writtenChunks,
      writtenBytes: evt.writtenBytes,
      lastSentEvent: evt.lastSentEvent,
      sentTerminal: evt.sentTerminal,
      upstreamStatus: evt.upstreamStatus,
    }),
  });
}
