import { Hono } from "hono";
import { z } from "zod";
import {
  appendErrorLog,
  groupErrorLog,
  getUnreadCount,
  readErrorLog,
  setReadCursor,
  type ErrorSource,
} from "../../logs/error-log.js";

const RawQuerySchema = z.object({
  limit: z.preprocess(
    (v) => (v === undefined ? undefined : Number(v)),
    z.number().int().min(1).max(500).optional(),
  ),
});

const ReportBodySchema = z.object({
  source: z.enum(["main", "renderer", "server", "external"]),
  error: z.object({
    name: z.string().min(1).max(200),
    message: z.string().max(4000),
    stack: z.string().max(10_000).optional(),
  }),
  context: z.record(z.string(), z.unknown()).optional(),
});

export function createErrorLogRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/error-logs", (c) => {
    const entries = readErrorLog();
    const groups = groupErrorLog(entries);
    return c.json({ groups });
  });

  app.get("/admin/error-logs/raw", (c) => {
    const parsed = RawQuerySchema.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid limit", details: parsed.error.issues });
    }
    const entries = readErrorLog(parsed.data.limit);
    return c.json({ entries });
  });

  app.get("/admin/error-logs/count", (c) => {
    const entries = readErrorLog();
    return c.json({ total: entries.length, unread: getUnreadCount(entries) });
  });

  app.post("/admin/error-logs/seen", (c) => {
    const entries = readErrorLog(1);
    // Use the newest entry's ts; if the log is empty, mark "now" so a
    // later report doesn't need to be considered already-read.
    const cursor = entries[0]?.ts ?? new Date().toISOString();
    setReadCursor(cursor);
    return c.json({ ok: true, cursor });
  });

  app.post("/admin/error-logs/report", async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw === null) {
      c.status(400);
      return c.json({ error: "Invalid JSON" });
    }
    const parsed = ReportBodySchema.safeParse(raw);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid payload", details: parsed.error.issues });
    }
    appendErrorLog({
      source: parsed.data.source as ErrorSource,
      error: parsed.data.error,
      context: parsed.data.context,
    });
    return c.json({ ok: true });
  });

  return app;
}
