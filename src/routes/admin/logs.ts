import { Hono } from "hono";
import { z } from "zod";
import { logStore, type LogDirection } from "../../logs/store.js";

const ListLogsQuerySchema = z.object({
  limit: z.preprocess((value) => value === undefined ? undefined : Number(value), z.number().int().min(1).max(200).optional()),
  offset: z.preprocess((value) => value === undefined ? undefined : Number(value), z.number().int().min(0).optional()),
});

function parseDirection(raw: string | null | undefined): LogDirection | "all" {
  if (raw === "ingress" || raw === "egress" || raw === "all") return raw;
  return "all";
}

export function createLogRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/logs", (c) => {
    const parsed = ListLogsQuerySchema.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
    });
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    const direction = parseDirection(c.req.query("direction"));
    const search = c.req.query("search");
    const data = logStore.list({
      direction,
      search,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return c.json(data);
  });

  app.get("/admin/logs/state", (c) => {
    return c.json(logStore.getState());
  });

  app.post("/admin/logs/state", async (c) => {
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    const paused = typeof body.paused === "boolean" ? body.paused : undefined;
    return c.json(logStore.setState({ enabled, paused }));
  });

  app.post("/admin/logs/clear", (c) => {
    logStore.clear();
    return c.json({ ok: true });
  });

  app.get("/admin/logs/:id", (c) => {
    const rec = logStore.get(c.req.param("id"));
    if (!rec) {
      c.status(404);
      return c.json({ error: "not_found" });
    }
    return c.json(rec);
  });

  return app;
}
