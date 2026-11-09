/**
 * Admin routes for the safety-policy guard.
 *
 * GET  /admin/policy-guard-settings      — current config
 * POST /admin/policy-guard-settings      — update config in local.yaml
 * GET  /admin/policy-guard-quarantines   — conversations currently refused locally
 * POST /admin/policy-guard-quarantines/reset — release one conversation (or all)
 *
 * Auth is the global `dashboardAuth` middleware mounted in `src/index.ts`, so
 * these routes must NOT add a bearer-only guard: that is what broke cookie
 * sessions for other admin endpoints (see the error-logs auth regression test).
 *
 * The quarantine list is the operational half of this feature. A pattern list
 * supplied by the operator will produce false positives, and a false positive
 * cannot be released by editing the conversation (there is nothing wrong with
 * it), so without a visible list and a manual release the only ways out would
 * be waiting for the TTL or restarting the process.
 */

import { Hono } from "hono";
import { getConfig, getLocalConfigPath, reloadAllConfigs } from "../../config.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import {
  listConversationQuarantines,
  resetConversationQuarantine,
} from "../../proxy/conversation-quarantine.js";

/** Bound the error text echoed to the dashboard. */
const MAX_MESSAGE_CHARS = 500;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim().length > 0);
}

export function createPolicyGuardRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/policy-guard-settings", (c) => {
    const config = getConfig();
    return c.json({
      enabled: config.policy_guard.enabled,
      error_codes: config.policy_guard.error_codes,
      message_patterns: config.policy_guard.message_patterns,
      status_codes: config.policy_guard.status_codes,
      ttl_seconds: config.policy_guard.ttl_seconds,
    });
  });

  app.post("/admin/policy-guard-settings", async (c) => {
    const body = await c.req.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      c.status(400);
      return c.json({ error: "Request body must be an object" });
    }
    const patch = body as Record<string, unknown>;

    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      c.status(400);
      return c.json({ error: "enabled must be a boolean" });
    }
    if (patch.error_codes !== undefined && !isStringArray(patch.error_codes)) {
      c.status(400);
      return c.json({ error: "error_codes must be an array of non-empty strings" });
    }
    if (patch.message_patterns !== undefined && !isStringArray(patch.message_patterns)) {
      c.status(400);
      return c.json({ error: "message_patterns must be an array of non-empty strings" });
    }
    if (patch.status_codes !== undefined) {
      if (!Array.isArray(patch.status_codes)) {
        c.status(400);
        return c.json({ error: "status_codes must be an array" });
      }
      const bad = patch.status_codes.find(
        (v) => !Number.isInteger(v) || (v as number) < 100 || (v as number) > 599,
      );
      if (bad !== undefined) {
        c.status(400);
        return c.json({ error: "status_codes entries must be HTTP status codes (100-599)" });
      }
    }
    if (patch.ttl_seconds !== undefined) {
      if (!Number.isSafeInteger(patch.ttl_seconds) || (patch.ttl_seconds as number) < 1) {
        c.status(400);
        return c.json({ error: "ttl_seconds must be a positive integer" });
      }
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.policy_guard) data.policy_guard = {};
      const guard = data.policy_guard as Record<string, unknown>;
      if (patch.enabled !== undefined) guard.enabled = patch.enabled;
      if (patch.error_codes !== undefined) guard.error_codes = patch.error_codes;
      if (patch.message_patterns !== undefined) guard.message_patterns = patch.message_patterns;
      if (patch.status_codes !== undefined) guard.status_codes = patch.status_codes;
      if (patch.ttl_seconds !== undefined) guard.ttl_seconds = patch.ttl_seconds;
    });
    reloadAllConfigs();

    // Both consumers read config per call, so the new values apply immediately:
    // `policy-rejection.ts` on the next error classification, and
    // `conversation-quarantine.ts` on the next TTL check.
    return c.json({ success: true, config: getConfig().policy_guard });
  });

  app.get("/admin/policy-guard-quarantines", (c) => {
    const now = Date.now();
    const quarantines = listConversationQuarantines(now).map((entry) => ({
      conversation_id: entry.conversationId,
      code: entry.code,
      message: entry.message.slice(0, MAX_MESSAGE_CHARS),
      recorded_at: new Date(entry.recordedAt).toISOString(),
      age_seconds: Math.round((now - entry.recordedAt) / 1000),
    }));
    return c.json({ enabled: getConfig().policy_guard.enabled, quarantines });
  });

  app.post("/admin/policy-guard-quarantines/reset", async (c) => {
    const body = await c.req.json() as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      c.status(400);
      return c.json({ error: "Request body must be an object" });
    }
    const { conversation_id: conversationId, all } = body as {
      conversation_id?: unknown;
      all?: unknown;
    };

    if (all === true) {
      const released = listConversationQuarantines();
      for (const entry of released) resetConversationQuarantine(entry.conversationId);
      return c.json({ success: true, released: released.length });
    }
    if (typeof conversationId !== "string" || !conversationId) {
      c.status(400);
      return c.json({ error: "conversation_id must be a non-empty string, or all must be true" });
    }
    resetConversationQuarantine(conversationId);
    return c.json({ success: true, released: 1 });
  });

  return app;
}
