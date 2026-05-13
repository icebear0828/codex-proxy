import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useOllamaSettings } from "../../../shared/hooks/use-ollama-settings";
import { useSettings } from "../../../shared/hooks/use-settings";
import { isNetworkExposedHost } from "../../../shared/utils/host";

export function OllamaBridgeSettings() {
  const t = useT();
  const settings = useSettings();
  const ollama = useOllamaSettings(settings.apiKey);

  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftHost, setDraftHost] = useState<string | null>(null);
  const [draftPort, setDraftPort] = useState<string | null>(null);
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [draftDisableVision, setDraftDisableVision] = useState<boolean | null>(null);
  const [collapsed, setCollapsed] = useState(true);

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

  const isDirty =
    draftEnabled !== null ||
    draftHost !== null ||
    draftPort !== null ||
    draftVersion !== null ||
    draftDisableVision !== null;

  const handleSave = useCallback(async () => {
    const patch: Record<string, unknown> = {};
    if (draftEnabled !== null) patch.enabled = draftEnabled;
    if (draftHost !== null) patch.host = draftHost.trim();
    if (draftPort !== null) {
      const val = parseInt(draftPort, 10);
      if (isNaN(val) || val < 1 || val > 65535) return;
      patch.port = val;
    }
    if (draftVersion !== null) patch.version = draftVersion.trim();
    if (draftDisableVision !== null) patch.disable_vision = draftDisableVision;

    await ollama.save(patch);
    setDraftEnabled(null);
    setDraftHost(null);
    setDraftPort(null);
    setDraftVersion(null);
    setDraftDisableVision(null);
  }, [draftEnabled, draftHost, draftPort, draftVersion, draftDisableVision, ollama]);

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
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 6.75A2.25 2.25 0 016.75 4.5h10.5a2.25 2.25 0 012.25 2.25v10.5a2.25 2.25 0 01-2.25 2.25H6.75a2.25 2.25 0 01-2.25-2.25V6.75z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 9.75h7.5m-7.5 4.5h4.5" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("ollamaBridgeSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
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
            {status?.endpoint && (
              <code class="px-2 py-1 rounded bg-slate-100 dark:bg-bg-dark text-xs text-slate-700 dark:text-text-main">
                {status.endpoint}
              </code>
            )}
            <button
              onClick={ollama.load}
              class="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-bg-dark"
            >
              {t("refresh")}
            </button>
          </div>

          {status?.error && (
            <div class="px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700/50 rounded-lg text-xs text-red-700 dark:text-red-400">
              {status.error}
            </div>
          )}

          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("ollamaBridgeEnabledHint")}</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
                {t("ollamaBridgeHost")}
              </label>
              <p class="text-xs text-slate-400 dark:text-text-dim">{t("ollamaBridgeHostHint")}</p>
              <input
                type="text"
                class={inputCls}
                value={displayHost}
                onInput={(e) => setDraftHost((e.target as HTMLInputElement).value)}
                placeholder="127.0.0.1"
              />
            </div>

            <div class="space-y-1.5">
              <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
                {t("ollamaBridgePort")}
              </label>
              <p class="text-xs text-slate-400 dark:text-text-dim">{t("ollamaBridgePortHint")}</p>
              <input
                type="number"
                min="1"
                max="65535"
                class={`${inputCls} max-w-[160px]`}
                value={displayPort}
                onInput={(e) => setDraftPort((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          {exposesNetwork && (
            <div class="px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg text-xs text-amber-700 dark:text-amber-400">
              {t("ollamaBridgeHostWarning")}
            </div>
          )}

          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("ollamaBridgeVersion")}
            </label>
            <p class="text-xs text-slate-400 dark:text-text-dim">{t("ollamaBridgeVersionHint")}</p>
            <input
              type="text"
              class={`${inputCls} max-w-[220px]`}
              value={displayVersion}
              onInput={(e) => setDraftVersion((e.target as HTMLInputElement).value)}
            />
          </div>

          <div class="space-y-1">
            <div class="flex items-center gap-2">
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
            </div>
            <p class="text-xs text-slate-400 dark:text-text-dim ml-6">{t("ollamaBridgeDisableVisionHint")}</p>
          </div>

          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={ollama.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !ollama.saving
                  ? "bg-primary-action text-white hover:bg-primary-action-hover cursor-pointer"
                  : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
              }`}
            >
              {ollama.saving ? "..." : t("submit")}
            </button>
            {ollama.saved && (
              <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("quotaSaved")}</span>
            )}
            {ollama.error && (
              <span class="text-xs font-medium text-red-500">{ollama.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
