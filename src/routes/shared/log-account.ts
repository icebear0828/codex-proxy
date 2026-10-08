import { createHash } from "crypto";
import type { ApiKeyEntry } from "../../auth/api-key-pool.js";

export function getApiKeyLogAccount(entry: ApiKeyEntry | null | undefined): string | undefined {
  if (!entry || entry.provider !== "antigravity") return undefined;
  return entry.label?.trim() || `AGY ${createHash("sha256").update(entry.apiKey).digest("hex").slice(0, 8)}`;
}
