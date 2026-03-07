import { useState, useCallback, useRef } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { ImportDiff } from "../../../shared/hooks/use-proxy-assignments";

interface ImportExportProps {
  onExport: () => Promise<Array<{ email: string; proxyId: string }>>;
  onImportPreview: (data: Array<{ email: string; proxyId: string }>) => Promise<ImportDiff | null>;
  onApplyImport: (assignments: Array<{ accountId: string; proxyId: string }>) => Promise<void>;
}

export function ImportExport({ onExport, onImportPreview, onApplyImport }: ImportExportProps) {
  const t = useT();
  const [showImport, setShowImport] = useState(false);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleExport = useCallback(async () => {
    const data = await onExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "proxy-assignments.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [onExport]);

  const handleFileSelect = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Array<{ email: string; proxyId: string }>;
      if (!Array.isArray(parsed)) {
        alert("Invalid format: expected array of { email, proxyId }");
        return;
      }
      setImporting(true);
      const result = await onImportPreview(parsed);
      setDiff(result);
      setImporting(false);
    } catch {
      alert("Failed to parse JSON file");
    }
  }, [onImportPreview]);

  const handleApply = useCallback(async () => {
    if (!diff || diff.changes.length === 0) return;
    setImporting(true);
    await onApplyImport(
      diff.changes.map((c) => ({ accountId: c.accountId, proxyId: c.to })),
    );
    setImporting(false);
    setDiff(null);
    setShowImport(false);
  }, [diff, onApplyImport]);

  const handleClose = useCallback(() => {
    setShowImport(false);
    setDiff(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  return (
    <>
      {/* Buttons */}
      <div class="flex items-center gap-2">
        <button
          onClick={() => setShowImport(true)}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
        >
          {t("importBtn")}
        </button>
        <button
          onClick={handleExport}
          class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
        >
          {t("exportBtn")}
        </button>
      </div>

      {/* Import Modal */}
      {showImport && (
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
          <div
            class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-6 w-full max-w-lg mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 class="text-lg font-semibold mb-4">{t("importPreview")}</h3>

            {!diff ? (
              <div class="space-y-4">
                <p class="text-sm text-slate-500 dark:text-text-dim">{t("importFile")}</p>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  class="block w-full text-sm text-slate-500 dark:text-text-dim file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer"
                />
                {importing && (
                  <p class="text-sm text-slate-500 dark:text-text-dim animate-pulse">Loading...</p>
                )}
              </div>
            ) : (
              <div class="space-y-4">
                {diff.changes.length === 0 ? (
                  <p class="text-sm text-slate-500 dark:text-text-dim">{t("noChanges")}</p>
                ) : (
                  <>
                    <p class="text-sm font-medium">
                      {diff.changes.length} {t("changesCount")}
                      {diff.unchanged > 0 && (
                        <span class="text-slate-400 dark:text-text-dim ml-2">
                          ({diff.unchanged} unchanged)
                        </span>
                      )}
                    </p>
                    <div class="max-h-60 overflow-y-auto border border-gray-100 dark:border-border-dark rounded-lg">
                      {diff.changes.map((c) => (
                        <div
                          key={c.accountId}
                          class="flex items-center justify-between px-3 py-2 text-xs border-b border-gray-50 dark:border-border-dark/50"
                        >
                          <span class="font-medium truncate flex-1 text-slate-700 dark:text-text-main">
                            {c.email}
                          </span>
                          <span class="flex items-center gap-1.5 shrink-0 ml-2">
                            <span class="text-slate-400 dark:text-text-dim">{c.from}</span>
                            <svg class="size-3 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                            </svg>
                            <span class="text-primary font-medium">{c.to}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Actions */}
            <div class="flex items-center justify-end gap-2 mt-4">
              <button
                onClick={handleClose}
                class="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                {t("cancelBtn")}
              </button>
              {diff && diff.changes.length > 0 && (
                <button
                  onClick={handleApply}
                  disabled={importing}
                  class="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors disabled:opacity-50"
                >
                  {importing ? "..." : t("confirmApply")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
