import type { StatusCode } from "hono/utils/http-status";
import { toErrorStatus } from "./proxy-error-handler.js";

export interface NonStreamingCollectErrorResponsePlan {
  status: StatusCode;
  message: string;
}

export function planNonStreamingCollectErrorResponse(
  collectErr: unknown,
): NonStreamingCollectErrorResponsePlan {
  const message = collectErr instanceof Error ? collectErr.message : "Unknown error";
  const statusMatch = message.match(/HTTP\/[\d.]+ (\d{3})/);
  const upstreamStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  return {
    status: toErrorStatus(upstreamStatus),
    message,
  };
}
