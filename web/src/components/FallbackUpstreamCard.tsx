import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { FallbackUpstreamPublic } from "../../../shared/types";

interface FallbackUpstreamCardProps {
  config: FallbackUpstreamPublic;
  onUpdate: (baseUrl: string, apiKey: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
  /** True while requests are currently being served by a fallback (backup
   *  account retry or fallback upstream). Lights up + pulses the card. */
  active?: boolean;
}

/**
 * Full-width card for the single last-resort "upstream apikey" account.
 * Rendered at the very end of the account list, spanning the whole row.
 */
export function FallbackUpstreamCard({ config, onUpdate, onDelete, active = false }: FallbackUpstreamCardProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const err = await onUpdate(baseUrl.trim(), apiKey.trim());
      if (err) {
        setError(err);
        return;
      }
      setEditing(false);
      setApiKey("");
    } finally {
      setSaving(false);
    }
  }, [baseUrl, apiKey, onUpdate]);

  const handleDelete = useCallback(async () => {
    if (!confirm(t("fallbackDeleteConfirm"))) return;
    setDeleting(true);
    setError(null);
    try {
      const err = await onDelete();
      if (err) setError(err);
    } finally {
      setDeleting(false);
    }
  }, [onDelete, t]);

  return (
    <div
      class={`md:col-span-2 bg-white dark:bg-card-dark border rounded-xl p-4 transition-colors ${
        active
          ? "border-orange-400 dark:border-orange-500/70 ring-2 ring-orange-300/40 dark:ring-orange-500/20 shadow-lg animate-pulse"
          : "border-gray-200 dark:border-border-dark shadow-sm"
      }`}
    >
      <div class="flex flex-wrap justify-between items-start gap-2 mb-3">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class={`size-10 rounded-full flex items-center justify-center font-bold text-lg shrink-0 ${
            active
              ? "bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-300"
              : "bg-cyan-50 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-300"
          }`}>
            <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
          </div>
          <div class="min-w-0">
            <h3 class="text-[0.82rem] font-semibold leading-tight truncate">{t("fallbackUpstreamTitle")}</h3>
            <p class="text-xs text-slate-500 dark:text-text-dim truncate font-mono">{config.baseUrl}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 flex-wrap">
          {active && (
            <span class="px-2.5 py-1 rounded-full bg-orange-500 text-white border border-orange-400 text-xs font-semibold">
              {t("fallbackActiveBadge")}
            </span>
          )}
          <span class="px-2.5 py-1 rounded-full bg-cyan-50 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-800/30 text-xs font-medium">
            {t("fallbackInterface")}
          </span>
          <span class="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800/30 text-slate-500 dark:text-text-dim border border-slate-200 dark:border-slate-700/30 text-xs font-medium">
            {t("fallbackOnlyWhenExhausted")}
          </span>
          <button
            onClick={() => setEditing((v) => !v)}
            disabled={saving}
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-slate-100 dark:hover:bg-border-dark disabled:opacity-40"
            title={t("fallbackEdit")}
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-red-500 transition-colors rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
            title={t("fallbackDelete")}
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {editing ? (
        <div class="space-y-2 pt-2 border-t border-slate-100 dark:border-border-dark">
          <div class="flex gap-2">
            <input
              type="text"
              value={baseUrl}
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
              placeholder={t("fallbackBaseUrl")}
              class="flex-1 px-3 py-2 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-700 dark:text-text-main focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors"
            />
            <input
              type="password"
              value={apiKey}
              onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
              placeholder={t("fallbackApiKeyEdit")}
              class="flex-1 px-3 py-2 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-700 dark:text-text-main focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors"
            />
          </div>
          {error && <p class="text-xs text-red-500">{error}</p>}
          <div class="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              class="px-3 py-1.5 bg-primary-action hover:bg-primary-action-hover text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-40"
            >
              {saving ? t("fallbackSaving") : t("fallbackSave")}
            </button>
            <button
              onClick={() => { setEditing(false); setError(null); setApiKey(""); }}
              class="px-3 py-1.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-lg text-xs font-medium text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div class="pt-2 border-t border-slate-100 dark:border-border-dark flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-text-dim">
          <span class="font-mono">{config.apiKeyMasked}</span>
          <span>{t("fallbackOnlyWhenExhaustedDesc")}</span>
        </div>
      )}
    </div>
  );
}
