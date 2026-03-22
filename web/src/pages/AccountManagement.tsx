import { useState, useCallback, useMemo } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useAccounts } from "../../../shared/hooks/use-accounts";
import { AccountTable } from "../components/AccountTable";
import { AccountBulkActions } from "../components/AccountBulkActions";
import { AccountImportExport } from "../components/AccountImportExport";
import type { AssignmentAccount } from "../../../shared/hooks/use-proxy-assignments";
import type { TranslationKey } from "../../../shared/i18n/translations";

const statusOrder: Array<{ key: string; label: TranslationKey }> = [
  { key: "active", label: "active" },
  { key: "expired", label: "expired" },
  { key: "rate_limited", label: "rateLimited" },
  { key: "refreshing", label: "refreshing" },
  { key: "disabled", label: "disabled" },
  { key: "banned", label: "banned" },
];

export function AccountManagement() {
  const t = useT();
  const accounts = useAccounts();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState("all");
  const [message, setMessage] = useState<string | null>(null);

  // Map Account[] → AssignmentAccount[] for AccountTable
  const tableAccounts: AssignmentAccount[] = useMemo(
    () =>
      accounts.list.map((a) => ({
        id: a.id,
        email: a.email || a.id.slice(0, 8),
        status: a.status,
        proxyId: a.proxyId || "global",
        proxyName: "",
      })),
    [accounts.list],
  );

  // Status summary counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of accounts.list) {
      counts[a.status] = (counts[a.status] || 0) + 1;
    }
    return counts;
  }, [accounts.list]);

  const showMessage = useCallback((msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 3000);
  }, []);

  const handleBatchDelete = useCallback(async () => {
    const ids = [...selectedIds];
    const result = await accounts.batchDelete(ids);
    setSelectedIds(new Set());
    showMessage(`${t("deleteSuccess")}: ${result.deleted}`);
  }, [selectedIds, accounts, t, showMessage]);

  const handleSetActive = useCallback(async () => {
    const ids = [...selectedIds];
    const result = await accounts.batchSetStatus(ids, "active");
    setSelectedIds(new Set());
    showMessage(`${t("statusChangeSuccess")}: ${result.updated}`);
  }, [selectedIds, accounts, t, showMessage]);

  const handleSetDisabled = useCallback(async () => {
    const ids = [...selectedIds];
    const result = await accounts.batchSetStatus(ids, "disabled");
    setSelectedIds(new Set());
    showMessage(`${t("statusChangeSuccess")}: ${result.updated}`);
  }, [selectedIds, accounts, t, showMessage]);

  const handleStatusChipClick = useCallback((status: string) => {
    setStatusFilter((prev) => (prev === status ? "all" : status));
  }, []);

  return (
    <div class="min-h-screen bg-slate-50 dark:bg-bg-dark flex flex-col">
      {/* Header */}
      <header class="sticky top-0 z-50 bg-white dark:bg-card-dark border-b border-gray-200 dark:border-border-dark px-4 py-3">
        <div class="max-w-[1100px] mx-auto flex items-center gap-3">
          <a
            href="#/"
            class="text-sm text-slate-500 dark:text-text-dim hover:text-primary transition-colors"
          >
            &larr; Dashboard
          </a>
          <h1 class="text-base font-semibold text-slate-800 dark:text-text-main">
            {t("accountManagement")}
          </h1>
          <div class="flex-1" />
          <AccountImportExport
            onExport={accounts.exportAccounts}
            onImport={accounts.importAccounts}
            selectedIds={selectedIds}
          />
        </div>
      </header>

      {/* Main content */}
      <main class="flex-grow px-4 md:px-8 py-6 max-w-[1100px] mx-auto w-full">
        {/* Status summary chips */}
        <div class="flex flex-wrap gap-2 mb-4">
          {statusOrder.map(({ key, label }) => {
            const count = statusCounts[key] || 0;
            if (count === 0) return null;
            const isActive = statusFilter === key;
            return (
              <button
                key={key}
                onClick={() => handleStatusChipClick(key)}
                class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                  isActive
                    ? "bg-primary text-white border-primary"
                    : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
                }`}
              >
                {t(label)} ({count})
              </button>
            );
          })}
          <span class="px-3 py-1 text-xs text-slate-400 dark:text-text-dim">
            {accounts.list.length} {t("totalItems")}
          </span>
        </div>

        {/* Message toast */}
        {message && (
          <div class="mb-4 px-4 py-2 rounded-lg bg-primary/10 text-primary text-sm font-medium">
            {message}
          </div>
        )}

        {/* Table */}
        {accounts.loading ? (
          <div class="text-center py-12 text-slate-400 dark:text-text-dim">Loading...</div>
        ) : (
          <AccountTable
            accounts={tableAccounts}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
          />
        )}
      </main>

      {/* Bulk actions bar */}
      <AccountBulkActions
        selectedCount={selectedIds.size}
        onBatchDelete={handleBatchDelete}
        onSetActive={handleSetActive}
        onSetDisabled={handleSetDisabled}
      />
    </div>
  );
}
