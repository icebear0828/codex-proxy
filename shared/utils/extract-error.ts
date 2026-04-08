/**
 * Extract a human-readable error message from an API error response body.
 *
 * Handles both formats:
 *  - Admin endpoints (flat):   { error: "message" }
 *  - OpenAI error handler:     { error: { message: "..." } }
 */
export function extractErrorMessage(
  body: unknown,
  fallback: string,
): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && "message" in err) {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
  }
  return fallback;
}
