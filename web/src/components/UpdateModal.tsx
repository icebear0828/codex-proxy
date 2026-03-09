import { useEffect, useRef } from "preact/hooks";
import { useI18n } from "../../../shared/i18n/context";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  mode: "git" | "docker" | "electron";
  commits: { hash: string; message: string }[];
  release: { version: string; body: string; url: string } | null;
  onApply: () => void;
  applying: boolean;
  restarting: boolean;
  restartFailed: boolean;
}

export function UpdateModal({
  open,
  onClose,
  mode,
  commits,
  release,
  onApply,
  applying,
  restarting,
  restartFailed,
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
      class="backdrop:bg-black/50 bg-transparent p-0 m-auto max-w-lg w-full open:flex"
    >
      <div class="w-full bg-white dark:bg-card-dark rounded-xl shadow-2xl border border-gray-200 dark:border-border-dark overflow-hidden">
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
          {restarting ? (
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
            <ul class="space-y-1 text-sm text-slate-600 dark:text-text-dim max-h-64 overflow-y-auto">
              {commits.map((c) => (
                <li key={c.hash} class="flex gap-2 py-0.5">
                  <code class="text-primary/70 text-xs shrink-0 pt-0.5">{c.hash}</code>
                  <span class="text-xs">{c.message}</span>
                </li>
              ))}
            </ul>
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
              <button
                onClick={() => { navigator.clipboard.writeText("docker compose up -d --build"); }}
                class="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
              >
                {t("copy")} docker compose up -d --build
              </button>
            ) : (
              <a
                href={release?.url}
                target="_blank"
                rel="noopener noreferrer"
                class="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors inline-flex"
              >
                {t("downloadUpdate")}
              </a>
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
