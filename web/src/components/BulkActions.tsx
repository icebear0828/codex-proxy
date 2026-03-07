import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { ProxyEntry } from "../../../shared/types";

interface BulkActionsProps {
  selectedCount: number;
  selectedIds: Set<string>;
  proxies: ProxyEntry[];
  onBulkAssign: (proxyId: string) => void;
  onEvenDistribute: () => void;
  onOpenRuleAssign: () => void;
}

export function BulkActions({
  selectedCount,
  selectedIds,
  proxies,
  onBulkAssign,
  onEvenDistribute,
  onOpenRuleAssign,
}: BulkActionsProps) {
  const t = useT();
  const [targetProxy, setTargetProxy] = useState("global");

  const handleApply = useCallback(() => {
    if (selectedIds.size === 0) return;
    onBulkAssign(targetProxy);
  }, [selectedIds, targetProxy, onBulkAssign]);

  if (selectedCount === 0) return null;

  return (
    <div class="sticky bottom-0 z-40 bg-white dark:bg-card-dark border-t border-gray-200 dark:border-border-dark shadow-lg px-4 py-3">
      <div class="flex items-center gap-3 flex-wrap">
        {/* Selection count */}
        <span class="text-sm font-medium text-slate-700 dark:text-text-main shrink-0">
          {selectedCount} {t("accountsCount")} {t("selected")}
        </span>

        <div class="h-4 w-px bg-gray-200 dark:bg-border-dark hidden sm:block" />

        {/* Batch assign */}
        <div class="flex items-center gap-2">
          <span class="text-xs text-slate-500 dark:text-text-dim shrink-0">{t("batchAssignTo")}:</span>
          <select
            value={targetProxy}
            onChange={(e) => setTargetProxy((e.target as HTMLSelectElement).value)}
            class="text-xs px-2 py-1.5 rounded-md border border-gray-200 dark:border-border-dark bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            <option value="global">{t("globalDefault")}</option>
            <option value="direct">{t("directNoProxy")}</option>
            <option value="auto">{t("autoRoundRobin")}</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleApply}
            class="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
          >
            {t("applyBtn")}
          </button>
        </div>

        <div class="h-4 w-px bg-gray-200 dark:bg-border-dark hidden sm:block" />

        {/* Even distribute */}
        <button
          onClick={onEvenDistribute}
          disabled={proxies.length === 0}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t("evenDistribute")}
        </button>

        {/* Rule assign */}
        <button
          onClick={onOpenRuleAssign}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
        >
          {t("ruleAssign")}
        </button>
      </div>
    </div>
  );
}
