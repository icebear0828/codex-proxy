import { useCallback } from "preact/hooks";
import { useT, useI18n } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import { formatNumber, formatResetTime, formatWindowDuration } from "../../../shared/utils/format";
import type { Account, ProxyEntry } from "../../../shared/types";

const avatarColors = [
  ["bg-purple-100 dark:bg-[#2a1a3f]", "text-purple-600 dark:text-purple-400"],
  ["bg-amber-100 dark:bg-[#3d2c16]", "text-amber-600 dark:text-amber-500"],
  ["bg-blue-100 dark:bg-[#1a2a3f]", "text-blue-600 dark:text-blue-400"],
  ["bg-emerald-100 dark:bg-[#112a1f]", "text-emerald-600 dark:text-emerald-400"],
  ["bg-red-100 dark:bg-[#3f1a1a]", "text-red-600 dark:text-red-400"],
];

const statusStyles: Record<string, [string, string]> = {
  active: [
    "bg-green-100 text-green-700 border-green-200 dark:bg-[#11281d] dark:text-primary dark:border-[#1a442e]",
    "active",
  ],
  expired: [
    "bg-red-100 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/30",
    "expired",
  ],
  rate_limited: [
    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/30",
    "rateLimited",
  ],
  refreshing: [
    "bg-blue-100 text-blue-600 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/30",
    "refreshing",
  ],
  disabled: [
    "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/30 dark:text-slate-400 dark:border-slate-700/30",
    "disabled",
  ],
  banned: [
    "bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800/40",
    "banned",
  ],
};

interface AccountCardProps {
  account: Account;
  index: number;
  onDelete: (id: string) => Promise<string | null>;
  proxies?: ProxyEntry[];
  onProxyChange?: (accountId: string, proxyId: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function AccountCard({ account, index, onDelete, proxies, onProxyChange, selected, onToggleSelect }: AccountCardProps) {
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
  const plan = account.planType || t("freeTier");
  const windowSec = account.quota?.rate_limit?.limit_window_seconds;
  const windowDur = windowSec ? formatWindowDuration(windowSec, lang === "zh") : null;

  const [statusCls, statusKey] = statusStyles[account.status] || statusStyles.disabled;

  const handleDelete = useCallback(async () => {
    if (!confirm(t("removeConfirm"))) return;
    const err = await onDelete(account.id);
    if (err) alert(err);
  }, [account.id, onDelete, t]);

  // Quota — primary window
  const q = account.quota;
  const rl = q?.rate_limit;
  const pct = rl?.used_percent != null ? Math.round(rl.used_percent) : null;
  const barColor =
    pct == null ? "bg-primary" : pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-primary";
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
  const sPct = srl?.used_percent != null ? Math.round(srl.used_percent) : null;
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

  const handleToggle = useCallback(() => {
    onToggleSelect?.(account.id);
  }, [account.id, onToggleSelect]);

  return (
    <div class={`bg-white dark:bg-card-dark border rounded-xl p-4 shadow-sm hover:shadow-md transition-all ${selected ? "border-primary ring-1 ring-primary/30" : "border-gray-200 dark:border-border-dark hover:border-primary/30 dark:hover:border-primary/50"}`}>
      {/* Header */}
      <div class="flex justify-between items-start mb-4">
        <div class="flex items-center gap-3">
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
          <div>
            <h3 class="text-[0.82rem] font-semibold leading-tight">{email}</h3>
            <p class="text-xs text-slate-500 dark:text-text-dim">
              {plan}
              {windowDur && (
                <span class="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-border-dark text-slate-500 dark:text-text-dim text-[0.65rem] font-medium">
                  {windowDur}
                </span>
              )}
            </p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class={`px-2.5 py-1 rounded-full ${statusCls} text-xs font-medium border`}>
            {t(statusKey as TranslationKey)}
          </span>
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
        <div class="flex justify-between text-[0.68rem]">
          <span class="text-slate-400 dark:text-text-dim/70">{t("totalAll")}</span>
          <span class="text-slate-400 dark:text-text-dim/70">{formatNumber(requests)} req · {formatNumber(tokens)} tok</span>
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
      {(rl || srl) && (
        <div class="pt-3 mt-3 border-t border-slate-100 dark:border-border-dark space-y-3">
          {/* Primary window */}
          {rl && (
            <div>
              <div class="flex justify-between text-[0.78rem] mb-1.5">
                <span class="text-slate-500 dark:text-text-dim">
                  {t("rateLimit")}
                  {windowDur && (
                    <span class="ml-1 text-slate-400 dark:text-text-dim/70 text-[0.65rem]">({windowDur})</span>
                  )}
                </span>
                {rl.limit_reached ? (
                  <span class="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs font-medium">
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
                  <span class="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs font-medium">
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
        </div>
      )}
    </div>
  );
}
