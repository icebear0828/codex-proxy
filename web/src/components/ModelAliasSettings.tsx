import { useCallback, useMemo, useState, useEffect, useRef } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

interface ModelAliasSettingsProps {
  models: string[];
}

interface AliasRow {
  alias: string;
  target: string;
}

function aliasesToRows(aliases: Record<string, string> | undefined): AliasRow[] {
  return Object.entries(aliases ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alias, target]) => ({ alias, target }));
}

function rowsToAliases(rows: AliasRow[]): {
  aliases: Record<string, string>;
  error: string | null;
} {
  const aliases: Record<string, string> = {};
  for (const row of rows) {
    const alias = row.alias.trim();
    const target = row.target.trim();
    if (!alias && !target) continue;
    if (!alias || !target) {
      return { aliases: {}, error: "Both alias and target are required." };
    }
    if (alias === target) {
      return { aliases: {}, error: "Alias and target must be different." };
    }
    if (aliases[alias] !== undefined) {
      return { aliases: {}, error: `Duplicate alias: ${alias}` };
    }
    aliases[alias] = target;
  }
  return { aliases, error: null };
}

export function ModelAliasSettings({ models }: ModelAliasSettingsProps) {
  const t = useT();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);

  const currentRows = useMemo(
    () => aliasesToRows(gs.data?.model_aliases),
    [gs.data?.model_aliases],
  );
  const [draftRows, setDraftRows] = useState<AliasRow[] | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isFading, setIsFading] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rows = draftRows ?? currentRows;
  const isDirty = draftRows !== null;

  useEffect(() => {
    if (saved) {
      setIsFading(false);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
      const timer = setTimeout(() => {
        setIsFading(true);
      }, 1800);
      const endTimer = setTimeout(() => {
        setSaved(false);
        setIsFading(false);
      }, 2500);
      return () => {
        clearTimeout(timer);
        clearTimeout(endTimer);
      };
    }
  }, [saved]);

  const editRows = useCallback((update: (rows: AliasRow[]) => AliasRow[]) => {
    setValidationError(null);
    setDraftRows((prev) => update(prev ?? currentRows));
  }, [currentRows]);

  const handleSave = useCallback(async () => {
    const result = rowsToAliases(rows);
    if (result.error) {
      setValidationError(result.error);
      return;
    }
    setSaving(true);
    setValidationError(null);
    try {
      await gs.save({ model_aliases: result.aliases });
      setDraftRows(null);
      setSaved(true);
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [gs, rows]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 7.5h6m-6 4.5h9m-9 4.5h4.5M5.25 4.5h13.5A2.25 2.25 0 0121 6.75v10.5a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 17.25V6.75A2.25 2.25 0 015.25 4.5z" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("settingsCategoryAliases")}</h2>
        </div>

        {/* Header Action / Save state */}
        <div class="flex items-center gap-2">
          {saving && (
            <div class="inline-flex items-center justify-center size-8 shrink-0 text-primary">
              <svg class="size-4 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
              </svg>
            </div>
          )}

          {!saving && isDirty && (
            <button
              type="button"
              onClick={handleSave}
              title={t("settingSave")}
              aria-label={t("settingSave")}
              class="inline-flex items-center justify-center size-8 rounded-lg bg-primary-action hover:bg-primary-action-hover text-white shadow-sm transition-all duration-150 active:scale-90 shrink-0 cursor-pointer animate-in fade-in zoom-in-90"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </button>
          )}

          {!saving && !isDirty && saved && (
            <div
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[0.72rem] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-500/20 shrink-0 transition-opacity duration-700 animate-in fade-in"
              style={{ opacity: isFading ? 0 : 1 }}
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <span>{t("settingSaved")}</span>
            </div>
          )}
        </div>
      </div>

      <div class="p-5 space-y-4">
        <p class="text-[0.75rem] text-slate-500 dark:text-text-dim">{t("modelAliasSettingsHint")}</p>

        {models && models.length > 0 && (
          <datalist id="model-target-options">
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </datalist>
        )}

        <div class="space-y-2">
          <div class="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] gap-2 text-[0.7rem] font-semibold uppercase tracking-wider text-slate-400 dark:text-text-dim">
            <span>{t("modelAliasName")}</span>
            <span>{t("modelAliasTarget")}</span>
            <span />
          </div>

          {rows.length === 0 && (
            <div class="rounded-lg border border-dashed border-gray-200 dark:border-border-dark px-4 py-6 text-center text-xs text-slate-400 dark:text-text-dim">
              {t("modelAliasEmpty")}
            </div>
          )}

          {rows.map((row, idx) => (
            <div key={idx} class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] gap-2">
              <input
                class={inputCls}
                value={row.alias}
                onInput={(e) => editRows((current) => current.map((item, itemIdx) => (
                  itemIdx === idx ? { ...item, alias: (e.target as HTMLInputElement).value } : item
                )))}
                placeholder="client-model"
                aria-label={t("modelAliasName")}
              />
              <input
                class={inputCls}
                value={row.target}
                onInput={(e) => editRows((current) => current.map((item, itemIdx) => (
                  itemIdx === idx ? { ...item, target: (e.target as HTMLInputElement).value } : item
                )))}
                placeholder="gpt-5.5 or openai:gpt-4o"
                list="model-target-options"
                aria-label={t("modelAliasTarget")}
              />
              <button
                type="button"
                onClick={() => editRows((current) => current.filter((_item, itemIdx) => itemIdx !== idx))}
                class="h-9 rounded-lg border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:text-red-500 hover:border-red-300 transition-colors flex items-center justify-center cursor-pointer"
                title={t("modelAliasRemove")}
              >
                <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {(validationError || gs.error) && (
          <p class="text-xs text-red-500 font-medium">{validationError ?? gs.error}</p>
        )}

        <div class="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => editRows((current) => [...current, { alias: "", target: "" }])}
            class="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 dark:border-border-dark text-slate-700 dark:text-text-main hover:border-primary hover:text-primary transition-colors cursor-pointer inline-flex items-center gap-1.5"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span>{t("modelAliasAdd")}</span>
          </button>
        </div>
      </div>
    </section>
  );
}
