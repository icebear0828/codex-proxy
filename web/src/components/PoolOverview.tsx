import { useMemo } from "preact/hooks";
import { useT, useI18n } from "../../../shared/i18n/context";
import { creditsToUsd, formatCredits, formatResetTime, formatUsd } from "../../../shared/utils/format";
import type { Account } from "../../../shared/types";
import { derivedStatus } from "../lib/accountStatus";

/** Default credit→USD rate matching the config schema default. */
const DEFAULT_CREDITS_PER_USD = 25;

interface PoolOverviewProps {
  accounts: Account[];
  creditsPerUsd?: number;
}

export interface PoolStats {
  active: number;
  exhausted: number;
  totalCredits: number;
  totalUsd: number | null;
  hasAnyCredits: boolean;
  topUsage: { account: Account; pct: number; resetAt: number | null } | null;
}

export function computePoolStats(accounts: Account[], creditsPerUsd = DEFAULT_CREDITS_PER_USD): PoolStats {
  let active = 0;
  let exhausted = 0;
  let totalCredits = 0;
  let hasAnyCredits = false;
  let topUsage: PoolStats["topUsage"] = null;

  for (const account of accounts) {
    const status = derivedStatus(account);
    if (status === "active") active += 1;
    if (status === "quota_exhausted" || status === "rate_limited") exhausted += 1;

    const credits = account.quota?.credits;
    if (credits?.has_credits || credits?.unlimited) {
      hasAnyCredits = true;
      if (!credits.unlimited && Number.isFinite(credits.balance)) {
        totalCredits += credits.balance;
      }
    }

    const srl = account.quota?.secondary_rate_limit;
    const pct = srl?.limit_reached
      ? 100
      : srl?.used_percent != null
        ? Math.round(srl.used_percent)
        : null;
    if (pct != null && (topUsage == null || pct > topUsage.pct)) {
      topUsage = { account, pct, resetAt: srl?.reset_at ?? null };
    }
  }

  const totalUsd = hasAnyCredits ? creditsToUsd(totalCredits, creditsPerUsd) : null;
  return { active, exhausted, totalCredits, totalUsd, hasAnyCredits, topUsage };
}

export function PoolOverview({ accounts, creditsPerUsd = DEFAULT_CREDITS_PER_USD }: PoolOverviewProps) {
  const t = useT();
  const { lang } = useI18n();
  const stats = useMemo(() => computePoolStats(accounts, creditsPerUsd), [accounts, creditsPerUsd]);

  if (accounts.length === 0) return null;

  return (
    <div
      data-testid="pool-overview"
      class="px-4 py-3 rounded-xl bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark text-sm transition-colors"
    >
      <div class="flex items-baseline justify-between mb-2">
        <h3 class="font-semibold text-primary">{t("poolOverview")}</h3>
        <span class="text-xs text-slate-400 dark:text-text-dim">
          {accounts.length}
        </span>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <div class="text-xs text-slate-500 dark:text-text-dim">{t("poolActiveAccounts")}</div>
          <div class="text-lg font-medium text-success">{stats.active}</div>
        </div>
        <div>
          <div class="text-xs text-slate-500 dark:text-text-dim">{t("poolExhaustedAccounts")}</div>
          <div class={`text-lg font-medium ${stats.exhausted > 0 ? "text-amber-600 dark:text-amber-500" : "text-slate-400 dark:text-text-dim"}`}>
            {stats.exhausted}
          </div>
        </div>
        {stats.hasAnyCredits && (
          <div data-testid="pool-credits">
            <div class="text-xs text-slate-500 dark:text-text-dim">{t("poolTotalCredits")}</div>
            <div class="text-lg font-medium text-primary">
              {formatCredits(stats.totalCredits)}
              {stats.totalUsd != null && (
                <span class="ml-1 text-xs text-slate-400 dark:text-text-dim">
                  ({formatUsd(stats.totalUsd)})
                </span>
              )}
            </div>
          </div>
        )}
        {stats.topUsage && (
          <div data-testid="pool-top-usage" class={stats.hasAnyCredits ? "" : "col-span-2"}>
            <div class="text-xs text-slate-500 dark:text-text-dim">{t("poolTopUsage")}</div>
            <div class="text-sm font-medium text-primary truncate">
              {stats.topUsage.account.email || stats.topUsage.account.id}
            </div>
            <div class="text-xs text-slate-500 dark:text-text-dim">
              {stats.topUsage.pct}%{stats.topUsage.resetAt ? ` · ${formatResetTime(stats.topUsage.resetAt, lang === "zh")}` : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
