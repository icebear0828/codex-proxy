/**
 * Images API 与 Codex Responses image_generation 工具之间的转换。
 *
 * 这里不负责账号领取、重试或响应写回；这些生命周期统一由 proxy-handler
 * 负责，避免 Images 兼容层复制一套上游编排。
 */

import { z } from "zod";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import type { CodexResponsesRequest } from "../../proxy/codex-api.js";
import {
  iterateCodexEvents,
  type ExtractedEvent,
  type UsageInfo,
} from "../../translation/codex-event-extractor.js";
import { codexApiErrorFromEvent } from "../../translation/codex-api-error-from-event.js";
import type {
  FormatCollectTranslatorResult,
  ResponseMetadata,
} from "./proxy-handler-types.js";

const IMAGE_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "2048x2048",
  "2048x3072",
  "3072x2048",
  "3840x2160",
  "2160x3840",
  "2304x3072",
  "auto",
] as const;

const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_BACKGROUNDS = ["auto", "opaque"] as const;
const IMAGE_MODERATION_LEVELS = ["auto", "low"] as const;

const ImageResponseFormatSchema = z.union([
  z.literal("b64_json"),
  z.object({ type: z.literal("b64_json") }),
]);

/** Images generations 的最小兼容请求。未知字段保留在解析结果中但不会转发。 */
export const ImageGenerationRequestSchema = z.object({
  model: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  size: z.enum(IMAGE_SIZES).optional(),
  quality: z.enum(["standard", "hd"]).optional(),
  output_format: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  background: z.enum(IMAGE_BACKGROUNDS).optional(),
  moderation: z.enum(IMAGE_MODERATION_LEVELS).optional(),
  partial_images: z.number().int().min(0).max(3).optional(),
  n: z.literal(1).optional(),
  response_format: ImageResponseFormatSchema.optional(),
  /** Images generations 本身只返回完整 JSON，不提供 SSE。 */
  stream: z.literal(false).optional(),
}).passthrough();

export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;

export const IMAGE_GENERATION_FAILED_CODE = "image_generation_failed";
export const IMAGE_GENERATION_EMPTY_RESULT_MESSAGE =
  "Upstream returned no image_generation_call.result";

export class ImageGenerationEmptyResultError extends Error {
  readonly code = IMAGE_GENERATION_FAILED_CODE;

  constructor() {
    super(IMAGE_GENERATION_EMPTY_RESULT_MESSAGE);
    this.name = "ImageGenerationEmptyResultError";
  }
}

/**
 * 将 Images 请求转换为 Codex Responses 请求。
 * `hostModel` 必须来自显式服务端配置；客户端传入的 gpt-image-2 只是
 * Images API 的模型标识，不能作为 Codex 宿主聊天模型发送。
 */
export function buildImageGenerationCodexRequest(
  request: ImageGenerationRequest,
  hostModel: string,
): CodexResponsesRequest {
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    size: request.size ?? "auto",
    output_format: request.output_format ?? "png",
  };
  if (request.output_compression !== undefined) {
    imageTool.output_compression = request.output_compression;
  }
  if (request.background !== undefined) imageTool.background = request.background;
  if (request.moderation !== undefined) imageTool.moderation = request.moderation;
  if (request.partial_images !== undefined) imageTool.partial_images = request.partial_images;

  return {
    model: hostModel,
    instructions: "",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: request.prompt }],
    }],
    stream: true,
    store: false,
    tools: [imageTool],
    ...(process.env.CODEX_PROXY_DISABLE_WS !== "1" ? { useWebSocket: true } : {}),
  };
}

interface ImageGenerationCall {
  result: string;
  revised_prompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseImageGenerationCall(value: unknown): ImageGenerationCall | null {
  if (!isRecord(value) || value.type !== "image_generation_call") return null;
  if (typeof value.result !== "string" || value.result.length === 0) return null;
  return {
    result: value.result,
    ...(typeof value.revised_prompt === "string" ? { revised_prompt: value.revised_prompt } : {}),
  };
}

function extractCompletedOutputImage(event: ExtractedEvent): ImageGenerationCall | null {
  if (event.typed.type !== "response.completed") return null;
  const response = event.typed.response;
  if (!isRecord(response) || !Array.isArray(response.output)) {
    return null;
  }
  for (const item of response.output) {
    const call = parseImageGenerationCall(item);
    if (call) return call;
  }
  return null;
}

/**
 * 收集 Responses SSE 中的最终图片结果并包装成标准 Images JSON。
 * partial_image 事件刻意不向客户端单独暴露：Images generations 是非流式接口，
 * 但请求参数仍会透传给上游，让上游按客户端意图生成完整结果。
 */
export async function collectImageGenerationResponse(options: {
  api: UpstreamAdapter;
  response: Response;
  onResponseMetadata?: (metadata: ResponseMetadata) => void;
}): Promise<FormatCollectTranslatorResult> {
  let responseId: string | null = null;
  let usage: UsageInfo = { input_tokens: 0, output_tokens: 0 };
  let image: ImageGenerationCall | null = null;
  let responseCompleted = false;

  for await (const event of iterateCodexEvents(options.api, options.response)) {
    if (event.responseId) responseId = event.responseId;
    if (event.usage) usage = event.usage;
    if (event.error) throw codexApiErrorFromEvent(event.error);

    if (event.typed.type === "response.output_item.done" && !responseCompleted) {
      const eventImage = event.imageGenerationDone;
      if (eventImage && eventImage.result.length > 0 && image === null) {
        image = eventImage;
      }
    }
    if (event.typed.type === "response.completed") {
      responseCompleted = true;
      const response = event.typed.response;
      // Real upstream `response.completed` events routinely carry an empty
      // `output: []` even for a fully successful image generation — the
      // actual image only ever appears once, on the earlier
      // `output_item.done` event (confirmed against the live Codex Responses
      // API; see PR discussion). An empty/missing output array therefore
      // means "not repeated here", not "explicitly no image" — it must NOT
      // clear an already-found result.
      // A *non-empty* output array is authoritative, though: if upstream
      // bothers to enumerate the final items and none of them is an image,
      // that is a genuine failure signal and must override any earlier
      // (now known stale) output_item.done result.
      if (isRecord(response) && Array.isArray(response.output) && response.output.length > 0) {
        image = extractCompletedOutputImage(event);
      }
    }
  }

  // An image item before the terminal event is only an intermediate result.
  // Never return it as a successful Images response when the upstream stream
  // was truncated or ended without response.completed.
  if (!responseCompleted || !image || image.result.length === 0) {
    throw new ImageGenerationEmptyResultError();
  }

  return {
    response: {
      created: Math.floor(Date.now() / 1000),
      data: [{
        b64_json: image.result,
        ...(image.revised_prompt !== undefined ? { revised_prompt: image.revised_prompt } : {}),
      }],
    },
    usage: { ...usage, image_request_succeeded: true },
    responseId,
  };
}

export function isImageGenerationRequest(value: unknown): value is ImageGenerationRequest {
  return ImageGenerationRequestSchema.safeParse(value).success;
}
