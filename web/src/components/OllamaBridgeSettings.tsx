import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useOllamaSettings } from "../../../shared/hooks/use-ollama-settings";
import { useSettings } from "../../../shared/hooks/use-settings";
import { isNetworkExposedHost } from "../../../shared/utils/host";
import { SettingItemControl } from "./settings/SettingItemControl";

export function OllamaBridgeSettings() {
  const t = useT();
  const settings = useSettings();
  const ollama = useOllamaSettings(settings.apiKey);

  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftHost, setDraftHost] = useState<string | null>(null);
  const [draftPort, setDraftPort] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [draftDisableVision, setDraftDisableVision] = useState<boolean | null>(null);

  const [savingFields, setSavingFields] = useState<Record<string, boolean>>({});
  const [savedFields, setSavedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  const currentEnabled = ollama.data?.enabled ?? false;
  const currentHost = ollama.data?.host ?? "127.0.0.1";
  const currentPort = ollama.data?.port ?? 11434;
  const currentVersion = ollama.data?.version ?? "0.18.3";
  const currentDisableVision = ollama.data?.disable_vision ?? false;
  const status = ollama.data?.status;

  const displayEnabled = draftEnabled ?? currentEnabled;
  const displayHost = draftHost ?? currentHost;
  const displayPort = draftPort ?? String(currentPort);
  const displayVersion = draftVersion ?? currentVersion;
  const displayDisableVision = draftDisableVision ?? currentDisableVision;
  const exposesNetwork = isNetworkExposedHost(displayHost);

  const saveSingleField = useCallback(async (fieldName: string, patch: Record<string, unknown>, resetDraft: () => void) => {
    setSavingFields((prev) => ({ ...prev, [fieldName]: true }));
    setFieldErrors((prev) => ({ ...prev, [fieldName]: null }));
    try {
      await ollama.save(patch);
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
  }, [ollama]);

  const handleSaveEnabled = useCallback(() => {
    if (draftEnabled === null) return;
    saveSingleField("enabled", { enabled: draftEnabled }, () => setDraftEnabled(null));
  }, [draftEnabled, saveSingleField]);

  const handleSaveHost = useCallback(() => {
    if (draftHost === null) return;
    saveSingleField("host", { host: draftHost.trim() }, () => setDraftHost(null));
  }, [draftHost, saveSingleField]);

  const handleSavePort = useCallback(() => {
    if (draftPort === null) return;
    const val = parseInt(draftPort, 10);
    if (isNaN(val) || val < 1 || val > 65535) {
      setFieldErrors((prev) => ({ ...prev, port: t("settingErrorPort") }));
      return;
    }
    saveSingleField("port", { port: val }, () => setDraftPort(null));
  }, [draftPort, saveSingleField, t]);

  const handleSaveVersion = useCallback(() => {
    if (draftVersion === null) return;
    saveSingleField("version", { version: draftVersion.trim() }, () => setDraftVersion(null));
  }, [draftVersion, saveSingleField]);

  const handleSaveDisableVision = useCallback(() => {
    if (draftDisableVision === null) return;
    saveSingleField("disable_vision", { disable_vision: draftDisableVision }, () => setDraftDisableVision(null));
  }, [draftDisableVision, saveSingleField]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 6.75A2.25 2.25 0 016.75 4.5h10.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25H6.75a2.25 2.25 0 01-2.25-2.25V6.75z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 9.75h7.5m-7.5 4.5h4.5" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("settingsCategoryOllama")}</h2>
        </div>
        <div class="flex items-center gap-2">
          <span class={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            status?.running
              ? "bg-success-container text-success"
              : status?.error
                ? "bg-danger-container text-danger"
                : "bg-slate-100 text-slate-600 dark:bg-[#21262d] dark:text-text-dim"
          }`}>
            {status?.running
              ? t("ollamaBridgeRunning")
              : status?.error
                ? t("ollamaBridgeError")
                : t("ollamaBridgeStopped")}
          </span>
          <button
            onClick={ollama.load}
            class="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:text-text-dim dark:hover:text-text-main hover:bg-slate-100 dark:hover:bg-border-dark"
            title={t("refresh")}
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.985 4.356v4.992" />
            </svg>
          </button>
        </div>
      </div>

      <div class="px-5 py-2">
        {status?.endpoint && (
          <div class="py-2 flex items-center gap-2 text-xs text-slate-500 dark:text-text-dim">
            <span>Endpoint:</span>
            <code class="px-2 py-0.5 rounded bg-slate-100 dark:bg-bg-dark font-mono text-slate-700 dark:text-text-main">
              {status.endpoint}
            </code>
          </div>
        )}

        {status?.error && (
          <div class="my-2 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-lg text-xs text-red-700 dark:text-red-400">
            {status.error}
          </div>
        )}

        {/* Enable Ollama */}
        <SettingItemControl
          label={t("ollamaBridgeEnabled")}
          hint={t("ollamaBridgeEnabledHint")}
          isDirty={draftEnabled !== null && draftEnabled !== currentEnabled}
          saving={!!savingFields.enabled}
          saved={savedFields.enabled}
          error={fieldErrors.enabled}
          requiresRestart={true}
          layout="inline"
          onSave={handleSaveEnabled}
        >
          <input
            type="checkbox"
            id="ollama-enabled"
            checked={displayEnabled}
            onChange={(e) => setDraftEnabled((e.target as HTMLInputElement).checked)}
            class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
          />
          <label for="ollama-enabled" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
            {t("ollamaBridgeEnabled")}
          </label>
        </SettingItemControl>

        {/* Listen Host */}
        <SettingItemControl
          label={t("ollamaBridgeHost")}
          hint={t("ollamaBridgeHostHint")}
          isDirty={draftHost !== null && draftHost !== currentHost}
          saving={!!savingFields.host}
          saved={savedFields.host}
          error={fieldErrors.host}
          requiresRestart={true}
          onSave={handleSaveHost}
        >
          <input
            type="text"
            class={inputCls}
            value={displayHost}
            onInput={(e) => setDraftHost((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveHost(); }}
            placeholder="127.0.0.1"
          />
        </SettingItemControl>

        {exposesNetwork && (
          <div class="my-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg text-xs text-amber-700 dark:text-amber-400">
            {t("ollamaBridgeHostWarning")}
          </div>
        )}

        {/* Listen Port */}
        <SettingItemControl
          label={t("ollamaBridgePort")}
          hint={t("ollamaBridgePortHint")}
          isDirty={draftPort !== null && draftPort !== String(currentPort)}
          saving={!!savingFields.port}
          saved={savedFields.port}
          error={fieldErrors.port}
          requiresRestart={true}
          onSave={handleSavePort}
        >
          <input
            type="number"
            min="1"
            max="65535"
            class={`${inputCls} max-w-[160px]`}
            value={displayPort}
            onInput={(e) => setDraftPort((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSavePort(); }}
          />
        </SettingItemControl>

        {/* Reported Version */}
        <SettingItemControl
          label={t("ollamaBridgeVersion")}
          hint={t("ollamaBridgeVersionHint")}
          isDirty={draftVersion !== null && draftVersion !== currentVersion}
          saving={!!savingFields.version}
          saved={savedFields.version}
          error={fieldErrors.version}
          requiresRestart={false}
          onSave={handleSaveVersion}
        >
          <input
            type="text"
            class={`${inputCls} max-w-[220px]`}
            value={displayVersion}
            onInput={(e) => setDraftVersion((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveVersion(); }}
          />
        </SettingItemControl>

        {/* Disable Vision */}
        <SettingItemControl
          label={t("ollamaBridgeDisableVision")}
          hint={t("ollamaBridgeDisableVisionHint")}
          isDirty={draftDisableVision !== null && draftDisableVision !== currentDisableVision}
          saving={!!savingFields.disable_vision}
          saved={savedFields.disable_vision}
          error={fieldErrors.disable_vision}
          requiresRestart={false}
          layout="inline"
          onSave={handleSaveDisableVision}
        >
          <input
            type="checkbox"
            id="ollama-disable-vision"
            checked={displayDisableVision}
            onChange={(e) => setDraftDisableVision((e.target as HTMLInputElement).checked)}
            class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
          />
          <label for="ollama-disable-vision" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
            {t("ollamaBridgeDisableVision")}
          </label>
        </SettingItemControl>
      </div>
    </section>
  );
}
