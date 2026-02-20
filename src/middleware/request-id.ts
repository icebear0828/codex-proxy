import type { Context, Next } from "hono";
import { randomUUID } from "crypto";

/**
 * Middleware that generates a unique request ID for each request.
 * Sets X-Request-Id response header and stores it in c.set() for logging.
 */
export async function requestId(c: Context, next: Next): Promise<void> {
  const id = c.req.header("x-request-id") ?? randomUUID().slice(0, 8);
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
}
