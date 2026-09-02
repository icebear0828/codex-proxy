import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { useSettings } from "../../../shared/hooks/use-settings";
import { SettingItemControl } from "./settings/SettingItemControl";

export function LogsSettings() {
  const t = useT();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);

  const [draftLogsEnabled, setDraftLogsEnabled] = useState<boolean | null>(null);
  const [draftLogsCapacity, setDraftLogsCapacity] = useState<string | null>(null);
  const [draftLogsCaptureBody, setDraftLogsCaptureBody] = useState<boolean | null>(null);
  const [draftLogsLlmOnly, setDraftLogsLlmOnly] = useState<boolean | null>(null);

  const [savingField, setSavingField] = useState<string | null>(null);
  const [savedFields, setSavedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  const currentLogsEnabled = gs.data?.logs_enabled ?? false;
  const currentLogsCapacity = gs.data?.logs_capacity ?? 2000;
  const currentLogsCaptureBody = gs.data?.logs_capture_body ?? false;
  const currentLogsLlmOnly = gs.data?.logs_llm_only ?? true;

  const displayLogsEnabled = draftLogsEnabled ?? currentLogsEnabled;
  const displayLogsCapacity = draftLogsCapacity ?? String(currentLogsCapacity);
  const displayLogsCaptureBody = draftLogsCaptureBody ?? currentLogsCaptureBody;
  const displayLogsLlmOnly = draftLogsLlmOnly ?? currentLogsLlmOnly;

  const saveSingleField = useCallback(async (fieldName: string, patch: Record<string, unknown>, resetDraft: () => void) => {
    setSavingField(fieldName);
    setFieldErrors((prev) => ({ ...prev, [fieldName]: null }));
    try {
      await gs.save(patch);
      resetDraft();
      setSavedFields((prev) => ({ ...prev, [fieldName]: true }));
    } catch (err: unknown) {
      setFieldErrors((prev) => ({ ...prev, [fieldName]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setSavingField(null);
    }
  }, [gs]);

  const handleSaveLogsEnabled = useCallback(() => {
    if (draftLogsEnabled === null) return;
    saveSingleField("logs_enabled", { logs_enabled: draftLogsEnabled }, () => setDraftLogsEnabled(null));
  }, [draftLogsEnabled, saveSingleField]);

  const handleSaveLogsCapacity = useCallback(() => {
    if (draftLogsCapacity === null) return;
    const val = parseInt(draftLogsCapacity, 10);
    if (isNaN(val) || val < 1) {
      setFieldErrors((prev) => ({ ...prev, logs_capacity: "Invalid capacity" }));
      return;
    }
    saveSingleField("logs_capacity", { logs_capacity: val }, () => setDraftLogsCapacity(null));
  }, [draftLogsCapacity, saveSingleField]);

  const handleSaveLogsCaptureBody = useCallback(() => {
    if (draftLogsCaptureBody === null) return;
    saveSingleField("logs_capture_body", { logs_capture_body: draftLogsCaptureBody }, () => setDraftLogsCaptureBody(null));
  }, [draftLogsCaptureBody, saveSingleField]);

  const handleSaveLogsLlmOnly = useCallback(() => {
    if (draftLogsLlmOnly === null) return;
    saveSingleField("logs_llm_only", { logs_llm_only: draftLogsLlmOnly }, () => setDraftLogsLlmOnly(null));
  }, [draftLogsLlmOnly, saveSingleField]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 3.75A.75.75 0 013.75 3h16.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75H3.75A.75.75 0 013 8.25v-4.5zM3 15.75a.75.75 0 01.75-.75h16.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75H3.75a.75.75 0 01-.75-.75v-4.5zM6.75 6h.008v.008H6.75V6zm0 12h.008v.008H6.75V18zm3 0h7.5" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("logsSettings")}</h2>
        </div>
      </div>

      <div class="px-5 py-2">
        {/* Enable Logs */}
        <SettingItemControl
          label={t("logsEnable")}
          hint={t("logsEnabledHint")}
          isDirty={draftLogsEnabled !== null && draftLogsEnabled !== currentLogsEnabled}
          saving={savingField === "logs_enabled"}
          saved={savedFields.logs_enabled}
          error={fieldErrors.logs_enabled}
          requiresRestart={false}
          layout="inline"
          onSave={handleSaveLogsEnabled}
        >
          <input
            type="checkbox"
            id="logs-enabled"
            checked={displayLogsEnabled}
            onChange={(e) => setDraftLogsEnabled((e.target as HTMLInputElement).checked)}
            class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
          />
          <label for="logs-enabled" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
            {t("logsEnable")}
          </label>
        </SettingItemControl>

        {/* Log Capacity */}
        <SettingItemControl
          label={t("logsCapacity")}
          hint={t("logsCapacityHint")}
          isDirty={draftLogsCapacity !== null && draftLogsCapacity !== String(currentLogsCapacity)}
          saving={savingField === "logs_capacity"}
          saved={savedFields.logs_capacity}
          error={fieldErrors.logs_capacity}
          requiresRestart={false}
          onSave={handleSaveLogsCapacity}
        >
          <input
            type="number"
            min="1"
            class={`${inputCls} max-w-[160px]`}
            value={displayLogsCapacity}
            onInput={(e) => setDraftLogsCapacity((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveLogsCapacity(); }}
          />
        </SettingItemControl>

        {/* Capture Body */}
        <SettingItemControl
          label={t("logsCaptureBody")}
          hint={t("logsCaptureBodyHint")}
          isDirty={draftLogsCaptureBody !== null && draftLogsCaptureBody !== currentLogsCaptureBody}
          saving={savingField === "logs_capture_body"}
          saved={savedFields.logs_capture_body}
          error={fieldErrors.logs_capture_body}
          requiresRestart={false}
          layout="inline"
          onSave={handleSaveLogsCaptureBody}
        >
          <input
            type="checkbox"
            id="logs-capture-body"
            checked={displayLogsCaptureBody}
            onChange={(e) => setDraftLogsCaptureBody((e.target as HTMLInputElement).checked)}
            class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
          />
          <label for="logs-capture-body" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
            {t("logsCaptureBody")}
          </label>
        </SettingItemControl>

        {/* LLM Only */}
        <SettingItemControl
          label={t("logsLlmOnly")}
          hint={t("logsLlmOnlyHint")}
          isDirty={draftLogsLlmOnly !== null && draftLogsLlmOnly !== currentLogsLlmOnly}
          saving={savingField === "logs_llm_only"}
          saved={savedFields.logs_llm_only}
          error={fieldErrors.logs_llm_only}
          requiresRestart={false}
          layout="inline"
          onSave={handleSaveLogsLlmOnly}
        >
          <input
            type="checkbox"
            id="logs-llm-only"
            checked={displayLogsLlmOnly}
            onChange={(e) => setDraftLogsLlmOnly((e.target as HTMLInputElement).checked)}
            class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
          />
          <label for="logs-llm-only" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
            {t("logsLlmOnly")}
          </label>
        </SettingItemControl>
      </div>
    </section>
  );
}
