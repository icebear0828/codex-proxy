export interface ProxyApiKeyRequestLike {
  header(name: string): string | undefined;
  query(name: string): string | undefined;
}

export type ProxyApiKeySource =
  | "authorization"
  | "x-api-key"
  | "api-key"
  | "x-goog-api-key"
  | "key"
  | "api_key";

export const OPENAI_PROXY_KEY_SOURCES: ProxyApiKeySource[] = [
  "authorization",
  "x-api-key",
  "api-key",
];

export const ANTHROPIC_PROXY_KEY_SOURCES: ProxyApiKeySource[] = [
  "x-api-key",
  "authorization",
  "api-key",
];

export const GEMINI_PROXY_KEY_SOURCES: ProxyApiKeySource[] = [
  "key",
  "x-goog-api-key",
  "authorization",
  "x-api-key",
  "api-key",
];

function extractAuthorizationToken(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match) {
    const token = match[1]?.trim();
    return token || null;
  }

  return trimmed;
}

export function extractProxyApiKey(
  req: ProxyApiKeyRequestLike,
  sources: readonly ProxyApiKeySource[],
): string | null {
  for (const source of sources) {
    switch (source) {
      case "authorization": {
        const token = extractAuthorizationToken(req.header("Authorization"));
        if (token) return token;
        break;
      }
      case "x-api-key": {
        const token = req.header("x-api-key")?.trim();
        if (token) return token;
        break;
      }
      case "api-key": {
        const token = req.header("api-key")?.trim();
        if (token) return token;
        break;
      }
      case "x-goog-api-key": {
        const token = req.header("x-goog-api-key")?.trim();
        if (token) return token;
        break;
      }
      case "key": {
        const token = req.query("key")?.trim();
        if (token) return token;
        break;
      }
      case "api_key": {
        const token = req.query("api_key")?.trim();
        if (token) return token;
        break;
      }
    }
  }

  return null;
}
