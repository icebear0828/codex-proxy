import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useRotationSettings, type RotationStrategy } from "../../../shared/hooks/use-rotation-settings";
import { useSettings } from "../../../shared/hooks/use-settings";
import { SettingItemControl } from "./settings/SettingItemControl";

type Mode = "sticky" | "rotation";
type RotationSub = "least_used" | "round_robin";

function toMode(strategy: RotationStrategy): Mode {
  return strategy === "sticky" ? "sticky" : "rotation";
}

function toStrategy(mode: Mode, sub: RotationSub): RotationStrategy {
  return mode === "sticky" ? "sticky" : sub;
}

export function RotationSettings() {
  const t = useT();
  const settings = useSettings();
  const rs = useRotationSettings(settings.apiKey);

  const current = rs.data?.rotation_strategy ?? "least_used";
  const currentMode = toMode(current);
  const currentSub: RotationSub = current === "sticky" ? "least_used" : (current as RotationSub);

  const [draftMode, setDraftMode] = useState<Mode | null>(null);
  const [draftSub, setDraftSub] = useState<RotationSub | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayMode = draftMode ?? currentMode;
  const displaySub = draftSub ?? currentSub;
  const displayStrategy = toStrategy(displayMode, displaySub);
  const isDirty = displayStrategy !== current;

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await rs.save({ rotation_strategy: displayStrategy });
      setDraftMode(null);
      setDraftSub(null);
      setSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [isDirty, saving, displayStrategy, rs]);

  const radioCls = "w-4 h-4 text-primary focus:ring-primary cursor-pointer";
  const labelCls = "text-[0.8rem] font-medium text-slate-700 dark:text-text-main cursor-pointer";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden transition-colors">
      <div class="px-5 py-4 border-b border-gray-100 dark:border-border-dark flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="flex size-7 items-center justify-center rounded-lg bg-primary-container text-primary">
            <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
            </svg>
          </div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("rotationSettings")}</h2>
        </div>
      </div>

      <div class="px-5 py-2">
        <SettingItemControl
          label={t("rotationStrategy")}
          hint={t("rotationStrategyHint")}
          isDirty={isDirty}
          saving={saving}
          saved={saved}
          error={error}
          requiresRestart={false}
          onSave={handleSave}
        >
          {/* Mode: Sticky vs Rotation */}
          <div class="space-y-3 pt-1">
            {/* Sticky */}
            <label class="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-border-dark cursor-pointer hover:bg-slate-50 dark:hover:bg-bg-dark transition-colors">
              <input
                type="radio"
                name="rotation-mode"
                checked={displayMode === "sticky"}
                onChange={() => setDraftMode("sticky")}
                class={radioCls + " mt-0.5"}
              />
              <div>
                <span class={labelCls}>{t("rotationSticky")}</span>
                <p class="text-[0.75rem] text-slate-400 dark:text-text-dim mt-0.5">{t("rotationStickyDesc")}</p>
              </div>
            </label>

            {/* Rotation */}
            <label class="flex items-start gap-3 p-3 rounded-lg border border-gray-200 dark:border-border-dark cursor-pointer hover:bg-slate-50 dark:hover:bg-bg-dark transition-colors">
              <input
                type="radio"
                name="rotation-mode"
                checked={displayMode === "rotation"}
                onChange={() => setDraftMode("rotation")}
                class={radioCls + " mt-0.5"}
              />
              <div class="flex-1">
                <span class={labelCls}>{t("rotationRotate")}</span>
                <p class="text-[0.75rem] text-slate-400 dark:text-text-dim mt-0.5">{t("rotationRotateDesc")}</p>
              </div>
            </label>

            {/* Sub-strategy (only when rotation mode) */}
            {displayMode === "rotation" && (
              <div class="ml-8 space-y-2 pl-2 border-l-2 border-primary/30">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rotation-sub"
                    checked={displaySub === "least_used"}
                    onChange={() => setDraftSub("least_used")}
                    class={radioCls}
                  />
                  <div>
                    <span class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("rotationLeastUsed")}</span>
                    <span class="text-xs text-slate-400 dark:text-text-dim ml-1.5">{t("rotationLeastUsedDesc")}</span>
                  </div>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rotation-sub"
                    checked={displaySub === "round_robin"}
                    onChange={() => setDraftSub("round_robin")}
                    class={radioCls}
                  />
                  <div>
                    <span class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("rotationRoundRobin")}</span>
                    <span class="text-xs text-slate-400 dark:text-text-dim ml-1.5">{t("rotationRoundRobinDesc")}</span>
                  </div>
                </label>
              </div>
            )}
          </div>
        </SettingItemControl>
      </div>
    </section>
  );
}
