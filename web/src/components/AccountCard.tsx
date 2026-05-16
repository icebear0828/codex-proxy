import { useCallback, useState } from "preact/hooks";
import { useT, useI18n } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import {
  creditsToUsd,
  formatCredits,
  formatNumber,
  formatResetTime,
  formatUsd,
  formatWindowDuration,
} from "../../../shared/utils/format";
import type { Account, AccountQuotaWindow, ProxyEntry } from "../../../shared/types";
import { derivedStatus } from "../lib/accountStatus";

/** Default credit→USD rate matching the config schema default (1000 credits = $40).
 *  Surfacing this through a settings hook lives in a follow-up PR. */
const DEFAULT_CREDITS_PER_USD = 25;

const avatarColors = [
  ["bg-avatar-purple-bg", "text-avatar-purple-text"],
  ["bg-avatar-amber-bg", "text-avatar-amber-text"],
  ["bg-avatar-blue-bg", "text-avatar-blue-text"],
  ["bg-avatar-emerald-bg", "text-avatar-emerald-text"],
  ["bg-avatar-red-bg", "text-avatar-red-text"],
];

const statusStyles: Record<string, [string, string]> = {
  active: [
    "bg-success-container text-success border-success/30",
    "active",
  ],
  expired: [
    "bg-danger-container text-danger border-danger/30",
    "expired",
  ],
  quota_exhausted: [
    "bg-warning-container text-warning border-warning/30",
    "quotaExhausted",
  ],
  rate_limited: [
    "bg-warning-container text-warning border-warning/30",
    "rateLimited",
  ],
  refreshing: [
    "bg-info-container text-info border-info/30",
    "refreshing",
  ],
  disabled: [
    "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/30 dark:text-slate-400 dark:border-slate-700/30",
    "disabled",
  ],
  banned: [
    "bg-danger-container text-danger border-danger/40",
    "banned",
  ],
};

type LimitBucket = NonNullable<NonNullable<Account["quota"]>["rate_limits_by_limit_id"]>[string];

function normalizedLimitName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function isReviewLimitName(value: string | null | undefined): boolean {
  const normalized = normalizedLimitName(value);
  return normalized === "review" ||
    normalized === "code_review" ||
    normalized === "codex_review" ||
    normalized === "codex_code_review" ||
    normalized.includes("code_review") ||
    normalized.includes("codex_review");
}

function limitLabel(bucket: LimitBucket): string {
  const label = (bucket.limit_name || bucket.limit_id || "").trim();
  return label ? label.replace(/_/g, " ") : "limit";
}

function limitPercent(limit: (AccountQuotaWindow & { allowed?: boolean }) | null | undefined): number | null {
  return limit?.limit_reached ? 100
    : limit?.used_percent != null ? Math.round(limit.used_percent)
    : null;
}

