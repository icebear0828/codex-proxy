import { useState, useCallback, useRef } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { AssignmentAccount } from "../../../shared/hooks/use-proxy-assignments";
import type { ProxyEntry } from "../../../shared/types";

const PAGE_SIZE = 50;

const statusStyles: Record<string, [string, TranslationKey]> = {
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

interface AccountTableProps {
  accounts: AssignmentAccount[];
  proxies?: ProxyEntry[];
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onSingleProxyChange?: (accountId: string, proxyId: string) => void;
  filterGroup?: string | null;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
  onToggleStatus?: (id: string, currentStatus: string) => Promise<string | null>;
}

export function AccountTable({
  accounts,
  proxies,
  selectedIds,
  onSelectionChange,
  onSingleProxyChange,
  filterGroup = null,
  statusFilter,
  onStatusFilterChange,
  onToggleStatus,
}: AccountTableProps) {
  const t = useT();
  const showProxy = !!proxies;
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const lastClickedIndex = useRef<number | null>(null);

  // Filter accounts
  let filtered = accounts;

  // By group
  if (filterGroup) {
    filtered = filtered.filter((a) => a.proxyId === filterGroup);
  }

  // By status
  if (statusFilter && statusFilter !== "all") {
    filtered = filtered.filter((a) => a.status === statusFilter);
  }

  // By search
  if (search) {
    const lower = search.toLowerCase();
    filtered = filtered.filter((a) => a.email.toLowerCase().includes(lower) || (a.label && a.label.toLowerCase().includes(lower)));
  }

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageAccounts = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const pageAccountsRef = useRef(pageAccounts);
  pageAccountsRef.current = pageAccounts;

  // Reset page when filters change
  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    setPage(0);
  }, []);

  const handleStatusFilter = useCallback(
    (value: string) => {
      onStatusFilterChange(value);
      setPage(0);
    },
    [onStatusFilterChange],
  );

  // Select/deselect
  const toggleSelect = useCallback(
    (id: string, index: number, shiftKey: boolean) => {
      const newSet = new Set(selectedIds);
      const currentPage = pageAccountsRef.current;

      if (shiftKey && lastClickedIndex.current !== null) {
        // Range select
        const start = Math.min(lastClickedIndex.current, index);
        const end = Math.max(lastClickedIndex.current, index);
        for (let i = start; i <= end; i++) {
          if (currentPage[i]) {
            newSet.add(currentPage[i].id);
          }
        }
      } else {
        if (newSet.has(id)) {
          newSet.delete(id);
        } else {
          newSet.add(id);
        }
      }

      lastClickedIndex.current = index;
      onSelectionChange(newSet);
    },
    [selectedIds, onSelectionChange],
  );

  const toggleSelectAll = useCallback(() => {
    const currentPage = pageAccountsRef.current;
    const pageIds = currentPage.map((a) => a.id);
    const allSelected = pageIds.every((id) => selectedIds.has(id));
    const newSet = new Set(selectedIds);
    if (allSelected) {
      for (const id of pageIds) newSet.delete(id);
    } else {
      for (const id of pageIds) newSet.add(id);
    }
    onSelectionChange(newSet);
  }, [selectedIds, onSelectionChange]);

  const allPageSelected = pageAccounts.length > 0 && pageAccounts.every((a) => selectedIds.has(a.id));

  return (
    <div class="flex flex-col gap-3">
      {/* Filters */}
      <div class="flex items-center gap-2">
        <input
          type="text"
          placeholder={t("searchAccount")}
          value={search}
          onInput={(e) => handleSearch((e.target as HTMLInputElement).value)}
          class="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <select
          value={statusFilter}
          onChange={(e) => handleStatusFilter((e.target as HTMLSelectElement).value)}
          class="px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
        >
          <option value="all">{t("allStatuses")}</option>
          <option value="active">{t("active")}</option>
          <option value="expired">{t("expired")}</option>
          <option value="rate_limited">{t("rateLimited")}</option>
          <option value="banned">{t("banned")}</option>
          <option value="disabled">{t("disabled")}</option>
        </select>
      </div>

      {/* Table */}
      <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl overflow-hidden">
        {/* Table Header */}
        <div class="flex items-center gap-3 px-4 py-2.5 border-b border-gray-100 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-xs text-slate-500 dark:text-text-dim font-medium">
          <label class="flex items-center cursor-pointer shrink-0" title={t("selectAll")}>
            <input
              type="checkbox"
              checked={allPageSelected}
              onChange={toggleSelectAll}
              class="rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
            />
          </label>
          <span class="flex-1 min-w-0">Email</span>
          <span class="w-20 text-center hidden sm:block">{t("statusFilter")}</span>
          {onToggleStatus && <span class="w-12 text-center hidden sm:block" />}
          {showProxy && <span class="w-40 text-center hidden md:block">{t("proxyAssignment")}</span>}
        </div>

        {/* Rows */}
        {pageAccounts.length === 0 ? (
          <div class="px-4 py-8 text-center text-sm text-slate-400 dark:text-text-dim">
            {t("noAccounts")}
          </div>
        ) : (
          pageAccounts.map((acct, idx) => {
            const isSelected = selectedIds.has(acct.id);
            const [statusCls, statusKey] = statusStyles[acct.status] || statusStyles.disabled;

            return (
              <div
                key={acct.id}
                class={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 dark:border-border-dark/50 transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-primary/5 dark:bg-primary/10"
                    : "hover:bg-slate-50 dark:hover:bg-border-dark/30"
                }`}
                onClick={(e) => {
                  if ((e.target as HTMLElement).tagName === "SELECT") return;
                  toggleSelect(acct.id, idx, e.shiftKey);
                }}
              >
                <label class="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(acct.id, idx, false)}
                    class="rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
                  />
                </label>
                <span class="flex-1 min-w-0 text-sm font-medium truncate text-slate-700 dark:text-text-main">
                  {acct.label ? `${acct.label} (${acct.email})` : acct.email}
                </span>
                <span class="w-20 hidden sm:flex justify-center">
                  <span class={`px-2 py-0.5 rounded-full text-[0.65rem] font-medium border ${statusCls}`}>
                    {t(statusKey)}
                  </span>
                </span>
                {onToggleStatus && (() => {
                  const isEnabled = acct.status !== "disabled";
                  const canToggle = acct.status === "active" || acct.status === "disabled" || acct.status === "rate_limited" || acct.status === "refreshing";
                  return (
                    <span class="w-12 hidden sm:flex justify-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => { if (canToggle) onToggleStatus(acct.id, acct.status); }}
                        disabled={!canToggle}
                        title={canToggle ? (isEnabled ? t("disableAccount") : t("enableAccount")) : undefined}
                        class={`relative inline-flex h-4 w-7 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                          !canToggle ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
                        } ${isEnabled ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"}`}
                      >
                        <span
                          class={`pointer-events-none inline-block h-3 w-3 rounded-full bg-white dark:bg-slate-200 shadow transform transition-transform duration-200 ${
                            isEnabled ? "translate-x-3" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </span>
                  );
                })()}
                {showProxy && (
                  <span class="w-40 hidden md:block" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={acct.proxyId || "global"}
                      onChange={(e) => onSingleProxyChange?.(acct.id, (e.target as HTMLSelectElement).value)}
                      class="w-full text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-border-dark bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
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
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div class="flex items-center justify-between text-xs text-slate-500 dark:text-text-dim">
          <span>
            {t("totalItems")} {totalCount}
          </span>
          <div class="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              class="px-2.5 py-1 rounded-md border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t("prevPage")}
            </button>
            <span class="font-medium">
              {safePage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={safePage >= totalPages - 1}
              class="px-2.5 py-1 rounded-md border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t("nextPage")}
            </button>
          </div>
        </div>
      )}

      {/* Hint */}
      <p class="text-[0.65rem] text-slate-400 dark:text-text-dim text-center">
        {t("shiftSelectHint")}
      </p>
    </div>
  );
}
