/**
 * Fingerprint manager — builds headers that mimic the Codex Desktop client.
 *
 * Based on Codex source: applyDesktopAuthHeaders / buildDesktopUserAgent
 */

import { getConfig, getFingerprint, type AppConfig, type FingerprintConfig } from "../config.js";
import { extractChatGptAccountId } from "../auth/jwt-utils.js";
import type { AppContext } from "../context.js";

export type ClientProfile = "codex_cli" | "codex_desktop" | "opencode" | "pi" | "custom";

export interface ProfilePreset {
  originator: string;
  userAgentTemplate: string;
  includeBrowserHeaders: boolean;
}

export const PROFILE_PRESETS: Record<Exclude<ClientProfile, "custom">, ProfilePreset> = {
  codex_cli: {
    originator: "codex_cli_rs",
    userAgentTemplate: "codex_cli_rs/{version} ({platform} {arch})",
    includeBrowserHeaders: false,
  },
  codex_desktop: {
    originator: "Codex Desktop",
    userAgentTemplate: "Codex Desktop/{version} ({platform}; {arch})",
    includeBrowserHeaders: true,
  },
  opencode: {
    originator: "opencode",
    userAgentTemplate: "opencode/{version} ({platform} {arch})",
    includeBrowserHeaders: false,
  },
  pi: {
    originator: "pi",
    userAgentTemplate: "pi/{version} ({platform} {arch})",
    includeBrowserHeaders: false,
  },
};

/** Resolve config + fingerprint from optional context or fall back to singletons. */
function resolve(ctx?: AppContext): { config: AppConfig; fp: FingerprintConfig } {
  return {
    config: ctx?.config ?? getConfig(),
    fp: ctx?.fingerprint ?? getFingerprint(),
  };
}

function getProfile(config: AppConfig): ClientProfile {
  return config.client.profile ?? "codex_cli";
}

function resolveOriginator(config: AppConfig): string {
  const profile = getProfile(config);
  if (profile !== "custom" && profile in PROFILE_PRESETS) {
    return config.client.originator || PROFILE_PRESETS[profile].originator;
  }
  return config.client.originator || "codex_cli_rs";
}

function resolveUserAgent(config: AppConfig, fp: FingerprintConfig): string {
  const profile = getProfile(config);
  let template = fp.user_agent_template;
  if (profile !== "custom" && profile in PROFILE_PRESETS) {
    template = PROFILE_PRESETS[profile].userAgentTemplate;
  }
  return template
    .replace("{version}", config.client.app_version)
    .replace("{platform}", config.client.platform)
    .replace("{arch}", config.client.arch);
}

function shouldIncludeBrowserHeaders(config: AppConfig): boolean {
  const profile = getProfile(config);
  if (profile !== "custom" && profile in PROFILE_PRESETS) {
    return PROFILE_PRESETS[profile].includeBrowserHeaders;
  }
  return config.client.originator === "Codex Desktop";
}

/**
 * Reorder headers according to the fingerprint header_order config.
 * Keys not in the order list are appended at the end.
 */
function orderHeaders(
  headers: Record<string, string>,
  order: string[],
): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const key of order) {
    if (key in headers) {
      ordered[key] = headers[key];
    }
  }
  for (const key of Object.keys(headers)) {
    if (!(key in ordered)) {
      ordered[key] = headers[key];
    }
  }
  return ordered;
}

/**
 * Build the dynamic sec-ch-ua value based on chromium_version from config.
 */
function buildSecChUa(config: AppConfig): string {
  const cv = config.client.chromium_version;
  return `"Chromium";v="${cv}", "Not:A-Brand";v="24"`;
}

/**
 * Build raw headers (unordered) with all fingerprint fields.
 * Does NOT include Authorization, ChatGPT-Account-Id, Content-Type, or Accept.
 */
function buildRawDefaultHeaders(config: AppConfig, fp: FingerprintConfig): Record<string, string> {
  const raw: Record<string, string> = {};
  const includeBrowser = shouldIncludeBrowserHeaders(config);

  raw["User-Agent"] = resolveUserAgent(config, fp);
  if (includeBrowser) {
    raw["sec-ch-ua"] = buildSecChUa(config);
  }

  // Add static default headers (Accept-Encoding, Accept-Language, sec-fetch-*, etc.)
  if (fp.default_headers) {
    for (const [key, value] of Object.entries(fp.default_headers)) {
      if (!includeBrowser && key.toLowerCase().startsWith("sec-")) {
        continue;
      }
      raw[key] = value;
    }
  }

  return raw;
}

/**
 * Build anonymous headers for non-authenticated requests (OAuth, appcast, etc.).
 * Contains User-Agent, sec-ch-ua, Accept-Encoding, Accept-Language, sec-fetch-*
 * but NOT Authorization, Cookie, or ChatGPT-Account-Id.
 * Headers are ordered per fingerprint config.
 */
export function buildAnonymousHeaders(ctx?: AppContext): Record<string, string> {
  const { config, fp } = resolve(ctx);
  const raw = buildRawDefaultHeaders(config, fp);
  return orderHeaders(raw, fp.header_order);
}

export function buildHeaders(
  token: string,
  accountId?: string | null,
  ctx?: AppContext,
): Record<string, string> {
  const { config, fp } = resolve(ctx);
  const raw: Record<string, string> = {};

  raw["Authorization"] = `Bearer ${token}`;

  const acctId = accountId ?? extractChatGptAccountId(token);
  if (acctId) raw["ChatGPT-Account-Id"] = acctId;

  raw["originator"] = resolveOriginator(config);

  // Merge default headers (User-Agent, sec-ch-ua, Accept-Encoding, etc.)
  const defaults = buildRawDefaultHeaders(config, fp);
  for (const [key, value] of Object.entries(defaults)) {
    raw[key] = value;
  }

  return orderHeaders(raw, fp.header_order);
}

export function buildHeadersWithContentType(
  token: string,
  accountId?: string | null,
  ctx?: AppContext,
): Record<string, string> {
  const { config, fp } = resolve(ctx);
  const raw: Record<string, string> = {};

  raw["Authorization"] = `Bearer ${token}`;

  const acctId = accountId ?? extractChatGptAccountId(token);
  if (acctId) raw["ChatGPT-Account-Id"] = acctId;

  raw["originator"] = resolveOriginator(config);

  // Merge default headers
  const defaults = buildRawDefaultHeaders(config, fp);
  for (const [key, value] of Object.entries(defaults)) {
    raw[key] = value;
  }

  raw["Content-Type"] = "application/json";

  // Single orderHeaders call (no double-sorting)
  return orderHeaders(raw, fp.header_order);
}

