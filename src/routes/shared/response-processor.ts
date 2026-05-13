/**
 * Response processing helpers for the proxy handler.
 *
 * Encapsulates streaming (SSE) and non-streaming (collect) response paths.
 */

import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import { CodexApiError } from "../../proxy/codex-types.js";
import type { FormatAdapter, ResponseMetadata, UsageHint } from "./proxy-handler-types.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { debugDump, debugDumpEnabled } from "../../utils/debug-dump.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import {
  applyWrittenChunkTrace,
  createWrittenStreamTrace,
  formatDiagnosticValue,
  inspectStreamChunk,
  streamErrorStatus,
} from "./response-stream-trace.js";

/** Minimal subset of Hono's StreamingApi that we actually use. */
export interface StreamWriter {
  write(chunk: string): Promise<unknown>;
  onAbort(cb: () => void): void;
}

export interface StreamDiagnostics {
  requestId?: string;
  tag?: string;
  provider?: string;
  path?: string;
  accountEntryId?: string;
  variantHash?: string;
  abortSignal?: AbortSignal;
}

export interface StreamResponseOptions {
  writer: StreamWriter;
  api: UpstreamAdapter;
  response: Response;
  model: string;
  adapter: FormatAdapter;
  onUsage: (u: UsageInfo) => void;
  tupleSchema?: Record<string, unknown> | null;
  onResponseId?: (id: string) => void;
  usageHint?: UsageHint;
  onResponseMetadata?: (metadata: ResponseMetadata) => void;
  diagnostics?: StreamDiagnostics;
}

/**
 * Stream SSE chunks from the Codex upstream to the client.
 *
 * Handles: client disconnect (stops reading upstream), stream errors
 * (sends error SSE event before closing).
 */
export async function streamResponse(options: StreamResponseOptions): Promise<void> {
  const {
    writer,
    api,
    response,
    model,
    adapter,
    onUsage,
    tupleSchema,
    onResponseId,
    usageHint,
    onResponseMetadata,
    diagnostics,
  } = options;
  const written = createWrittenStreamTrace();
  // Diagnostic context passed into adapter-internal premature-close records
  // (e.g. streamPassthrough in responses.ts). The adapter is free to ignore
  // it; carrying it through here means audit entries land on the real
  // requestId/account/variantHash instead of the synthetic fallback.
  const streamContext = {
    requestId: diagnostics?.requestId,
    tag: diagnostics?.tag ?? adapter.tag,
    provider: diagnostics?.provider,
    path: diagnostics?.path,
    model,
    accountEntryId: diagnostics?.accountEntryId,
    variantHash: diagnostics?.variantHash,
  };
  try {
    for await (const chunk of adapter.streamTranslator({
      api,
      response,
      model,
      onUsage,
      onResponseId: onResponseId ?? (() => {}),
      tupleSchema,
      usageHint,
      onResponseMetadata,
      streamContext,
    })) {
      const chunkTrace = inspectStreamChunk(chunk);
      if (debugDumpEnabled()) {
        debugDump("upstream-chunk", {
          rid: diagnostics?.requestId,
          tag: diagnostics?.tag ?? adapter.tag,
          event: chunkTrace.lastEvent,
          terminal: chunkTrace.terminal,
          chunk: chunk.length > 16_000 ? chunk.slice(0, 16_000) + "...<truncated>" : chunk,
        });
      }
      try {
        await writer.write(chunk);
        applyWrittenChunkTrace(written, chunkTrace);
      } catch (writeErr) {
        const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.warn(
          `[stream-client-disconnect] rid=${formatDiagnosticValue(diagnostics?.requestId)}` +
            ` tag=${formatDiagnosticValue(diagnostics?.tag ?? adapter.tag)} model=${model}` +
            ` written_chunks=${written.chunks} written_bytes=${written.bytes}` +
            ` last_sent_event=${formatDiagnosticValue(written.lastEvent)}` +
            ` sent_terminal=${written.sawTerminal}` +
            ` failed_chunk_event=${formatDiagnosticValue(chunkTrace.lastEvent)}` +
            ` failed_chunk_terminal=${chunkTrace.terminal}` +
            ` err=${errMsg}`,
        );
        recordStreamCloseEvent({
          kind: "client-write-failed",
          requestId: diagnostics?.requestId ?? null,
          tag: diagnostics?.tag ?? adapter.tag ?? null,
          provider: diagnostics?.provider ?? null,
          path: diagnostics?.path ?? null,
          model,
          accountEntryId: diagnostics?.accountEntryId ?? null,
          variantHash: diagnostics?.variantHash ?? null,
          writtenChunks: written.chunks,
          writtenBytes: written.bytes,
          lastSentEvent: written.lastEvent,
          sentTerminal: written.sawTerminal,
          detail: errMsg,
        });
        // Client disconnected mid-stream — stop reading upstream
        return;
      }
    }
    if (debugDumpEnabled()) {
      debugDump("stream-finish", {
        rid: diagnostics?.requestId,
        tag: diagnostics?.tag ?? adapter.tag,
        chunks: written.chunks,
        bytes: written.bytes,
        sawTerminal: written.sawTerminal,
        lastEvent: written.lastEvent,
      });
    }
  } catch (err) {
    if (diagnostics?.abortSignal?.aborted) {
      return;
    }
    const errMsg = err instanceof Error ? err.message : "Stream interrupted";
    const errStatus = err instanceof CodexApiError ? err.status : "?";
    const errBody = err instanceof CodexApiError ? err.body : undefined;
    const responseStatus = streamErrorStatus(err);
    if (debugDumpEnabled()) {
      debugDump("stream-error", {
        rid: diagnostics?.requestId,
        tag: diagnostics?.tag ?? adapter.tag,
        status: errStatus,
        msg: errMsg,
        body: errBody?.slice(0, 4000) ?? null,
        chunks: written.chunks,
        bytes: written.bytes,
        sawTerminal: written.sawTerminal,
      });
    }
    console.warn(
      `[stream-error] rid=${formatDiagnosticValue(diagnostics?.requestId)}` +
        ` tag=${formatDiagnosticValue(diagnostics?.tag ?? adapter.tag)} model=${model}` +
        ` status=${errStatus}` +
        ` written_chunks=${written.chunks} written_bytes=${written.bytes}` +
        ` last_sent_event=${formatDiagnosticValue(written.lastEvent)}` +
        ` sent_terminal=${written.sawTerminal}` +
        ` msg=${errMsg}` +
        (errBody ? ` body=${errBody.slice(0, 1000)}` : ""),
    );
    recordStreamCloseEvent({
      kind: "upstream-error",
      requestId: diagnostics?.requestId ?? null,
      tag: diagnostics?.tag ?? adapter.tag ?? null,
      provider: diagnostics?.provider ?? null,
      path: diagnostics?.path ?? null,
      model,
      accountEntryId: diagnostics?.accountEntryId ?? null,
      variantHash: diagnostics?.variantHash ?? null,
      writtenChunks: written.chunks,
      writtenBytes: written.bytes,
      lastSentEvent: written.lastEvent,
      sentTerminal: written.sawTerminal,
      upstreamStatus: typeof errStatus === "number" ? errStatus : null,
      detail: errMsg,
    });
    // Send error SSE event to client before closing
    try {
      await writer.write(
        adapter.formatStreamError?.(responseStatus, errMsg) ??
          `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`,
      );
    } catch { /* client already gone */ }
  }
}
