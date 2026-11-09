import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import {
  usePolicyGuardSettings,
  usePolicyGuardQuarantines,
} from "../../../shared/hooks/use-policy-guard";
import { useSettings } from "../../../shared/hooks/use-settings";
import { SettingItemControl } from "./settings/SettingItemControl";

/** Comma-separated list of HTTP status codes; empty means "no restriction". */
function parseStatusCodes(raw: string): number[] | null {
  if (!raw.trim()) return [];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 100 || n > 599)) return null;
  return nums;
}

/** One entry per line; blank lines dropped. */
function parseLines(raw: string): string[] {
  return raw.split("\n").map((s) => s.trim()).filter(Boolean);
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function PolicyGuardSettings() {
  const t = useT();
  const settings = useSettings();
  const guard = usePolicyGuardSettings(settings.apiKey);
  const quarantine = usePolicyGuardQuarantines(settings.apiKey);

  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftTtl, setDraftTtl] = useState<string | null>(null);
  const [draftStatuses, setDraftStatuses] = useState<string | null>(null);
  const [draftCodes, setDraftCodes] = useState<string | null>(null);
  const [draftPatterns, setDraftPatterns] = useState<string | null>(null);

  const [savingFields, setSavingFields] = useState<Record<string, boolean>>({});
  const [savedFields, setSavedFields] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  const currentEnabled = guard.data?.enabled ?? false;
  const currentTtl = guard.data?.ttl_seconds ?? 3600;
  const currentStatuses = guard.data?.status_codes ?? [];
  const currentCodes = guard.data?.error_codes ?? [];
  const currentPatterns = guard.data?.message_patterns ?? [];

  const displayEnabled = draftEnabled ?? currentEnabled;
  const displayTtl = draftTtl ?? String(currentTtl);
  const displayStatuses = draftStatuses ?? currentStatuses.join(", ");
  const displayCodes = draftCodes ?? currentCodes.join("\n");
  const displayPatterns = draftPatterns ?? currentPatterns.join("\n");

  const saveField = useCallback(async (
    field: string,
    patch: Record<string, unknown>,
    resetDraft: () => void,
  ) => {
    setSavingFields((prev) => ({ ...prev, [field]: true }));
    setFieldErrors((prev) => ({ ...prev, [field]: null }));
    try {
      await guard.save(patch);
      resetDraft();
      setSavedFields((prev) => ({ ...prev, [field]: true }));
    } catch (err: unknown) {
      setFieldErrors((prev) => ({
        ...prev,
        [field]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSavingFields((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  }, [guard]);

  const handleSaveEnabled = useCallback(() => {
    if (draftEnabled === null) return;
    saveField("enabled", { enabled: draftEnabled }, () => setDraftEnabled(null));
  }, [draftEnabled, saveField]);

  const handleSaveTtl = useCallback(() => {
    if (draftTtl === null) return;
    const val = parseInt(draftTtl, 10);
    if (isNaN(val) || val < 1) {
      setFieldErrors((prev) => ({ ...prev, ttl: t("policyGuardErrorTtl") }));
      return;
    }
    saveField("ttl", { ttl_seconds: val }, () => setDraftTtl(null));
  }, [draftTtl, saveField, t]);

  const handleSaveStatuses = useCallback(() => {
    if (draftStatuses === null) return;
    const parsed = parseStatusCodes(draftStatuses);
    if (!parsed) {
      setFieldErrors((prev) => ({ ...prev, statuses: t("policyGuardErrorStatusCodes") }));
      return;
    }
    saveField("statuses", { status_codes: parsed }, () => setDraftStatuses(null));
  }, [draftStatuses, saveField, t]);

  const handleSaveCodes = useCallback(() => {
    if (draftCodes === null) return;
    saveField("codes", { error_codes: parseLines(draftCodes) }, () => setDraftCodes(null));
  }, [draftCodes, saveField]);

  const handleSavePatterns = useCallback(() => {
    if (draftPatterns === null) return;
    saveField("patterns", { message_patterns: parseLines(draftPatterns) }, () => setDraftPatterns(null));
  }, [draftPatterns, saveField]);

  const inputCls =
    "w-full px-3 py-2 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-700 dark:text-text-main outline-none focus:ring-1 focus:ring-primary";
  const textareaCls = `${inputCls} resize-y min-h-[4.5rem] leading-relaxed`;

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("policyGuardTitle")}</h2>
        </div>
      </div>

      <div class="px-5 pt-3 pb-2">
        <p class="text-[0.75rem] text-slate-500 dark:text-text-dim leading-relaxed">
          {t("policyGuardIntro")}
        </p>
      </div>

      <div class="px-5 py-2">
        <SettingItemControl
          label={t("policyGuardEnabled")}
          hint={t("policyGuardEnabledHint")}
          isDirty={draftEnabled !== null && draftEnabled !== currentEnabled}
          saving={!!savingFields.enabled}
          saved={savedFields.enabled}
          error={fieldErrors.enabled}
          requiresRestart={false}
          layout="inline"
          onSave={handleSaveEnabled}
        >
          <input
            type="checkbox"
            id="policy-guard-enabled"
            checked={displayEnabled}
            onChange={(e) => setDraftEnabled((e.target as HTMLInputElement).checked)}
            class="w-4 h-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary cursor-pointer"
          />
          <label for="policy-guard-enabled" class="text-xs font-semibold text-slate-700 dark:text-text-main cursor-pointer">
            {t("policyGuardEnabled")}
          </label>
        </SettingItemControl>

        <SettingItemControl
          label={t("policyGuardErrorCodes")}
          hint={t("policyGuardErrorCodesHint")}
          isDirty={draftCodes !== null && draftCodes !== currentCodes.join("\n")}
          saving={!!savingFields.codes}
          saved={savedFields.codes}
          error={fieldErrors.codes}
          requiresRestart={false}
          onSave={handleSaveCodes}
        >
          <textarea
            class={textareaCls}
            value={displayCodes}
            onInput={(e) => setDraftCodes((e.target as HTMLTextAreaElement).value)}
            spellcheck={false}
            placeholder={"cyber_policy\nsession_blocked_by_cyber_policy"}
          />
        </SettingItemControl>

        <SettingItemControl
          label={t("policyGuardMessagePatterns")}
          hint={t("policyGuardMessagePatternsHint")}
          isDirty={draftPatterns !== null && draftPatterns !== currentPatterns.join("\n")}
          saving={!!savingFields.patterns}
          saved={savedFields.patterns}
          error={fieldErrors.patterns}
          requiresRestart={false}
          onSave={handleSavePatterns}
        >
          <textarea
            class={textareaCls}
            value={displayPatterns}
            onInput={(e) => setDraftPatterns((e.target as HTMLTextAreaElement).value)}
            spellcheck={false}
            placeholder={"possible cybersecurity risk\n网络安全策略屏蔽"}
          />
        </SettingItemControl>

        <SettingItemControl
          label={t("policyGuardStatusCodes")}
          hint={t("policyGuardStatusCodesHint")}
          isDirty={draftStatuses !== null && draftStatuses !== currentStatuses.join(", ")}
          saving={!!savingFields.statuses}
          saved={savedFields.statuses}
          error={fieldErrors.statuses}
          requiresRestart={false}
          onSave={handleSaveStatuses}
        >
          <input
            type="text"
            class={inputCls}
            value={displayStatuses}
            onInput={(e) => setDraftStatuses((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveStatuses(); }}
            placeholder="400, 403"
          />
        </SettingItemControl>

        <SettingItemControl
          label={t("policyGuardTtl")}
          hint={t("policyGuardTtlHint")}
          isDirty={draftTtl !== null && draftTtl !== String(currentTtl)}
          saving={!!savingFields.ttl}
          saved={savedFields.ttl}
          error={fieldErrors.ttl}
          requiresRestart={false}
          onSave={handleSaveTtl}
        >
          <div class="flex items-center gap-2">
            <input
              type="number"
              min="1"
              class={`${inputCls} max-w-[140px]`}
              value={displayTtl}
              onInput={(e) => setDraftTtl((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveTtl(); }}
            />
            <span class="text-xs text-slate-500 dark:text-text-dim">{t("seconds")}</span>
          </div>
        </SettingItemControl>
      </div>

      {/* Active quarantines — the manual release that makes a false positive
          recoverable without waiting out the TTL or restarting the process. */}
      <div class="px-5 pb-5 pt-1">
        <div class="flex items-center justify-between gap-4 mb-2">
          <div class="space-y-0.5">
            <h3 class="text-xs font-semibold text-slate-700 dark:text-text-main">
              {t("policyGuardQuarantines")}
            </h3>
            <p class="text-[0.75rem] text-slate-500 dark:text-text-dim leading-relaxed">
              {t("policyGuardQuarantinesHint")}
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            {quarantine.quarantines.length > 0 && (
              <button
                type="button"
                onClick={() => quarantine.reset({ all: true })}
                class="px-2.5 py-1 rounded-md text-[0.72rem] font-semibold border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-gray-50 dark:hover:bg-bg-dark transition-colors cursor-pointer"
              >
                {t("policyGuardReleaseAll")}
              </button>
            )}
            <button
              type="button"
              onClick={() => quarantine.refresh()}
              class="px-2.5 py-1 rounded-md text-[0.72rem] font-semibold border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-gray-50 dark:hover:bg-bg-dark transition-colors cursor-pointer"
            >
              {t("policyGuardRefresh")}
            </button>
          </div>
        </div>

        {quarantine.error && (
          <p class="text-xs text-red-500 font-medium mb-2">{quarantine.error}</p>
        )}

        {quarantine.quarantines.length === 0 ? (
          <p class="text-[0.75rem] text-slate-400 dark:text-text-dim italic">
            {quarantine.loading ? t("policyGuardLoading") : t("policyGuardNoQuarantines")}
          </p>
        ) : (
          <ul class="divide-y divide-gray-100 dark:divide-border-dark/60 border border-gray-100 dark:border-border-dark rounded-lg overflow-hidden">
            {quarantine.quarantines.map((q) => (
              <li key={q.conversation_id} class="px-3 py-2 flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <code class="text-[0.72rem] font-mono text-slate-700 dark:text-text-main">
                      {q.conversation_id.slice(0, 8)}
                    </code>
                    <span class="text-[0.7rem] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-bg-dark text-slate-500 dark:text-text-dim font-mono">
                      {q.code}
                    </span>
                    <span class="text-[0.7rem] text-slate-400 dark:text-text-dim">
                      {formatAge(q.age_seconds)}
                    </span>
                  </div>
                  <p class="text-[0.72rem] text-slate-500 dark:text-text-dim mt-1 break-words">
                    {q.message}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => quarantine.reset({ conversationId: q.conversation_id })}
                  title={t("policyGuardRelease")}
                  class="shrink-0 px-2.5 py-1 rounded-md text-[0.72rem] font-semibold border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-gray-50 dark:hover:bg-bg-dark transition-colors cursor-pointer"
                >
                  {t("policyGuardRelease")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
