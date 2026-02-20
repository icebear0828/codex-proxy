import type { Context, Next } from "hono";

export async function logger(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const rid = c.get("requestId") ?? "-";

  console.log(`→ ${method} ${path} [${rid}]`);

  await next();

  const ms = Date.now() - start;
  const status = c.res.status;
  console.log(`← ${method} ${path} ${status} ${ms}ms [${rid}]`);
}
