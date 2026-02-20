import { CodexApiError } from "../proxy/codex-api.js";

/** Retry a function on 5xx errors with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxRetries = 2,
    baseDelayMs = 1000,
    tag = "Proxy",
  }: { maxRetries?: number; baseDelayMs?: number; tag?: string } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof CodexApiError && err.status >= 500 && err.status < 600;
      if (!isRetryable || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[${tag}] Retrying after ${err instanceof CodexApiError ? err.status : "error"} (attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms)`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
