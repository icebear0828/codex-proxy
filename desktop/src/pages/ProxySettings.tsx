import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useProxyAssignments } from "../../../shared/hooks/use-proxy-assignments";
import { ProxyGroupList } from "../components/ProxyGroupList";
import { AccountTable } from "../components/AccountTable";
import { BulkActions } from "../components/BulkActions";
import { ImportExport } from "../components/ImportExport";
import { RuleAssign } from "../components/RuleAssign";

export function ProxySettings() {
  const t = useT();
  const data = useProxyAssignments();
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState("all");
  const [showRuleAssign, setShowRuleAssign] = useState(false);

  // Single account proxy change (optimistic)
  const handleSingleProxyChange = useCallback(
    async (accountId: string, proxyId: string) => {
      await data.assignBulk([{ accountId, proxyId }]);
    },
    [data.assignBulk],
  );

  // Bulk assign all selected to a single proxy
  const handleBulkAssign = useCallback(
    async (proxyId: string) => {
      const assignments = Array.from(selectedIds).map((accountId) => ({ accountId, proxyId }));
      await data.assignBulk(assignments);
      setSelectedIds(new Set());
    },
    [selectedIds, data.assignBulk],
  );

  // Even distribute selected across all active proxies
  const handleEvenDistribute = useCallback(async () => {
    const activeProxies = data.proxies.filter((p) => p.status === "active");
    if (activeProxies.length === 0) return;

    const ids = Array.from(selectedIds);
    await data.assignRule(ids, "round-robin", activeProxies.map((p) => p.id));
    setSelectedIds(new Set());
  }, [selectedIds, data.proxies, data.assignRule]);

  // Rule-based assignment
  const handleRuleAssign = useCallback(
    async (rule: string, targetProxyIds: string[]) => {
      const ids = Array.from(selectedIds);
      await data.assignRule(ids, rule, targetProxyIds);
      setSelectedIds(new Set());
      setShowRuleAssign(false);
    },
    [selectedIds, data.assignRule],
  );

  if (data.loading) {
    return (
      <div class="flex-grow flex items-center justify-center">
        <div class="text-sm text-slate-400 dark:text-text-dim animate-pulse">Loading...</div>
      </div>
    );
  }

  return (
    <div class="flex flex-col flex-grow">
      {/* Top bar */}
      <div class="px-4 md:px-8 lg:px-40 py-4 border-b border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark">
        <div class="flex items-center justify-between max-w-[1200px] mx-auto">
          <div>
            <h2 class="text-lg font-bold">{t("proxySettings")}</h2>
            <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5">
              {t("proxySettingsDesc")}
            </p>
          </div>
          <ImportExport
            onExport={data.exportAssignments}
            onImportPreview={data.importPreview}
            onApplyImport={data.applyImport}
          />
        </div>
      </div>

      {/* Main content */}
      <div class="flex-grow px-4 md:px-8 lg:px-40 py-6">
        <div class="flex gap-6 max-w-[1200px] mx-auto">
          {/* Left sidebar — proxy groups */}
          <div class="w-56 shrink-0 hidden lg:block">
            <ProxyGroupList
              accounts={data.accounts}
              proxies={data.proxies}
              selectedGroup={selectedGroup}
              onSelectGroup={setSelectedGroup}
            />
          </div>

          {/* Right panel — account table */}
          <div class="flex-1 min-w-0">
            {/* Mobile group filter */}
            <div class="lg:hidden mb-3">
              <select
                value={selectedGroup ?? "__all__"}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  setSelectedGroup(v === "__all__" ? null : v);
                }}
                class="w-full px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              >
                <option value="__all__">{t("allAccounts")} ({data.accounts.length})</option>
                <option value="global">{t("globalDefault")}</option>
                {data.proxies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
                <option value="direct">{t("directNoProxy")}</option>
                <option value="auto">{t("autoRoundRobin")}</option>
              </select>
            </div>

            <AccountTable
              accounts={data.accounts}
              proxies={data.proxies}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              onSingleProxyChange={handleSingleProxyChange}
              filterGroup={selectedGroup}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
            />
          </div>
        </div>
      </div>

      {/* Bulk actions bar */}
      <BulkActions
        selectedCount={selectedIds.size}
        selectedIds={selectedIds}
        proxies={data.proxies}
        onBulkAssign={handleBulkAssign}
        onEvenDistribute={handleEvenDistribute}
        onOpenRuleAssign={() => setShowRuleAssign(true)}
      />

      {/* Rule assign modal */}
      {showRuleAssign && (
        <RuleAssign
          proxies={data.proxies}
          selectedCount={selectedIds.size}
          onAssign={handleRuleAssign}
          onClose={() => setShowRuleAssign(false)}
        />
      )}
    </div>
  );
}
