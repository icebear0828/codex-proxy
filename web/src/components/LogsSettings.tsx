import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

export function LogsSettings() {
  const t = useT();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);

  const [draftLogsEnabled, setDraftLogsEnabled] = useState<boolean | null>(null);
  const [draftLogsCapacity, setDraftLogsCapacity] = useState<string | null>(null);
  const [draftLogsCaptureBody, setDraftLogsCaptureBody] = useState<boolean | null>(null);
  const [draftLogsLlmOnly, setDraftLogsLlmOnly] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const currentLogsEnabled = gs.data?.logs_enabled ?? false;
  const currentLogsCapacity = gs.data?.logs_capacity ?? 2000;
  const currentLogsCaptureBody = gs.data?.logs_capture_body ?? false;
  const currentLogsLlmOnly = gs.data?.logs_llm_only ?? true;

  const displayLogsEnabled = draftLogsEnabled ?? currentLogsEnabled;
  const displayLogsCapacity = draftLogsCapacity ?? String(currentLogsCapacity);
  const displayLogsCaptureBody = draftLogsCaptureBody ?? currentLogsCaptureBody;
  const displayLogsLlmOnly = draftLogsLlmOnly ?? currentLogsLlmOnly;

  const isDirty =
    draftLogsEnabled !== null ||
    draftLogsCapacity !== null ||
    draftLogsCaptureBody !== null ||
    draftLogsLlmOnly !== null;

  const handleSave = useCallback(async () => {
    const patch: Record<string, unknown> = {};

    if (draftLogsEnabled !== null) {
      patch.logs_enabled = draftLogsEnabled;
    }

    if (draftLogsCapacity !== null) {
      const val = parseInt(draftLogsCapacity, 10);
      if (isNaN(val) || val < 1) return;
      patch.logs_capacity = val;
    }

    if (draftLogsCaptureBody !== null) {
      patch.logs_capture_body = draftLogsCaptureBody;
    }

    if (draftLogsLlmOnly !== null) {
      patch.logs_llm_only = draftLogsLlmOnly;
    }

    await gs.save(patch);
    setDraftLogsEnabled(null);
    setDraftLogsCapacity(null);
    setDraftLogsCaptureBody(null);
    setDraftLogsLlmOnly(null);
  }, [draftLogsEnabled, draftLogsCapacity, draftLogsCaptureBody, draftLogsLlmOnly, gs]);

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
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 3.75A.75.75 0 013.75 3h16.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75H3.75A.75.75 0 013 8.25v-4.5zM3 15.75a.75.75 0 01.75-.75h16.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75H3.75a.75.75 0 01-.75-.75v-4.5zM6.75 6h.008v.008H6.75V6zm0 12h.008v.008H6.75V18zm3 0h7.5" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("logsSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("logsEnabledHint")}</p>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("logsCapacity")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("logsCapacityHint")}</p>
            <input
              type="number"
              min="1"
              class={`${inputCls} max-w-[160px]`}
              value={displayLogsCapacity}
              onInput={(e) => setDraftLogsCapacity((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("logsCaptureBodyHint")}</p>
          </div>

          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("logsLlmOnlyHint")}</p>
          </div>

          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={gs.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !gs.saving
                  ? "bg-primary-action text-white hover:bg-primary-action-hover cursor-pointer"
                  : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
              }`}
            >
              {gs.saving ? "..." : t("submit")}
            </button>
            {gs.saved && (
              <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("quotaSaved")}</span>
            )}
            {gs.error && (
              <span class="text-xs font-medium text-red-500">{gs.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
