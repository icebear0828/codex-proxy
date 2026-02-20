import { useT } from "../i18n/context";
import { AccountCard } from "./AccountCard";
import type { Account } from "../hooks/use-accounts";

interface AccountListProps {
  accounts: Account[];
  loading: boolean;
  onDelete: (id: string) => Promise<string | null>;
}

export function AccountList({ accounts, loading, onDelete }: AccountListProps) {
  const t = useT();

  return (
    <section class="flex flex-col gap-4">
      <div class="flex items-end justify-between">
        <div class="flex flex-col gap-1">
          <h2 class="text-[0.95rem] font-bold tracking-tight">{t("connectedAccounts")}</h2>
          <p class="text-slate-500 dark:text-text-dim text-[0.8rem]">{t("connectedAccountsDesc")}</p>
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
