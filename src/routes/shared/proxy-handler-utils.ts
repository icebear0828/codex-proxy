import { CodexApi } from "../../proxy/codex-api.js";
import type { CookieJar } from "../../proxy/cookie-jar.js";
import type { CodexFingerprintMode } from "../../auth/types.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";
import { calculateUsageCostUsd, loadPricingCatalog, resolveModelPricing } from "../../auth/usage-pricing.js";

let pricingCatalog: ReturnType<typeof loadPricingCatalog> | null = null;

function getPricingCatalog(): ReturnType<typeof loadPricingCatalog> {
  pricingCatalog ??= loadPricingCatalog();
  return pricingCatalog;
}

/** Attach the model and local official-price estimate before account release. */
export function annotateUsageCost(model: string | undefined, usage: UsageInfo | undefined): UsageInfo | undefined {
  if (!usage) return undefined;
  if (!model) return usage;
  let estimatedCost = 0;
  try {
    const catalog = getPricingCatalog();
    if (!resolveModelPricing(model, catalog)) return usage;
    estimatedCost = calculateUsageCostUsd(model, usage, catalog);
  } catch (err) {
    // Test fixtures and minimal deployments may not ship the optional catalog.
    // Preserve the legacy release payload until pricing data is available.
    if (err instanceof Error && !err.message.includes("ENOENT")) {
      console.warn(`[UsagePricing] Failed to calculate cost for model ${model}:`, err.message);
    }
    return usage;
  }
  return { ...usage, model, estimated_cost_usd: estimatedCost };
}

/** Strip CodexApiError's "Codex API error (NNN): " prefix so log warns that
 *  already include status= don't duplicate it inside the message body. */
export function stripCodexErrorPrefix(msg: string): string {
  return msg.replace(/^Codex API error \(\d+\): /, "");
}

/** Annotate a usage payload with image_generation attempt outcome before
 *  releasing the account, so `recordUsage` can split it into success vs failed
 *  counters. Synthesizes a usage object when the failure path has none. */
export function annotateImageGenOutcome(
  usage: UsageInfo | undefined,
  expectsImageGen: boolean | undefined,
): UsageInfo | undefined {
  if (!expectsImageGen) return usage;
  const succeeded = (usage?.image_output_tokens ?? 0) > 0;
  if (usage) {
    return { ...usage, image_request_attempted: true, image_request_succeeded: succeeded };
  }
  return {
    input_tokens: 0,
    output_tokens: 0,
    image_request_attempted: true,
    image_request_succeeded: false,
  };
}

export function buildCodexApi(
  token: string,
  accountId: string | null,
  cookieJar: CookieJar | undefined,
  entryId: string,
  proxyPool?: ProxyPool,
  codexFingerprintMode: CodexFingerprintMode = "off",
): CodexApi {
  const proxyUrl = proxyPool?.resolveProxyUrl(entryId);
  return new CodexApi(
    token,
    accountId,
    cookieJar,
    entryId,
    proxyUrl,
    undefined,
    undefined,
    { codexFingerprintMode },
  );
}

export function validateClientKeyModel(
  c: import("hono").Context,
  model: string,
): { allowed: boolean; message?: string } {
  const role = c.get("authRole");
  if (role !== "client_key") {
    return { allowed: true };
  }

  const clientKey = c.get("clientKey") as import("../../auth/client-key-types.js").ClientKeyEntry | undefined;
  if (!clientKey || !clientKey.allowed_models || clientKey.allowed_models.length === 0) {
    return { allowed: true };
  }

  if (clientKey.allowed_models.includes(model)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    message: `Model '${model}' is not in the allowed model list for this client key`,
  };
}

export function recordClientKeyUsage(
  c: import("hono").Context,
  model: string,
  usage?: Partial<UsageInfo>,
  costUsd?: number,
): void {
  const role = c.get("authRole");
  if (role !== "client_key") return;

  const clientKey = c.get("clientKey") as import("../../auth/client-key-types.js").ClientKeyEntry | undefined;
  const pool = c.get("clientKeyPool") as import("../../auth/client-key-pool.js").ClientKeyPool | undefined;
  if (!clientKey || !pool) return;

  pool.recordUsage(
    clientKey.id,
    model,
    {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cached_tokens: usage?.cached_tokens ?? 0,
    },
    costUsd,
  );
}

