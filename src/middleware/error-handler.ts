import type { Context, Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { OpenAIErrorBody } from "../types/openai.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";

function makeOpenAIError(
  message: string,
  type: string,
  code: string | null,
): OpenAIErrorBody {
  return {
    error: {
      message,
      type,
      param: null,
      code,
    },
  };
}

function makeAnthropicError(
  message: string,
  errorType: AnthropicErrorType,
): AnthropicErrorBody {
  return { type: "error", error: { type: errorType, message } };
}

interface GeminiErrorBody {
  error: { code: number; message: string; status: string };
}

function makeGeminiError(
  code: number,
  message: string,
  status: string,
): GeminiErrorBody {
  return { error: { code, message, status } };
}

const GEMINI_STATUS_MAP: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "INTERNAL",
  503: "UNAVAILABLE",
};

export async function errorHandler(c: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[ErrorHandler]", message);

    const status = (err as { status?: number }).status;
    const path = c.req.path;

    // Anthropic Messages API errors
    if (path.startsWith("/v1/messages")) {
      if (status === 401) {
        c.status(401);
        return c.json(
          makeAnthropicError(
            "Invalid or expired token. Please re-authenticate.",
            "authentication_error",
          ),
        ) as never;
      }
      if (status === 429) {
        c.status(429);
        return c.json(
          makeAnthropicError(
            "Rate limit exceeded. Please try again later.",
            "rate_limit_error",
          ),
        ) as never;
      }
      if (status && status >= 500) {
        c.status(502);
        return c.json(
          makeAnthropicError(`Upstream server error: ${message}`, "api_error"),
        ) as never;
      }
      c.status(500);
      return c.json(makeAnthropicError(message, "api_error")) as never;
    }

    // Gemini API errors
    if (path.startsWith("/v1beta/")) {
      const code = status ?? 500;
      const geminiStatus = GEMINI_STATUS_MAP[code] ?? "INTERNAL";
      c.status((code >= 400 && code < 600 ? code : 500) as StatusCode);
      return c.json(makeGeminiError(code, message, geminiStatus)) as never;
    }

    // Default: OpenAI-format errors
    if (status === 401) {
      c.status(401);
      return c.json(
        makeOpenAIError(
          "Invalid or expired ChatGPT token. Please re-authenticate.",
          "invalid_request_error",
          "invalid_api_key",
        ),
      ) as never;
    }

    if (status === 429) {
      c.status(429);
      return c.json(
        makeOpenAIError(
          "Rate limit exceeded. Please try again later.",
          "rate_limit_error",
          "rate_limit_exceeded",
        ),
      ) as never;
    }

    if (status && status >= 500) {
      c.status(502);
      return c.json(
        makeOpenAIError(
          `Upstream server error: ${message}`,
          "server_error",
          "server_error",
        ),
      ) as never;
    }

    c.status(500);
    return c.json(
      makeOpenAIError(message, "server_error", "internal_error"),
    ) as never;
  }
}
