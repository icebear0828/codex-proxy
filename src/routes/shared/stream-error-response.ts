import type { Context } from "hono";
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
