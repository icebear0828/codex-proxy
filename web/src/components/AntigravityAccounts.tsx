import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { AntigravityAccountSummary } from "../../../shared/hooks/use-accounts";

interface AntigravityAccountsProps {
  accounts: AntigravityAccountSummary[];
  onAdd: () => Promise<void>;
  onDelete: (id: string) => Promise<string | null>;
  onToggleStatus: (id: string, status: AntigravityAccountSummary["status"]) => Promise<string | null>;
}

export function AntigravityAccounts({ accounts, onAdd, onDelete, onToggleStatus }: AntigravityAccountsProps) {
  const t = useT();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const handleDelete = async (account: AntigravityAccountSummary) => {
    if (!confirm(t("antigravityAccountDeleteConfirm"))) return;
    setBusyId(account.id);
    setError("");
    const result = await onDelete(account.id);
    if (result) setError(result);
    setBusyId(null);
  };

  const handleToggle = async (account: AntigravityAccountSummary) => {
    setBusyId(account.id);
    setError("");
    const result = await onToggleStatus(account.id, account.status);
    if (result) setError(result);
    setBusyId(null);
  };

  return (
    <section class="overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-sm dark:border-violet-900/50 dark:bg-card-dark">
      <div class="flex flex-wrap items-center gap-3 border-b border-violet-100 px-5 py-4 dark:border-violet-900/40">
        <span class="flex size-9 items-center justify-center rounded-xl bg-violet-50 text-sm font-bold text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">✦</span>
        <div>
          <h2 class="text-sm font-semibold text-slate-800 dark:text-text-main">{t("antigravityAccountsTitle")}</h2>
          <p class="mt-0.5 text-xs text-slate-500 dark:text-text-dim">{t("antigravityAccountsDescription")}</p>
        </div>
        <span class="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">{accounts.length}</span>
        <button onClick={() => { void onAdd(); }} class="ml-auto rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-violet-700">{t("addAccount")}</button>
      </div>

      {accounts.length === 0 ? (
        <div class="px-5 py-7 text-center text-sm text-slate-400 dark:text-text-dim">{t("antigravityNoAccounts")}</div>
      ) : (
        <div class="divide-y divide-gray-100 dark:divide-border-dark">
          {accounts.map((account) => (
            <article key={account.id} class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-sm font-medium text-slate-800 dark:text-text-main">{account.label}</span>
                  <span class={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${account.status === "active" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300" : account.status === "error" ? "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"}`}>
                    {account.status === "active" ? t("antigravityAccountActive") : account.status === "error" ? t("antigravityAccountError") : t("antigravityAccountDisabled")}
                  </span>
                </div>
                <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-text-dim">
                  <span>{account.modelCount} {t("antigravityModelsAuto")}</span>
                  <span>{account.claudeModelCount} Claude</span>
                  <span>{account.geminiModelCount} Gemini</span>
                  <details class="group">
                    <summary class="cursor-pointer text-violet-700 dark:text-violet-300">{t("antigravityModelsShow")}</summary>
                    <div class="mt-2 grid max-h-36 gap-x-4 gap-y-1 overflow-auto rounded-lg border border-gray-100 bg-slate-50 p-3 font-mono text-[10px] dark:border-border-dark dark:bg-bg-dark sm:grid-cols-2">
                      {account.models.map((model) => <span key={model}>{model}</span>)}
                    </div>
                  </details>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <button onClick={() => { void handleToggle(account); }} disabled={busyId === account.id} class="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border-dark dark:text-text-dim dark:hover:bg-bg-dark">
                  {account.status === "active" ? t("antigravityAccountDisable") : t("antigravityAccountEnable")}
                </button>
                <button onClick={() => { void handleDelete(account); }} disabled={busyId === account.id} class="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/20">
                  {t("antigravityAccountDelete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {error && (
        <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) setError(""); }}>
          <div role="alertdialog" aria-modal="true" class="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-border-dark dark:bg-card-dark">
            <h2 class="text-base font-semibold text-red-600 dark:text-red-300">{t("accountNoticeError")}</h2>
            <p class="mt-2 break-words text-sm text-slate-600 dark:text-text-dim">{error}</p>
            <div class="mt-5 flex justify-end">
              <button onClick={() => setError("")} class="rounded-lg bg-primary-action px-4 py-2 text-sm font-semibold text-white">{t("confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
