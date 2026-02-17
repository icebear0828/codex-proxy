import type { Context, Next } from "hono";
import type { OpenAIErrorBody } from "../types/openai.js";

function makeError(
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

export async function errorHandler(c: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[ErrorHandler]", message);

    const status = (err as { status?: number }).status;

    if (status === 401) {
      c.status(401);
      return c.json(
        makeError(
          "Invalid or expired ChatGPT token. Please re-authenticate.",
          "invalid_request_error",
          "invalid_api_key",
        ),
      ) as never;
    }

    if (status === 429) {
      c.status(429);
      return c.json(
        makeError(
          "Rate limit exceeded. Please try again later.",
          "rate_limit_error",
          "rate_limit_exceeded",
        ),
      ) as never;
    }

    if (status && status >= 500) {
      c.status(502);
      return c.json(
        makeError(
          `Upstream server error: ${message}`,
          "server_error",
          "server_error",
        ),
      ) as never;
    }

    c.status(500);
    return c.json(
      makeError(message, "server_error", "internal_error"),
    ) as never;
  }
}
