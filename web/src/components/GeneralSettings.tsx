import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

export function GeneralSettings() {
  const t = useT();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);

  const [draftPort, setDraftPort] = useState<string | null>(null);
  const [draftProxyUrl, setDraftProxyUrl] = useState<string | null>(null);
  const [draftForceHttp11, setDraftForceHttp11] = useState<boolean | null>(null);
  const [draftInjectContext, setDraftInjectContext] = useState<boolean | null>(null);
  const [draftSuppressDirectives, setDraftSuppressDirectives] = useState<boolean | null>(null);
  const [draftDefaultModel, setDraftDefaultModel] = useState<string | null>(null);
  const [draftReasoningEffort, setDraftReasoningEffort] = useState<string | null>(null);
  const [draftRefreshEnabled, setDraftRefreshEnabled] = useState<boolean | null>(null);
  const [draftRefreshMargin, setDraftRefreshMargin] = useState<string | null>(null);
  const [draftRefreshConcurrency, setDraftRefreshConcurrency] = useState<string | null>(null);
  const [draftAutoUpdate, setDraftAutoUpdate] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const currentPort = gs.data?.port ?? 8080;
  const currentProxyUrl = gs.data?.proxy_url ?? "";
  const currentForceHttp11 = gs.data?.force_http11 ?? false;
  const currentInjectContext = gs.data?.inject_desktop_context ?? false;
  const currentSuppressDirectives = gs.data?.suppress_desktop_directives ?? false;
  const currentDefaultModel = gs.data?.default_model ?? "";
  const currentReasoningEffort = gs.data?.default_reasoning_effort ?? "medium";
  const currentRefreshEnabled = gs.data?.refresh_enabled ?? true;
  const currentRefreshMargin = gs.data?.refresh_margin_seconds ?? 300;
  const currentRefreshConcurrency = gs.data?.refresh_concurrency ?? 2;
  const currentAutoUpdate = gs.data?.auto_update ?? true;

  const displayPort = draftPort ?? String(currentPort);
  const displayProxyUrl = draftProxyUrl ?? currentProxyUrl;
  const displayForceHttp11 = draftForceHttp11 ?? currentForceHttp11;
  const displayInjectContext = draftInjectContext ?? currentInjectContext;
  const displaySuppressDirectives = draftSuppressDirectives ?? currentSuppressDirectives;
  const displayDefaultModel = draftDefaultModel ?? currentDefaultModel;
  const displayReasoningEffort = draftReasoningEffort ?? currentReasoningEffort;
  const displayRefreshEnabled = draftRefreshEnabled ?? currentRefreshEnabled;
  const displayRefreshMargin = draftRefreshMargin ?? String(currentRefreshMargin);
  const displayRefreshConcurrency = draftRefreshConcurrency ?? String(currentRefreshConcurrency);
  const displayAutoUpdate = draftAutoUpdate ?? currentAutoUpdate;

  const isDirty =
    draftPort !== null ||
    draftProxyUrl !== null ||
    draftForceHttp11 !== null ||
    draftInjectContext !== null ||
    draftSuppressDirectives !== null ||
    draftDefaultModel !== null ||
    draftReasoningEffort !== null ||
    draftRefreshEnabled !== null ||
    draftRefreshMargin !== null ||
    draftRefreshConcurrency !== null ||
    draftAutoUpdate !== null;

  const handleSave = useCallback(async () => {
    const patch: Record<string, unknown> = {};

    if (draftPort !== null) {
      const val = parseInt(draftPort, 10);
      if (isNaN(val) || val < 1 || val > 65535) return;
      patch.port = val;
    }

    if (draftProxyUrl !== null) {
      patch.proxy_url = draftProxyUrl.trim() || null;
    }

    if (draftForceHttp11 !== null) {
      patch.force_http11 = draftForceHttp11;
    }

    if (draftInjectContext !== null) {
      patch.inject_desktop_context = draftInjectContext;
    }

    if (draftSuppressDirectives !== null) {
      patch.suppress_desktop_directives = draftSuppressDirectives;
    }

    if (draftDefaultModel !== null) {
      patch.default_model = draftDefaultModel.trim();
    }

    if (draftReasoningEffort !== null) {
      patch.default_reasoning_effort = draftReasoningEffort;
    }

    if (draftRefreshEnabled !== null) {
      patch.refresh_enabled = draftRefreshEnabled;
    }

    if (draftRefreshMargin !== null) {
      const val = parseInt(draftRefreshMargin, 10);
      if (isNaN(val) || val < 0) return;
      patch.refresh_margin_seconds = val;
    }

    if (draftRefreshConcurrency !== null) {
      const val = parseInt(draftRefreshConcurrency, 10);
      if (isNaN(val) || val < 1) return;
      patch.refresh_concurrency = val;
    }

    if (draftAutoUpdate !== null) {
      patch.auto_update = draftAutoUpdate;
    }

    await gs.save(patch);
    setDraftPort(null);
    setDraftProxyUrl(null);
    setDraftForceHttp11(null);
    setDraftInjectContext(null);
    setDraftSuppressDirectives(null);
    setDraftDefaultModel(null);
    setDraftReasoningEffort(null);
    setDraftRefreshEnabled(null);
    setDraftRefreshMargin(null);
    setDraftRefreshConcurrency(null);
    setDraftAutoUpdate(null);
  }, [draftPort, draftProxyUrl, draftForceHttp11, draftInjectContext, draftSuppressDirectives, draftDefaultModel, draftReasoningEffort, draftRefreshEnabled, draftRefreshMargin, draftRefreshConcurrency, draftAutoUpdate, gs]);

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
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("generalSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          {/* Auto Update */}
          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("generalSettingsAutoUpdateHint")}</p>
          </div>

          {/* Server Port */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("generalSettingsPort")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("generalSettingsPortHint")}</p>
            <input
              type="number"
              min="1"
              max="65535"
              class={`${inputCls} max-w-[160px]`}
              value={displayPort}
              onInput={(e) => setDraftPort((e.target as HTMLInputElement).value)}
            />
          </div>

          {/* Default Model */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("generalSettingsDefaultModel")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("generalSettingsDefaultModelHint")}</p>
            <input
              type="text"
              class={inputCls}
              value={displayDefaultModel}
              onInput={(e) => setDraftDefaultModel((e.target as HTMLInputElement).value)}
              placeholder="gpt-5.2-codex"
            />
          </div>

          {/* Default Reasoning Effort */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("generalSettingsReasoningEffort")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("generalSettingsReasoningEffortHint")}</p>
            <select
              class={`${inputCls} max-w-[200px]`}
              value={displayReasoningEffort}
              onChange={(e) => setDraftReasoningEffort((e.target as HTMLSelectElement).value)}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </div>

          {/* Upstream Proxy */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("generalSettingsProxyUrl")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("generalSettingsProxyUrlHint")}</p>
            <input
              type="text"
              class={inputCls}
              value={displayProxyUrl}
              onInput={(e) => setDraftProxyUrl((e.target as HTMLInputElement).value)}
              placeholder="socks5://127.0.0.1:1080"
            />
          </div>

          {/* Force HTTP/1.1 */}
          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("generalSettingsForceHttp11Hint")}</p>
          </div>

          {/* Inject Desktop Context */}
          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("generalSettingsInjectContextHint")}</p>
          </div>

          {/* Suppress Desktop Directives */}
          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
              <label
                for="suppress-desktop-directives"
                class={`text-xs font-semibold cursor-pointer ${
                  displayInjectContext
                    ? "text-slate-700 dark:text-text-main"
                    : "text-slate-400 dark:text-text-dim"
                }`}
              >
                {t("generalSettingsSuppressDirectives")}
              </label>
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("generalSettingsSuppressDirectivesHint")}</p>
          </div>

          {/* Auto-refresh Tokens */}
          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("generalSettingsRefreshEnabledHint")}</p>
          </div>

          {/* Refresh Margin */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("generalSettingsRefreshMargin")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("generalSettingsRefreshMarginHint")}</p>
            <input
              type="number"
              min="0"
              class={`${inputCls} max-w-[160px]`}
              value={displayRefreshMargin}
              onInput={(e) => setDraftRefreshMargin((e.target as HTMLInputElement).value)}
            />
          </div>

          {/* Refresh Concurrency */}
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("generalSettingsRefreshConcurrency")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("generalSettingsRefreshConcurrencyHint")}</p>
            <input
              type="number"
              min="1"
              class={`${inputCls} max-w-[160px]`}
              value={displayRefreshConcurrency}
              onInput={(e) => setDraftRefreshConcurrency((e.target as HTMLInputElement).value)}
            />
          </div>

          {/* Save button + status */}
          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={gs.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !gs.saving
                  ? "bg-primary text-white hover:bg-primary/90 cursor-pointer"
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

          {/* Restart required warning */}
          {gs.restartRequired && (
            <div class="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg">
              <svg class="size-4 text-amber-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span class="text-xs font-medium text-amber-700 dark:text-amber-400">
                {t("generalSettingsRestartRequired")}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
