/**
 * Response processing helpers for the proxy handler.
 *
 * Encapsulates streaming (SSE) and non-streaming (collect) response paths.
 */

import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import type { FormatAdapter } from "./proxy-handler.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

/** Minimal subset of Hono's StreamingApi that we actually use. */
export interface StreamWriter {
  write(chunk: string): Promise<unknown>;
  onAbort(cb: () => void): void;
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
): Promise<void> {
  try {
    for await (const chunk of adapter.streamTranslator(
      api,
      rawResponse,
      model,
      onUsage,
      onResponseId ?? (() => {}),
      tupleSchema,
    )) {
      try {
        await s.write(chunk);
      } catch {
        // Client disconnected mid-stream — stop reading upstream
        return;
      }
    }
  } catch (err) {
    // Send error SSE event to client before closing
    try {
      const errMsg = err instanceof Error ? err.message : "Stream interrupted";
      await s.write(
        `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`,
      );
    } catch { /* client already gone */ }
  }
}

