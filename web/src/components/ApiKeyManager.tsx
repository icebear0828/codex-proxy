import { useState, useCallback, useEffect, useMemo, useRef } from "preact/hooks";
import { useApiKeys } from "../../../shared/hooks/use-api-keys";
import { useT } from "../../../shared/i18n/context";
import type { ApiKeyCapability, ApiKeyProvider, ApiKeyMemoProvider, ApiKeyWire, ApiKeyEntry, ApiKeyMemo, CatalogModel } from "../../../shared/hooks/use-api-keys";
import { accountToolbarIconClass } from "../lib/account-toolbar";

/** Providers whose upstream wire protocol is selectable. */
const WIRE_SELECTABLE_PROVIDERS: ReadonlySet<ApiKeyProvider> = new Set(["openai", "openrouter", "custom"]);

const PROVIDER_OPTIONS: Array<{ value: ApiKeyProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "antigravity", label: "Antigravity OAuth" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
];

type ProviderModelStatus = "idle" | "loading" | "loaded" | "fallback";

function normalizeCustomModelInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderModelChecklist(models: CatalogModel[], selectedModelSet: Set<string>, onToggle: (modelId: string) => void, emptyHint?: string) {
  return (
    <div class="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark p-2 flex flex-col gap-1">
      {models.length === 0 && emptyHint
        ? <div class="px-2 py-2 text-sm text-slate-400 dark:text-text-dim">{emptyHint}</div>
        : models.map((model) => (
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

function AddKeyForm({ onAdd, catalog, fetchProviderModels, memos, memoCoverage, createMemo, deleteMemo, fetchMemoModels, generateMemos, loadMemoCoverage, loadMemos }: {
  onAdd: (input: {
    provider: ApiKeyProvider;
    models: string[];
    apiKey: string;
    baseUrl?: string;
    projectId?: string;
    label?: string;
    capabilities?: ApiKeyCapability[];
    wire?: ApiKeyWire;
    memoId?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  catalog: Record<string, { displayName: string; defaultBaseUrl: string; models: Array<{ id: string; displayName: string }> }>;
  fetchProviderModels: (input: { provider: ApiKeyProvider; apiKey: string; baseUrl?: string; wire?: ApiKeyWire; force?: boolean }) => Promise<
    { ok: true; models: CatalogModel[]; fetchedAt?: string; fromCache?: boolean; stale?: boolean }
    | { ok: false; error: string }
  >;
  memos: ApiKeyMemo[];
  memoCoverage: { uncovered: number; canGenerate: boolean } | null;
  createMemo: (input: { name?: string; provider: ApiKeyMemoProvider; apiKey: string; baseUrl?: string; wire?: ApiKeyWire; capabilities?: ApiKeyCapability[] }) => Promise<{ ok: boolean; memo?: ApiKeyMemo; error?: string }>;
  deleteMemo: (id: string) => Promise<void>;
  fetchMemoModels: (id: string, force?: boolean) => Promise<{ ok: true; models: CatalogModel[]; fetchedAt?: string; stale?: boolean; memo?: ApiKeyMemo } | { ok: false; error: string }>;
  generateMemos: () => Promise<{ created: number; skipped: number }>;
  loadMemoCoverage: () => Promise<void>;
  loadMemos: () => Promise<void>;
}) {
  const t = useT();
  const [provider, setProvider] = useState<ApiKeyProvider>("anthropic");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [manualModelsInput, setManualModelsInput] = useState("");
  const [capabilities, setCapabilities] = useState<ApiKeyCapability[]>(["chat"]);
  const [wire, setWire] = useState<ApiKeyWire>("chat");
  const [providerModels, setProviderModels] = useState<CatalogModel[]>([]);
  const [modelStatus, setModelStatus] = useState<ProviderModelStatus>("idle");
  const [modelMessage, setModelMessage] = useState(t("providerModelsHint"));
  const [modelFilter, setModelFilter] = useState("");
  const [modelsFetchedAt, setModelsFetchedAt] = useState<string | null>(null);
  const [modelsStale, setModelsStale] = useState(false);
  const [modelFetchError, setModelFetchError] = useState("");
  const [activeMemoId, setActiveMemoId] = useState<string | null>(null);
  const [saveAsMemo, setSaveAsMemo] = useState(true);
  const [memoBusy, setMemoBusy] = useState<string | null>(null);
  const [memoNotice, setMemoNotice] = useState("");
  const [memoFilter, setMemoFilter] = useState("");
  const [memosExpanded, setMemosExpanded] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const latestModelRequestRef = useRef(0);
  const latestResolvedSignatureRef = useRef("");

  const activeMemo = useMemo(() => memos.find((memo) => memo.id === activeMemoId) ?? null, [memos, activeMemoId]);
  const filteredMemos = useMemo(() => {
    const query = memoFilter.trim().toLowerCase();
    if (!query) return memos;
    return memos.filter((memo) =>
      memo.name.toLowerCase().includes(query)
      || memo.baseUrl.toLowerCase().includes(query)
      || memo.provider.toLowerCase().includes(query));
  }, [memos, memoFilter]);

  const wireOptions = useMemo<Array<{ value: ApiKeyWire; label: string; description: string }>>(() => [
    {
      value: "chat",
      label: t("wireChatLabel"),
      description: t("wireChatDesc"),
    },
    {
      value: "responses",
      label: t("wireResponsesLabel"),
      description: t("wireResponsesDesc"),
    },
    {
      value: "codex-responses",
      label: t("wireCodexResponsesLabel"),
      description: t("wireCodexResponsesDesc"),
    },
    {
      value: "anthropic",
      label: t("wireAnthropicLabel"),
      description: t("wireAnthropicDesc"),
    },
    {
      value: "gemini",
      label: t("wireGeminiLabel"),
      description: t("wireGeminiDesc"),
    },
  ], [t]);

  const capabilityOptions = useMemo<Array<{ value: ApiKeyCapability; label: string }>>(() => [
    { value: "chat", label: t("capChat") },
    { value: "embeddings", label: t("capEmbeddings") },
  ], [t]);

  const isCustom = provider === "custom";
  const isAntigravity = provider === "antigravity";
  const supportsMemos = !isAntigravity;
  const wireSelectable = WIRE_SELECTABLE_PROVIDERS.has(provider);
  const providerCatalog = !isCustom ? catalog[provider]?.models ?? [] : [];
  const usingLiveModels = providerModels.length > 0;
  const availableModels = usingLiveModels ? providerModels : providerCatalog;
  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase();
    if (!query) return availableModels;
    return availableModels.filter((model) => model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query));
  }, [availableModels, modelFilter]);
  const visibleWireOptions = isCustom
    ? wireOptions
    : wireOptions.filter((option) => option.value === "chat" || option.value === "responses");
  const selectedWireOption = visibleWireOptions.find((option) => option.value === wire) ?? visibleWireOptions[0];
  const selectedModelSet = useMemo(() => new Set(selectedModels), [selectedModels]);
  const selectedCapabilitySet = useMemo(() => new Set(capabilities), [capabilities]);
  const visibleCapabilityOptions = isAntigravity
    ? capabilityOptions.filter((option) => option.value === "chat")
    : capabilityOptions;

  const resetProviderModels = useCallback((status: ProviderModelStatus = "idle", message?: string) => {
    setProviderModels([]);
    setSelectedModels([]);
    setModelStatus(status);
    setModelMessage(message ?? (isCustom ? t("customModelsHint") : t("providerModelsHint")));
    setModelFilter("");
    setModelsFetchedAt(null);
    setModelsStale(false);
    setModelFetchError("");
  }, [isCustom, t]);

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

  const triggerProviderModelFetch = useCallback(async (options: { force?: boolean } = {}) => {
    const force = options.force ?? false;
    if (provider === "antigravity") {
      setModelStatus("fallback");
      setModelMessage(t("antigravityModelHint"));
      return;
    }
    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (!normalizedApiKey || (isCustom && !normalizedBaseUrl)) {
      if (!force) resetProviderModels("idle", isCustom ? t("customModelsHint") : t("providerModelsHint"));
      return;
    }

    const signature = isCustom
      ? `${provider}::${wire}::${normalizedBaseUrl}::${normalizedApiKey}`
      : `${provider}::${normalizedApiKey}`;
    if (!force && latestResolvedSignatureRef.current === signature && providerModels.length > 0) return;

    const requestId = latestModelRequestRef.current + 1;
    latestModelRequestRef.current = requestId;
    setModelStatus("loading");
    setModelMessage(t("fetchingModelsHint"));
    if (force) setModelFetchError("");
    setError("");

    const result = await fetchProviderModels({
      provider,
      apiKey: normalizedApiKey,
      baseUrl: isCustom ? normalizedBaseUrl : undefined,
      wire: isCustom ? wire : undefined,
      force,
    });

    if (latestModelRequestRef.current !== requestId) return;

    if (!result.ok || result.models.length === 0) {
      const message = result.ok ? t("modelsFallbackHint") : t("modelsFallbackHintWithError", { error: result.error });
      // On a manual refresh keep the previously fetched list instead of dropping it.
      if (force && providerModels.length > 0) {
        setModelStatus("loaded");
        setModelMessage("");
        setModelFetchError(message);
      } else {
        setProviderModels([]);
        setSelectedModels([]);
        setModelStatus("fallback");
        setModelMessage(message);
      }
      latestResolvedSignatureRef.current = "";
      return;
    }

    setProviderModels(result.models);
    setModelsFetchedAt(result.fetchedAt ?? null);
    setModelsStale(Boolean(result.stale));
    setModelFetchError(result.stale ? t("modelsStaleHint") : "");
    setModelStatus("loaded");
    setModelMessage("");
    latestResolvedSignatureRef.current = signature;
    setSelectedModels((prev) => {
      const next = prev.filter((id) => result.models.some((model) => model.id === id));
      return next.length > 0 ? next : [result.models[0].id];
    });
  }, [apiKey, baseUrl, fetchProviderModels, isCustom, provider, providerModels.length, resetProviderModels, t, wire]);

  /** Apply a memo as form defaults; the key shows as "from memo" placeholder. */
  const applyMemo = useCallback((memo: ApiKeyMemo) => {
    setActiveMemoId(memo.id);
    setProvider(memo.provider);
    setApiKey("");
    setBaseUrl(memo.provider === "custom" ? memo.baseUrl : "");
    setLabel(memo.name);
    setManualModelsInput("");
    setCapabilities(memo.capabilities.length > 0 ? [...memo.capabilities] : ["chat"]);
    setWire(memo.wire);
    setError("");
    setMemoNotice("");
    latestResolvedSignatureRef.current = "";
    if (memo.models.length > 0) {
      setProviderModels(memo.models);
      setModelsFetchedAt(memo.modelsFetchedAt);
      setModelsStale(false);
      setModelFetchError("");
      setModelStatus("loaded");
      setModelMessage("");
      setSelectedModels([]);
    } else {
      resetProviderModels("idle", t("memoModelsEmptyHint"));
    }
  }, [resetProviderModels, t]);

  const handleMemoRefreshModels = useCallback(async (memo: ApiKeyMemo) => {
    setMemoBusy(memo.id);
    setMemoNotice("");
    const result = await fetchMemoModels(memo.id, true);
    setMemoBusy(null);
    if (!result.ok) {
      setMemoNotice(t("memoModelsRefreshFailed", { error: result.error }));
      return;
    }
    if (activeMemoId === memo.id) {
      applyMemo({ ...memo, models: result.models, modelsFetchedAt: result.fetchedAt ?? memo.modelsFetchedAt });
    }
  }, [activeMemoId, applyMemo, fetchMemoModels, t]);

  const handleSaveMemoFromForm = useCallback(async () => {
    if (provider === "antigravity") return;
    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = isCustom ? baseUrl.trim() : catalog[provider]?.defaultBaseUrl ?? "";
    if (!normalizedApiKey) {
      setMemoNotice(t("memoSaveNeedKey"));
      return;
    }
    setMemoBusy("save");
    const result = await createMemo({
      name: label.trim() || undefined,
      provider,
      apiKey: normalizedApiKey,
      baseUrl: isCustom ? normalizedBaseUrl : undefined,
      wire,
      capabilities,
    });
    setMemoBusy(null);
    if (!result.ok || !result.memo) {
      setMemoNotice(result.error || t("memoSaveFailed"));
      return;
    }
    setSaveAsMemo(false);
    setMemoNotice(t("memoSaved"));
    setActiveMemoId(result.memo.id);
    if (result.memo.models.length > 0) {
      setProviderModels(result.memo.models);
      setModelsFetchedAt(result.memo.modelsFetchedAt);
      setModelStatus("loaded");
      setModelMessage("");
    }
  }, [apiKey, baseUrl, capabilities, catalog, createMemo, isCustom, label, provider, t, wire]);

  const handleGenerateMemos = useCallback(async () => {
    setMemoBusy("generate");
    const result = await generateMemos();
    setMemoBusy(null);
    setMemoNotice(result.created > 0
      ? t("memoGenerated", { count: result.created })
      : t("memoGenerateNone"));
  }, [generateMemos, t]);

  useEffect(() => {
    void loadMemos();
    void loadMemoCoverage();
  }, [loadMemos, loadMemoCoverage]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    const normalizedManualModels = normalizeCustomModelInput(manualModelsInput);
    const models = modelStatus === "fallback"
      ? normalizedManualModels
      : [...new Set([...selectedModels, ...normalizedManualModels])];
    const usingMemoKey = activeMemo && !normalizedApiKey;

    if (models.length === 0 || (!normalizedApiKey && !usingMemoKey)) {
      setError(t("requireModelAndKey"));
      return;
    }
    if (isCustom && !normalizedBaseUrl && !(activeMemo?.baseUrl)) {
      setError(t("requireBaseUrl"));
      return;
    }
    if (capabilities.length === 0) {
      setError(t("requireCapability"));
      return;
    }

    setAdding(true);
    const submittedWire: ApiKeyWire = isCustom
      ? wire
      : wire === "responses"
        ? "responses"
        : "chat";
    // Manual key + "save as memo" — persist the template before adding entries.
    if (provider !== "antigravity" && !usingMemoKey && saveAsMemo) {
      await createMemo({
        name: label.trim() || undefined,
        provider,
        apiKey: normalizedApiKey,
        baseUrl: isCustom ? normalizedBaseUrl : undefined,
        wire,
        capabilities,
      });
    }
    const result = await onAdd({
      provider,
      models,
      apiKey: normalizedApiKey || (usingMemoKey ? "" : ""),
      baseUrl: isCustom ? normalizedBaseUrl : undefined,
      projectId: isAntigravity ? projectId.trim() || undefined : undefined,
      label: label.trim() || undefined,
      capabilities,
      wire: wireSelectable ? submittedWire : undefined,
      memoId: usingMemoKey ? activeMemo.id : undefined,
    });
    setAdding(false);
    if (result.ok) {
      setSelectedModels([]);
      setApiKey("");
      setProjectId("");
      setBaseUrl("");
      setLabel("");
      setManualModelsInput("");
      setCapabilities(["chat"]);
      setWire("chat");
      setActiveMemoId(null);
      setSaveAsMemo(true);
      setMemoNotice("");
      resetProviderModels();
    } else {
      setError(result.error || t("failedToAddKey"));
    }
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-3 p-4 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl">
      {supportsMemos && memos.length > 0 && (
        <div class="group/memos flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("memoSectionTitle")}</label>
            <span class="text-[0.65rem] text-slate-400 dark:text-text-dim">{t("memoSectionHint")}</span>
            <input
              type="text"
              value={memoFilter}
              onInput={(e) => setMemoFilter((e.target as HTMLInputElement).value)}
              placeholder={t("memoFilterPlaceholder")}
              class="ml-auto w-32 px-2 py-0.5 text-[0.7rem] rounded-md border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main focus:w-44 transition-all"
            />
            <button
              type="button"
              title={memosExpanded ? t("memoCollapse") : t("memoExpand")}
              onClick={() => setMemosExpanded((v) => !v)}
              class="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-text-main transition-colors"
            >
              <svg class={`size-3.5 transition-transform ${memosExpanded ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>
          {/* Fixed-height placeholder (~1.5 card rows incl. row gap). The overlay
              expands over following content instead of pushing it down, so hover
              never causes layout shift. A bottom fade hints at clipped rows. */}
          <div class="relative h-[78px]">
            {memos.length > 3 && (
              <div
                class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-7 bg-gradient-to-t from-white to-transparent dark:from-bg-dark transition-opacity"
                style={{ opacity: memosExpanded ? 0 : undefined }}
              />
            )}
            {memosExpanded && (
              <div
                class="fixed inset-0 z-20"
                onClick={() => setMemosExpanded(false)}
              />
            )}
            <div
              class={`absolute inset-x-0 top-0 z-30 rounded-lg transition-shadow ${
                memosExpanded
                  ? "max-h-[min(60vh,384px)] overflow-y-auto p-2 -m-2 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark shadow-lg"
                  : "max-h-[78px] overflow-hidden group-hover/memos:max-h-[min(60vh,384px)] group-hover/memos:overflow-y-auto p-2 -m-2 group-hover/memos:bg-white group-hover/memos:dark:bg-card-dark group-hover/memos:border group-hover/memos:border-gray-200 group-hover/memos:dark:border-border-dark group-hover/memos:shadow-lg"
              } flex flex-wrap gap-2 content-start`}
            >
              {filteredMemos.map((memo) => (
                <div
                  key={memo.id}
                  class={`group flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg border text-sm cursor-pointer transition-colors ${
                    activeMemoId === memo.id
                      ? "border-primary bg-primary/5 dark:bg-primary/10"
                      : "border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark hover:border-gray-300"
                  }`}
                  onClick={() => applyMemo(memo)}
                >
                  <div class="flex flex-col leading-tight min-w-0">
                    <span class="text-xs font-medium text-slate-800 dark:text-text-main truncate max-w-[180px]">{memo.name}</span>
                    <span class="text-[0.65rem] text-slate-400 dark:text-text-dim">
                      {memo.provider}{memo.wire ? ` · ${memo.wire}` : ""} · {memo.models.length > 0 ? t("memoModelCount", { count: memo.models.length }) : t("memoNoModels")}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={memoBusy === memo.id}
                    title={t("refreshModelsTitle")}
                    onClick={(e) => { e.stopPropagation(); void handleMemoRefreshModels(memo); }}
                    class="p-1 text-slate-400 hover:text-primary disabled:opacity-40 transition-colors"
                  >
                    <svg class={`size-3.5 ${memoBusy === memo.id ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    title={t("memoDelete")}
                    onClick={(e) => { e.stopPropagation(); void deleteMemo(memo.id); }}
                    class="p-1 text-slate-400 hover:text-red-500 transition-colors"
                  >
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              {filteredMemos.length === 0 && (
                <span class="px-2 py-1.5 text-[0.7rem] text-slate-400 dark:text-text-dim">{t("memoFilterNoMatch")}</span>
              )}
            </div>
          </div>
          <span class="text-[0.65rem] text-slate-400 dark:text-text-dim">{t("memoDecoupledHint")}</span>
        </div>
      )}
      {memoCoverage?.canGenerate && (
        <button
          type="button"
          onClick={() => { void handleGenerateMemos(); }}
          disabled={memoBusy === "generate"}
          class="self-start px-2.5 py-1 text-[0.7rem] rounded-md border border-dashed border-gray-300 dark:border-border-dark text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-card-dark disabled:opacity-40 transition-colors"
        >
          {memoBusy === "generate" ? t("memoGenerating") : t("memoGenerateBtn", { count: memoCoverage.uncovered })}
        </button>
      )}
      {memoNotice && <p class="text-xs text-slate-500 dark:text-text-dim">{memoNotice}</p>}

      <div class="flex flex-wrap gap-3">
        <div class="flex flex-col gap-1 min-w-[140px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("providerTypeLabel")}</label>
          <select
            value={provider}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ApiKeyProvider;
              setProvider(v);
              setSelectedModels([]);
              setBaseUrl("");
              setApiKey("");
              setProjectId("");
              setLabel("");
              setManualModelsInput("");
              setCapabilities(["chat"]);
              setWire("chat");
              setActiveMemoId(null);
              latestResolvedSignatureRef.current = "";
              resetProviderModels("idle", v === "antigravity" ? t("antigravityModelHint") : v === "custom" ? t("customModelsHint") : t("providerModelsHint"));
            }}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.value === "antigravity" ? t("antigravityProviderOption") : o.label}</option>
            ))}
          </select>
        </div>

        <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{isAntigravity ? t("antigravityRefreshTokenLabel") : t("apiKeyLabelField")}</label>
          <input
            type="password"
            value={apiKey}
            onInput={(e) => {
              setApiKey((e.target as HTMLInputElement).value);
              latestResolvedSignatureRef.current = "";
              if (activeMemo && (e.target as HTMLInputElement).value) setActiveMemoId(null);
              resetProviderModels("idle", isCustom ? t("customModelsHint") : t("providerModelsHint"));
            }}
            onBlur={() => { void triggerProviderModelFetch(); }}
            placeholder={activeMemo ? t("memoKeyPlaceholder", { name: activeMemo.name }) : isAntigravity ? "1//..." : "sk-..."}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
          {supportsMemos && activeMemo && (
            <label class="flex items-center gap-1.5 text-[0.65rem] text-slate-400 dark:text-text-dim cursor-pointer">
              <input
                type="checkbox"
                checked={saveAsMemo}
                onChange={(e) => setSaveAsMemo((e.target as HTMLInputElement).checked)}
              />
              {t("saveAsMemoLabel")}
            </label>
          )}
        </div>
        {isAntigravity && (
          <div class="flex flex-col gap-1 min-w-[240px] flex-1">
            <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("antigravityProjectIdLabel")}</label>
            <input
              type="text"
              value={projectId}
              onInput={(e) => setProjectId((e.target as HTMLInputElement).value)}
              placeholder={t("antigravityProjectIdHint")}
              class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
            />
          </div>
        )}
      </div>

      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("modelsLabel")}</label>
          {availableModels.length > 0 && (
            <button
              type="button"
              onClick={() => { void triggerProviderModelFetch({ force: true }); }}
              disabled={modelStatus === "loading" || !apiKey.trim() || (isCustom && !baseUrl.trim())}
              title={t("refreshModelsTitle")}
              class="ml-auto flex items-center gap-1 px-2 py-0.5 text-[0.7rem] rounded-md border border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-card-dark disabled:opacity-40 transition-colors"
            >
              <svg class={`size-3 ${modelStatus === "loading" ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              {t("refreshModelsBtn")}
            </button>
          )}
        </div>
        {availableModels.length > 0 && (
          <input
            type="text"
            value={modelFilter}
            onInput={(e) => setModelFilter((e.target as HTMLInputElement).value)}
            placeholder={t("modelFilterPlaceholder")}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        )}
        {availableModels.length > 0 && renderModelChecklist(filteredModels, selectedModelSet, handleModelToggle, t("modelFilterNoMatch"))}
        {availableModels.length === 0 && (
          <div class="px-2.5 py-2 text-sm rounded-lg border border-dashed border-gray-200 dark:border-border-dark text-slate-400 dark:text-text-dim">
            {modelStatus === "loading" ? t("fetchingModelsHint") : isAntigravity ? t("antigravityModelHint") : modelMessage}
          </div>
        )}
        <input
          type="text"
          value={manualModelsInput}
          onInput={(e) => setManualModelsInput((e.target as HTMLInputElement).value)}
          placeholder={modelStatus === "fallback" ? "model-name-1, model-name-2" : "manual-model-1, manual-model-2"}
          class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
        />
        {availableModels.length > 0 && (
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.65rem] text-slate-400 dark:text-text-dim">
            <span>{t("modelsCountLabel", { count: availableModels.length, shown: filteredModels.length })}</span>
            {usingLiveModels && modelsFetchedAt && (
              <span title={new Date(modelsFetchedAt).toLocaleString()}>
                · {modelsStale ? t("modelsStaleHint") : t("modelsUpdatedAt", { time: new Date(modelsFetchedAt).toLocaleString() })}
              </span>
            )}
            {modelFetchError && <span class="text-amber-500">· {modelFetchError}</span>}
          </div>
        )}
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("capabilitiesLabel")}</label>
        <div class="flex flex-wrap gap-2">
          {visibleCapabilityOptions.map((option) => (
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
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("upstreamProtocolLabel")}</label>
          <select
            value={wire}
            onChange={(e) => {
              setWire((e.target as HTMLSelectElement).value as ApiKeyWire);
              latestResolvedSignatureRef.current = "";
              resetProviderModels("idle", isCustom ? t("customModelsHint") : t("providerModelsHint"));
            }}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            {visibleWireOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span class="text-[0.65rem] text-slate-400 dark:text-text-dim">
            {selectedWireOption.description}
          </span>
        </div>
      )}

      {isCustom && (
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("baseUrlLabel")}</label>
          <input
            type="url"
            value={baseUrl}
            onInput={(e) => {
              setBaseUrl((e.target as HTMLInputElement).value);
              latestResolvedSignatureRef.current = "";
              resetProviderModels("idle", t("customModelsHint"));
            }}
            onBlur={() => { void triggerProviderModelFetch(); }}
            placeholder="https://api.example.com/v1"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      )}

      <div class="flex gap-3 items-end">
        <div class="flex flex-col gap-1 flex-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">{t("labelOptionalField")}</label>
          <input
            type="text"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            placeholder={t("labelPlaceholderField")}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          class="px-4 py-1.5 text-sm font-medium text-white bg-primary-action hover:bg-primary-action-hover rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {adding ? t("addingKeyBtn") : t("addKeyBtn")}
        </button>
      </div>

      {supportsMemos && !activeMemo && (
        <label class="flex items-center gap-1.5 text-[0.7rem] text-slate-500 dark:text-text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={saveAsMemo}
            onChange={(e) => setSaveAsMemo((e.target as HTMLInputElement).checked)}
          />
          {t("saveAsMemoLabel")}
        </label>
      )}

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
    case "antigravity": return "bg-info-container text-info";
    case "openrouter": return "bg-avatar-purple-bg text-avatar-purple-text";
    default: return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
  }
}

function KeyRow({ entry, onDelete, onToggle }: {
  entry: ApiKeyEntry;
  onDelete: (id: string) => void;
  onToggle: (id: string, status: "active" | "disabled") => void;
}) {
  const t = useT();
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
        {entry.capabilities.join(", ")}{entry.provider === "custom" ? ` · ${entry.wire}` : ""}
      </span>

      <span class="text-xs font-mono text-slate-400 dark:text-text-dim ml-auto hidden sm:inline">
        {entry.apiKey}
      </span>

      <button
        onClick={() => onToggle(entry.id, isActive ? "disabled" : "active")}
        title={isActive ? t("disableApiKey") : t("enableApiKey")}
        class={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
          isActive ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span class={`absolute left-0 top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
          isActive ? "translate-x-[16px]" : "translate-x-0.5"
        }`} />
      </button>

      <button
        onClick={() => onDelete(entry.id)}
        title={t("deleteApiKey")}
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
  const t = useT();
  const { keys, catalog, memos, memoCoverage, loading, addKey, deleteKey, toggleStatus, importKeys, fetchProviderModels, createMemo, deleteMemo, fetchMemoModels, generateMemos, loadMemos, loadMemoCoverage } = useApiKeys();
  const [showForm, setShowForm] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback(async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) return;
    try {
      const result = await importKeys(files[0]);
      setImportResult(t("importApiKeysResult", { added: result.added, failed: result.failed }));
      setTimeout(() => setImportResult(null), 5000);
    } catch {
      setImportResult(t("importApiKeysFailed"));
    }
    if (fileRef.current) fileRef.current.value = "";
  }, [importKeys, t]);

  if (loading) {
    return <div class="text-sm text-slate-400 dark:text-text-dim animate-pulse">{t("loadingApiKeys")}</div>;
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main flex items-center gap-2">
          <svg class="size-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
          </svg>
          {t("apiKeysTitle")}
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
            title={t("importApiKeys")}
            class={accountToolbarIconClass}
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12M12 16.5V3" />
            </svg>
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            title={t("addApiKey")}
            class={accountToolbarIconClass}
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
          fetchProviderModels={fetchProviderModels}
          memos={memos}
          memoCoverage={memoCoverage}
          createMemo={createMemo}
          deleteMemo={deleteMemo}
          fetchMemoModels={fetchMemoModels}
          generateMemos={generateMemos}
          loadMemoCoverage={loadMemoCoverage}
          loadMemos={loadMemos}
        />
      )}

      {keys.length === 0 ? (
        <div class="text-center py-8 text-sm text-slate-400 dark:text-text-dim">
          {t("noApiKeys")}
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
