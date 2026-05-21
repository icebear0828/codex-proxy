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
import type { ApiKeyProvider } from "../auth/api-key-catalog.js";
import { getConfig } from "../config.js";
import { withFetchDispatcher } from "../proxy/fetch-dispatcher.js";

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

function invalidProxyApiKeyResponse(c: Context): Response {
  c.status(401);
  return c.json(openAIError("Invalid proxy API key", "invalid_api_key"));
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function checkProxyApiKey(c: Context, accountPool: AccountPool): Response | null {
  const config = getConfig();
  if (!config.server.proxy_api_key) return null;

  const providedKey = c.req.header("x-api-key") ?? extractBearerToken(c.req.header("Authorization"));
  if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
    return invalidProxyApiKeyResponse(c);
  }

  return null;
}

function supportsOpenAIEmbeddings(provider: ApiKeyProvider): boolean {
  return provider === "openai" || provider === "openrouter" || provider === "custom";
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

async function parseEmbeddingsRequest(c: Context): Promise<
  { ok: true; data: EmbeddingsRequest } | { ok: false; response: Response }
> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.status(400);
    return { ok: false, response: c.json(openAIError("Malformed JSON request body", "invalid_json")) };
  }

  const parsed = EmbeddingsRequestSchema.safeParse(body);
  if (!parsed.success) {
    c.status(400);
    return {
      ok: false,
      response: c.json(openAIError(`Invalid request: ${parsed.error.message}`, "invalid_request")),
    };
  }

  return { ok: true, data: parsed.data };
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

export function createEmbeddingsRoutes(accountPool: AccountPool, apiKeyPool: ApiKeyPool): Hono {
  const app = new Hono();

  app.post("/v1/embeddings", async (c) => {
    const authError = checkProxyApiKey(c, accountPool);
    if (authError) return authError;

    const parsed = await parseEmbeddingsRequest(c);
    if (!parsed.ok) return parsed.response;

    const resolved = resolveEmbeddingEntry(apiKeyPool, parsed.data.model);
    if (!resolved) {
      c.status(404);
      return c.json(openAIError(`Model '${parsed.data.model}' not found for embeddings`, "model_not_found", "model"));
    }

    if (!supportsOpenAIEmbeddings(resolved.entry.provider)) {
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

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: copyResponseHeaders(upstream),
    });
  });

  return app;
}
