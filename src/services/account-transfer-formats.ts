import type { AccountEntry, CodexQuotaWindow } from "../auth/types.js";
import { decodeJwtPayload } from "../auth/jwt-utils.js";
import type { ImportEntry } from "./account-import.js";

export type AccountExportFormat = "full" | "minimal" | "cockpit_tools" | "sub2api" | "cpa";

type JsonRecord = Record<string, unknown>;

interface Sub2ApiAccountItem {
  name: string;
  platform: "openai";
  type: "oauth";
  credentials: JsonRecord;
  concurrency: number;
  priority: number;
}

interface Sub2ApiExportPayload {
  exported_at: string;
  proxies: [];
  accounts: Sub2ApiAccountItem[];
  type: "sub2api-data";
  version: 1;
}

interface PortableCodexToken {
  access_token: string;
  refresh_token?: string;
  account_id?: string;
  last_refresh?: string;
  email?: string;
  type: "codex";
  expired?: string;
}

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = toRecord(current);
    if (!record || !(key in record)) return undefined;
    current = record[key];
  }
  return current;
}

function firstString(value: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const found = normalizeString(readPath(value, path));
    if (found) return found;
  }
  return undefined;
}

function normalizeLabel(value: unknown): string | null | undefined {
  const label = normalizeString(value);
  if (label === undefined) return undefined;
  return label.length > 64 ? label.slice(0, 64) : label;
}

function labelFromValue(value: unknown): string | null | undefined {
  return normalizeLabel(
    firstString(value, [
      ["label"],
      ["name"],
      ["account_name"],
      ["accountName"],
      ["account_note"],
      ["accountNote"],
      ["note"],
    ]),
  );
}

function looksLikeRefreshToken(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("oaistb_rt_") || normalized.startsWith("rt_");
}

function normalizeBearer(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("bearer ")
    ? trimmed.slice("bearer ".length).trim()
    : trimmed;
}

function candidateFromString(value: string): ImportEntry | null {
  const token = normalizeBearer(value);
  if (!token) return null;
  if (looksLikeRefreshToken(token)) return { refreshToken: token };
  return { token };
}

