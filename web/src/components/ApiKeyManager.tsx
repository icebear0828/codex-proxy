/**
 * API Key Manager — Dashboard component for managing third-party API keys.
 * Supports add/delete/toggle/import/export with predefined model catalogs.
 */

import { useState, useCallback, useRef } from "preact/hooks";
import { useApiKeys } from "../../../shared/hooks/use-api-keys";
import type { ApiKeyProvider, ApiKeyEntry } from "../../../shared/hooks/use-api-keys";
import { CopyButton } from "./CopyButton";

const PROVIDER_OPTIONS: Array<{ value: ApiKeyProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
];

// ── Add Key Form ───────────────────────────────────────────────────

function AddKeyForm({ onAdd, catalog }: {
  onAdd: (input: { provider: ApiKeyProvider; model: string; apiKey: string; baseUrl?: string; label?: string }) => Promise<{ ok: boolean; error?: string }>;
  catalog: Record<string, { displayName: string; defaultBaseUrl: string; models: Array<{ id: string; displayName: string }> }>;
}) {
  const [provider, setProvider] = useState<ApiKeyProvider>("anthropic");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const isCustom = provider === "custom";
  const providerCatalog = !isCustom ? catalog[provider]?.models ?? [] : [];

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");
    if (!model.trim() || !apiKey.trim()) {
      setError("Model and API Key are required");
      return;
    }
    if (isCustom && !baseUrl.trim()) {
      setError("Base URL is required for custom providers");
      return;
    }
    setAdding(true);
    const result = await onAdd({
      provider,
      model: model.trim(),
      apiKey: apiKey.trim(),
      baseUrl: isCustom ? baseUrl.trim() : undefined,
      label: label.trim() || undefined,
    });
    setAdding(false);
    if (result.ok) {
      setModel("");
      setApiKey("");
      setBaseUrl("");
      setLabel("");
    } else {
      setError(result.error || "Failed to add key");
    }
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-3 p-4 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl">
      <div class="flex flex-wrap gap-3">
        {/* Provider */}
        <div class="flex flex-col gap-1 min-w-[140px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ApiKeyProvider;
              setProvider(v);
              setModel("");
              setBaseUrl("");
            }}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Model */}
        <div class="flex flex-col gap-1 flex-1 min-w-[180px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Model</label>
          {providerCatalog.length > 0 ? (
            <select
              value={model}
              onChange={(e) => setModel((e.target as HTMLSelectElement).value)}
              class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
            >
              <option value="">Select model...</option>
              {providerCatalog.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onInput={(e) => setModel((e.target as HTMLInputElement).value)}
              placeholder="model-name"
              class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
            />
          )}
        </div>

        {/* API Key */}
        <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">API Key</label>
          <input
            type="password"
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            placeholder="sk-..."
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      </div>

      {/* Custom-only: Base URL */}
      {isCustom && (
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Base URL</label>
          <input
            type="url"
            value={baseUrl}
            onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            placeholder="https://api.example.com/v1"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      )}

      {/* Label + Submit */}
      <div class="flex gap-3 items-end">
        <div class="flex flex-col gap-1 flex-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Label (optional)</label>
          <input
            type="text"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            placeholder="e.g. Production, Team A"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          class="px-4 py-1.5 text-sm font-medium text-white bg-primary hover:bg-primary-hover rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {adding ? "Adding..." : "Add Key"}
        </button>
      </div>

      {error && <p class="text-xs text-red-500">{error}</p>}
    </form>
  );
}

// ── Key Row ────────────────────────────────────────────────────────

function providerBadgeColor(provider: ApiKeyProvider): string {
  switch (provider) {
    case "anthropic": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
    case "openai": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
    case "gemini": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
    case "openrouter": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400";
    default: return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
  }
}

function KeyRow({ entry, onDelete, onToggle }: {
  entry: ApiKeyEntry;
  onDelete: (id: string) => void;
  onToggle: (id: string, status: "active" | "disabled") => void;
}) {
  const isActive = entry.status === "active";

  return (
    <div class={`flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-opacity ${!isActive ? "opacity-50" : ""}`}>
      {/* Provider badge */}
      <span class={`text-[0.65rem] font-semibold uppercase px-1.5 py-0.5 rounded ${providerBadgeColor(entry.provider)}`}>
        {entry.provider}
      </span>

      {/* Model */}
      <span class="text-sm font-mono text-slate-800 dark:text-text-main">
        {entry.model}
      </span>

      {/* Label */}
      {entry.label && (
        <span class="text-xs text-slate-500 dark:text-text-dim">
          {entry.label}
        </span>
      )}

      {/* Masked key */}
      <span class="text-xs font-mono text-slate-400 dark:text-text-dim ml-auto hidden sm:inline">
        {entry.apiKey}
      </span>

      {/* Toggle */}
      <button
        onClick={() => onToggle(entry.id, isActive ? "disabled" : "active")}
        title={isActive ? "Disable" : "Enable"}
        class={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
          isActive ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span class={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
          isActive ? "translate-x-[16px]" : "translate-x-0.5"
        }`} />
      </button>

      {/* Delete */}
      <button
        onClick={() => onDelete(entry.id)}
        title="Delete"
        class="p-1 text-slate-400 hover:text-red-500 transition-colors"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
        </svg>
      </button>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────────

export function ApiKeyManager() {
  const { keys, catalog, loading, addKey, deleteKey, toggleStatus, importKeys } = useApiKeys();
  const [showForm, setShowForm] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback(async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) return;
    try {
      const result = await importKeys(files[0]);
      setImportResult(`Added: ${result.added}, Failed: ${result.failed}`);
      setTimeout(() => setImportResult(null), 5000);
    } catch {
      setImportResult("Import failed");
    }
    if (fileRef.current) fileRef.current.value = "";
  }, [importKeys]);

  if (loading) {
    return <div class="text-sm text-slate-400 dark:text-text-dim animate-pulse">Loading API keys...</div>;
  }

  return (
    <div class="flex flex-col gap-3">
      {/* Header */}
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main flex items-center gap-2">
          <svg class="size-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
          </svg>
          API Keys
          <span class="text-xs font-normal text-slate-400 dark:text-text-dim">
            ({keys.length})
          </span>
        </h2>

        <div class="ml-auto flex items-center gap-1">
          {importResult && (
            <span class="text-xs text-slate-500 dark:text-text-dim mr-2">{importResult}</span>
          )}

          <input ref={fileRef} type="file" accept=".json" onChange={handleImport} class="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            title="Import"
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12M12 16.5V3" />
            </svg>
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            title="Add API Key"
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <AddKeyForm
          onAdd={async (input) => {
            const result = await addKey(input);
            if (result.ok) setShowForm(false);
            return result;
          }}
          catalog={catalog}
        />
      )}

      {/* Key list */}
      {keys.length === 0 ? (
        <div class="text-center py-8 text-sm text-slate-400 dark:text-text-dim">
          No API keys configured. Click + to add one.
        </div>
      ) : (
        <div class="flex flex-col gap-2">
          {keys.map((entry) => (
            <KeyRow
              key={entry.id}
              entry={entry}
              onDelete={deleteKey}
              onToggle={toggleStatus}
            />
          ))}
        </div>
      )}
    </div>
  );
}
