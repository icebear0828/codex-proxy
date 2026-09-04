import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useSettings } from "../../../shared/hooks/use-settings";
import { SettingItemControl } from "./settings/SettingItemControl";

export function SettingsPanel() {
  const t = useT();
  const settings = useSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayValue = draft ?? settings.apiKey ?? "";
  const isDirty = draft !== null && draft !== (settings.apiKey ?? "");

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const newKey = (draft ?? settings.apiKey ?? "").trim() || null;
      await settings.save(newKey);
      setDraft(null);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [isDirty, saving, draft, settings]);

  const handleClear = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await settings.save(null);
      setDraft(null);
      setRevealed(false);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [saving, settings]);

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("masterApiKeyAuth")}</h2>
        </div>
      </div>

      <div class="px-5 py-2">
        <SettingItemControl
          label={t("apiKeyLabel")}
          hint={t("masterApiKeyAuthHint")}
          isDirty={isDirty}
          saving={saving}
          saved={saved}
          error={error}
          requiresRestart={false}
          onSave={handleSave}
        >
          <div class="space-y-2">
            <div class="relative flex items-center">
              <div class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-text-dim">
                <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                </svg>
              </div>
              <input
                type={revealed ? "text" : "password"}
                class="w-full pl-10 pr-10 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary tracking-wider"
                value={displayValue}
                onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                placeholder={t("apiKeyLabel")}
              />
              <button
                type="button"
                onClick={() => setRevealed(!revealed)}
                class="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 dark:text-text-dim hover:text-slate-600 dark:hover:text-text-main"
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

            {settings.apiKey && (
              <div class="flex justify-end">
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={saving}
                  class="text-[0.72rem] text-slate-400 dark:text-text-dim hover:text-red-500 dark:hover:text-red-400 transition-colors"
                >
                  {t("apiKeyClear")}
                </button>
              </div>
            )}
          </div>
        </SettingItemControl>
      </div>
    </section>
  );
}
