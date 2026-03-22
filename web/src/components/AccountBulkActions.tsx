import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";

interface AccountBulkActionsProps {
  selectedCount: number;
  loading: boolean;
  onBatchDelete: () => void;
  onSetActive: () => void;
  onSetDisabled: () => void;
}

export function AccountBulkActions({
  selectedCount,
  loading,
  onBatchDelete,
  onSetActive,
  onSetDisabled,
}: AccountBulkActionsProps) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = useCallback(() => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onBatchDelete();
  }, [confirming, onBatchDelete]);

  const cancelConfirm = useCallback(() => setConfirming(false), []);

  if (selectedCount === 0) return null;

  return (
    <div class="sticky bottom-0 z-40 bg-white dark:bg-card-dark border-t border-gray-200 dark:border-border-dark shadow-lg px-4 py-3">
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-sm font-medium text-slate-700 dark:text-text-main shrink-0">
          {selectedCount} {t("accountsCount")} {t("selected")}
        </span>

        <div class="h-4 w-px bg-gray-200 dark:bg-border-dark hidden sm:block" />

        <button
          onClick={onSetActive}
          disabled={loading}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-green-200 dark:border-green-800/40 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("setActive")}
        </button>

        <button
          onClick={onSetDisabled}
          disabled={loading}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700/40 bg-slate-50 dark:bg-slate-800/20 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("setDisabled")}
        </button>

        <div class="h-4 w-px bg-gray-200 dark:bg-border-dark hidden sm:block" />

        {confirming ? (
          <div class="flex items-center gap-2">
            <button
              onClick={handleDelete}
              disabled={loading}
              class="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("batchDeleteConfirm")}
            </button>
            <button
              onClick={cancelConfirm}
              disabled={loading}
              class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t("cancel")}
            </button>
          </div>
        ) : (
          <button
            onClick={handleDelete}
            disabled={loading}
            class="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("batchDelete")}
          </button>
        )}
      </div>
    </div>
  );
}
