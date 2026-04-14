type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const SECRET_KEY_RE = /(authorization|x-api-key|api_key|apikey|token|refresh_token|access_token|cookie|set-cookie|session|secret)/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function redactString(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function redactJson(value: unknown, depth = 0): JsonValue {
  if (depth > 6) return "***";
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        if (typeof v === "string") out[key] = redactString(v);
        else out[key] = "***";
      } else if (key.toLowerCase() === "headers" && isRecord(v)) {
        const headersOut: Record<string, JsonValue> = {};
        for (const [hKey, hVal] of Object.entries(v)) {
          if (SECRET_KEY_RE.test(hKey)) {
            headersOut[hKey] = typeof hVal === "string" ? redactString(hVal) : "***";
          } else {
            headersOut[hKey] = redactJson(hVal, depth + 1);
          }
        }
        out[key] = headersOut;
      } else {
        out[key] = redactJson(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
