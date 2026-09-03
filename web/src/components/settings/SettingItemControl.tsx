import { useState, useEffect, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { useT } from "../../../../shared/i18n/context";

interface SettingItemControlProps {
  label: string;
  hint?: ComponentChildren;
  isDirty?: boolean;
  saving?: boolean;
  saved?: boolean;
  error?: string | null;
  requiresRestart?: boolean;
  onSave?: () => Promise<void> | void;
  children: ComponentChildren;
  layout?: "inline" | "stacked";
  disabled?: boolean;
}

export function SettingItemControl({
  label,
  hint,
  isDirty = false,
  saving = false,
  saved = false,
  error = null,
  requiresRestart = false,
  onSave,
  children,
  layout = "stacked",
  disabled = false,
}: SettingItemControlProps) {
  const t = useT();
  const [showSavedBadge, setShowSavedBadge] = useState(false);
  const [isFading, setIsFading] = useState(false);

  // A badge must only appear after a *successful* save, not when the user merely
  // reverts an edit back to the committed value (which also flips isDirty true->false).
  // We detect a real save two ways:
  //   1. the Save button was clicked (lastSaveClickRef), or
  //   2. the parent externally flipped `saved` false->true (savedRising), used by
  //      fields like layoutMode that have no Save button and signal the badge via
  //      the `saved` prop.
  const lastSaveClickRef = useRef(false);
  const prevSavedRef = useRef(saved);
  const fadeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearFadeTimers = () => {
    fadeTimersRef.current.forEach((t) => clearTimeout(t));
    fadeTimersRef.current = [];
  };

  // Cancel in-flight fades only on unmount — do NOT cancel them when `saved` flips
  // false (e.g. layoutMode resets `saved` at 2s), otherwise the remove timer is lost.
  useEffect(() => clearFadeTimers, []);

  useEffect(() => {
    if (isDirty) {
      // Editing invalidates any pending badge/save signal.
      lastSaveClickRef.current = false;
      prevSavedRef.current = saved;
      return;
    }

    const savedRising = saved && !prevSavedRef.current;
    prevSavedRef.current = saved;

    const shouldShow = saved && (savedRising || lastSaveClickRef.current);
    lastSaveClickRef.current = false;
    if (!shouldShow) return;

    clearFadeTimers();
    setShowSavedBadge(true);
    setIsFading(false);

    if (!requiresRestart) {
      // requiresRestart badges must persist until the app is restarted.
      fadeTimersRef.current.push(
        setTimeout(() => {
          setIsFading(true);
        }, 1800),
        setTimeout(() => {
          setShowSavedBadge(false);
          setIsFading(false);
        }, 2500),
      );
    }
  }, [saved, isDirty, requiresRestart]);

  const handleSave = async (e?: Event) => {
    if (e) e.preventDefault();
    if (!onSave || saving || disabled) return;
    lastSaveClickRef.current = true;
    await onSave();
  };

  const actionNode = (
    <div class="flex items-center gap-2 shrink-0 min-h-[32px]">
      {saving && (
        <div class="inline-flex items-center justify-center size-8 shrink-0 text-primary" title={t("settingSaving")}>
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

      {!saving && !isDirty && showSavedBadge && (
        requiresRestart ? (
          <div
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.72rem] font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60 shrink-0 animate-in fade-in"
            title={t("generalSettingsRestartRequired")}
          >
            <svg class="size-3.5 animate-spin" style="animation-duration: 8s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.992 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.985 4.356v4.992" />
            </svg>
            <span>{t("settingWaitingRestart")}</span>
          </div>
        ) : (
          <div
            class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[0.72rem] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-500/20 shrink-0 transition-opacity duration-700 animate-in fade-in"
            style={{ opacity: isFading ? 0 : 1 }}
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <span>{t("settingSaved")}</span>
          </div>
        )
      )}
    </div>
  );

  if (layout === "inline") {
    return (
      <div class="py-3 border-b border-gray-100 dark:border-border-dark/60 last:border-b-0">
        <div class="flex items-center justify-between gap-4">
          <div class="space-y-0.5 flex-1 min-w-0">
            <div class="flex items-center gap-2">
              {children}
            </div>
            {hint && (
              <p class="text-[0.75rem] text-slate-500 dark:text-text-dim leading-relaxed ml-6">{hint}</p>
            )}
          </div>
          {actionNode}
        </div>
        {error && <p class="text-xs text-red-500 font-medium mt-1 ml-6">{error}</p>}
      </div>
    );
  }

  return (
    <div class="py-3 border-b border-gray-100 dark:border-border-dark/60 last:border-b-0 space-y-1.5">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-0.5 flex-1 min-w-0">
          <label class="block text-xs font-semibold text-slate-700 dark:text-text-main">
            {label}
          </label>
          {hint && (
            <p class="text-[0.75rem] text-slate-500 dark:text-text-dim leading-relaxed">{hint}</p>
          )}
        </div>
        {actionNode}
      </div>
      <div class="flex items-center gap-2">
        <div class="flex-1 min-w-0">
          {children}
        </div>
      </div>
      {error && <p class="text-xs text-red-500 font-medium">{error}</p>}
    </div>
  );
}
