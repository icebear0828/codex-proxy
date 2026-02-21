import { Hono } from "hono";
import { ChatCompletionRequestSchema } from "../types/openai.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { SessionManager } from "../session/manager.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import { translateToCodexRequest } from "../translation/openai-to-codex.js";
import {
  streamCodexToOpenAI,
  collectCodexResponse,
} from "../translation/codex-to-openai.js";
import { getConfig } from "../config.js";
import {
  handleProxyRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";

const OPENAI_FORMAT: FormatAdapter = {
  tag: "Chat",
  noAccountStatus: 503,
  formatNoAccount: () => ({
    error: {
      message:
        "No available accounts. All accounts are expired or rate-limited.",
      type: "server_error",
      param: null,
      code: "no_available_accounts",
    },
  }),
  format429: (msg) => ({
    error: {
      message: msg,
      type: "rate_limit_error",
      param: null,
      code: "rate_limit_exceeded",
    },
  }),
  formatError: (_status, msg) => ({
    error: {
      message: msg,
      type: "server_error",
      param: null,
      code: "codex_api_error",
    },
  }),
  streamTranslator: streamCodexToOpenAI,
  collectTranslator: collectCodexResponse,
};

export function createChatRoutes(
  accountPool: AccountPool,
  sessionManager: SessionManager,
  cookieJar?: CookieJar,
): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      return c.json({
        error: {
          message: "Not authenticated. Please login first at /",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    // Optional proxy API key check
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const authHeader = c.req.header("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");
      if (
        !providedKey ||
        !accountPool.validateProxyApiKey(providedKey)
      ) {
        c.status(401);
        return c.json({
          error: {
            message: "Invalid proxy API key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        });
      }
    }

    // Parse request
    const body = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({
        error: {
          message: `Invalid request: ${parsed.error.message}`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      });
    }
    const req = parsed.data;

    const codexRequest = translateToCodexRequest(req);

    return handleProxyRequest(
      c,
      accountPool,
      sessionManager,
      cookieJar,
      {
        codexRequest,
        sessionMessages: req.messages.map((m) => ({
          role: m.role,
          content: typeof m.content === "string"
            ? m.content
            : m.content.filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("\n"),
        })),
        model: codexRequest.model,
        isStreaming: req.stream,
      },
      OPENAI_FORMAT,
    );
  });

  return app;
}
