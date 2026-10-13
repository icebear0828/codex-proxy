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

const TEXT_SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(\b(?:authorization|proxy-authorization|x-api-key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|cookie|token)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
];

/** Redact credentials embedded in free-form error/provider text. */
export function redactText(value: string): string {
  let safe = value.replace(TEXT_SECRET_PATTERNS[0], "Bearer [REDACTED]");
  safe = safe.replace(TEXT_SECRET_PATTERNS[1], "$1[REDACTED]");
  for (const pattern of TEXT_SECRET_PATTERNS.slice(2)) safe = safe.replace(pattern, "[REDACTED]");
  return safe;
}

/** Apply text redaction recursively after key-based JSON redaction. */
export function redactTextValues(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated:max-depth]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((child) => redactTextValues(child, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactTextValues(child, depth + 1)]));
  }
  return value;
}

export function redactJson(value: unknown, depth = 0): JsonValue {
  // Tool parameter schemas are legitimately deep (Claude Code ships tools
  // whose input_schema nests 8+ levels). Depth 6 was cutting those to "***",
  // which made schema-related upstream 400s impossible to debug from logs.
  if (depth > 12) return "***";
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
