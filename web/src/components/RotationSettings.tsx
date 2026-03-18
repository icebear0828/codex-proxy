import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useRotationSettings, type RotationStrategy } from "../../../shared/hooks/use-rotation-settings";
import { useSettings } from "../../../shared/hooks/use-settings";

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
  const [collapsed, setCollapsed] = useState(true);

  const displayMode = draftMode ?? currentMode;
  const displaySub = draftSub ?? currentSub;
  const displayStrategy = toStrategy(displayMode, displaySub);
  const isDirty = displayStrategy !== current;

  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    await rs.save({ rotation_strategy: displayStrategy });
    setDraftMode(null);
    setDraftSub(null);
  }, [isDirty, displayStrategy, rs]);

  const radioCls = "w-4 h-4 text-primary focus:ring-primary cursor-pointer";
  const labelCls = "text-[0.8rem] font-medium text-slate-700 dark:text-text-main cursor-pointer";

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("rotationSettings")}</h2>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <p class="text-xs text-slate-400 dark:text-text-dim">{t("rotationStrategyHint")}</p>

          {/* Mode: Sticky vs Rotation */}
          <div class="space-y-3">
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
                <p class="text-xs text-slate-400 dark:text-text-dim mt-0.5">{t("rotationStickyDesc")}</p>
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
                <p class="text-xs text-slate-400 dark:text-text-dim mt-0.5">{t("rotationRotateDesc")}</p>
              </div>
            </label>

            {/* Sub-strategy (only when rotation mode) */}
            {displayMode === "rotation" && (
              <div class="ml-10 space-y-2">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="rotation-sub"
                    checked={displaySub === "least_used"}
                    onChange={() => setDraftSub("least_used")}
                    class={radioCls}
                  />
                  <div>
                    <span class="text-xs font-medium text-slate-600 dark:text-text-main">{t("rotationLeastUsed")}</span>
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
                    <span class="text-xs font-medium text-slate-600 dark:text-text-main">{t("rotationRoundRobin")}</span>
                    <span class="text-xs text-slate-400 dark:text-text-dim ml-1.5">{t("rotationRoundRobinDesc")}</span>
                  </div>
                </label>
              </div>
            )}
          </div>

          {/* Save button + status */}
          <div class="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={rs.saving || !isDirty}
              class={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                isDirty && !rs.saving
                  ? "bg-primary text-white hover:bg-primary/90 cursor-pointer"
                  : "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
              }`}
            >
              {rs.saving ? "..." : t("submit")}
            </button>
            {rs.saved && (
              <span class="text-xs font-medium text-green-600 dark:text-green-400">{t("rotationSaved")}</span>
            )}
            {rs.error && (
              <span class="text-xs font-medium text-red-500">{rs.error}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
