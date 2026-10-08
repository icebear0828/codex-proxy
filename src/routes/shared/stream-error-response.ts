import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import type { FormatAdapter, ProxyRequest } from "./proxy-handler-types.js";

export function canReturnStreamError(req: ProxyRequest, fmt: FormatAdapter): boolean {
  return req.isStreaming && typeof fmt.formatStreamError === "function";
}

export function streamErrorResponse(
  c: Context,
  fmt: FormatAdapter,
  status: number,
  message: string,
): Response {
  // The status must be applied to the context before the stream body is
  // returned; once the SSE body starts, only the payload is left to write.
  // Without this the context keeps its default 200 and an upstream failure
  // reaches the client as a successful response carrying an SSE error frame.
  c.status(status as StatusCode);
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");

  return stream(c, async (s) => {
    await s.write(
      fmt.formatStreamError?.(status, message) ??
        `data: ${JSON.stringify({ error: { message, type: "stream_error" } })}\n\n`,
    );
  });
}
