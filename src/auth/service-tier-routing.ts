import { getConfig } from "../config.js";

/** Missing tiers use the configured default, then the upstream standard tier. */
export function getServiceTierAccountRule(serviceTier?: string | null) {
  const config = getConfig();
  if (!config.auth.service_tier_routing) return undefined;
  const tier = serviceTier ?? config.model.default_service_tier ?? "default";
  const rules = config.auth.service_tier_routing;
  return Object.hasOwn(rules, tier) ? rules[tier] : undefined;
}

/** Exact model IDs; only explicit operator overrides supersede the client. */
export function getModelServiceTierOverride(model: string): string | undefined {
  const overrides = getConfig().model?.service_tier_overrides;
  return overrides && Object.hasOwn(overrides, model) ? overrides[model] : undefined;
}
