import { useCallback } from "preact/hooks";
import { useT } from "../i18n/context";
import { useI18n } from "../i18n/context";
import { formatNumber, formatResetTime } from "../utils/format";
import type { Account } from "../hooks/use-accounts";

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
};

interface AccountCardProps {
  account: Account;
  index: number;
  onDelete: (id: string) => Promise<string | null>;
}

export function AccountCard({ account, index, onDelete }: AccountCardProps) {
  const t = useT();
  const { lang } = useI18n();
  const email = account.email || "Unknown";
  const initial = email.charAt(0).toUpperCase();
  const [bgColor, textColor] = avatarColors[index % avatarColors.length];
  const usage = account.usage || {};
  const requests = usage.request_count ?? 0;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  const plan = account.planType || t("freeTier");

  const [statusCls, statusKey] = statusStyles[account.status] || statusStyles.disabled;

  const handleDelete = useCallback(async () => {
    if (!confirm(t("removeConfirm"))) return;
    const err = await onDelete(account.id);
    if (err) alert(err);
  }, [account.id, onDelete, t]);

  // Quota
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

  return (
    <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-4 shadow-sm hover:shadow-md transition-all hover:border-primary/30 dark:hover:border-primary/50">
      {/* Header */}
      <div class="flex justify-between items-start mb-4">
        <div class="flex items-center gap-3">
          <div class={`size-10 rounded-full ${bgColor} ${textColor} flex items-center justify-center font-bold text-lg`}>
            {initial}
          </div>
          <div>
            <h3 class="text-[0.82rem] font-semibold leading-tight">{email}</h3>
            <p class="text-xs text-slate-500 dark:text-text-dim">{plan}</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class={`px-2.5 py-1 rounded-full ${statusCls} text-xs font-medium border`}>
            {t(statusKey as any)}
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
          <span class="text-slate-500 dark:text-text-dim">{t("totalRequests")}</span>
          <span class="font-medium">{formatNumber(requests)}</span>
        </div>
        <div class="flex justify-between text-[0.78rem]">
          <span class="text-slate-500 dark:text-text-dim">{t("tokensUsed")}</span>
          <span class="font-medium">{formatNumber(tokens)}</span>
        </div>
      </div>

      {/* Quota bar */}
      {rl && (
        <div class="pt-3 mt-3 border-t border-slate-100 dark:border-border-dark">
          <div class="flex justify-between text-[0.78rem] mb-1.5">
            <span class="text-slate-500 dark:text-text-dim">{t("rateLimit")}</span>
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
    </div>
  );
}
