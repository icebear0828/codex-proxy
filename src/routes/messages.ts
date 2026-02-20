/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { SessionManager } from "../session/manager.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import {
  handleProxyRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

/**
 * Extract text from Anthropic message content for session hashing.
 */
function contentToString(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

const ANTHROPIC_FORMAT: FormatAdapter = {
  tag: "Messages",
  noAccountStatus: 529 as StatusCode,
  formatNoAccount: () =>
    makeError(
      "overloaded_error",
      "No available accounts. All accounts are expired or rate-limited.",
    ),
  format429: (msg) => makeError("rate_limit_error", msg),
  formatError: (_status, msg) => makeError("api_error", msg),
  streamTranslator: streamCodexToAnthropic,
  collectTranslator: collectCodexToAnthropicResponse,
};

export function createMessagesRoutes(
  accountPool: AccountPool,
  sessionManager: SessionManager,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check (x-api-key or Bearer token)
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const xApiKey = c.req.header("x-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = xApiKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    // Parse request
    const body = await c.req.json();
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    // Build session-compatible messages for multi-turn lookup
    const sessionMessages: Array<{ role: string; content: string }> = [];
    if (req.system) {
      const sysText =
        typeof req.system === "string"
          ? req.system
          : req.system.map((b) => b.text).join("\n");
      sessionMessages.push({ role: "system", content: sysText });
    }
    for (const msg of req.messages) {
      sessionMessages.push({
        role: msg.role,
        content: contentToString(msg.content),
      });
    }

    const codexRequest = translateAnthropicToCodexRequest(req);

    return handleProxyRequest(
      c,
      accountPool,
      sessionManager,
      cookieJar,
      {
        codexRequest,
        sessionMessages,
        model: req.model,
        isStreaming: req.stream,
      },
      ANTHROPIC_FORMAT,
    );
  });

  return app;
}
