import { useI18n, useT } from "../i18n/context";
import { AccountCard } from "./AccountCard";
import type { Account } from "../hooks/use-accounts";

interface AccountListProps {
  accounts: Account[];
  loading: boolean;
  onDelete: (id: string) => Promise<string | null>;
  onRefresh: () => void;
  refreshing: boolean;
  lastUpdated: Date | null;
}

export function AccountList({ accounts, loading, onDelete, onRefresh, refreshing, lastUpdated }: AccountListProps) {
  const t = useT();
  const { lang } = useI18n();

  const updatedAtText = lastUpdated
    ? lastUpdated.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-center justify-between">
        <div class="flex flex-col gap-1">
          <h2 class="text-[0.95rem] font-bold tracking-tight">{t("connectedAccounts")}</h2>
          <p class="text-slate-500 dark:text-text-dim text-[0.8rem]">{t("connectedAccountsDesc")}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          {updatedAtText && (
            <span class="text-[0.75rem] text-slate-400 dark:text-text-dim hidden sm:inline">
              {t("updatedAt")} {updatedAtText}
            </span>
          )}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            title={t("refresh")}
            aria-label={t("refresh")}
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 outline-none"
          >
            <svg
              class={`size-[18px] ${refreshing ? "animate-spin" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading ? (
          <div class="md:col-span-2 text-center py-8 text-slate-400 dark:text-text-dim text-sm bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-colors">
            {t("loadingAccounts")}
          </div>
        ) : accounts.length === 0 ? (
          <div class="md:col-span-2 text-center py-8 text-slate-400 dark:text-text-dim text-sm bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-colors">
            {t("noAccounts")}
          </div>
        ) : (
          accounts.map((acct, i) => (
            <AccountCard key={acct.id} account={acct} index={i} onDelete={onDelete} />
          ))
        )}
      </div>
    </section>
  );
}
