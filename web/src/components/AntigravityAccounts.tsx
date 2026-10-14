import { useState } from "preact/hooks";
import { useI18n, useT } from "../../../shared/i18n/context";
import { formatNumber, formatResetTime } from "../../../shared/utils/format";
import type { AntigravityAccountSummary } from "../../../shared/hooks/use-accounts";
import {
  AccountCardAvatar,
  AccountCardDeleteButton,
  AccountCardHeader,
  AccountCardProgressBar,
  AccountCardRefreshButton,
  AccountCardStatRow,
  AccountCardStats,
  AccountCardStatusBadge,
  AccountCardStatusToggle,
  AccountCardSurface,
} from "./AccountCardPrimitives";

interface AntigravityAccountsProps {
  accounts: AntigravityAccountSummary[];
  onAdd: () => Promise<void>;
  onDelete: (id: string) => Promise<string | null>;
  onToggleStatus: (id: string, status: AntigravityAccountSummary["status"]) => Promise<string | null>;
  onRefresh: () => void;
}

export function AntigravityAccounts({ accounts, onAdd, onDelete, onToggleStatus, onRefresh }: AntigravityAccountsProps) {
  const t = useT();
  const { lang } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  const handleDelete = async (account: AntigravityAccountSummary) => {
    if (!confirm(t("removeConfirm"))) return;
    setBusyId(account.id);
    try {
      const result = await onDelete(account.id);
      if (result) alert(result);
    } finally {
      setBusyId(null);
    }
  };

  const handleToggle = async (account: AntigravityAccountSummary) => {
    setBusyId(account.id);
    try {
      const result = await onToggleStatus(account.id, account.status);
      if (result) alert(result);
    } finally {
      setBusyId(null);
    }
  };

  const handleRefresh = async (id: string) => {
    setRefreshingId(id);
    try {
      await onRefresh();
    } finally {
      setRefreshingId(null);
    }
  };

  return (
    <>
      {accounts.map((account, index) => {
        const statusClass = account.status === "active"
          ? "bg-success-container text-success border-success/30"
          : account.status === "error"
            ? "bg-danger-container text-danger border-danger/30"
            : "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/30 dark:text-slate-400 dark:border-slate-700/30";
        const isEnabled = account.status === "active";
        const busy = busyId === account.id;
        const label = account.email || account.label || "Antigravity";
        const subscription = account.planType || "—";
        const initial = label.charAt(0).toUpperCase();

        return (
          <AccountCardSurface key={account.id}>
            <AccountCardHeader>
              <div class="flex items-center gap-3 min-w-0 flex-1">
                <AccountCardAvatar initial={initial} index={index} />
                <div class="min-w-0">
                  <h3 class="text-[0.82rem] font-semibold leading-tight truncate">{label}</h3>
                  <p class="text-xs text-slate-500 dark:text-text-dim truncate">
                    {subscription} · {account.claudeModelCount} Claude · {account.geminiModelCount} Gemini
                  </p>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0 flex-wrap">
                <AccountCardStatusToggle
                  enabled={isEnabled}
                  disabled={busy}
                  title={isEnabled ? t("disableAccount") : t("enableAccount")}
                  onClick={() => void handleToggle(account)}
                />
                <AccountCardStatusBadge className={statusClass}>
                  {account.status === "active" ? t("antigravityAccountActive") : account.status === "error" ? t("antigravityAccountError") : t("antigravityAccountDisabled")}
                </AccountCardStatusBadge>
                <AccountCardRefreshButton
                  refreshing={refreshingId === account.id}
                  title={t("refreshQuota")}
                  onClick={() => void handleRefresh(account.id)}
                />
                <AccountCardDeleteButton title={t("deleteAccount")} onClick={() => void handleDelete(account)} />
              </div>
            </AccountCardHeader>

            <details class="mb-3 text-xs">
              <summary class="cursor-pointer text-slate-500 dark:text-text-dim">{t("antigravityModelsShow")}</summary>
              <div class="mt-2 grid max-h-36 gap-x-4 gap-y-1 overflow-auto rounded-lg border border-gray-100 bg-slate-50 p-3 font-mono text-[10px] dark:border-border-dark dark:bg-bg-dark sm:grid-cols-2">
                {account.models.map((model) => <span key={model}>{model}</span>)}
              </div>
            </details>

            <AccountCardStats>
              <AccountCardStatRow label={t("windowRequests")} value={formatNumber(account.windowRequestCount)} />
              <AccountCardStatRow label={t("windowTokens")} value={formatNumber(account.windowRequestTokens)} />
              <AccountCardStatRow label={t("windowImageRequests")} value={formatNumber(account.windowImageRequestCount)} />
            </AccountCardStats>

            {(account.quota?.buckets.length ?? 0) > 0 && (
              <div class="pt-3 mt-3 border-t border-slate-100 dark:border-border-dark space-y-3">
                {account.quota!.buckets.map((bucket, bucketIndex) => {
                  const remaining = bucket.remainingFraction == null
                    ? null
                    : Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 100);
                  const resetTimestamp = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
                  const resetAt = Number.isFinite(resetTimestamp)
                    ? formatResetTime(resetTimestamp / 1000, lang)
                    : bucket.resetTime;
                  const quotaLabel = bucket.modelId || t("rateLimit");

                  return (
                    <div key={`${bucket.modelId}-${bucketIndex}`}>
                      <div class="flex justify-between text-[0.78rem] mb-1.5">
                        <span class="text-slate-500 dark:text-text-dim">{quotaLabel}</span>
                        {remaining == null ? (
                          <span class="font-medium text-slate-400 dark:text-text-dim">—</span>
                        ) : (
                          <span class={`font-medium ${remaining <= 10 ? "text-red-500" : remaining <= 40 ? "text-amber-600 dark:text-amber-500" : "text-primary"}`}>
                            {remaining}% {t("remaining")}
                          </span>
                        )}
                      </div>
                      {remaining != null && <AccountCardProgressBar remaining={remaining} testId={`antigravity-quota-${bucketIndex}`} />}
                      {resetAt && <p class="text-xs text-slate-400 dark:text-text-dim mt-1">{t("resetsAt")} {resetAt}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </AccountCardSurface>
        );
      })}
      {accounts.length === 0 && (
        <button onClick={() => { void onAdd(); }} class="bg-white dark:bg-card-dark border border-dashed border-gray-300 dark:border-border-dark rounded-xl p-4 shadow-sm text-sm text-slate-500 dark:text-text-dim hover:border-primary/50 transition-all">
          + {t("antigravityStartLogin")}
        </button>
      )}
    </>
  );
}
