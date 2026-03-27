import { useEffect, useRef } from "preact/hooks";
import { useI18n } from "../../../shared/i18n/context";
import type { UpdateStep } from "../../../shared/hooks/use-update-status";
import type { TranslationKey } from "../../../shared/i18n/translations";

const STEP_LABELS: Record<string, TranslationKey> = {
  pull: "updatePulling",
  install: "updateInstalling",
  build: "updateBuilding",
  restart: "updateRestarting",
};

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  mode: "git" | "docker" | "electron";
  commits: { hash: string; message: string }[];
  changelog: string | null;
  release: { version: string; body: string; url: string } | null;
  onApply: () => void;
  applying: boolean;
  restarting: boolean;
  restartFailed: boolean;
  updateSteps?: UpdateStep[];
}

export function UpdateModal({
  open,
  onClose,
  mode,
  commits,
  changelog,
  release,
  onApply,
  applying,
  restarting,
  restartFailed,
  updateSteps = [],
}: UpdateModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Close on backdrop click
  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === dialogRef.current && !restarting && !applying) {
      onClose();
    }
  };

  // Close on Escape
  const handleCancel = (e: Event) => {
    if (restarting || applying) {
      e.preventDefault();
    }
  };

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      onCancel={handleCancel}
      class="backdrop:bg-black/50 bg-transparent p-0 m-0 w-full h-full max-w-none max-h-none inset-0 open:flex open:items-center open:justify-center"
    >
      <div class="w-full max-w-lg bg-white dark:bg-card-dark rounded-xl shadow-2xl border border-gray-200 dark:border-border-dark overflow-hidden">
        {/* Header */}
        <div class="px-5 py-4 border-b border-gray-200 dark:border-border-dark flex items-center justify-between">
          <h2 class="text-base font-bold text-slate-800 dark:text-text-main">
            {t("updateTitle")}
          </h2>
          {!restarting && !applying && (
            <button
              onClick={onClose}
              class="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:text-text-dim dark:hover:text-text-main hover:bg-slate-100 dark:hover:bg-border-dark transition-colors"
            >
              <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div class="px-5 py-4">
          {(applying || restarting) && updateSteps.length > 0 ? (
            <div class="space-y-2 py-2">
              {updateSteps.map((s) => (
                <div key={s.step} class="flex items-center gap-3 text-sm">
                  {s.status === "done" ? (
                    <svg class="size-5 text-primary shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                  ) : s.status === "error" ? (
                    <svg class="size-5 text-red-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  ) : (
                    <svg class="size-5 animate-spin text-primary shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  <span class={s.status === "done" ? "text-slate-500 dark:text-text-dim" : "text-slate-700 dark:text-text-main font-medium"}>
                    {t(STEP_LABELS[s.step] ?? ("updateBuilding" as TranslationKey))}
                  </span>
                </div>
              ))}
            </div>
          ) : restarting ? (
            <div class="flex flex-col items-center gap-3 py-6">
              <svg class="size-8 animate-spin text-primary" viewBox="0 0 24 24" fill="none">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span class="text-sm font-medium text-slate-600 dark:text-text-dim">
                {t("updateRestarting")}
              </span>
            </div>
          ) : restartFailed ? (
            <div class="flex flex-col items-center gap-3 py-6">
              <svg class="size-8 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span class="text-sm font-medium text-red-600 dark:text-red-400">
                {t("restartFailed")}
              </span>
            </div>
          ) : mode === "git" ? (
            changelog ? (
              <pre class="text-xs text-slate-600 dark:text-text-dim whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
                {changelog}
              </pre>
            ) : (
              <ul class="space-y-1 text-sm text-slate-600 dark:text-text-dim max-h-64 overflow-y-auto">
                {commits.map((c) => (
                  <li key={c.hash} class="flex gap-2 py-0.5">
                    <code class="text-primary/70 text-xs shrink-0 pt-0.5">{c.hash}</code>
                    <span class="text-xs">{c.message}</span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              {release && (
                <pre class="text-xs text-slate-600 dark:text-text-dim whitespace-pre-wrap max-h-64 overflow-y-auto leading-relaxed">
                  {release.body}
                </pre>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!restarting && !restartFailed && (
          <div class="px-5 py-3 border-t border-gray-200 dark:border-border-dark flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              disabled={applying}
              class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors disabled:opacity-50"
            >
              {t("cancelBtn")}
            </button>
            {mode === "git" ? (
              <button
                onClick={onApply}
                disabled={applying}
                class="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {applying && (
                  <svg class="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {applying ? t("applyingUpdate") : t("updateNow")}
              </button>
            ) : mode === "docker" ? (
              <div class="flex flex-col items-end gap-1.5">
                <button
                  onClick={() => { navigator.clipboard.writeText("docker compose pull && docker compose up -d"); }}
                  class="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
                >
                  {t("copy")} docker compose pull && docker compose up -d
                </button>
                <span class="text-[10px] text-slate-400 dark:text-text-dim">
                  {t("dockerAutoUpdateHint")}
                </span>
              </div>
            ) : (
              // electron mode: link to GitHub release page for manual download
              release?.url ? (
                <a
                  href={release.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
                >
                  {t("electronDownloadBtn")}
                </a>
              ) : (
                <span class="text-xs text-slate-500 dark:text-text-dim italic">
                  {t("electronUpdateHint")}
                </span>
              )
            )}
          </div>
        )}

        {/* Close button for restartFailed state */}
        {restartFailed && (
          <div class="px-5 py-3 border-t border-gray-200 dark:border-border-dark flex justify-end">
            <button
              onClick={onClose}
              class="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors"
            >
              {t("close")}
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
