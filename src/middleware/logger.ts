import type { Context, Next } from "hono";
import { log } from "../utils/logger.js";

export async function logger(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const rid = c.get("requestId") ?? "-";

  log.info(`→ ${method} ${path}`, { rid, method, path });

  await next();

  const ms = Date.now() - start;
  const status = c.res.status;
  log.info(`← ${method} ${path} ${status} ${ms}ms`, { rid, method, path, status, ms });
}
