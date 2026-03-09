import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { ProxyEntry } from "../../../shared/types";

interface RuleAssignProps {
  proxies: ProxyEntry[];
  selectedCount: number;
  onAssign: (rule: string, targetProxyIds: string[]) => void;
  onClose: () => void;
}

export function RuleAssign({ proxies, selectedCount, onAssign, onClose }: RuleAssignProps) {
  const t = useT();
  const [rule, setRule] = useState("round-robin");
  const [targetIds, setTargetIds] = useState<Set<string>>(
    () => new Set(proxies.filter((p) => p.status === "active").map((p) => p.id)),
  );

  const toggleTarget = useCallback((id: string) => {
    setTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    if (targetIds.size === 0) return;
    onAssign(rule, Array.from(targetIds));
  }, [rule, targetIds, onAssign]);

  // Also include special values
  const allTargets = [
    { id: "global", label: t("globalDefault"), status: "active" as const },
    { id: "direct", label: t("directNoProxy"), status: "active" as const },
    ...proxies.map((p) => ({ id: p.id, label: p.name, status: p.status })),
  ];

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-6 w-full max-w-md mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-lg font-semibold mb-1">{t("assignRuleTitle")}</h3>
        <p class="text-xs text-slate-500 dark:text-text-dim mb-4">
          {selectedCount} {t("accountsCount")} {t("selected")}
        </p>

        {/* Rule selection */}
        <div class="mb-4">
          <label class="text-xs font-medium text-slate-600 dark:text-text-dim block mb-1.5">
            {t("assignRuleTitle")}
          </label>
          <select
            value={rule}
            onChange={(e) => setRule((e.target as HTMLSelectElement).value)}
            class="w-full px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
          >
            <option value="round-robin">{t("roundRobinRule")}</option>
          </select>
        </div>

        {/* Target proxies */}
        <div class="mb-4">
          <label class="text-xs font-medium text-slate-600 dark:text-text-dim block mb-1.5">
            {t("ruleTarget")}
          </label>
          <div class="max-h-48 overflow-y-auto border border-gray-100 dark:border-border-dark rounded-lg">
            {allTargets.map((target) => (
              <label
                key={target.id}
                class="flex items-center gap-2 px-3 py-2 border-b border-gray-50 dark:border-border-dark/50 hover:bg-slate-50 dark:hover:bg-border-dark/30 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={targetIds.has(target.id)}
                  onChange={() => toggleTarget(target.id)}
                  class="rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary"
                />
                <span class="text-sm text-slate-700 dark:text-text-main">{target.label}</span>
                {target.status !== "active" && (
                  <span class="text-[0.6rem] text-slate-400 dark:text-text-dim">({target.status})</span>
                )}
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div class="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            class="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
          >
            {t("cancelBtn")}
          </button>
          <button
            onClick={handleApply}
            disabled={targetIds.size === 0}
            class="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {t("applyBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
