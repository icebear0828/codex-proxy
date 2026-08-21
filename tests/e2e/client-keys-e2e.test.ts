import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.js";
import { ClientKeyPool } from "../../src/auth/client-key-pool.js";
import { ClientKeyPersistence } from "../../src/auth/client-key-persistence.js";
import { createClientKeyAdminRoutes } from "../../src/routes/admin/client-keys.js";
import { createChatRoutes } from "../../src/routes/chat.js";
import { createModelRoutes } from "../../src/routes/models.js";
import { AccountPool } from "../../src/auth/account-pool.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Client Keys Real E2E Workflow (≥ 3 Successful Iterations)", () => {
  let tempDir: string;
  let pool: ClientKeyPool;
  let app: Hono;
  const MASTER_KEY = "master-secret-for-e2e-test";

  beforeAll(() => {
    loadConfig();
    tempDir = mkdtempSync(join(tmpdir(), "client-key-e2e-"));
    const persistence = new ClientKeyPersistence(
      join(tempDir, "client-keys.sqlite"),
      join(tempDir, "client-keys.json"),
    );
    pool = new ClientKeyPool(persistence, () => MASTER_KEY);

    const accountPool = new AccountPool();
    app = new Hono();
    app.route("/", createClientKeyAdminRoutes(pool, () => MASTER_KEY));
    app.route("/", createModelRoutes(undefined, pool));
    app.route("/", createChatRoutes(accountPool, undefined, undefined, undefined, pool));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  it("completes full client key lifecycle with ≥ 3 successful consecutive calls for all endpoints", async () => {
    // 1. Admin creates a scoped Client Key
    const createRes = await app.request("/admin/client-keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MASTER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "E2E Distributed Key",
        max_budget_usd: 10.0,
        max_tokens: 100000,
        max_concurrency: 3,
        allowed_models: ["gpt-5.4", "gpt-5.3-codex"],
      }),
    });
    expect(createRes.status).toBe(200);
    const createdData = await createRes.json();
    expect(createdData.success).toBe(true);
    const clientKey = createdData.key.key;
    const clientKeyId = createdData.key.id;

    console.log(`[E2E] Created Client Key: ${clientKey} (ID: ${clientKeyId})`);

    // 2. Iteration 1, 2, 3: Query /v1/sub-key/info (Consecutive >= 3 times)
    for (let i = 1; i <= 3; i++) {
      const infoRes = await app.request("/v1/sub-key/info", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientKey}` },
      });
      expect(infoRes.status).toBe(200);
      const info = await infoRes.json();
      expect(info.name).toBe("E2E Distributed Key");
      expect(info.remaining_budget_usd).toBe(10.0);
      expect(info.allowed_models).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
      console.log(`[E2E] Iteration ${i} /v1/sub-key/info -> SUCCESS (Remaining: $${info.remaining_budget_usd})`);
    }

    // 3. Iteration 1, 2, 3: Query /v1/models with whitelisting (Consecutive >= 3 times)
    for (let i = 1; i <= 3; i++) {
      const modelsRes = await app.request("/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientKey}` },
      });
      expect(modelsRes.status).toBe(200);
      const modelsList = await modelsRes.json();
      const modelIds = modelsList.data.map((m: { id: string }) => m.id);
      // All returned models must be in whitelist
      expect(modelIds.every((id: string) => ["gpt-5.4", "gpt-5.3-codex"].includes(id))).toBe(true);
      console.log(`[E2E] Iteration ${i} /v1/models (Filtered) -> SUCCESS (${modelIds.join(", ")})`);
    }

    // 4. Security Verification: Client Key is blocked from /admin/*
    const adminBlockedRes = await app.request("/admin/client-keys", {
      method: "GET",
      headers: { Authorization: `Bearer ${clientKey}` },
    });
    expect(adminBlockedRes.status).toBe(401);
    console.log(`[E2E] Verified: Client Key is strictly blocked from /admin routes (Status: 401)`);

    // 5. Model Whitelisting: Forbidden model is blocked with 403
    const forbiddenModelRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "unauthorized-model-xyz",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(forbiddenModelRes.status).toBe(403);
    console.log(`[E2E] Verified: Unauthorized model request strictly rejected (Status: 403)`);

    // 6. Record usage and verify quota tracking
    pool.recordUsage(clientKeyId, "gpt-5.4", { input_tokens: 500, output_tokens: 500 }, 1.5);
    const updatedInfo = await (
      await app.request("/v1/sub-key/info", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientKey}` },
      })
    ).json();
    expect(updatedInfo.used_cost_usd).toBe(1.5);
    expect(updatedInfo.remaining_budget_usd).toBe(8.5);
    expect(updatedInfo.used_tokens).toBe(1000);
    console.log(`[E2E] Verified: Usage recorded and quota reflected accurately (Used: $1.5, Rem: $8.5)`);
  });
});
