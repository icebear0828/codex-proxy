import { useState, useCallback, useEffect } from "preact/hooks";
import { useI18n, useT } from "../../../shared/i18n/context";
import { AccountCard } from "./AccountCard";
import { AccountImportExport } from "./AccountImportExport";
import type { Account, ProxyEntry, QuotaWarning } from "../../../shared/types";

interface AccountListProps {
  accounts: Account[];
  loading: boolean;
  onDelete: (id: string) => Promise<string | null>;
  onRefresh: () => void;
  refreshing: boolean;
  lastUpdated: Date | null;
  proxies?: ProxyEntry[];
  onProxyChange?: (accountId: string, proxyId: string) => void;
  onExport?: (selectedIds?: string[], format?: "full" | "minimal") => Promise<void>;
  onImport?: (file: File) => Promise<{ success: boolean; added: number; updated: number; failed: number; errors: string[] }>;
  onToggleStatus?: (id: string, currentStatus: string) => Promise<string | null>;
  onUpdateLabel?: (id: string, label: string | null) => Promise<string | null>;
}

const PAGE_SIZE = 10;

export function AccountList({ accounts, loading, onDelete, onRefresh, refreshing, lastUpdated, proxies, onProxyChange, onExport, onImport, onToggleStatus, onUpdateLabel }: AccountListProps) {
  const t = useT();
  const { lang } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [warnings, setWarnings] = useState<QuotaWarning[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const refreshAllQuota = useCallback(async () => {
    setQuotaRefreshing(true);
    try {
      await fetch("/auth/accounts?quota=fresh");
      onRefresh();
    } finally {
      setQuotaRefreshing(false);
    }
  }, [onRefresh]);

  // Poll quota warnings
  useEffect(() => {
    const fetchWarnings = async () => {
      try {
        const resp = await fetch("/auth/quota/warnings");
        const data = await resp.json();
        setWarnings(data.warnings || []);
      } catch { /* ignore */ }
    };
    fetchWarnings();
    const timer = setInterval(fetchWarnings, 30_000);
    return () => clearInterval(timer);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === accounts.length) return new Set();
      return new Set(accounts.map((a) => a.id));
    });
  }, [accounts]);

  const updatedAtText = lastUpdated
    ? lastUpdated.toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  const activeCount = accounts.filter((a) => a.status === "active").length;

  return (
    <section class="flex flex-col gap-4">
      {/* Row 1: Title + stats */}
      <div class="flex items-start justify-between">
        <div class="flex flex-col gap-1">
          <h2 class="text-[0.95rem] font-bold tracking-tight">{t("connectedAccounts")}</h2>
          <p class="text-slate-500 dark:text-text-dim text-[0.8rem]">{t("connectedAccountsDesc")}</p>
        </div>
        <div class="flex flex-col items-end gap-1 shrink-0">
          <span class="text-[0.82rem] font-semibold">
            <span class="text-primary">{activeCount}</span>
            <span class="text-slate-400 dark:text-text-dim"> / {accounts.length}</span>
          </span>
          {updatedAtText && (
            <span class="text-[0.7rem] text-slate-400 dark:text-text-dim">
              {t("updatedAt")} {updatedAtText}
            </span>
          )}
        </div>
      </div>

      {/* Action toolbar */}
      <div class="flex items-center gap-1.5 flex-wrap">
        {/* Refresh list */}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-primary hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg class={`size-3.5 ${refreshing ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
          </svg>
          <span class="hidden sm:inline">{t("refreshList")}</span>
        </button>
        {/* Refresh all quota */}
        <button
          onClick={refreshAllQuota}
          disabled={quotaRefreshing}
          class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg class={`size-3.5 ${quotaRefreshing ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5" />
          </svg>
          <span class="hidden sm:inline">{t("quotaShort")}</span>
        </button>
        {/* Import / Export */}
        {onExport && onImport && (
          <AccountImportExport onExport={onExport} onImport={onImport} selectedIds={selectedIds} />
        )}
        {/* Select all */}
        {accounts.length > 0 && (
          <button
            onClick={toggleSelectAll}
            class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-text-dim hover:text-primary hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              {selectedIds.size === accounts.length ? (
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              ) : (
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              )}
            </svg>
            <span class="hidden sm:inline">{selectedIds.size === accounts.length ? t("deselectAll") : t("selectAll")}</span>
          </button>
        )}
        {/* Pagination — right side */}
        {!loading && accounts.length > PAGE_SIZE && (
          <div class="flex items-center gap-2 ml-auto pl-3 border-l border-gray-200 dark:border-border-dark">
            <span class="text-xs text-slate-400 dark:text-text-dim tabular-nums">
              {Math.min(visibleCount, accounts.length)} / {accounts.length}
            </span>
            {visibleCount < accounts.length ? (
              <button
                onClick={() => setVisibleCount(accounts.length)}
                class="px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors"
              >
                {t("expandAll")}
              </button>
            ) : (
              <button
                onClick={() => setVisibleCount(PAGE_SIZE)}
                class="px-2.5 py-1 text-xs font-medium text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors"
              >
                {t("collapse")}
              </button>
            )}
          </div>
        )}
      </div>
      {/* Quota warning banners */}
      {warnings.filter((w) => w.level === "critical").length > 0 && (
        <div class="px-4 py-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span>
            {t("quotaCriticalWarning").replace("{count}", String(warnings.filter((w) => w.level === "critical").length))}
          </span>
        </div>
      )}
      {warnings.filter((w) => w.level === "warning").length > 0 && warnings.filter((w) => w.level === "critical").length === 0 && (
        <div class="px-4 py-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 text-amber-700 dark:text-amber-400 text-sm flex items-center gap-2">
          <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span>
            {t("quotaWarning").replace("{count}", String(warnings.filter((w) => w.level === "warning").length))}
          </span>
        </div>
      )}
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
          accounts.slice(0, visibleCount).map((acct, i) => (
            <AccountCard key={acct.id} account={acct} index={i} onDelete={onDelete} proxies={proxies} onProxyChange={onProxyChange} selected={selectedIds.has(acct.id)} onToggleSelect={toggleSelect} onRefreshQuota={async (id) => { await fetch(`/auth/accounts?quota=fresh&id=${id}`); onRefresh(); }} onToggleStatus={onToggleStatus} onUpdateLabel={onUpdateLabel} />
          ))
        )}
      </div>
      {/* Show more at bottom when partially expanded */}
      {!loading && accounts.length > PAGE_SIZE && visibleCount < accounts.length && visibleCount > PAGE_SIZE && (
        <div class="flex items-center justify-center mt-2">
          <button
            onClick={() => setVisibleCount((c) => Math.min(c + PAGE_SIZE, accounts.length))}
            class="px-4 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
          >
            {t("showMore")}
          </button>
        </div>
      )}
    </section>
  );
}
