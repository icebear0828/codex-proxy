import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { FormatAdapter, ProxyRequest } from "./proxy-handler-types.js";
import { canReturnStreamError, streamErrorResponse } from "./stream-error-response.js";

export interface AccountPoolSummary {
  total: number;
  active: number;
  expired: number;
  quota_exhausted: number;
  rate_limited: number;
  refreshing: number;
  disabled: number;
  banned: number;
}

export interface RespondWithNoAccountOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
}

export interface RespondWithProxyErrorOptions {
  c: Context;
  req: ProxyRequest;
  fmt: FormatAdapter;
  status: number;
  message: string;
  useFormat429?: boolean;
}

export function buildAccountExhaustionDetail(summary: AccountPoolSummary, message: string): string {
  const parts: string[] = [];
  if (summary.rate_limited) parts.push(`${summary.rate_limited} rate-limited`);
  if (summary.expired) parts.push(`${summary.expired} expired`);
  if (summary.banned) parts.push(`${summary.banned} banned`);
  if (summary.disabled) parts.push(`${summary.disabled} disabled`);
  if (summary.quota_exhausted) parts.push(`${summary.quota_exhausted} quota-exhausted`);
  if (summary.refreshing) parts.push(`${summary.refreshing} refreshing`);

  return parts.length
    ? `All accounts exhausted (${parts.join(", ")}). ${message}`
    : `No accounts available. ${message}`;
}

export function respondWithNoAccount(options: RespondWithNoAccountOptions): Response {
  const { c, req, fmt } = options;
  if (canReturnStreamError(req, fmt)) {
    return streamErrorResponse(
      c,
      fmt,
      fmt.noAccountStatus,
      "No available accounts. All accounts are expired or rate-limited.",
    );
  }
  c.status(fmt.noAccountStatus);
  return c.json(fmt.formatNoAccount());
}

export function respondWithProxyError(options: RespondWithProxyErrorOptions): Response {
  const { c, req, fmt, status, message, useFormat429 = false } = options;
  if (canReturnStreamError(req, fmt)) {
    return streamErrorResponse(c, fmt, status, message);
  }
  c.status(status as StatusCode);
  return c.json(useFormat429 ? fmt.format429(message) : fmt.formatError(status, message));
}
