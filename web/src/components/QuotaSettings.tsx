import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useQuotaSettings } from "../../../shared/hooks/use-quota-settings";
import { useSettings } from "../../../shared/hooks/use-settings";
import { SettingItemControl } from "./settings/SettingItemControl";

export function QuotaSettings() {
  const t = useT();
  const settings = useSettings();
  const qs = useQuotaSettings(settings.apiKey);

  const [draftInterval, setDraftInterval] = useState<string | null>(null);
  const [draftPrimary, setDraftPrimary] = useState<string | null>(null);
  const [draftSecondary, setDraftSecondary] = useState<string | null>(null);
  const [draftSkip, setDraftSkip] = useState<boolean | null>(null);

  const [savingFields, setSavingFields] = useState<Record<string, boolean>>({});
  const [savedFields, setSavedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  const currentInterval = qs.data?.refresh_interval_minutes ?? 5;
  const currentPrimary = qs.data?.warning_thresholds.primary ?? [80, 90];
  const currentSecondary = qs.data?.warning_thresholds.secondary ?? [80, 90];
  const currentSkip = qs.data?.skip_exhausted ?? true;

  const displayInterval = draftInterval ?? String(currentInterval);
  const displayPrimary = draftPrimary ?? currentPrimary.join(", ");
  const displaySecondary = draftSecondary ?? currentSecondary.join(", ");
  const displaySkip = draftSkip ?? currentSkip;

  const parseThresholds = (str: string): number[] | null => {
    if (!str.trim()) return [];
    const parts = str.split(",").map((s) => s.trim()).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.some((n) => isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100)) return null;
    return nums.sort((a, b) => a - b);
  };

  const saveSingleField = useCallback(async (fieldName: string, patch: Record<string, unknown>, resetDraft: () => void) => {
    setSavingFields((prev) => ({ ...prev, [fieldName]: true }));
    setFieldErrors((prev) => ({ ...prev, [fieldName]: null }));
    try {
      await qs.save(patch);
      resetDraft();
      setSavedFields((prev) => ({ ...prev, [fieldName]: true }));
    } catch (err: unknown) {
      setFieldErrors((prev) => ({ ...prev, [fieldName]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSavingFields((prev) => {
        const next = { ...prev };
        delete next[fieldName];
        return next;
      });
    }
  }, [qs]);

  const handleSaveInterval = useCallback(() => {
    if (draftInterval === null) return;
    const val = parseInt(draftInterval, 10);
    if (isNaN(val) || val < 0) {
      setFieldErrors((prev) => ({ ...prev, interval: t("settingErrorInterval") }));
      return;
    }
    saveSingleField("interval", { refresh_interval_minutes: val }, () => setDraftInterval(null));
  }, [draftInterval, saveSingleField, t]);

  const handleSavePrimary = useCallback(() => {
    if (draftPrimary === null) return;
    const parsed = parseThresholds(draftPrimary);
    if (!parsed) {
      setFieldErrors((prev) => ({ ...prev, primary: t("settingErrorThresholds") }));
      return;
    }
    const currentTh = qs.data?.warning_thresholds ?? { primary: [80, 90], secondary: [80, 90] };
    saveSingleField("primary", { warning_thresholds: { ...currentTh, primary: parsed } }, () => setDraftPrimary(null));
  }, [draftPrimary, qs.data?.warning_thresholds, saveSingleField, t]);

  const handleSaveSecondary = useCallback(() => {
    if (draftSecondary === null) return;
    const parsed = parseThresholds(draftSecondary);
    if (!parsed) {
      setFieldErrors((prev) => ({ ...prev, secondary: t("settingErrorThresholds") }));
      return;
    }
    const currentTh = qs.data?.warning_thresholds ?? { primary: [80, 90], secondary: [80, 90] };
    saveSingleField("secondary", { warning_thresholds: { ...currentTh, secondary: parsed } }, () => setDraftSecondary(null));
  }, [draftSecondary, qs.data?.warning_thresholds, saveSingleField, t]);

  const handleSaveSkip = useCallback(() => {
    if (draftSkip === null) return;
    saveSingleField("skip", { skip_exhausted: draftSkip }, () => setDraftSkip(null));
  }, [draftSkip, saveSingleField]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("settingsCategoryQuota")}</h2>
        </div>
      </div>

      <div class="px-5 py-2">
        {/* Refresh interval */}
        <SettingItemControl
          label={t("quotaRefreshInterval")}
          hint={t("quotaRefreshIntervalHint")}
          isDirty={draftInterval !== null && draftInterval !== String(currentInterval)}
          saving={!!savingFields.interval}
          saved={savedFields.interval}
          error={fieldErrors.interval}
          requiresRestart={false}
          onSave={handleSaveInterval}
        >
          <div class="flex items-center gap-2">
            <input
              type="number"
              min="0"
              class={`${inputCls} max-w-[140px]`}
              value={displayInterval}
              onInput={(e) => setDraftInterval((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveInterval(); }}
            />
            <span class="text-xs text-slate-500 dark:text-text-dim">{t("minutes")}</span>
          </div>
        </SettingItemControl>

        {/* Skip exhausted */}
        <SettingItemControl
          label={t("quotaSkipExhausted")}
          isDirty={draftSkip !== null && draftSkip !== currentSkip}
          saving={!!savingFields.skip}
          saved={savedFields.skip}
          error={fieldErrors.skip}
          requiresRestart={false}
          layout="inline"
          onSave={handleSaveSkip}
        >
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
        </SettingItemControl>

        {/* Primary thresholds */}
        <SettingItemControl
          label={t("quotaPrimaryThresholds")}
          hint={t("quotaThresholdsHint")}
          isDirty={draftPrimary !== null && draftPrimary !== currentPrimary.join(", ")}
          saving={!!savingFields.primary}
          saved={savedFields.primary}
          error={fieldErrors.primary}
          requiresRestart={false}
          onSave={handleSavePrimary}
        >
          <input
            type="text"
            class={inputCls}
            value={displayPrimary}
            onInput={(e) => setDraftPrimary((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSavePrimary(); }}
            placeholder="80, 90"
          />
        </SettingItemControl>

        {/* Secondary thresholds */}
        <SettingItemControl
          label={t("quotaSecondaryThresholds")}
          isDirty={draftSecondary !== null && draftSecondary !== currentSecondary.join(", ")}
          saving={!!savingFields.secondary}
          saved={savedFields.secondary}
          error={fieldErrors.secondary}
          requiresRestart={false}
          onSave={handleSaveSecondary}
        >
          <input
            type="text"
            class={inputCls}
            value={displaySecondary}
            onInput={(e) => setDraftSecondary((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveSecondary(); }}
            placeholder="80, 90"
          />
        </SettingItemControl>
      </div>
    </section>
  );
}
