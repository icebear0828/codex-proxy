import { useCallback, useMemo, useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

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

export function ModelAliasSettings() {
  const t = useT();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);

  const currentRows = useMemo(
    () => aliasesToRows(gs.data?.model_aliases),
    [gs.data?.model_aliases],
  );
  const [draftRows, setDraftRows] = useState<AliasRow[] | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  const rows = draftRows ?? currentRows;
  const isDirty = draftRows !== null;

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
    await gs.save({ model_aliases: result.aliases });
    setDraftRows(null);
    setValidationError(null);
  }, [gs, rows]);

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
            <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 7.5h6m-6 4.5h9m-9 4.5h4.5M5.25 4.5h13.5A2.25 2.25 0 0121 6.75v10.5a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 17.25V6.75A2.25 2.25 0 015.25 4.5z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("modelAliasSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <p class="text-xs text-slate-400 dark:text-text-dim">{t("modelAliasSettingsHint")}</p>

          <div class="space-y-2">
            <div class="hidden sm:grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] gap-2 text-[0.7rem] font-semibold uppercase text-slate-400 dark:text-text-dim">
              <span>{t("modelAliasName")}</span>
              <span>{t("modelAliasTarget")}</span>
              <span />
            </div>
            {rows.length === 0 && (
              <div class="rounded-lg border border-dashed border-gray-200 dark:border-border-dark px-3 py-4 text-xs text-slate-400 dark:text-text-dim">
                {t("modelAliasEmpty")}
              </div>
            )}
            {rows.map((row, idx) => (
              <div key={`${idx}-${row.alias}`} class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] gap-2">
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
                  aria-label={t("modelAliasTarget")}
                />
                <button
                  type="button"
                  onClick={() => editRows((current) => current.filter((_item, itemIdx) => itemIdx !== idx))}
                  class="h-9 rounded-lg border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:text-red-500 hover:border-red-300 transition-colors"
                  title={t("modelAliasRemove")}
                >
                  x
                </button>
              </div>
            ))}
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => editRows((current) => [...current, { alias: "", target: "" }])}
              class="px-3 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-border-dark text-slate-700 dark:text-text-main hover:border-primary/50 transition-colors"
            >
              {t("modelAliasAdd")}
            </button>
            <button
              type="button"
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
            {(validationError || gs.error) && (
              <span class="text-xs font-medium text-red-500">{validationError ?? gs.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
