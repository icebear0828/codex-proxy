import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const state = vi.hoisted(() => ({
  config: {
    server: { proxy_api_key: null as string | null },
    account_keepalive: {
      enabled: false,
      mode: "fixed_times" as "fixed_times" | "interval",
      fixed_times: [] as string[],
      interval_minutes: null as number | null,
      concurrency: 2,
      per_account_delay_ms: 0,
    },
  },
}));

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(() => state.config),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  reloadAllConfigs: vi.fn(),
  mutateYaml: vi.fn((_path: string, mutate: (data: Record<string, unknown>) => void) => {
    const data: Record<string, unknown> = {
      account_keepalive: { ...state.config.account_keepalive },
    };
    mutate(data);
    state.config.account_keepalive = {
      ...state.config.account_keepalive,
      ...(data.account_keepalive as Partial<typeof state.config.account_keepalive>),
    };
  }),
  scheduler: {
    getStatus: vi.fn(() => ({})),
    runNow: vi.fn(async () => []),
    stop: vi.fn(),
    start: vi.fn(),
  },
}));

vi.mock("@src/config.js", () => ({
  getConfig: mocks.getConfig,
  getLocalConfigPath: mocks.getLocalConfigPath,
  reloadAllConfigs: mocks.reloadAllConfigs,
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({ mutateYaml: mocks.mutateYaml }));

import { createKeepaliveRoutes } from "@src/routes/admin/keepalive.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", createKeepaliveRoutes(mocks.scheduler as never));
  return app;
}

function resetConfig(): void {
  state.config.server.proxy_api_key = null;
  state.config.account_keepalive = {
    enabled: false,
    mode: "fixed_times",
    fixed_times: [],
    interval_minutes: null,
    concurrency: 2,
    per_account_delay_ms: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConfig();
});

describe("account keepalive config route", () => {
  it("accepts valid 24-hour fixed times", async () => {
    const app = createApp();
    const fixedTimes = ["00:00", "09:00", "23:59"];

    const response = await app.request("/admin/keepalive-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixed_times: fixedTimes }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).config.fixed_times).toEqual(fixedTimes);
    expect(mocks.mutateYaml).toHaveBeenCalledOnce();
    expect(mocks.scheduler.stop).toHaveBeenCalledOnce();
    expect(mocks.scheduler.start).toHaveBeenCalledOnce();
  });

  it.each(["9:00", "24:00", "12:60", "12:30:00", "\\\\09:00"])(
    "rejects invalid fixed time %s",
    async (time) => {
      const app = createApp();
      const response = await app.request("/admin/keepalive-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixed_times: [time] }),
      });

      expect(response.status).toBe(400);
      expect(mocks.mutateYaml).not.toHaveBeenCalled();
      expect(mocks.scheduler.stop).not.toHaveBeenCalled();
      expect(mocks.scheduler.start).not.toHaveBeenCalled();
    },
  );

  it("requires the configured API key for updates", async () => {
    state.config.server.proxy_api_key = "test-secret";
    const app = createApp();

    const response = await app.request("/admin/keepalive-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixed_times: ["09:00"] }),
    });

    expect(response.status).toBe(401);
    expect(mocks.mutateYaml).not.toHaveBeenCalled();
  });
});