interface AccountCardProps {
  account: Account;
  index: number;
  onDelete: (id: string) => Promise<string | null>;
  proxies?: ProxyEntry[];
  onProxyChange?: (accountId: string, proxyId: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onRefreshQuota?: (id: string) => Promise<void>;
  onToggleStatus?: (id: string, currentStatus: string) => Promise<string | null>;
  onUpdateLabel?: (id: string, label: string | null) => Promise<string | null>;
}

export function AccountCard({ account, index, onDelete, proxies, onProxyChange, selected, onToggleSelect, onRefreshQuota, onToggleStatus, onUpdateLabel }: AccountCardProps) {
  const t = useT();
  const { lang } = useI18n();
  const email = account.email || "Unknown";
  const initial = email.charAt(0).toUpperCase();
  const [bgColor, textColor] = avatarColors[index % avatarColors.length];
  const usage = account.usage || {};
  const requests = usage.request_count ?? 0;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  const winRequests = usage.window_request_count ?? 0;
  const winTokens = (usage.window_input_tokens ?? 0) + (usage.window_output_tokens ?? 0);
  const imageTokens = (usage.image_input_tokens ?? 0) + (usage.image_output_tokens ?? 0);
  const winImageTokens = (usage.window_image_input_tokens ?? 0) + (usage.window_image_output_tokens ?? 0);
  const imageRequests = usage.image_request_count ?? 0;
  const imageRequestsFailed = usage.image_request_failed_count ?? 0;
  const winImageRequests = usage.window_image_request_count ?? 0;
  const winImageRequestsFailed = usage.window_image_request_failed_count ?? 0;
  const hasImageActivity = imageRequests > 0 || imageRequestsFailed > 0 || imageTokens > 0;
  const plan = account.planType || t("freeTier");
  const windowSec = account.quota?.rate_limit?.limit_window_seconds;
  const windowDur = windowSec ? formatWindowDuration(windowSec, lang === "zh") : null;

  const effectiveStatus = derivedStatus(account);
  const [statusCls, statusKey] = statusStyles[effectiveStatus] || statusStyles.disabled;

  const handleDelete = useCallback(async () => {
    if (!confirm(t("removeConfirm"))) return;
    const err = await onDelete(account.id);
    if (err) alert(err);
  }, [account.id, onDelete, t]);

  // Quota — primary window (default 0% used = 100% available for accounts without data)
  const q = account.quota;
  const rl = q?.rate_limit;
  const pct = rl?.limit_reached ? 100
    : rl?.used_percent != null ? Math.round(rl.used_percent)
    : (account.status === "active" ? 0 : null);
  const barColor =
    pct == null ? "bg-primary-action" : pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-primary-action";
  const pctColor =
    pct == null
      ? "text-primary"
      : pct >= 90
        ? "text-red-500"
        : pct >= 60
          ? "text-amber-600 dark:text-amber-500"
          : "text-primary";
  const resetAt = rl?.reset_at ? formatResetTime(rl.reset_at, lang === "zh") : null;

  // Quota — secondary window (e.g. weekly)
  const srl = q?.secondary_rate_limit;
  const sPct = srl?.limit_reached ? 100
    : srl?.used_percent != null ? Math.round(srl.used_percent)
    : null;
  const sBarColor =
    sPct == null ? "bg-indigo-500" : sPct >= 90 ? "bg-red-500" : sPct >= 60 ? "bg-amber-500" : "bg-indigo-500";
  const sPctColor =
    sPct == null
      ? "text-indigo-500"
      : sPct >= 90
        ? "text-red-500"
        : sPct >= 60
          ? "text-amber-600 dark:text-amber-500"
          : "text-indigo-500";
  const sResetAt = srl?.reset_at ? formatResetTime(srl.reset_at, lang === "zh") : null;
  const sWindowSec = srl?.limit_window_seconds;
  const sWindowDur = sWindowSec ? formatWindowDuration(sWindowSec, lang === "zh") : null;

  // Quota — dedicated code review window
  const rrl = q?.code_review_rate_limit;
  const rPct = rrl?.limit_reached ? 100
    : rrl?.used_percent != null ? Math.round(rrl.used_percent)
    : null;
  const rBarColor =
    rPct == null ? "bg-cyan-500" : rPct >= 90 ? "bg-red-500" : rPct >= 60 ? "bg-amber-500" : "bg-cyan-500";
  const rPctColor =
    rPct == null
      ? "text-cyan-500"
      : rPct >= 90
        ? "text-red-500"
        : rPct >= 60
          ? "text-amber-600 dark:text-amber-500"
          : "text-cyan-500";
  const rResetAt = rrl?.reset_at ? formatResetTime(rrl.reset_at, lang === "zh") : null;
  const rWindowSec = rrl?.limit_window_seconds;
  const rWindowDur = rWindowSec ? formatWindowDuration(rWindowSec, lang === "zh") : null;
  const additionalRateLimits = Object.values(q?.rate_limits_by_limit_id ?? {})
    .filter((bucket) => {
      const limitId = normalizedLimitName(bucket.limit_id);
      if (!limitId || limitId === "codex") return false;
      return !isReviewLimitName(bucket.limit_id) && !isReviewLimitName(bucket.limit_name);
    })
    .sort((a, b) => limitLabel(a).localeCompare(limitLabel(b)));

  // Credits — only render for accounts that actually carry a credit pool
  // (Pro / PAYG / Team with explicit balance). Plus accounts have
  // has_credits=false and a "0" balance that conveys no useful info.
  const creditsInfo = q?.credits;
  const showCredits = !!creditsInfo && (creditsInfo.has_credits || creditsInfo.unlimited);
  const creditUsd = showCredits && !creditsInfo!.unlimited
    ? creditsToUsd(creditsInfo!.balance, DEFAULT_CREDITS_PER_USD)
    : null;

  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const handleRefreshQuota = useCallback(async () => {
    if (!onRefreshQuota) return;
    setQuotaRefreshing(true);
    try {
      await onRefreshQuota(account.id);
    } finally {
      setQuotaRefreshing(false);
    }
  }, [account.id, onRefreshQuota]);

  const handleToggle = useCallback(() => {
    onToggleSelect?.(account.id);
  }, [account.id, onToggleSelect]);

  const [statusToggling, setStatusToggling] = useState(false);
  const isEnabled = account.status !== "disabled";
  // `rate_limited` is no longer a backend status; toggling is allowed for the
  // remaining backend states. Cards rendered with derived "rate_limited" badge
  // have backend status "active" and therefore satisfy this check.
  const canToggle = account.status === "active" || account.status === "disabled" || account.status === "refreshing" || account.status === "quota_exhausted";

  const handleStatusToggle = useCallback(async () => {
    if (!onToggleStatus || !canToggle) return;
    setStatusToggling(true);
    try {
      const err = await onToggleStatus(account.id, account.status);
      if (err) console.error(err);
    } finally {
      setStatusToggling(false);
    }
  }, [account.id, account.status, canToggle, onToggleStatus]);

  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label || "");

