import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useGeneralSettings, type SystemPromptStrategy } from "../../../shared/hooks/use-general-settings";
import { useSettings } from "../../../shared/hooks/use-settings";
import { getLayoutMode, saveLayoutMode, type LayoutMode } from "../lib/layout-preferences";
import { SettingItemControl } from "./settings/SettingItemControl";

interface GeneralSettingsProps {
  layoutMode?: LayoutMode;
  onLayoutModeChange?: (mode: LayoutMode) => void;
}

export function GeneralSettings({ layoutMode, onLayoutModeChange }: GeneralSettingsProps = {}) {
  const t = useT();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);

  const [draftPort, setDraftPort] = useState<string | null>(null);
  const [draftProxyUrl, setDraftProxyUrl] = useState<string | null>(null);
  const [draftForceHttp11, setDraftForceHttp11] = useState<boolean | null>(null);
  const [draftInjectContext, setDraftInjectContext] = useState<boolean | null>(null);
  const [draftSuppressDirectives, setDraftSuppressDirectives] = useState<boolean | null>(null);
  const [draftAllowSystemPromptStrategy, setDraftAllowSystemPromptStrategy] = useState<boolean | null>(null);
  const [draftSystemPromptStrategy, setDraftSystemPromptStrategy] = useState<SystemPromptStrategy | null>(null);
  const [draftDefaultModel, setDraftDefaultModel] = useState<string | null>(null);
  const [draftImageHostModel, setDraftImageHostModel] = useState<string | null>(null);
  const [draftReasoningEffort, setDraftReasoningEffort] = useState<string | null>(null);
  const [draftRefreshEnabled, setDraftRefreshEnabled] = useState<boolean | null>(null);
  const [draftRefreshMargin, setDraftRefreshMargin] = useState<string | null>(null);
  const [draftRefreshConcurrency, setDraftRefreshConcurrency] = useState<string | null>(null);
  const [draftMaxConcurrent, setDraftMaxConcurrent] = useState<string | null>(null);
  const [draftRequestInterval, setDraftRequestInterval] = useState<string | null>(null);
  const [draftUsageHistoryRetention, setDraftUsageHistoryRetention] = useState<string | null>(null);
  const [draftAutoUpdate, setDraftAutoUpdate] = useState<boolean | null>(null);
  const [draftAutoDownload, setDraftAutoDownload] = useState<boolean | null>(null);
  const [draftShowUpdateDialog, setDraftShowUpdateDialog] = useState<boolean | null>(null);
  const [draftAllowPrerelease, setDraftAllowPrerelease] = useState<boolean | null>(null);
  const [localLayoutMode, setLocalLayoutMode] = useState<LayoutMode>(() => getLayoutMode());
  const [collapsed, setCollapsed] = useState(true);

  // Field-level saving / saved states
  const [savingField, setSavingField] = useState<string | null>(null);
  const [savedFields, setSavedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  const currentPort = gs.data?.port ?? 8080;
  const currentProxyUrl = gs.data?.proxy_url ?? "";
  const currentForceHttp11 = gs.data?.force_http11 ?? false;
  const currentInjectContext = gs.data?.inject_desktop_context ?? false;
  const currentSuppressDirectives = gs.data?.suppress_desktop_directives ?? false;
  const currentAllowSystemPromptStrategy = gs.data?.allow_client_system_prompt_strategy ?? false;
  const currentSystemPromptStrategy = gs.data?.system_prompt_strategy ?? "instructions";
  const currentDefaultModel = gs.data?.default_model ?? "";
  const currentImageHostModel = gs.data?.image_host_model ?? "";
  const currentImageHostModelAllowedModels = gs.data?.image_host_model_allowed_models ?? [];
  const currentReasoningEffort = gs.data?.default_reasoning_effort ?? "";
  const currentRefreshEnabled = gs.data?.refresh_enabled ?? true;
  const currentRefreshMargin = gs.data?.refresh_margin_seconds ?? 300;
  const currentRefreshConcurrency = gs.data?.refresh_concurrency ?? 2;
  const currentMaxConcurrent = gs.data?.max_concurrent_per_account ?? 3;
  const currentRequestInterval = gs.data?.request_interval_ms ?? 50;
  const currentUsageHistoryRetention = gs.data?.usage_history_retention_days ?? null;
  const currentAutoUpdate = gs.data?.auto_update ?? true;
  const currentAutoDownload = gs.data?.auto_download ?? false;
  const currentShowUpdateDialog = gs.data?.show_update_dialog ?? false;
  const currentAllowPrerelease = gs.data?.allow_prerelease ?? false;

  const displayPort = draftPort ?? String(currentPort);
  const displayProxyUrl = draftProxyUrl ?? currentProxyUrl;
  const displayForceHttp11 = draftForceHttp11 ?? currentForceHttp11;
  const displayInjectContext = draftInjectContext ?? currentInjectContext;
  const displaySuppressDirectives = draftSuppressDirectives ?? currentSuppressDirectives;
  const displayAllowSystemPromptStrategy = draftAllowSystemPromptStrategy ?? currentAllowSystemPromptStrategy;
  const canEditSystemPromptStrategy = displayAllowSystemPromptStrategy;
  const displaySystemPromptStrategy = draftSystemPromptStrategy ?? currentSystemPromptStrategy;
  const displayDefaultModel = draftDefaultModel ?? currentDefaultModel;
  const displayImageHostModel = draftImageHostModel ?? currentImageHostModel;
  const displayReasoningEffort = draftReasoningEffort ?? currentReasoningEffort;
  const displayRefreshEnabled = draftRefreshEnabled ?? currentRefreshEnabled;
  const displayRefreshMargin = draftRefreshMargin ?? String(currentRefreshMargin);
  const displayRefreshConcurrency = draftRefreshConcurrency ?? String(currentRefreshConcurrency);
  const displayMaxConcurrent = draftMaxConcurrent ?? String(currentMaxConcurrent);
  const displayRequestInterval = draftRequestInterval ?? String(currentRequestInterval);
  const displayUsageHistoryRetention = draftUsageHistoryRetention ?? (currentUsageHistoryRetention === null ? "" : String(currentUsageHistoryRetention));
  const displayAutoUpdate = draftAutoUpdate ?? currentAutoUpdate;
  const displayAutoDownload = draftAutoDownload ?? currentAutoDownload;
  const displayShowUpdateDialog = draftShowUpdateDialog ?? currentShowUpdateDialog;
  const displayAllowPrerelease = draftAllowPrerelease ?? currentAllowPrerelease;
  const displayLayoutMode = layoutMode ?? localLayoutMode;

  const handleLayoutModeChange = (mode: LayoutMode) => {
    setLocalLayoutMode(mode);
    saveLayoutMode(mode);
    onLayoutModeChange?.(mode);
    setSavedFields((prev) => ({ ...prev, layoutMode: true }));
    setTimeout(() => {
      setSavedFields((prev) => ({ ...prev, layoutMode: false }));
    }, 2000);
  };

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

  const handleSavePort = useCallback(() => {
    if (draftPort === null) return;
    const val = parseInt(draftPort, 10);
    if (isNaN(val) || val < 1 || val > 65535) {
      setFieldErrors((prev) => ({ ...prev, port: "Invalid port number (1-65535)" }));
      return;
    }
    saveSingleField("port", { port: val }, () => setDraftPort(null));
  }, [draftPort, saveSingleField]);

  const handleSaveProxyUrl = useCallback(() => {
    if (draftProxyUrl === null) return;
    saveSingleField("proxy_url", { proxy_url: draftProxyUrl.trim() || null }, () => setDraftProxyUrl(null));
  }, [draftProxyUrl, saveSingleField]);

  const handleSaveForceHttp11 = useCallback(() => {
    if (draftForceHttp11 === null) return;
    saveSingleField("force_http11", { force_http11: draftForceHttp11 }, () => setDraftForceHttp11(null));
  }, [draftForceHttp11, saveSingleField]);

  const handleSaveInjectContext = useCallback(() => {
    if (draftInjectContext === null) return;
    saveSingleField("inject_desktop_context", { inject_desktop_context: draftInjectContext }, () => setDraftInjectContext(null));
  }, [draftInjectContext, saveSingleField]);

  const handleSaveSuppressDirectives = useCallback(() => {
    if (draftSuppressDirectives === null) return;
    saveSingleField("suppress_desktop_directives", { suppress_desktop_directives: draftSuppressDirectives }, () => setDraftSuppressDirectives(null));
  }, [draftSuppressDirectives, saveSingleField]);

  const handleSaveAllowSystemPromptStrategy = useCallback(() => {
    if (draftAllowSystemPromptStrategy === null) return;
    saveSingleField("allow_client_system_prompt_strategy", { allow_client_system_prompt_strategy: draftAllowSystemPromptStrategy }, () => setDraftAllowSystemPromptStrategy(null));
  }, [draftAllowSystemPromptStrategy, saveSingleField]);

  const handleSaveSystemPromptStrategy = useCallback(() => {
    if (draftSystemPromptStrategy === null) return;
    saveSingleField("system_prompt_strategy", { system_prompt_strategy: draftSystemPromptStrategy }, () => setDraftSystemPromptStrategy(null));
  }, [draftSystemPromptStrategy, saveSingleField]);

  const handleSaveDefaultModel = useCallback(() => {
    if (draftDefaultModel === null) return;
    saveSingleField("default_model", { default_model: draftDefaultModel.trim() }, () => setDraftDefaultModel(null));
  }, [draftDefaultModel, saveSingleField]);

  const handleSaveImageHostModel = useCallback(() => {
    if (draftImageHostModel === null) return;
    saveSingleField("image_host_model", { image_host_model: draftImageHostModel.trim() }, () => setDraftImageHostModel(null));
  }, [draftImageHostModel, saveSingleField]);

  const handleSaveReasoningEffort = useCallback(() => {
    if (draftReasoningEffort === null) return;
    saveSingleField("default_reasoning_effort", { default_reasoning_effort: draftReasoningEffort === "" ? null : draftReasoningEffort }, () => setDraftReasoningEffort(null));
  }, [draftReasoningEffort, saveSingleField]);

  const handleSaveRefreshEnabled = useCallback(() => {
    if (draftRefreshEnabled === null) return;
    saveSingleField("refresh_enabled", { refresh_enabled: draftRefreshEnabled }, () => setDraftRefreshEnabled(null));
  }, [draftRefreshEnabled, saveSingleField]);

  const handleSaveRefreshMargin = useCallback(() => {
    if (draftRefreshMargin === null) return;
    const val = parseInt(draftRefreshMargin, 10);
    if (isNaN(val) || val < 0) return;
    saveSingleField("refresh_margin_seconds", { refresh_margin_seconds: val }, () => setDraftRefreshMargin(null));
  }, [draftRefreshMargin, saveSingleField]);

  const handleSaveRefreshConcurrency = useCallback(() => {
    if (draftRefreshConcurrency === null) return;
    const val = parseInt(draftRefreshConcurrency, 10);
    if (isNaN(val) || val < 1) return;
    saveSingleField("refresh_concurrency", { refresh_concurrency: val }, () => setDraftRefreshConcurrency(null));
  }, [draftRefreshConcurrency, saveSingleField]);

  const handleSaveMaxConcurrent = useCallback(() => {
    if (draftMaxConcurrent === null) return;
    const val = parseInt(draftMaxConcurrent, 10);
    if (isNaN(val) || val < 1) return;
    saveSingleField("max_concurrent_per_account", { max_concurrent_per_account: val }, () => setDraftMaxConcurrent(null));
  }, [draftMaxConcurrent, saveSingleField]);

  const handleSaveRequestInterval = useCallback(() => {
    if (draftRequestInterval === null) return;
    const val = parseInt(draftRequestInterval, 10);
    if (isNaN(val) || val < 0) return;
    saveSingleField("request_interval_ms", { request_interval_ms: val }, () => setDraftRequestInterval(null));
  }, [draftRequestInterval, saveSingleField]);

  const handleSaveUsageHistoryRetention = useCallback(() => {
    if (draftUsageHistoryRetention === null) return;
    const trimmed = draftUsageHistoryRetention.trim();
    const val = trimmed === "" ? null : Number(trimmed);
    if (val !== null && (!Number.isInteger(val) || val < 1)) return;
    saveSingleField("usage_history_retention_days", { usage_history_retention_days: val }, () => setDraftUsageHistoryRetention(null));
  }, [draftUsageHistoryRetention, saveSingleField]);

  const handleSaveAutoUpdate = useCallback(() => {
    if (draftAutoUpdate === null) return;
    saveSingleField("auto_update", { auto_update: draftAutoUpdate }, () => setDraftAutoUpdate(null));
  }, [draftAutoUpdate, saveSingleField]);

  const handleSaveAutoDownload = useCallback(() => {
    if (draftAutoDownload === null) return;
    saveSingleField("auto_download", { auto_download: draftAutoDownload }, () => setDraftAutoDownload(null));
  }, [draftAutoDownload, saveSingleField]);

  const handleSaveShowUpdateDialog = useCallback(() => {
    if (draftShowUpdateDialog === null) return;
    saveSingleField("show_update_dialog", { show_update_dialog: draftShowUpdateDialog }, () => setDraftShowUpdateDialog(null));
  }, [draftShowUpdateDialog, saveSingleField]);

  const handleSaveAllowPrerelease = useCallback(() => {
    if (draftAllowPrerelease === null) return;
    saveSingleField("allow_prerelease", { allow_prerelease: draftAllowPrerelease }, () => setDraftAllowPrerelease(null));
  }, [draftAllowPrerelease, saveSingleField]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <div class="space-y-6">
      {/* 1. Service & Network */}
      <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
        <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
            </div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("settingsCategoryService")}</h2>
          </div>
        </div>

        <div class="px-5 py-2">
          {/* Server Port */}
          <SettingItemControl
            label={t("generalSettingsPort")}
            hint={t("generalSettingsPortHint")}
            isDirty={draftPort !== null && draftPort !== String(currentPort)}
            saving={savingField === "port"}
            saved={savedFields.port}
            error={fieldErrors.port}
            requiresRestart={true}
            onSave={handleSavePort}
          >
            <input
              type="number"
              min="1"
              max="65535"
              class={`${inputCls} max-w-[180px]`}
              value={displayPort}
              onInput={(e) => setDraftPort((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSavePort(); }}
            />
          </SettingItemControl>

          {/* Upstream Proxy */}
          <SettingItemControl
            label={t("generalSettingsProxyUrl")}
            hint={t("generalSettingsProxyUrlHint")}
            isDirty={draftProxyUrl !== null && draftProxyUrl !== currentProxyUrl}
            saving={savingField === "proxy_url"}
            saved={savedFields.proxy_url}
            error={fieldErrors.proxy_url}
            requiresRestart={true}
            onSave={handleSaveProxyUrl}
          >
            <input
              type="text"
              class={inputCls}
              value={displayProxyUrl}
              onInput={(e) => setDraftProxyUrl((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveProxyUrl(); }}
              placeholder="socks5://127.0.0.1:1080"
            />
          </SettingItemControl>

          {/* Force HTTP/1.1 */}
          <SettingItemControl
            label={t("generalSettingsForceHttp11")}
            hint={t("generalSettingsForceHttp11Hint")}
            isDirty={draftForceHttp11 !== null && draftForceHttp11 !== currentForceHttp11}
            saving={savingField === "force_http11"}
            saved={savedFields.force_http11}
            error={fieldErrors.force_http11}
            requiresRestart={true}
            layout="inline"
            onSave={handleSaveForceHttp11}
          >
            <input
              type="checkbox"
              id="force-http11"
              checked={displayForceHttp11}
              onChange={(e) => setDraftForceHttp11((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
            />
            <label for="force-http11" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
              {t("generalSettingsForceHttp11")}
            </label>
          </SettingItemControl>
        </div>
      </section>

      {/* 2. Model & Generation Defaults */}
      <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
        <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("settingsCategoryModel")}</h2>
          </div>
        </div>

        <div class="px-5 py-2">
          {/* Default Model */}
          <SettingItemControl
            label={t("generalSettingsDefaultModel")}
            hint={t("generalSettingsDefaultModelHint")}
            isDirty={draftDefaultModel !== null && draftDefaultModel !== currentDefaultModel}
            saving={savingField === "default_model"}
            saved={savedFields.default_model}
            error={fieldErrors.default_model}
            requiresRestart={false}
            onSave={handleSaveDefaultModel}
          >
            <input
              type="text"
              class={inputCls}
              value={displayDefaultModel}
              onInput={(e) => setDraftDefaultModel((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveDefaultModel(); }}
              placeholder="gpt-5.2-codex"
            />
          </SettingItemControl>

          {/* Images API Host Model */}
          <SettingItemControl
            label={t("generalSettingsImageHostModel")}
            hint={t("generalSettingsImageHostModelHint")}
            isDirty={draftImageHostModel !== null && draftImageHostModel !== currentImageHostModel}
            saving={savingField === "image_host_model"}
            saved={savedFields.image_host_model}
            error={fieldErrors.image_host_model}
            requiresRestart={false}
            onSave={handleSaveImageHostModel}
          >
            <input
              id="image-host-model"
              type="text"
              class={inputCls}
              value={displayImageHostModel}
              list="image-host-model-allowed-models"
              onInput={(e) => setDraftImageHostModel((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveImageHostModel(); }}
              placeholder="gpt-5.5"
            />
            <datalist id="image-host-model-allowed-models">
              {currentImageHostModelAllowedModels.map((model: string) => <option key={model} value={model} />)}
            </datalist>
          </SettingItemControl>

          {/* Default Reasoning Effort */}
          <SettingItemControl
            label={t("generalSettingsReasoningEffort")}
            hint={t("generalSettingsReasoningEffortHint")}
            isDirty={draftReasoningEffort !== null && draftReasoningEffort !== currentReasoningEffort}
            saving={savingField === "default_reasoning_effort"}
            saved={savedFields.default_reasoning_effort}
            error={fieldErrors.default_reasoning_effort}
            requiresRestart={false}
            onSave={handleSaveReasoningEffort}
          >
            <select
              class={`${inputCls} max-w-[220px]`}
              value={displayReasoningEffort}
              onChange={(e) => setDraftReasoningEffort((e.target as HTMLSelectElement).value)}
            >
              <option value="">Disabled (no reasoning)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </SettingItemControl>

          {/* Client System Prompt Strategy Switch */}
          <SettingItemControl
            label={t("generalSettingsAllowSystemPromptStrategy")}
            hint={t("generalSettingsAllowSystemPromptStrategyHint")}
            isDirty={draftAllowSystemPromptStrategy !== null && draftAllowSystemPromptStrategy !== currentAllowSystemPromptStrategy}
            saving={savingField === "allow_client_system_prompt_strategy"}
            saved={savedFields.allow_client_system_prompt_strategy}
            error={fieldErrors.allow_client_system_prompt_strategy}
            requiresRestart={false}
            layout="inline"
            onSave={handleSaveAllowSystemPromptStrategy}
          >
            <input
              type="checkbox"
              id="allow-system-prompt-strategy"
              checked={displayAllowSystemPromptStrategy}
              onChange={(e) => setDraftAllowSystemPromptStrategy((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
            />
            <label for="allow-system-prompt-strategy" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
              {t("generalSettingsAllowSystemPromptStrategy")}
            </label>
          </SettingItemControl>

          {/* System Prompt Strategy */}
          <SettingItemControl
            label={t("generalSettingsSystemPromptStrategy")}
            hint={
              <div class="text-[0.73rem] text-slate-500 dark:text-text-dim space-y-1">
                <p>{t("generalSettingsSystemPromptStrategyHintIntro")}</p>
                <ul class="space-y-0.5">
                  <li class="flex gap-1.5"><code class="font-mono text-[0.68rem] text-slate-600 dark:text-text-main shrink-0">instructions</code> <span>{t("generalSettingsSystemPromptStrategyDescInstructions")}</span></li>
                  <li class="flex gap-1.5"><code class="font-mono text-[0.68rem] text-slate-600 dark:text-text-main shrink-0">developer_inline</code> <span>{t("generalSettingsSystemPromptStrategyDescDeveloperInline")}</span></li>
                  <li class="flex gap-1.5"><code class="font-mono text-[0.68rem] text-slate-600 dark:text-text-main shrink-0">system_inline</code> <span>{t("generalSettingsSystemPromptStrategyDescSystemInline")}</span></li>
                </ul>
              </div>
            }
            isDirty={draftSystemPromptStrategy !== null && draftSystemPromptStrategy !== currentSystemPromptStrategy}
            saving={savingField === "system_prompt_strategy"}
            saved={savedFields.system_prompt_strategy}
            error={fieldErrors.system_prompt_strategy}
            requiresRestart={false}
            disabled={!canEditSystemPromptStrategy}
            onSave={handleSaveSystemPromptStrategy}
          >
            <select
              class={`${inputCls} max-w-[280px] ${canEditSystemPromptStrategy ? "" : "cursor-not-allowed opacity-50"}`}
              value={displaySystemPromptStrategy}
              disabled={!canEditSystemPromptStrategy}
              onChange={(e) => setDraftSystemPromptStrategy((e.target as HTMLSelectElement).value as SystemPromptStrategy)}
            >
              <option value="instructions">{t("generalSettingsSystemPromptStrategyOptionInstructions")}</option>
              <option value="developer_inline">{t("generalSettingsSystemPromptStrategyOptionDeveloperInline")}</option>
              <option value="system_inline">{t("generalSettingsSystemPromptStrategyOptionSystemInline")}</option>
            </select>
          </SettingItemControl>

          {/* Inject Desktop Context */}
          <SettingItemControl
            label={t("generalSettingsInjectContext")}
            hint={t("generalSettingsInjectContextHint")}
            isDirty={draftInjectContext !== null && draftInjectContext !== currentInjectContext}
            saving={savingField === "inject_desktop_context"}
            saved={savedFields.inject_desktop_context}
            error={fieldErrors.inject_desktop_context}
            requiresRestart={false}
            layout="inline"
            onSave={handleSaveInjectContext}
          >
            <input
              type="checkbox"
              id="inject-desktop-context"
              checked={displayInjectContext}
              onChange={(e) => setDraftInjectContext((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
            />
            <label for="inject-desktop-context" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
              {t("generalSettingsInjectContext")}
            </label>
          </SettingItemControl>

          {/* Suppress Desktop Directives */}
          <SettingItemControl
            label={t("generalSettingsSuppressDirectives")}
            hint={t("generalSettingsSuppressDirectivesHint")}
            isDirty={draftSuppressDirectives !== null && draftSuppressDirectives !== currentSuppressDirectives}
            saving={savingField === "suppress_desktop_directives"}
            saved={savedFields.suppress_desktop_directives}
            error={fieldErrors.suppress_desktop_directives}
            requiresRestart={false}
            layout="inline"
            disabled={!displayInjectContext}
            onSave={handleSaveSuppressDirectives}
          >
            <input
              type="checkbox"
              id="suppress-desktop-directives"
              checked={displaySuppressDirectives}
              onChange={(e) => setDraftSuppressDirectives((e.target as HTMLInputElement).checked)}
              disabled={!displayInjectContext}
              class={`w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary ${
                displayInjectContext ? "cursor-pointer" : "cursor-not-allowed opacity-50"
              }`}
            />
            <label for="suppress-desktop-directives" class={`text-xs font-semibold cursor-pointer ${displayInjectContext ? "text-slate-700 dark:text-text-main" : "text-slate-400 dark:text-text-dim"}`}>
              {t("generalSettingsSuppressDirectives")}
            </label>
          </SettingItemControl>
        </div>
      </section>

      {/* 3. Account Routing & Token Refresh */}
      <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
        <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.985 4.356v4.992" />
              </svg>
            </div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("settingsCategoryRouting")}</h2>
          </div>
        </div>

        <div class="px-5 py-2">
          {/* Auto-refresh Tokens */}
          <SettingItemControl
            label={t("generalSettingsRefreshEnabled")}
            hint={t("generalSettingsRefreshEnabledHint")}
            isDirty={draftRefreshEnabled !== null && draftRefreshEnabled !== currentRefreshEnabled}
            saving={savingField === "refresh_enabled"}
            saved={savedFields.refresh_enabled}
            error={fieldErrors.refresh_enabled}
            requiresRestart={false}
            layout="inline"
            onSave={handleSaveRefreshEnabled}
          >
            <input
              type="checkbox"
              id="refresh-enabled"
              checked={displayRefreshEnabled}
              onChange={(e) => setDraftRefreshEnabled((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
            />
            <label for="refresh-enabled" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
              {t("generalSettingsRefreshEnabled")}
            </label>
          </SettingItemControl>

          {/* Refresh Margin */}
          <SettingItemControl
            label={t("generalSettingsRefreshMargin")}
            hint={t("generalSettingsRefreshMarginHint")}
            isDirty={draftRefreshMargin !== null && draftRefreshMargin !== String(currentRefreshMargin)}
            saving={savingField === "refresh_margin_seconds"}
            saved={savedFields.refresh_margin_seconds}
            error={fieldErrors.refresh_margin_seconds}
            requiresRestart={false}
            onSave={handleSaveRefreshMargin}
          >
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="0"
                class={`${inputCls} max-w-[160px]`}
                value={displayRefreshMargin}
                onInput={(e) => setDraftRefreshMargin((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveRefreshMargin(); }}
              />
              <span class="text-xs text-slate-500 dark:text-text-dim">s</span>
            </div>
          </SettingItemControl>

          {/* Refresh Concurrency */}
          <SettingItemControl
            label={t("generalSettingsRefreshConcurrency")}
            hint={t("generalSettingsRefreshConcurrencyHint")}
            isDirty={draftRefreshConcurrency !== null && draftRefreshConcurrency !== String(currentRefreshConcurrency)}
            saving={savingField === "refresh_concurrency"}
            saved={savedFields.refresh_concurrency}
            error={fieldErrors.refresh_concurrency}
            requiresRestart={false}
            onSave={handleSaveRefreshConcurrency}
          >
            <input
              type="number"
              min="1"
              class={`${inputCls} max-w-[160px]`}
              value={displayRefreshConcurrency}
              onInput={(e) => setDraftRefreshConcurrency((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveRefreshConcurrency(); }}
            />
          </SettingItemControl>

          {/* Max Concurrent Per Account */}
          <SettingItemControl
            label={t("generalSettingsMaxConcurrent")}
            hint={t("generalSettingsMaxConcurrentHint")}
            isDirty={draftMaxConcurrent !== null && draftMaxConcurrent !== String(currentMaxConcurrent)}
            saving={savingField === "max_concurrent_per_account"}
            saved={savedFields.max_concurrent_per_account}
            error={fieldErrors.max_concurrent_per_account}
            requiresRestart={false}
            onSave={handleSaveMaxConcurrent}
          >
            <input
              type="number"
              min="1"
              class={`${inputCls} max-w-[160px]`}
              value={displayMaxConcurrent}
              onInput={(e) => setDraftMaxConcurrent((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveMaxConcurrent(); }}
            />
          </SettingItemControl>

          {/* Request Interval */}
          <SettingItemControl
            label={t("generalSettingsRequestInterval")}
            hint={t("generalSettingsRequestIntervalHint")}
            isDirty={draftRequestInterval !== null && draftRequestInterval !== String(currentRequestInterval)}
            saving={savingField === "request_interval_ms"}
            saved={savedFields.request_interval_ms}
            error={fieldErrors.request_interval_ms}
            requiresRestart={false}
            onSave={handleSaveRequestInterval}
          >
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="0"
                class={`${inputCls} max-w-[160px]`}
                value={displayRequestInterval}
                onInput={(e) => setDraftRequestInterval((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveRequestInterval(); }}
              />
              <span class="text-xs text-slate-500 dark:text-text-dim">ms</span>
            </div>
          </SettingItemControl>

          {/* Usage History Retention */}
          <SettingItemControl
            label={t("generalSettingsUsageHistoryRetention")}
            hint={t("generalSettingsUsageHistoryRetentionHint")}
            isDirty={draftUsageHistoryRetention !== null && draftUsageHistoryRetention !== (currentUsageHistoryRetention === null ? "" : String(currentUsageHistoryRetention))}
            saving={savingField === "usage_history_retention_days"}
            saved={savedFields.usage_history_retention_days}
            error={fieldErrors.usage_history_retention_days}
            requiresRestart={false}
            onSave={handleSaveUsageHistoryRetention}
          >
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="1"
                class={`${inputCls} max-w-[160px]`}
                value={displayUsageHistoryRetention}
                onInput={(e) => setDraftUsageHistoryRetention((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveUsageHistoryRetention(); }}
                placeholder={t("unlimited")}
              />
              <span class="text-xs text-slate-500 dark:text-text-dim">{t("days")}</span>
            </div>
          </SettingItemControl>
        </div>
      </section>

      {/* 4. App Preferences & Updates */}
      <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
        <button
          onClick={() => setCollapsed(!collapsed)}
          class="w-full px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between cursor-pointer select-none text-left"
        >
          <div class="flex items-center gap-2.5">
            <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
              </svg>
            </div>
            <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("generalSettings")}</h2>
          </div>
          <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>

        {!collapsed && (
          <div class="px-5 py-2">
            {/* Dashboard Layout */}
            <SettingItemControl
              label={t("generalSettingsLayout")}
              hint={t("generalSettingsLayoutHint")}
              saved={savedFields.layoutMode}
            >
              <select
                id="dashboard-layout"
                class={`${inputCls} max-w-[280px]`}
                value={displayLayoutMode}
                onChange={(e) => handleLayoutModeChange((e.target as HTMLSelectElement).value as LayoutMode)}
              >
                <option value="sidebar">{t("generalSettingsLayoutSidebar")}</option>
                <option value="top">{t("generalSettingsLayoutTop")}</option>
              </select>
            </SettingItemControl>

            {/* Auto Update */}
            <SettingItemControl
              label={t("generalSettingsAutoUpdate")}
              hint={t("generalSettingsAutoUpdateHint")}
              isDirty={draftAutoUpdate !== null && draftAutoUpdate !== currentAutoUpdate}
              saving={savingField === "auto_update"}
              saved={savedFields.auto_update}
              error={fieldErrors.auto_update}
              requiresRestart={false}
              layout="inline"
              onSave={handleSaveAutoUpdate}
            >
              <input
                type="checkbox"
                id="auto-update"
                checked={displayAutoUpdate}
                onChange={(e) => setDraftAutoUpdate((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
              />
              <label for="auto-update" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
                {t("generalSettingsAutoUpdate")}
              </label>
            </SettingItemControl>

            {/* Auto Download */}
            <SettingItemControl
              label={t("generalSettingsAutoDownload")}
              hint={t("generalSettingsAutoDownloadHint")}
              isDirty={draftAutoDownload !== null && draftAutoDownload !== currentAutoDownload}
              saving={savingField === "auto_download"}
              saved={savedFields.auto_download}
              error={fieldErrors.auto_download}
              requiresRestart={false}
              layout="inline"
              disabled={!displayAutoUpdate}
              onSave={handleSaveAutoDownload}
            >
              <input
                type="checkbox"
                id="auto-download"
                checked={displayAutoDownload}
                onChange={(e) => setDraftAutoDownload((e.target as HTMLInputElement).checked)}
                disabled={!displayAutoUpdate}
                class={`w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary ${
                  displayAutoUpdate ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                }`}
              />
              <label for="auto-download" class={`text-xs font-semibold cursor-pointer ${displayAutoUpdate ? "text-slate-700 dark:text-text-main" : "text-slate-400 dark:text-text-dim"}`}>
                {t("generalSettingsAutoDownload")}
              </label>
            </SettingItemControl>

            {/* Allow Prerelease / Beta */}
            <SettingItemControl
              label={t("generalSettingsAllowPrerelease")}
              hint={t("generalSettingsAllowPrereleaseHint")}
              isDirty={draftAllowPrerelease !== null && draftAllowPrerelease !== currentAllowPrerelease}
              saving={savingField === "allow_prerelease"}
              saved={savedFields.allow_prerelease}
              error={fieldErrors.allow_prerelease}
              requiresRestart={false}
              layout="inline"
              onSave={handleSaveAllowPrerelease}
            >
              <input
                type="checkbox"
                id="allow-prerelease"
                checked={displayAllowPrerelease}
                onChange={(e) => setDraftAllowPrerelease((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
              />
              <label for="allow-prerelease" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
                {t("generalSettingsAllowPrerelease")}
              </label>
            </SettingItemControl>

            {/* Update Dialog */}
            <SettingItemControl
              label={t("generalSettingsShowUpdateDialog")}
              hint={t("generalSettingsShowUpdateDialogHint")}
              isDirty={draftShowUpdateDialog !== null && draftShowUpdateDialog !== currentShowUpdateDialog}
              saving={savingField === "show_update_dialog"}
              saved={savedFields.show_update_dialog}
              error={fieldErrors.show_update_dialog}
              requiresRestart={false}
              layout="inline"
              onSave={handleSaveShowUpdateDialog}
            >
              <input
                type="checkbox"
                id="show-update-dialog"
                checked={displayShowUpdateDialog}
                onChange={(e) => setDraftShowUpdateDialog((e.target as HTMLInputElement).checked)}
                class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
              />
              <label for="show-update-dialog" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
                {t("generalSettingsShowUpdateDialog")}
              </label>
            </SettingItemControl>
          </div>
        )}
      </section>
    </div>
  );
}
