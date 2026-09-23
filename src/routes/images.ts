/**
 * POST /v1/images/generations 与 /v1/images/edits — OpenAI Images API 兼容入口。
 *
 * 这里是两条 Images 路由的唯一注册点，按模型路由分发：
 * - 模型命中 Codex Responses API-key provider（且该 adapter 声明 Codex JSON
 *   辅助能力）→ JSON 请求体透传给上游 `/images/generations`|`/images/edits`；
 * - 其余可路由模型（ChatGPT 账号 wire）→ 转换成 Codex Responses 的
 *   image_generation 工具调用（edits 以 input_image 携带参考图，Edit mode），
 *   交给共享 proxy-handler 负责账号、WebSocket、重试、用量和释放。
 *
 * edits 额外接受 multipart/form-data 文件上传（OpenAI Images 标准格式，
 * `image`/`image[]` 文件段）：入口统一转换为 Codex JSON 协议体后进入同一分发，
 * 两种模式共享同一转换。
 */

import { Hono, type Context } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import { getConfig } from "../config.js";
import { resolveRoutableCodexHostModel } from "../models/routable-model-resolver.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import { errorHandler } from "../middleware/error-handler.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { handleProxyRequest } from "./shared/proxy-handler.js";
import { validateClientKeyModel, recordClientKeyUsage } from "./shared/proxy-handler-utils.js";
import type { FormatAdapter, ProxyRequest } from "./shared/proxy-handler-types.js";
import { handleCodexAuxiliaryJson } from "./codex-auxiliary.js";
import { supportsCodexAuxiliaryJson } from "../proxy/upstream-adapter.js";
import {
  buildImageGenerationCodexRequest,
  buildImageEditCodexRequest,
  collectImageGenerationResponse,
  convertMultipartEditsBody,
  validateImagePngCompression,
  IMAGE_GENERATION_EMPTY_RESULT_MESSAGE,
  IMAGE_GENERATION_FAILED_CODE,
  ImageGenerationRequestSchema,
  ImageEditRequestSchema,
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelNotFound(c: Context, model: string): Response {
  c.status(404);
  return c.json({
    error: {
      message: `Model '${model}' not found`,
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  });
}

function modelNotRoutableForImages(c: Context, model: string): Response {
  c.status(400);
  return c.json({
    error: {
      message: `Model ${model} is not routed through a Codex Responses API-key provider`,
      type: "invalid_request_error",
      code: "unsupported_codex_auxiliary_route",
    },
  });
}

export type ImagesRouteKind = "generations" | "edits";

const IMAGES_AUX_PATH: Record<ImagesRouteKind, "images/generations" | "images/edits"> = {
  generations: "images/generations",
  edits: "images/edits",
};

/**
 * API-key 分支：与 Codex 辅助 JSON 透传语义完全一致——请求体逐字节保留
 * （仅解析模型别名/剥离 provider 前缀），上游状态与响应体原样返回。
 */
async function runApiKeyImagesPassthrough(
  c: Context,
  path: "images/generations" | "images/edits",
  rawBody: Record<string, unknown>,
  rawModel: string,
  upstream: UpstreamAdapter & Required<Pick<UpstreamAdapter, "forwardCodexJsonRequest">>,
  resolvedModel: string | undefined,
): Promise<Response> {
  const modelCheck = validateClientKeyModel(c, rawModel);
  if (!modelCheck.allowed) {
    c.status(403);
    return c.json({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "model_not_allowed",
        message: modelCheck.message,
        param: "model",
      },
    });
  }

  const directModel = resolvedModel ?? rawModel;
  const response = await handleCodexAuxiliaryJson({
    c,
    upstream,
    path,
    body: directModel === rawModel ? rawBody : { ...rawBody, model: directModel },
    model: directModel,
  });
  if (response.ok) {
    recordClientKeyUsage(c, rawModel, { input_tokens: 100, output_tokens: 100 });
  }
  return response;
}

export function createImagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  clientKeyPool?: ClientKeyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();
  app.onError(errorHandler);

  const finishAccountImages = async (
    c: Context,
    codexRequest: ProxyRequest["codexRequest"],
    clientModel: string,
    summaryBody: unknown,
  ): Promise<Response> => {
    const proxyReq: ProxyRequest = {
      codexRequest,
      // req.model controls account-plan routing and diagnostics. It must be the
      // configured Codex host model, never the client-only gpt-image-2 name.
      model: codexRequest.model,
      isStreaming: false,
      expectsImageGen: true,
    };

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: clientModel,
      stream: false,
      request: summarizeRequestForLog("images", summaryBody, {
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

  const resolveHostModel = (c: Context): string | Response => {
    const configuredHostModel = getConfig().model.image_host_model ?? "gpt-5.5";
    const hostModel = resolveRoutableCodexHostModel(configuredHostModel);
    if (!hostModel) return formatImagesConfigurationError(c, configuredHostModel);
    return hostModel;
  };

  const runAccountImages = async (c: Context, kind: ImagesRouteKind, rawBody: unknown): Promise<Response> => {
    if (kind === "generations") {
      const parsed = ImageGenerationRequestSchema.safeParse(rawBody);
      if (!parsed.success) return invalidRequest(c, `Invalid request: ${parsed.error.message}`);
      const modelCheck = validateClientKeyModel(c, parsed.data.model);
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
      const compressionError = validateImagePngCompression(parsed.data.output_format, parsed.data.output_compression);
      if (compressionError) return invalidRequest(c, compressionError);

      if (!accountPool.isAuthenticated()) return notAuthenticated(c);
      const hostModel = resolveHostModel(c);
      if (typeof hostModel !== "string") return hostModel;
      return finishAccountImages(c, buildImageGenerationCodexRequest(parsed.data, hostModel), parsed.data.model, parsed.data);
    }

    const parsed = ImageEditRequestSchema.safeParse(rawBody);
    if (!parsed.success) return invalidRequest(c, `Invalid request: ${parsed.error.message}`);
    const modelCheck = validateClientKeyModel(c, parsed.data.model);
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
    const compressionError = validateImagePngCompression(parsed.data.output_format, parsed.data.output_compression);
    if (compressionError) return invalidRequest(c, compressionError);

    if (!accountPool.isAuthenticated()) return notAuthenticated(c);
    const hostModel = resolveHostModel(c);
    if (typeof hostModel !== "string") return hostModel;
    return finishAccountImages(c, buildImageEditCodexRequest(parsed.data, hostModel), parsed.data.model, parsed.data);
  };

  const dispatchImagesRequest = async (c: Context, kind: ImagesRouteKind, rawBody: unknown): Promise<Response> => {
    const rawModel = isRecord(rawBody) ? nonEmptyString(rawBody.model) : null;

    if (rawModel && upstreamRouter) {
      const routeMatch = upstreamRouter.resolveMatch(rawModel);
      if (routeMatch.kind === "api-key" || routeMatch.kind === "adapter") {
        if (supportsCodexAuxiliaryJson(routeMatch.adapter)) {
          return runApiKeyImagesPassthrough(
            c,
            IMAGES_AUX_PATH[kind],
            rawBody as Record<string, unknown>,
            rawModel,
            routeMatch.adapter,
            routeMatch.resolvedModel,
          );
        }
        return modelNotRoutableForImages(c, rawModel);
      }
      if (routeMatch.kind === "codex") {
        return runAccountImages(c, kind, rawBody);
      }
      return modelNotFound(c, rawModel);
    }

    return runAccountImages(c, kind, rawBody);
  };

  const imagesHandler = (kind: ImagesRouteKind) => async (c: Context): Promise<Response> => {
    // multipart 仅用于 edits 文件上传：入口统一转换为 Codex JSON 协议体后走
    // 既有分发（API-key 上游收到 images[{image_url}]，账号模式收到 Edit mode
    // 转换），两种模式共享同一转换。
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (contentType.startsWith("multipart/form-data")) {
      if (kind !== "edits") {
        return invalidRequest(c, "multipart/form-data is only supported on /v1/images/edits; send JSON to /v1/images/generations");
      }
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return invalidRequest(c, "Malformed multipart/form-data body");
      }
      const converted = await convertMultipartEditsBody(form);
      if (!converted.ok) return invalidRequest(c, converted.error);
      return dispatchImagesRequest(c, kind, converted.body);
    }

    const rawBody: unknown = await c.req.json();
    return dispatchImagesRequest(c, kind, rawBody);
  };

  app.post("/v1/images/generations", apiKeyAuth(accountPool, clientKeyPool), imagesHandler("generations"));
  app.post("/images/generations", apiKeyAuth(accountPool, clientKeyPool), imagesHandler("generations"));
  app.post("/v1/images/edits", apiKeyAuth(accountPool, clientKeyPool), imagesHandler("edits"));
  app.post("/images/edits", apiKeyAuth(accountPool, clientKeyPool), imagesHandler("edits"));
  return app;
}

export { IMAGES_FORMAT, formatImagesError };
