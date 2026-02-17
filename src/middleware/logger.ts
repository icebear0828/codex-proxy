import type { Context, Next } from "hono";

export async function logger(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  console.log(`→ ${method} ${path}`);

  await next();

  const ms = Date.now() - start;
  const status = c.res.status;
  console.log(`← ${method} ${path} ${status} ${ms}ms`);
}
