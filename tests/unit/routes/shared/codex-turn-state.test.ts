import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { relayCodexTurnState } from "@src/routes/shared/codex-turn-state.js";

describe("relayCodexTurnState", () => {
  it("relays the upstream turn state for native Responses responses", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      relayCodexTurnState(c, new Response(null, {
        headers: { "x-codex-turn-state": "turn-123" },
      }), "Responses");
      return c.text("ok");
    });

    const response = await app.request("/");
    expect(response.headers.get("x-codex-turn-state")).toBe("turn-123");
  });

  it("does not expose the Codex-only state on translated formats", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      relayCodexTurnState(c, new Response(null, {
        headers: { "x-codex-turn-state": "turn-123" },
      }), "Chat");
      return c.text("ok");
    });

    const response = await app.request("/");
    expect(response.headers.get("x-codex-turn-state")).toBeNull();
  });

  it("ignores an upstream response without turn state", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      relayCodexTurnState(c, new Response(null), "Responses");
      return c.text("ok");
    });

    const response = await app.request("/");
    expect(response.headers.get("x-codex-turn-state")).toBeNull();
  });
});
