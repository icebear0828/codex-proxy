import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useSettings } from "../../../shared/hooks/use-settings";

export function SettingsPanel() {
  const t = useT();
  const settings = useSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  // Sync draft when settings load
  const displayValue = draft ?? settings.apiKey ?? "";

  const handleSave = useCallback(async () => {
    const newKey = (draft ?? settings.apiKey ?? "").trim() || null;
    await settings.save(newKey);
    setDraft(null);
  }, [draft, settings]);

  const handleClear = useCallback(async () => {
    await settings.save(null);
    setDraft(null);
    setRevealed(false);
  }, [settings]);

  const isDirty = draft !== null && draft !== (settings.apiKey ?? "");

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      {/* Header — clickable to toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("settings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Collapsible content */}
      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4">
          <div class="space-y-1.5">
            <label class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("apiKeyLabel")}</label>
            <div class="flex items-center gap-2">
              <div class="relative flex-1">
                <div class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-text-dim">
                  <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                  </svg>
                </div>
                <input
                  type={revealed ? "text" : "password"}
                  class="w-full pl-10 pr-10 py-2.5 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary tracking-wider"
                  value={displayValue}
                  onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                  onFocus={() => setRevealed(true)}
                  placeholder={t("apiKeyLabel")}
                />
                {/* Toggle visibility */}
                <button
                  onClick={() => setRevealed(!revealed)}
                  class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 dark:text-text-dim hover:text-slate-600 dark:hover:text-text-main"
                  title={revealed ? "Hide" : "Show"}
                >
                  {revealed ? (
                    <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
              </div>
              {/* Save button */}
              <button
                onClick={handleSave}
                disabled={settings.saving || !isDirty}
                class={`px-4 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  isDirty && !settings.saving
                    ? "bg-primary-action text-white hover:bg-primary-action-hover cursor-pointer"
                    : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
                }`}
              >
                {settings.saving ? "..." : t("submit")}
              </button>
            </div>

            {/* Status messages */}
            <div class="flex items-center gap-3 mt-2 min-h-[1.5rem]">
              {settings.saved && (
                <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("apiKeySaved")}</span>
              )}
              {settings.error && (
                <span class="text-xs font-medium text-red-500">{settings.error}</span>
              )}
              {/* Clear key button */}
              {settings.apiKey && (
                <button
                  onClick={handleClear}
                  disabled={settings.saving}
                  class="text-xs text-slate-400 dark:text-text-dim hover:text-red-500 dark:hover:text-red-400 transition-colors ml-auto"
                >
                  {t("apiKeyClear")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
