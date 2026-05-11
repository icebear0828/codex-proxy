/**
 * Response processing helpers for the proxy handler.
 *
 * Encapsulates streaming (SSE) and non-streaming (collect) response paths.
 */

import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import { CodexApiError } from "../../proxy/codex-types.js";
import type { FormatAdapter, ResponseMetadata, UsageHint } from "./proxy-handler.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { debugDump, debugDumpEnabled } from "../../utils/debug-dump.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";

/** Minimal subset of Hono's StreamingApi that we actually use. */
export interface StreamWriter {
  write(chunk: string): Promise<unknown>;
  onAbort(cb: () => void): void;
}

export interface StreamDiagnostics {
  requestId?: string;
  tag?: string;
  accountEntryId?: string;
  variantHash?: string;
}

interface WrittenStreamTrace {
  chunks: number;
  bytes: number;
  lastEvent: string | null;
  sawTerminal: boolean;
}

interface ChunkTrace {
  bytes: number;
  lastEvent: string | null;
  terminal: boolean;
}

function isTerminalStreamEvent(event: string): boolean {
  return event === "response.completed" ||
    event === "response.failed" ||
    event === "error" ||
    event === "message_stop" ||
    event === "[DONE]";
}

function inspectStreamChunk(chunk: string): ChunkTrace {
  const trace: ChunkTrace = {
    bytes: Buffer.byteLength(chunk, "utf8"),
    lastEvent: null,
    terminal: false,
  };

  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event: ")) {
      const event = line.slice("event: ".length).trim();
      if (event) {
        trace.lastEvent = event;
        if (isTerminalStreamEvent(event)) trace.terminal = true;
      }
      continue;
    }
    if (line.startsWith("data: ")) {
      const data = line.slice("data: ".length).trim();
      if (data === "[DONE]") {
        trace.lastEvent = "[DONE]";
        trace.terminal = true;
      }
    }
  }

  return trace;
}

function applyWrittenChunkTrace(written: WrittenStreamTrace, chunk: ChunkTrace): void {
  written.chunks += 1;
  written.bytes += chunk.bytes;
  if (chunk.lastEvent) written.lastEvent = chunk.lastEvent;
  if (chunk.terminal) written.sawTerminal = true;
}

function formatDiagnosticValue(value: string | null | undefined): string {
  return value && value.length > 0 ? value : "none";
}

function streamErrorStatus(err: unknown): number {
  if (err instanceof CodexApiError && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  return 502;
}

/**
 * Stream SSE chunks from the Codex upstream to the client.
 *
 * Handles: client disconnect (stops reading upstream), stream errors
 * (sends error SSE event before closing).
 */
export async function streamResponse(
  s: StreamWriter,
  api: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  adapter: FormatAdapter,
  onUsage: (u: UsageInfo) => void,
  tupleSchema?: Record<string, unknown> | null,
  onResponseId?: (id: string) => void,
  usageHint?: UsageHint,
  onResponseMetadata?: (metadata: ResponseMetadata) => void,
  diagnostics?: StreamDiagnostics,
): Promise<void> {
  const written: WrittenStreamTrace = {
    chunks: 0,
    bytes: 0,
    lastEvent: null,
    sawTerminal: false,
  };
  try {
    for await (const chunk of adapter.streamTranslator(
      api,
      rawResponse,
      model,
      onUsage,
      onResponseId ?? (() => {}),
      tupleSchema,
      usageHint,
      onResponseMetadata,
    )) {
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
        await s.write(chunk);
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
      await s.write(
        adapter.formatStreamError?.(responseStatus, errMsg) ??
          `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`,
      );
    } catch { /* client already gone */ }
  }
}