  const handleLabelEdit = useCallback(() => {
    setLabelDraft(account.label || "");
    setEditingLabel(true);
  }, [account.label]);

  const handleLabelSave = useCallback(async () => {
    if (!onUpdateLabel) return;
    const trimmed = labelDraft.trim();
    const newLabel = trimmed || null;
    const err = await onUpdateLabel(account.id, newLabel);
    if (err) console.error(err);
    setEditingLabel(false);
  }, [account.id, labelDraft, onUpdateLabel]);

  const handleLabelKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter") handleLabelSave();
    if (e.key === "Escape") setEditingLabel(false);
  }, [handleLabelSave]);

  return (
    <div class={`bg-white dark:bg-card-dark border rounded-xl p-4 shadow-sm hover:shadow-md transition-all ${selected ? "border-primary ring-1 ring-primary/30" : "border-gray-200 dark:border-border-dark hover:border-primary/30 dark:hover:border-primary/50"}`}>
      {/* Header */}
      <div class="flex flex-wrap justify-between items-start gap-2 mb-4">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected}
              onChange={handleToggle}
              class="size-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary/50 cursor-pointer shrink-0"
            />
          )}
          <div class={`size-10 rounded-full ${bgColor} ${textColor} flex items-center justify-center font-bold text-lg`}>
            {initial}
          </div>
          <div class="min-w-0">
            {editingLabel ? (
              <input
                type="text"
                value={labelDraft}
                onInput={(e) => setLabelDraft((e.target as HTMLInputElement).value)}
                onKeyDown={handleLabelKeyDown}
                onBlur={handleLabelSave}
                maxLength={64}
                placeholder={t("labelPlaceholder")}
                class="text-[0.82rem] font-semibold leading-tight w-full px-1.5 py-0.5 -ml-1.5 rounded border border-primary bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
            ) : (
              <div class="flex items-center gap-1 group">
                <h3 class="text-[0.82rem] font-semibold leading-tight truncate">
                  {account.label || email}
                </h3>
                {onUpdateLabel && (
                  <button
                    onClick={handleLabelEdit}
                    class="p-0.5 text-slate-300 dark:text-text-dim/50 opacity-0 group-hover:opacity-100 hover:text-primary transition-all shrink-0"
                    title={t("editLabel")}
                  >
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                    </svg>
                  </button>
                )}
              </div>
            )}
            <p class="text-xs text-slate-500 dark:text-text-dim truncate">
              {account.label ? `${email} · ${plan}` : plan}
              {windowDur && (
                <span class="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-border-dark text-slate-500 dark:text-text-dim text-[0.65rem] font-medium">
                  {windowDur}
                </span>
              )}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 flex-wrap">
          {onToggleStatus && (
            <button
              onClick={handleStatusToggle}
              disabled={!canToggle || statusToggling}
              title={canToggle ? (isEnabled ? t("disableAccount") : t("enableAccount")) : undefined}
              class={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                !canToggle ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
              } ${isEnabled ? "bg-primary-action" : "bg-slate-300 dark:bg-slate-600"}`}
            >
              <span
                class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white dark:bg-slate-200 shadow transform transition-transform duration-200 ${
                  isEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          )}
          <span class={`px-2.5 py-1 rounded-full ${statusCls} text-xs font-medium border`}>
            {t(statusKey as TranslationKey)}
          </span>
          {onRefreshQuota && (
            <button
              onClick={handleRefreshQuota}
              disabled={quotaRefreshing}
              class="p-1.5 text-slate-400 dark:text-text-dim hover:text-amber-500 transition-colors rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-40"
              title={t("refreshQuota")}
            >
              <svg class="size-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            </button>
          )}
          <button
            onClick={handleDelete}
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-red-500 transition-colors rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
            title={t("deleteAccount")}
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* Stats */}
      <div class="space-y-2">
        <div class="flex justify-between text-[0.78rem]">
          <span class="text-slate-500 dark:text-text-dim">{t("windowRequests")}</span>
          <span class="font-medium">{formatNumber(winRequests)}</span>
        </div>
        <div class="flex justify-between text-[0.78rem]">
          <span class="text-slate-500 dark:text-text-dim">{t("windowTokens")}</span>
          <span class="font-medium">{formatNumber(winTokens)}</span>
        </div>
        {hasImageActivity && (
          <>
            <div class="flex justify-between text-[0.78rem]">
              <span class="text-slate-500 dark:text-text-dim">{t("windowImageTokens")}</span>
              <span class="font-medium">{formatNumber(winImageTokens)}</span>
            </div>
            <div class="flex justify-between text-[0.78rem]">
              <span class="text-slate-500 dark:text-text-dim">{t("windowImageRequests")}</span>
              <span class="font-medium">
                {formatNumber(winImageRequests)} ok · {formatNumber(winImageRequestsFailed)} failed
              </span>
            </div>
          </>
        )}
        <div class="flex justify-between text-[0.68rem]">
          <span class="text-slate-400 dark:text-text-dim/70">{t("totalAll")}</span>
          <span class="text-slate-400 dark:text-text-dim/70">
            {formatNumber(requests)} req · {formatNumber(tokens)} tok
            {hasImageActivity ? ` · ${formatNumber(imageRequests)}/${formatNumber(imageRequestsFailed)} img` : ""}
          </span>
        </div>
      </div>

      {/* Proxy selector */}
      {proxies && onProxyChange && (
        <div class="flex items-center justify-between text-[0.78rem] mt-2 pt-2 border-t border-slate-100 dark:border-border-dark">
          <span class="text-slate-500 dark:text-text-dim">{t("proxyAssignment")}</span>
          <select
            value={account.proxyId || "global"}
            onChange={(e) =>
              onProxyChange(account.id, (e.target as HTMLSelectElement).value)
            }
            class="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-border-dark bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            <option value="global">{t("globalDefault")}</option>
            <option value="direct">{t("directNoProxy")}</option>
            <option value="auto">{t("autoRoundRobin")}</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.health?.exitIp ? ` (${p.health.exitIp})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Quota bars */}
      {(rl || srl || rrl || account.status === "active") && (
        <div class="pt-3 mt-3 border-t border-slate-100 dark:border-border-dark space-y-3">
          {/* Primary window */}
          {(rl || account.status === "active") && (
            <div>
              <div class="flex justify-between text-[0.78rem] mb-1.5">
                <span class="text-slate-500 dark:text-text-dim">
                  {t("rateLimit")}
                  {windowDur && (
                    <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">({windowDur})</span>
                  )}
                </span>
                {rl?.limit_reached ? (
                  <span class="px-2 py-0.5 rounded-full bg-danger-container text-danger text-xs font-medium">
                    {t("limitReached")}
                  </span>
                ) : pct != null ? (
                  <span class={`font-medium ${pctColor}`}>
                    {pct}% {t("used")}
                  </span>
                ) : (
                  <span class="font-medium text-primary">{t("ok")}</span>
                )}
              </div>
              {pct != null && (
                <div class="w-full bg-slate-100 dark:bg-border-dark rounded-full h-2 overflow-hidden">
                  <div class={`${barColor} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              )}
              {resetAt && (
                <p class="text-xs text-slate-400 dark:text-text-dim mt-1">
                  {t("resetsAt")} {resetAt}
                </p>
              )}
            </div>
          )}

          {/* Secondary window (e.g. weekly) */}
          {srl && (
            <div>
              <div class="flex justify-between text-[0.78rem] mb-1.5">
                <span class="text-slate-500 dark:text-text-dim">
                  {t("secondaryRateLimit")}
                  {sWindowDur && (
                    <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">({sWindowDur})</span>
                  )}
                </span>
                {srl.limit_reached ? (
                  <span class="px-2 py-0.5 rounded-full bg-danger-container text-danger text-xs font-medium">
                    {t("limitReached")}
                  </span>
                ) : sPct != null ? (
                  <span class={`font-medium ${sPctColor}`}>
                    {sPct}% {t("used")}
                  </span>
                ) : (
                  <span class="font-medium text-indigo-500">{t("ok")}</span>
                )}
              </div>
              {sPct != null && (
                <div class="w-full bg-slate-100 dark:bg-border-dark rounded-full h-2 overflow-hidden">
                  <div class={`${sBarColor} h-2 rounded-full transition-all`} style={{ width: `${sPct}%` }} />
                </div>
              )}
              {sResetAt && (
                <p class="text-xs text-slate-400 dark:text-text-dim mt-1">
                  {t("resetsAt")} {sResetAt}
                </p>
              )}
            </div>
          )}

          {/* Credit balance (Pro / PAYG / Team — accounts with has_credits=true). */}
          {showCredits && (
            <div data-testid="credit-balance" class="flex justify-between text-[0.78rem]">
              <span class="text-slate-500 dark:text-text-dim">
                {t("creditsBalance")}
              </span>
              {creditsInfo!.unlimited ? (
                <span class="font-medium text-emerald-500">{t("creditsUnlimited")}</span>
              ) : (
                <span class={`font-medium ${creditsInfo!.overage_limit_reached ? "text-red-500" : "text-primary"}`}>
                  {formatCredits(creditsInfo!.balance)}
                  {creditUsd != null && (
                    <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">
                      ({formatUsd(creditUsd)})
                    </span>
                  )}
                  {creditsInfo!.overage_limit_reached && (
                    <span class="ml-2 text-xs">· {t("creditsOverageReached")}</span>
                  )}
                </span>
              )}
            </div>
          )}

          {/* Review quota window */}
          {rrl && (
            <div>
              <div class="flex justify-between text-[0.78rem] mb-1.5">
                <span class="text-slate-500 dark:text-text-dim">
                  {t("reviewRateLimit")}
                  {rWindowDur && (
                    <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">({rWindowDur})</span>
                  )}
                </span>
                {rrl.limit_reached ? (
                  <span class="px-2 py-0.5 rounded-full bg-danger-container text-danger text-xs font-medium">
                    {t("limitReached")}
                  </span>
                ) : rPct != null ? (
                  <span class={`font-medium ${rPctColor}`}>
                    {rPct}% {t("used")}
                  </span>
                ) : rrl.allowed === false ? (
                  <span class="font-medium text-slate-400 dark:text-text-dim">{t("disabled")}</span>
                ) : (
                  <span class="font-medium text-cyan-500">{t("ok")}</span>
                )}
              </div>
              {rPct != null && (
                <div class="w-full bg-slate-100 dark:bg-border-dark rounded-full h-2 overflow-hidden">
                  <div class={`${rBarColor} h-2 rounded-full transition-all`} style={{ width: `${rPct}%` }} />
                </div>
              )}
              {rResetAt && (
                <p class="text-xs text-slate-400 dark:text-text-dim mt-1">
                  {t("resetsAt")} {rResetAt}
                </p>
              )}
            </div>
          )}

          {additionalRateLimits.map((bucket) => {
            const bPct = limitPercent(bucket);
            const bBarColor =
              bPct == null ? "bg-sky-500" : bPct >= 90 ? "bg-red-500" : bPct >= 60 ? "bg-amber-500" : "bg-sky-500";
            const bPctColor =
              bPct == null
                ? "text-sky-500"
                : bPct >= 90
                  ? "text-red-500"
                  : bPct >= 60
                    ? "text-amber-600 dark:text-amber-500"
                    : "text-sky-500";
            const bResetAt = bucket.reset_at ? formatResetTime(bucket.reset_at, lang === "zh") : null;
            const bWindowDur = bucket.limit_window_seconds ? formatWindowDuration(bucket.limit_window_seconds, lang === "zh") : null;
            const bSecondary = bucket.secondary_rate_limit;
            const bsPct = limitPercent(bSecondary);
            const bsResetAt = bSecondary?.reset_at ? formatResetTime(bSecondary.reset_at, lang === "zh") : null;
            const bsWindowDur = bSecondary?.limit_window_seconds ? formatWindowDuration(bSecondary.limit_window_seconds, lang === "zh") : null;

            return (
              <div key={bucket.limit_id || bucket.limit_name}>
                <div class="flex justify-between text-[0.78rem] mb-1.5 gap-3">
                  <span class="text-slate-500 dark:text-text-dim truncate" title={bucket.limit_id || bucket.limit_name || undefined}>
                    {t("additionalRateLimit")}: {limitLabel(bucket)}
                    {bWindowDur && (
                      <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">({bWindowDur})</span>
                    )}
                  </span>
                  {bucket.limit_reached ? (
                    <span class="px-2 py-0.5 rounded-full bg-danger-container text-danger text-xs font-medium shrink-0">
                      {t("limitReached")}
                    </span>
                  ) : bPct != null ? (
                    <span class={`font-medium shrink-0 ${bPctColor}`}>
                      {bPct}% {t("used")}
                    </span>
                  ) : bucket.allowed === false ? (
                    <span class="font-medium text-slate-400 dark:text-text-dim shrink-0">{t("disabled")}</span>
                  ) : (
                    <span class="font-medium text-sky-500 shrink-0">{t("ok")}</span>
                  )}
                </div>
                {bPct != null && (
                  <div class="w-full bg-slate-100 dark:bg-border-dark rounded-full h-2 overflow-hidden">
                    <div class={`${bBarColor} h-2 rounded-full transition-all`} style={{ width: `${Math.min(Math.max(bPct, 0), 100)}%` }} />
                  </div>
                )}
                {bResetAt && (
                  <p class="text-xs text-slate-400 dark:text-text-dim mt-1">
                    {t("resetsAt")} {bResetAt}
                  </p>
                )}
                {bSecondary && (
                  <div class="mt-2 pl-3 border-l border-slate-200 dark:border-border-dark">
                    <div class="flex justify-between text-[0.72rem] mb-1 gap-3">
                      <span class="text-slate-400 dark:text-text-dim/80">
                        {t("secondaryRateLimit")}
                        {bsWindowDur && (
                          <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">({bsWindowDur})</span>
                        )}
                      </span>
                      {bSecondary.limit_reached ? (
                        <span class="font-medium text-red-500 shrink-0">{t("limitReached")}</span>
                      ) : bsPct != null ? (
                        <span class="font-medium text-sky-500 shrink-0">{bsPct}% {t("used")}</span>
                      ) : (
                        <span class="font-medium text-sky-500 shrink-0">{t("ok")}</span>
                      )}
                    </div>
                    {bsResetAt && (
                      <p class="text-xs text-slate-400 dark:text-text-dim mt-1">
                        {t("resetsAt")} {bsResetAt}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
