/**
 * API Key Manager — Dashboard component for managing third-party API keys.
 * Supports add/delete/toggle/import/export with predefined model catalogs.
 */

import { useState, useCallback, useMemo, useRef } from "preact/hooks";
import { useApiKeys } from "../../../shared/hooks/use-api-keys";
import type { ApiKeyCapability, ApiKeyProvider, ApiKeyWire, ApiKeyEntry, CatalogModel } from "../../../shared/hooks/use-api-keys";

/** Providers whose upstream wire protocol (chat vs responses) is selectable. */
const WIRE_SELECTABLE_PROVIDERS: ReadonlySet<ApiKeyProvider> = new Set(["openai", "openrouter", "custom"]);

const CUSTOM_MODELS_HINT = "请先输入key和url，将会获取模型列表";
const CUSTOM_MODELS_FALLBACK_HINT = "模型列表获取失败，请手动输入模型名";

const PROVIDER_OPTIONS: Array<{ value: ApiKeyProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
];

const CAPABILITY_OPTIONS: Array<{ value: ApiKeyCapability; label: string }> = [
  { value: "chat", label: "Chat" },
  { value: "embeddings", label: "Embeddings" },
];

type CustomModelStatus = "idle" | "loading" | "loaded" | "fallback";

function normalizeCustomModelInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderModelChecklist(models: CatalogModel[], selectedModelSet: Set<string>, onToggle: (modelId: string) => void) {
  return (
    <div class="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark p-2 flex flex-col gap-1">
      {models.map((model) => (
        <label key={model.id} class="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/70 dark:hover:bg-card-dark/70 text-sm text-slate-800 dark:text-text-main">
          <input
            type="checkbox"
            checked={selectedModelSet.has(model.id)}
            onChange={() => onToggle(model.id)}
          />
          <span>{model.displayName}</span>
          <span class="text-xs font-mono text-slate-400 dark:text-text-dim ml-auto">{model.id}</span>
        </label>
      ))}
    </div>
  );
}

