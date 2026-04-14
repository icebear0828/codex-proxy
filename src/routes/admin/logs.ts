import { Hono } from "hono";
import { logStore, type LogDirection } from "../../logs/store.js";

function parseDirection(raw: string | null): LogDirection | "all" {
  if (raw === "ingress" || raw === "egress" || raw === "all") return raw;
  return "all";
}

export function createLogRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/logs", (c) => {
    const direction = parseDirection(c.req.query("direction"));
    const search = c.req.query("search");
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const data = logStore.list({ direction, search, limit, offset });
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