function candidateFromValue(value: unknown, fallbackLabel?: string | null): ImportEntry | null {
  if (typeof value === "string") return candidateFromString(value);

  const record = toRecord(value);
  if (!record) return null;

  const token = firstString(record, [
    ["token"],
    ["access_token"],
    ["accessToken"],
    ["tokens", "access_token"],
    ["tokens", "accessToken"],
    ["credentials", "access_token"],
    ["credentials", "accessToken"],
    ["credentials", "token"],
  ]);
  const refreshToken = firstString(record, [
    ["refreshToken"],
    ["refresh_token"],
    ["tokens", "refreshToken"],
    ["tokens", "refresh_token"],
    ["credentials", "refreshToken"],
    ["credentials", "refresh_token"],
  ]);
  const label = labelFromValue(record) ?? fallbackLabel ?? undefined;

  if (!token && !refreshToken) return null;

  return {
    ...(token ? { token: normalizeBearer(token) } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

function isSub2ApiAccount(value: unknown): boolean {
  const record = toRecord(value);
  if (!record) return false;
  const platform = normalizeString(record.platform)?.toLowerCase();
  const type = normalizeString(record.type)?.toLowerCase();
  return platform === "openai" && type === "oauth";
}

function parseSub2ApiPayload(value: JsonRecord): ImportEntry[] | null {
  const accounts = Array.isArray(value.accounts) ? value.accounts : null;
  if (!accounts) return null;
  const looksLikeSub2Api =
    normalizeString(value.type) === "sub2api-data" ||
    "proxies" in value ||
    accounts.some((item) => toRecord(item)?.credentials);
  if (!looksLikeSub2Api) return null;

  const entries: ImportEntry[] = [];
  for (const item of accounts) {
    if (!isSub2ApiAccount(item)) continue;
    const record = toRecord(item);
    const credentials = record ? toRecord(record.credentials) : null;
    if (!credentials) continue;
    const label = normalizeLabel(record?.name);
    const entry = candidateFromValue(credentials, label);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function parseAccountImportPayload(payload: unknown): ImportEntry[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item) => {
      const entry = candidateFromValue(item);
      return entry ? [entry] : [];
    });
  }

  const record = toRecord(payload);
  if (!record) {
    const entry = candidateFromValue(payload);
    return entry ? [entry] : [];
  }

  const sub2api = parseSub2ApiPayload(record);
  if (sub2api) return sub2api;

  if (Array.isArray(record.accounts)) {
    return record.accounts.flatMap((item) => {
      const entry = candidateFromValue(item);
      return entry ? [entry] : [];
    });
  }

  const entry = candidateFromValue(record);
  return entry ? [entry] : [];
}

export function parseAccountImportText(text: string): ImportEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseAccountImportPayload(JSON.parse(trimmed) as unknown);
    } catch {
      // Fall through to JSON-lines / token-lines parsing.
    }
  }

  const entries: ImportEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!normalized) continue;
    try {
      const parsed = JSON.parse(normalized) as unknown;
      entries.push(...parseAccountImportPayload(parsed));
    } catch {
      const entry = candidateFromString(normalized);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

export function parseAccountExportFormat(value: string | undefined): AccountExportFormat | null {
  if (!value || value === "full") return "full";
  if (
    value === "minimal" ||
    value === "cockpit_tools" ||
    value === "sub2api" ||
    value === "cpa"
  ) {
    return value;
  }
  return null;
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function accessTokenExpiry(entry: AccountEntry): string | undefined {
  return isoFromUnixSeconds(decodeJwtPayload(entry.token)?.exp);
}

function quotaWindowRemaining(window: CodexQuotaWindow | null | undefined): number | undefined {
  return typeof window?.remaining_percent === "number" ? window.remaining_percent : undefined;
}

function toPortableToken(entry: AccountEntry): PortableCodexToken {
  return {
    access_token: entry.token,
    ...(entry.refreshToken ? { refresh_token: entry.refreshToken } : {}),
    ...(entry.accountId ? { account_id: entry.accountId } : {}),
    last_refresh: entry.quotaFetchedAt ?? entry.addedAt,
    ...(entry.email ? { email: entry.email } : {}),
    type: "codex",
    ...(accessTokenExpiry(entry) ? { expired: accessTokenExpiry(entry) } : {}),
  };
}

function toSub2ApiAccount(entry: AccountEntry): Sub2ApiAccountItem {
  const credentials: JsonRecord = {
    access_token: entry.token,
    ...(entry.refreshToken ? { refresh_token: entry.refreshToken } : {}),
    ...(entry.email ? { email: entry.email } : {}),
    ...(entry.accountId ? { chatgpt_account_id: entry.accountId } : {}),
    ...(entry.userId ? { chatgpt_user_id: entry.userId } : {}),
    ...(entry.planType ? { plan_type: entry.planType } : {}),
    ...(accessTokenExpiry(entry) ? { expires_at: accessTokenExpiry(entry) } : {}),
  };
  const primaryRemaining = quotaWindowRemaining(entry.cachedQuota?.rate_limit);
  if (primaryRemaining !== undefined) credentials.quota_remaining_percent = primaryRemaining;

  return {
    name: entry.label?.trim() || entry.email || entry.id,
    platform: "openai",
    type: "oauth",
    credentials,
    concurrency: 0,
    priority: 0,
  };
}

export function buildAccountExportPayload(
  entries: AccountEntry[],
  format: AccountExportFormat,
): unknown {
  if (format === "full") return { accounts: entries };
  if (format === "minimal") {
    return {
      accounts: entries
        .filter((entry) => entry.refreshToken)
        .map((entry) => ({
          refreshToken: entry.refreshToken,
          ...(entry.label ? { label: entry.label } : {}),
        })),
    };
  }
  if (format === "cockpit_tools") {
    return entries.map(toPortableToken);
  }
  if (format === "sub2api") {
    const payload: Sub2ApiExportPayload = {
      exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      proxies: [],
      accounts: entries.map(toSub2ApiAccount),
      type: "sub2api-data",
      version: 1,
    };
    return payload;
  }

  const portable = entries.map(toPortableToken);
  return portable.length === 1 ? portable[0] : portable;
}
