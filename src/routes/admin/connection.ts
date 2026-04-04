import { Hono } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import { getConfig } from "../../config.js";
import { getTransport, getTransportInfo } from "../../tls/transport.js";
import { buildHeaders } from "../../fingerprint/manager.js";

export function createConnectionRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();

  app.post("/admin/test-connection", async (c) => {
    type DiagStatus = "pass" | "fail" | "skip";
    interface DiagCheck { name: string; status: DiagStatus; latencyMs: number; detail: string | null; error: string | null; }
    const checks: DiagCheck[] = [];
    let overallFailed = false;

    // 1. Server check
    const serverStart = Date.now();
    checks.push({
      name: "server",
      status: "pass",
      latencyMs: Date.now() - serverStart,
      detail: `PID ${process.pid}`,
      error: null,
    });

    // 2. Accounts check
    const accountsStart = Date.now();
    const poolSummary = accountPool.getPoolSummary();
    const hasActive = poolSummary.active > 0;
    checks.push({
      name: "accounts",
      status: hasActive ? "pass" : "fail",
      latencyMs: Date.now() - accountsStart,
      detail: hasActive
        ? `${poolSummary.active} active / ${poolSummary.total} total`
        : `0 active / ${poolSummary.total} total`,
      error: hasActive ? null : "No active accounts",
    });
    if (!hasActive) overallFailed = true;

    // 3. Transport check
    const transportStart = Date.now();
    const transportInfo = getTransportInfo();
    const transportOk = transportInfo.initialized;
    checks.push({
      name: "transport",
      status: transportOk ? "pass" : "fail",
      latencyMs: Date.now() - transportStart,
      detail: transportOk
        ? `${transportInfo.type}, impersonate=${transportInfo.impersonate}`
        : null,
      error: transportOk ? null : "Transport not initialized",
    });
    if (!transportOk) overallFailed = true;

    // 4. Upstream check
    if (!hasActive) {
      checks.push({
        name: "upstream",
        status: "skip",
        latencyMs: 0,
        detail: "Skipped (no active accounts)",
        error: null,
      });
    } else {
      const upstreamStart = Date.now();
      const acquired = accountPool.acquire();
      if (!acquired) {
        checks.push({
          name: "upstream",
          status: "fail",
          latencyMs: Date.now() - upstreamStart,
          detail: null,
          error: "Could not acquire account for test",
        });
        overallFailed = true;
      } else {
        try {
          const transport = getTransport();
          const config = getConfig();
          const url = `${config.api.base_url}/codex/usage`;
          const headers = buildHeaders(acquired.token, acquired.accountId);
          const resp = await transport.get(url, headers, 15);
          const latency = Date.now() - upstreamStart;
          if (resp.status >= 200 && resp.status < 400) {
            checks.push({
              name: "upstream",
              status: "pass",
              latencyMs: latency,
              detail: `HTTP ${resp.status} (${latency}ms)`,
              error: null,
            });
          } else {
            checks.push({
              name: "upstream",
              status: "fail",
              latencyMs: latency,
              detail: `HTTP ${resp.status}`,
              error: `Upstream returned ${resp.status}`,
            });
            overallFailed = true;
          }
        } catch (err) {
          const latency = Date.now() - upstreamStart;
          checks.push({
            name: "upstream",
            status: "fail",
            latencyMs: latency,
            detail: null,
            error: err instanceof Error ? err.message : String(err),
          });
          overallFailed = true;
        } finally {
          accountPool.releaseWithoutCounting(acquired.entryId);
        }
      }
    }

    return c.json({
      checks,
      overall: overallFailed ? "fail" as const : "pass" as const,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
