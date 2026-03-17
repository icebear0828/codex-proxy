import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useQuotaSettings } from "../../../shared/hooks/use-quota-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

export function QuotaSettings() {
  const t = useT();
  const settings = useSettings();
  const qs = useQuotaSettings(settings.apiKey);

  const [draftInterval, setDraftInterval] = useState<string | null>(null);
  const [draftPrimary, setDraftPrimary] = useState<string | null>(null);
  const [draftSecondary, setDraftSecondary] = useState<string | null>(null);
  const [draftSkip, setDraftSkip] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const currentInterval = qs.data?.refresh_interval_minutes ?? 5;
  const currentPrimary = qs.data?.warning_thresholds.primary ?? [80, 90];
  const currentSecondary = qs.data?.warning_thresholds.secondary ?? [80, 90];
  const currentSkip = qs.data?.skip_exhausted ?? true;

  const displayInterval = draftInterval ?? String(currentInterval);
  const displayPrimary = draftPrimary ?? currentPrimary.join(", ");
  const displaySecondary = draftSecondary ?? currentSecondary.join(", ");
  const displaySkip = draftSkip ?? currentSkip;

  const isDirty =
    draftInterval !== null ||
    draftPrimary !== null ||
    draftSecondary !== null ||
    draftSkip !== null;

  const parseThresholds = (str: string): number[] | null => {
    if (!str.trim()) return [];
    const parts = str.split(",").map((s) => s.trim()).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.some((n) => isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100)) return null;
    return nums.sort((a, b) => a - b);
  };

  const handleSave = useCallback(async () => {
    const patch: Record<string, unknown> = {};

    if (draftInterval !== null) {
      const val = parseInt(draftInterval, 10);
      if (isNaN(val) || val < 1) return;
      patch.refresh_interval_minutes = val;
    }

    if (draftPrimary !== null || draftSecondary !== null) {
      const thresholds: Record<string, number[]> = {};
      if (draftPrimary !== null) {
        const parsed = parseThresholds(draftPrimary);
        if (!parsed) return;
        thresholds.primary = parsed;
      }
      if (draftSecondary !== null) {
        const parsed = parseThresholds(draftSecondary);
        if (!parsed) return;
        thresholds.secondary = parsed;
      }
      patch.warning_thresholds = thresholds;
    }

    if (draftSkip !== null) {
      patch.skip_exhausted = draftSkip;
    }

    await qs.save(patch);
    setDraftInterval(null);
    setDraftPrimary(null);
    setDraftSecondary(null);
    setDraftSkip(null);
  }, [draftInterval, draftPrimary, draftSecondary, draftSkip, qs]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("quotaSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          {/* Refresh interval */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("quotaRefreshInterval")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("quotaRefreshIntervalHint")}</p>
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="1"
                class={`${inputCls} max-w-[120px]`}
                value={displayInterval}
                onInput={(e) => setDraftInterval((e.target as HTMLInputElement).value)}
              />
              <span class="text-xs text-slate-500 dark:text-text-dim">{t("minutes")}</span>
            </div>
          </div>

          {/* Primary thresholds */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("quotaPrimaryThresholds")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("quotaThresholdsHint")}</p>
            <input
              type="text"
              class={inputCls}
              value={displayPrimary}
              onInput={(e) => setDraftPrimary((e.target as HTMLInputElement).value)}
              placeholder="80, 90"
            />
          </div>

          {/* Secondary thresholds */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("quotaSecondaryThresholds")}
            </label>
            <input
              type="text"
              class={inputCls}
              value={displaySecondary}
              onInput={(e) => setDraftSecondary((e.target as HTMLInputElement).value)}
              placeholder="80, 90"
            />
          </div>

          {/* Skip exhausted */}
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="skip-exhausted"
              checked={displaySkip}
              onChange={(e) => setDraftSkip((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
            />
            <label for="skip-exhausted" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
              {t("quotaSkipExhausted")}
            </label>
          </div>

          {/* Save button + status */}
          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={qs.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !qs.saving
                  ? "bg-primary text-white hover:bg-primary/90 cursor-pointer"
                  : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
              }`}
            >
              {qs.saving ? "..." : t("submit")}
            </button>
            {qs.saved && (
              <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("quotaSaved")}</span>
            )}
            {qs.error && (
              <span class="text-xs font-medium text-red-500">{qs.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
