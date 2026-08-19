/**
 * OpenAI-compatible embeddings route.
 *
 * Embeddings are only supported through runtime API keys whose capabilities
 * explicitly include "embeddings". Codex accounts are not used for this path.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AccountPool } from "../auth/account-pool.js";
import type { ApiKeyEntry, ApiKeyPool } from "../auth/api-key-pool.js";
import { getConfig } from "../config.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { withFetchDispatcher } from "../proxy/fetch-dispatcher.js";
import type { ClientKeyPool } from "../auth/client-key-pool.js";
import { validateClientKeyModel, recordClientKeyUsage } from "./shared/proxy-handler-utils.js";

const EmbeddingInputSchema = z.union([
  z.string(),
  z.array(z.string()).min(1),
  z.array(z.number()).min(1),
  z.array(z.array(z.number()).min(1)).min(1),
]);

const EmbeddingsRequestSchema = z.object({
  model: z.string().trim().min(1),
  input: EmbeddingInputSchema,
  encoding_format: z.enum(["float", "base64"]).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
}).passthrough();

type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;

function openAIError(message: string, code: string, param: string | null = null) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param,
      code,
    },
  };
}



function supportsOpenAIEmbeddings(entry: ApiKeyEntry): boolean {
  if (entry.provider === "openai" || entry.provider === "openrouter") return true;
  return entry.provider === "custom" && (entry.wire === "chat" || entry.wire === "responses");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function modelCandidates(model: string): string[] {
  const trimmed = model.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx <= 0) return [trimmed];

  const providerPrefix = trimmed.slice(0, colonIdx);
  if (
    providerPrefix === "openai" ||
    providerPrefix === "openrouter" ||
    providerPrefix === "custom" ||
    providerPrefix === "anthropic" ||
    providerPrefix === "gemini"
  ) {
    return [trimmed, trimmed.slice(colonIdx + 1)];
  }

  return [trimmed];
}

function resolveEmbeddingEntry(pool: ApiKeyPool, model: string): { entry: ApiKeyEntry; upstreamModel: string } | null {
  for (const candidate of modelCandidates(model)) {
    const entry = pool.acquireByModelAndCapability(candidate, "embeddings");
    if (entry) return { entry, upstreamModel: candidate };
  }
  return null;
}



function buildUpstreamRequestBody(req: EmbeddingsRequest, upstreamModel: string): EmbeddingsRequest {
  return {
    ...req,
    model: upstreamModel,
  };
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type") ?? upstream.headers.get("content-type");
  headers.set("Content-Type", contentType ?? "application/json");
  return headers;
}

export function createEmbeddingsRoutes(
  accountPool: AccountPool,
  apiKeyPool: ApiKeyPool,
  clientKeyPool?: ClientKeyPool,
): Hono {
  const app = new Hono();

  app.post("/v1/embeddings", apiKeyAuth(accountPool, clientKeyPool), async (c) => {
    const body = await c.req.json();
    const parsed = EmbeddingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(openAIError(`Invalid request: ${parsed.error.message}`, "invalid_request"));
    }

    const modelCheck = validateClientKeyModel(c, parsed.data.model);
    if (!modelCheck.allowed) {
      c.status(403);
      return c.json(openAIError(modelCheck.message || "Model not allowed", "model_not_allowed", "model"));
    }

    const resolved = resolveEmbeddingEntry(apiKeyPool, parsed.data.model);
    if (!resolved) {
      c.status(404);
      return c.json(openAIError(`Model '${parsed.data.model}' not found for embeddings`, "model_not_found", "model"));
    }

    if (!supportsOpenAIEmbeddings(resolved.entry)) {
      c.status(400);
      return c.json(openAIError(
        `Provider '${resolved.entry.provider}' does not support OpenAI-compatible embeddings`,
        "unsupported_provider",
        "model",
      ));
    }

    const upstream = await fetch(`${normalizeBaseUrl(resolved.entry.baseUrl)}/embeddings`, withFetchDispatcher({
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resolved.entry.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(buildUpstreamRequestBody(parsed.data, resolved.upstreamModel)),
      signal: c.req.raw.signal,
    }));

    const text = await upstream.text();
    if (upstream.ok) {
      try {
        const parsedJson = JSON.parse(text) as { usage?: { prompt_tokens?: number } };
        if (parsedJson.usage?.prompt_tokens) {
          recordClientKeyUsage(c, parsed.data.model, {
            input_tokens: parsedJson.usage.prompt_tokens,
            output_tokens: 0,
          });
        }
      } catch {
        // ignore parse error
      }
    }

    return new Response(text, {
      status: upstream.status,
      headers: copyResponseHeaders(upstream),
    });
  });

  return app;
}