function AddKeyForm({ onAdd, catalog, fetchCustomModels }: {
  onAdd: (input: {
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl?: string;
    label?: string;
    capabilities?: ApiKeyCapability[];
    wire?: ApiKeyWire;
  }) => Promise<{ ok: boolean; error?: string }>;
  catalog: Record<string, { displayName: string; defaultBaseUrl: string; models: Array<{ id: string; displayName: string }> }>;
  fetchCustomModels: (input: { provider: "custom"; apiKey: string; baseUrl: string }) => Promise<{ ok: true; models: CatalogModel[] } | { ok: false; error: string }>;
}) {
  const [provider, setProvider] = useState<ApiKeyProvider>("anthropic");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [manualModelsInput, setManualModelsInput] = useState("");
  const [capabilities, setCapabilities] = useState<ApiKeyCapability[]>(["chat"]);
  const [wire, setWire] = useState<ApiKeyWire>("chat");
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [customModelStatus, setCustomModelStatus] = useState<CustomModelStatus>("idle");
  const [customModelMessage, setCustomModelMessage] = useState(CUSTOM_MODELS_HINT);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const latestCustomRequestRef = useRef(0);
  const latestResolvedSignatureRef = useRef("");

  const isCustom = provider === "custom";
  const wireSelectable = WIRE_SELECTABLE_PROVIDERS.has(provider);
  const providerCatalog = !isCustom ? catalog[provider]?.models ?? [] : [];
  const selectedModelSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const selectedCapabilitySet = useMemo(() => new Set(capabilities), [capabilities]);

  const resetCustomModels = useCallback((status: CustomModelStatus = "idle", message = CUSTOM_MODELS_HINT) => {
    setCustomModels([]);
    setSelectedModels([]);
    setCustomModelStatus(status);
    setCustomModelMessage(message);
  }, []);

  const handleModelToggle = (modelId: string) => {
    setSelectedModels((prev) => prev.includes(modelId)
      ? prev.filter((id) => id !== modelId)
      : [...prev, modelId]);
  };

  const handleCapabilityToggle = (capability: ApiKeyCapability) => {
    setCapabilities((prev) => prev.includes(capability)
      ? prev.filter((item) => item !== capability)
      : [...prev, capability]);
  };

  const triggerCustomModelFetch = useCallback(async () => {
    if (!isCustom) return;

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (!normalizedApiKey || !normalizedBaseUrl) {
      resetCustomModels();
      return;
    }

    const signature = `${normalizedBaseUrl}::${normalizedApiKey}`;
    if (latestResolvedSignatureRef.current === signature && customModels.length > 0) return;

    const requestId = latestCustomRequestRef.current + 1;
    latestCustomRequestRef.current = requestId;
    setCustomModelStatus("loading");
    setCustomModelMessage("正在获取模型列表...");
    setError("");

    const result = await fetchCustomModels({
      provider: "custom",
      apiKey: normalizedApiKey,
      baseUrl: normalizedBaseUrl,
    });

    if (latestCustomRequestRef.current !== requestId) return;

    if (!result.ok || result.models.length === 0) {
      setCustomModels([]);
      setSelectedModels([]);
      setCustomModelStatus("fallback");
      setCustomModelMessage(result.ok ? CUSTOM_MODELS_FALLBACK_HINT : `${CUSTOM_MODELS_FALLBACK_HINT}：${result.error}`);
      latestResolvedSignatureRef.current = "";
      return;
    }

    setCustomModels(result.models);
    setCustomModelStatus("loaded");
    setCustomModelMessage("");
    latestResolvedSignatureRef.current = signature;
    setSelectedModels((prev) => {
      const next = prev.filter((id) => result.models.some((model) => model.id === id));
      return next.length > 0 ? next : [result.models[0].id];
    });
  }, [apiKey, baseUrl, customModels.length, fetchCustomModels, isCustom, resetCustomModels]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    const normalizedManualModels = normalizeCustomModelInput(manualModelsInput);
    const models = isCustom && customModelStatus === "fallback"
      ? normalizedManualModels
      : [...new Set([...selectedModels, ...normalizedManualModels])];

    if (models.length === 0 || !normalizedApiKey) {
      setError(isCustom && customModelStatus === "fallback"
        ? "请输入至少一个模型名并填写 API Key"
        : "Select at least one model and enter an API Key");
      return;
    }
    if (isCustom && !normalizedBaseUrl) {
      setError("Base URL is required for custom providers");
      return;
    }
    if (capabilities.length === 0) {
      setError("Select at least one capability");
      return;
    }

    setAdding(true);
    const result = await onAdd({
      provider,
      models,
      apiKey: normalizedApiKey,
      baseUrl: isCustom ? normalizedBaseUrl : undefined,
      label: label.trim() || undefined,
      capabilities,
      wire: wireSelectable ? wire : undefined,
    });
    setAdding(false);
    if (result.ok) {
      setSelectedModels([]);
      setApiKey("");
      setBaseUrl("");
      setLabel("");
      setManualModelsInput("");
      setCapabilities(["chat"]);
      setWire("chat");
      resetCustomModels();
    } else {
      setError(result.error || "Failed to add key");
    }
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-3 p-4 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl">
      <div class="flex flex-wrap gap-3">
        <div class="flex flex-col gap-1 min-w-[140px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ApiKeyProvider;
              setProvider(v);
              setSelectedModels([]);
              setBaseUrl("");
              setApiKey("");
              setLabel("");
              setManualModelsInput("");
              setCapabilities(["chat"]);
              setWire("chat");
              latestResolvedSignatureRef.current = "";
              resetCustomModels();
            }}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">API Key</label>
          <input
            type="password"
            value={apiKey}
            onInput={(e) => {
              setApiKey((e.target as HTMLInputElement).value);
              if (isCustom) {
                latestResolvedSignatureRef.current = "";
                resetCustomModels();
              }
            }}
            placeholder="sk-..."
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Models</label>
        {!isCustom && renderModelChecklist(providerCatalog, selectedModelSet, handleModelToggle)}
        {isCustom && customModelStatus === "loaded" && renderModelChecklist(customModels, selectedModelSet, handleModelToggle)}
        {isCustom && customModelStatus !== "loaded" && (
          <div class="flex flex-col gap-2">
            <div class="px-2.5 py-2 text-sm rounded-lg border border-dashed border-gray-200 dark:border-border-dark text-slate-400 dark:text-text-dim">
              {customModelStatus === "loading" ? "正在获取模型列表..." : customModelMessage}
            </div>
            {customModelStatus === "fallback" && (
              <input
                type="text"
                value={manualModelsInput}
                onInput={(e) => setManualModelsInput((e.target as HTMLInputElement).value)}
                placeholder="model-name-1, model-name-2"
                class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
              />
            )}
          </div>
        )}
        {(!isCustom || customModelStatus === "loaded") && (
          <input
            type="text"
            value={manualModelsInput}
            onInput={(e) => setManualModelsInput((e.target as HTMLInputElement).value)}
            placeholder="manual-model-1, manual-model-2"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        )}
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Capabilities</label>
        <div class="flex flex-wrap gap-2">
          {CAPABILITY_OPTIONS.map((option) => (
            <label key={option.value} class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-sm text-slate-700 dark:text-text-main">
              <input
                type="checkbox"
                checked={selectedCapabilitySet.has(option.value)}
                onChange={() => handleCapabilityToggle(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>

      {wireSelectable && (
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Upstream protocol</label>
          <select
            value={wire}
            onChange={(e) => setWire((e.target as HTMLSelectElement).value as ApiKeyWire)}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            <option value="chat">Chat Completions (default)</option>
            <option value="responses">Responses API</option>
          </select>
          <span class="text-[0.65rem] text-slate-400 dark:text-text-dim">
            多数第三方(DeepSeek / Kimi / GLM)只支持 Chat Completions；仅当上游支持原生 Responses API 时才选 Responses。
          </span>
        </div>
      )}

      {isCustom && (
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Base URL</label>
          <input
            type="url"
            value={baseUrl}
            onInput={(e) => {
              setBaseUrl((e.target as HTMLInputElement).value);
              latestResolvedSignatureRef.current = "";
              resetCustomModels();
            }}
            onBlur={() => { void triggerCustomModelFetch(); }}
            placeholder="https://api.example.com/v1"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      )}

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
          class="px-4 py-1.5 text-sm font-medium text-white bg-primary-action hover:bg-primary-action-hover rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {adding ? "Adding..." : "Add Key"}
        </button>
      </div>

      {error && <p class="text-xs text-red-500">{error}</p>}
    </form>
  );
}

export { AddKeyForm };

function providerBadgeColor(provider: ApiKeyProvider): string {
  switch (provider) {
    case "anthropic": return "bg-warning-container text-warning";
    case "openai": return "bg-success-container text-success";
    case "gemini": return "bg-info-container text-info";
    case "openrouter": return "bg-avatar-purple-bg text-avatar-purple-text";
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
      <span class={`text-[0.65rem] font-semibold uppercase px-1.5 py-0.5 rounded ${providerBadgeColor(entry.provider)}`}>
        {entry.provider}
      </span>

      <span class="text-sm font-mono text-slate-800 dark:text-text-main">
        {entry.model}
      </span>

      {entry.label && (
        <span class="text-xs text-slate-500 dark:text-text-dim">
          {entry.label}
        </span>
      )}

      <span class="text-xs text-slate-400 dark:text-text-dim">
        {entry.capabilities.join(", ")}
      </span>

      <span class="text-xs font-mono text-slate-400 dark:text-text-dim ml-auto hidden sm:inline">
        {entry.apiKey}
      </span>

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

export function ApiKeyManager() {
  const { keys, catalog, loading, addKey, deleteKey, toggleStatus, importKeys, fetchCustomModels } = useApiKeys();
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

      {showForm && (
        <AddKeyForm
          onAdd={async (input) => {
            const result = await addKey(input);
            if (result.ok) setShowForm(false);
            return result;
          }}
          catalog={catalog}
          fetchCustomModels={fetchCustomModels}
        />
      )}

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
