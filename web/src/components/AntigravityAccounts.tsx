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

type Translate = ReturnType<typeof useT>;

interface AntigravityQuotaBucket {
  modelId: string;
  remainingFraction: number | null;
  resetTime: string | null;
}

interface AntigravityQuotaGroup {
  key: "gemini" | "codex" | "other";
  label: string;
  entries: Array<{ bucket: AntigravityQuotaBucket; index: number }>;
}

function remainingPercent(bucket: AntigravityQuotaBucket): number {
  return Math.round(Math.max(0, Math.min(1, bucket.remainingFraction ?? 0)) * 100);
}

function remainingColorClass(remaining: number): string {
  return remaining <= 10
    ? "text-red-500"
    : remaining <= 40
      ? "text-amber-600 dark:text-amber-500"
      : "text-primary";
}

/**
 * Group per-model quota buckets into the two shared Google AI Pro pools
 * (Gemini vs Claude/GPT) plus an overflow group for unknown models, so the
 * card stays compact by default while every raw bucket stays inspectable.
 * Purely presentational: routing and quota judgement logic are untouched.
 */
function buildAntigravityQuotaGroups(buckets: AntigravityQuotaBucket[], t: Translate): AntigravityQuotaGroup[] {
  const groups: AntigravityQuotaGroup[] = [
    { key: "gemini", label: t("antigravityQuotaGemini"), entries: [] },
    { key: "codex", label: t("antigravityQuotaClaudeGpt"), entries: [] },
    { key: "other", label: t("antigravityQuotaOther"), entries: [] },
  ];
  buckets.forEach((bucket, index) => {
    const modelId = bucket.modelId.toLowerCase();
    const target = modelId.startsWith("gemini")
      ? groups[0]
      : modelId.startsWith("claude") || modelId.startsWith("gpt")
        ? groups[1]
        : groups[2];
    target.entries.push({ bucket, index });
  });
  return groups.filter((group) => group.entries.length > 0);
}

function AntigravityQuotaGroupRow({ group, t, lang }: { group: AntigravityQuotaGroup; t: Translate; lang: ReturnType<typeof useI18n>["lang"] }) {
  // Summary shows the most-constrained bucket of the pool (never fabricates
  // 100% when no bucket reports a remaining fraction).
  const binding = group.entries
    .map((entry) => entry.bucket)
    .filter((bucket) => bucket.remainingFraction != null)
    .reduce<AntigravityQuotaBucket | null>(
      (best, bucket) => (best == null || bucket.remainingFraction! < best.remainingFraction! ? bucket : best),
      null,
    );
  const remaining = binding ? remainingPercent(binding) : null;
  const resetTimestamp = binding?.resetTime ? Date.parse(binding.resetTime) : NaN;
  const resetAt = Number.isFinite(resetTimestamp)
    ? formatResetTime(resetTimestamp / 1000, lang)
    : binding?.resetTime ?? null;

  return (
    <div>
      <div class="flex justify-between text-[0.78rem] mb-1.5">
        <span class="text-slate-500 dark:text-text-dim">{group.label}</span>
        {remaining == null ? (
          <span class="font-medium text-slate-400 dark:text-text-dim">—</span>
        ) : (
          <span class={`font-medium ${remainingColorClass(remaining)}`}>{remaining}% {t("remaining")}</span>
        )}
      </div>
      {remaining != null && <AccountCardProgressBar remaining={remaining} testId={`antigravity-quota-group-${group.key}`} />}
      {resetAt && <p class="text-xs text-slate-400 dark:text-text-dim mt-1">{t("resetsAt")} {resetAt}</p>}
      <details class="mt-1.5">
        <summary class="cursor-pointer text-[0.72rem] text-slate-400 dark:text-text-dim">
          {t("antigravityQuotaExpandModels")} ({group.entries.length})
        </summary>
        <div class="mt-2 space-y-3 border-l-2 border-slate-100 pl-3 dark:border-border-dark">
          {group.entries.map(({ bucket, index }) => {
            const bucketRemaining = bucket.remainingFraction == null ? null : remainingPercent(bucket);
            const bucketResetTimestamp = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
            const bucketResetAt = Number.isFinite(bucketResetTimestamp)
              ? formatResetTime(bucketResetTimestamp / 1000, lang)
              : bucket.resetTime;
            const quotaLabel = bucket.modelId || t("rateLimit");

            return (
              <div key={`${bucket.modelId}-${index}`}>
                <div class="flex justify-between text-[0.78rem] mb-1.5">
                  <span class="text-slate-500 dark:text-text-dim">{quotaLabel}</span>
                  {bucketRemaining == null ? (
                    <span class="font-medium text-slate-400 dark:text-text-dim">—</span>
                  ) : (
                    <span class={`font-medium ${remainingColorClass(bucketRemaining)}`}>{bucketRemaining}% {t("remaining")}</span>
                  )}
                </div>
                {bucketRemaining != null && <AccountCardProgressBar remaining={bucketRemaining} testId={`antigravity-quota-${index}`} />}
                {bucketResetAt && <p class="text-xs text-slate-400 dark:text-text-dim mt-1">{t("resetsAt")} {bucketResetAt}</p>}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

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
                {buildAntigravityQuotaGroups(account.quota!.buckets, t).map((group) => (
                  <AntigravityQuotaGroupRow key={group.key} group={group} t={t} lang={lang} />
                ))}
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
