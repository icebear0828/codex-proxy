import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createOfficialAgentRoutes } from "@src/routes/official-agent.js";
import type {
  CodexAppServerBridge,
  CodexAppNotification,
  StartThreadParams,
  StartTurnParams,
} from "@src/codex-app-server/types.js";
import { ConfigSchema } from "@src/config-schema.js";
import { resetConfigForTesting, setConfigForTesting } from "@src/config.js";

class FakeBridge implements CodexAppServerBridge {
  public startedTurns: StartTurnParams[] = [];

  async listApps(): Promise<unknown> {
    return { data: [{ id: "chrome", name: "Chrome", isAccessible: true, isEnabled: true }], nextCursor: null };
  }

  async startThread(params: StartThreadParams): Promise<unknown> {
    return { thread: { id: params.model === "gpt-5.4" ? "thr_54" : "thr_default" } };
  }

  async startTurn(params: StartTurnParams): Promise<unknown> {
    this.startedTurns.push(params);
    return { turn: { id: "turn_1", status: "inProgress" } };
  }

  notificationsUntilTurnCompleted(): AsyncIterable<CodexAppNotification> {
    return (async function* () {
      yield { method: "item/agentMessage/delta", params: { delta: "ok" } };
      yield { method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } };
    })();
  }
}

function makeApp(bridge: CodexAppServerBridge): Hono {
  const app = new Hono();
  app.route("/", createOfficialAgentRoutes(() => bridge));
  return app;
}

describe("official agent routes", () => {
  beforeEach(() => {
    resetConfigForTesting();
  });

  it("returns 503 when official agent bridge is disabled", async () => {
    setConfigForTesting(ConfigSchema.parse({ api: {}, client: {}, model: {}, auth: {}, server: {}, session: {} }));
    const res = await makeApp(new FakeBridge()).request("/official-agent/apps");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "official_agent_disabled", message: "Official Codex app-server bridge is disabled" },
    });
  });

  it("requires proxy API key when configured", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/apps");

    expect(res.status).toBe(401);
  });

  it("lists apps through the app-server bridge", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, session: {},
      server: { proxy_api_key: "proxy-key" },
      official_agent: { enabled: true },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/apps", {
      headers: { Authorization: "Bearer proxy-key" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [{ id: "chrome", name: "Chrome", isAccessible: true, isEnabled: true }],
      nextCursor: null,
    });
  });

  it("starts a thread", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      official_agent: { enabled: true },
    }));

    const res = await makeApp(new FakeBridge()).request("/official-agent/threads", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.4" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ thread: { id: "thr_54" } });
  });

  it("starts a turn and streams app-server notifications as SSE", async () => {
    setConfigForTesting(ConfigSchema.parse({
      api: {}, client: {}, model: {}, auth: {}, server: {}, session: {},
      official_agent: { enabled: true },
    }));
    const bridge = new FakeBridge();

    const res = await makeApp(bridge).request("/official-agent/threads/thr_54/turns", {
      method: "POST",
      body: JSON.stringify({ text: "Open the dashboard", app: { id: "chrome", name: "Chrome" } }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(bridge.startedTurns).toEqual([{
      threadId: "thr_54",
      text: "Open the dashboard",
      app: { id: "chrome", name: "Chrome" },
    }]);
    const body = await res.text();
    expect(body).toContain("event: official_agent.result");
    expect(body).toContain("event: item/agentMessage/delta");
    expect(body).toContain("event: turn/completed");
  });
});
