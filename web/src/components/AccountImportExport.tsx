import { useState, useCallback, useRef } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";

interface ImportResult {
  success: boolean;
  added: number;
  updated: number;
  failed: number;
  errors: string[];
}

interface AccountImportExportProps {
  onExport: (selectedIds?: string[], format?: "full" | "minimal") => Promise<void>;
  onImport: (file: File) => Promise<ImportResult>;
  selectedIds: Set<string>;
}

export function AccountImportExport({ onExport, onImport, selectedIds }: AccountImportExportProps) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleExport = useCallback(async (format?: "full" | "minimal") => {
    try {
      const ids = selectedIds.size > 0 ? [...selectedIds] : undefined;
      await onExport(ids, format);
    } catch (err) {
      console.error("[AccountExport] failed:", err);
    }
  }, [onExport, selectedIds]);

  const handleFileChange = useCallback(async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) return;

    setImporting(true);
    setResult(null);
    try {
      let totalAdded = 0, totalUpdated = 0, totalFailed = 0;
      for (const file of files) {
        const res = await onImport(file);
        totalAdded += res.added;
        totalUpdated += res.updated;
        totalFailed += res.failed;
      }
      const msg = t("accountImportResult")
        .replace("{added}", String(totalAdded))
        .replace("{updated}", String(totalUpdated))
        .replace("{failed}", String(totalFailed));
      setResult(msg);
    } catch {
      setResult(t("accountImportError"));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [onImport, t]);

  const triggerFileSelect = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const handleDownloadTemplate = useCallback(() => {
    const template = {
      accounts: [
        { token: "eyJhbGciOi... (JWT access token)", refreshToken: "oaistb_rt_... (optional)", label: "Team Alpha (optional)" },
        { refreshToken: "oaistb_rt_... (refresh token only — will auto-exchange)" },
      ],
    };
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-template.json";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const exportTitle = selectedIds.size > 0
    ? `${t("exportBtn")} (${selectedIds.size})`
    : t("exportBtn");

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".json"
        multiple
        onChange={handleFileChange}
        class="hidden"
      />
      <button
        onClick={triggerFileSelect}
        disabled={importing}
        title={t("importBtn")}
        class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10 disabled:opacity-40"
      >
        <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
        </svg>
      </button>
      <button
        onClick={handleDownloadTemplate}
        title={t("downloadTemplate")}
        class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
      >
        <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
      </button>
      <button
        onClick={() => handleExport("full")}
        title={exportTitle}
        class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
      >
        <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12M12 16.5V3" />
        </svg>
      </button>
      <button
        onClick={() => handleExport("minimal")}
        title={t("exportMinimal")}
        class="p-1.5 text-slate-400 dark:text-text-dim hover:text-amber-500 transition-colors rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20"
      >
        <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
        </svg>
      </button>
      {selectedIds.size > 0 && (
        <span class="text-[0.7rem] text-primary font-medium hidden sm:inline">
          {selectedIds.size}
        </span>
      )}
      {result && (
        <span class="text-[0.75rem] text-slate-500 dark:text-text-dim hidden sm:inline">
          {result}
        </span>
      )}
    </>
  );
}
