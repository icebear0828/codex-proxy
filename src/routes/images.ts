/**
 * POST /v1/images/generations — OpenAI Images API 兼容入口。
 *
 * Images 请求在这里转换成 Codex Responses 的 image_generation 工具调用，
 * 再交给共享 proxy-handler 负责账号、WebSocket、重试、用量和释放。
 */

import { Hono, type Context } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { getConfig } from "../config.js";
import { resolveRoutableCodexHostModel } from "../models/routable-model-resolver.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import { errorHandler } from "../middleware/error-handler.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { handleProxyRequest } from "./shared/proxy-handler.js";
import { validateClientKeyModel } from "./shared/proxy-handler-utils.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import {
  buildImageGenerationCodexRequest,
  collectImageGenerationResponse,
  IMAGE_GENERATION_EMPTY_RESULT_MESSAGE,
  IMAGE_GENERATION_FAILED_CODE,
  ImageGenerationRequestSchema,
} from "./shared/image-generation.js";

function formatImagesError(status: number, message: string): unknown {
  const isImageFailure = message === IMAGE_GENERATION_EMPTY_RESULT_MESSAGE;
  const isRateLimit = status === 429;
  return {
    error: {
      message,
      type: isRateLimit
        ? "rate_limit_error"
        : status >= 400 && status < 500
          ? "invalid_request_error"
          : "server_error",
      param: null,
      code: isImageFailure
        ? IMAGE_GENERATION_FAILED_CODE
        : isRateLimit
          ? "rate_limit_exceeded"
          : status >= 500
            ? "codex_api_error"
            : "invalid_request",
    },
  };
}

const IMAGES_FORMAT: FormatAdapter = {
  tag: "Images",
  noAccountStatus: 503,
  formatNoAccount: () => formatImagesError(503, "No available accounts. All accounts are expired or rate-limited."),
  format429: (message) => formatImagesError(429, message),
  formatError: (status, message) => formatImagesError(status, message),
  async *streamTranslator() {
    throw new Error("Images generations does not support streaming responses");
  },
  collectTranslator: ({ api, response, onResponseMetadata }) =>
    collectImageGenerationResponse({ api, response, onResponseMetadata }),
};

function invalidRequest(c: Context, message: string): Response {
  c.status(400);
  return c.json(formatImagesError(400, message));
}

export const IMAGE_HOST_MODEL_INVALID_CODE = "image_host_model_invalid";

function formatImagesConfigurationError(c: Context, model: string): Response {
  c.status(500);
  return c.json({
    error: {
      message: `Configured model.image_host_model "${model}" must be a routable Codex chat model and cannot be gpt-image-2`,
      type: "server_error",
      param: "model.image_host_model",
      code: IMAGE_HOST_MODEL_INVALID_CODE,
    },
  });
}

function notAuthenticated(c: Context): Response {
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

export function createImagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  clientKeyPool?: ClientKeyPool,
): Hono {
  const app = new Hono();
  app.onError(errorHandler);

  const imagesHandler = async (c: Context): Promise<Response> => {
    const rawBody: unknown = await c.req.json();
    const parsed = ImageGenerationRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return invalidRequest(c, `Invalid request: ${parsed.error.message}`);
    }

    const request = parsed.data;
    const modelCheck = validateClientKeyModel(c, request.model);
    if (!modelCheck.allowed) {
      c.status(403);
      return c.json({
        error: {
          message: modelCheck.message ?? "Model not allowed for this client key",
          type: "invalid_request_error",
          param: "model",
          code: "model_not_allowed",
        },
      });
    }

    const effectiveOutputFormat = request.output_format ?? "png";
    if (effectiveOutputFormat === "png" && request.output_compression !== undefined && request.output_compression !== 100) {
      return invalidRequest(c, "output_compression must be 100 when output_format is png");
    }

    if (!accountPool.isAuthenticated()) {
      return notAuthenticated(c);
    }

    const configuredHostModel = getConfig().model.image_host_model ?? "gpt-5.5";
    const hostModel = resolveRoutableCodexHostModel(configuredHostModel);
    if (!hostModel) {
      return formatImagesConfigurationError(c, configuredHostModel);
    }
    const codexRequest = buildImageGenerationCodexRequest(request, hostModel);
    const proxyReq: ProxyRequest = {
      codexRequest,
      // req.model controls account-plan routing and diagnostics. It must be the
      // configured Codex host model, never the client-only gpt-image-2 name.
      model: hostModel,
      isStreaming: false,
      expectsImageGen: true,
    };

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: request.model,
      stream: false,
      request: summarizeRequestForLog("images", request, {
        ip: getRealClientIp(c, getConfig().server.trust_proxy),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    return handleProxyRequest({
      c,
      accountPool,
      cookieJar,
      req: proxyReq,
      fmt: IMAGES_FORMAT,
      proxyPool,
    });
  };

  app.post("/v1/images/generations", apiKeyAuth(accountPool, clientKeyPool), imagesHandler);
  app.post("/images/generations", apiKeyAuth(accountPool, clientKeyPool), imagesHandler);
  return app;
}

export { IMAGES_FORMAT, formatImagesError };
