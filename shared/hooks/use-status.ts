import { useState, useEffect, useCallback, useMemo } from "preact/hooks";

export interface CatalogModel {
  id: string;
  displayName: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
}

export interface ModelFamily {
  id: string;
  displayName: string;
  efforts: { reasoningEffort: string; description: string }[];
  defaultEffort: string;
}

/**
 * Extract model family ID from a model ID.
 * gpt-5.3-codex-high → gpt-5.3-codex
 * gpt-5.3-codex-spark → gpt-5.3-codex-spark (spark is a distinct family)
 * gpt-5.4 → gpt-5.4
 */
function getFamilyId(id: string): string {
  // Bare model: gpt-5.4
  if (/^gpt-\d+(?:\.\d+)?$/.test(id)) return id;
  // Spark family: gpt-X.Y-codex-spark
  if (/^gpt-\d+(?:\.\d+)?-codex-spark$/.test(id)) return id;
  // Mini family: gpt-X.Y-codex-mini
  if (/^gpt-\d+(?:\.\d+)?-codex-mini$/.test(id)) return id;
  // Codex base or tier variant (high/mid/low/max): family = gpt-X.Y-codex
  const m = id.match(/^(gpt-\d+(?:\.\d+)?-codex)(?:-(?:high|mid|low|max))?$/);
  if (m) return m[1];
  // Legacy: gpt-5-codex, gpt-5-codex-mini
  const legacy = id.match(/^(gpt-\d+-codex)(?:-(?:high|mid|low|max|mini))?$/);
  if (legacy) return legacy[1];
  return id;
}

/** Check if a model ID is a tier variant (not the base family model). */
function isTierVariant(id: string): boolean {
  return /^gpt-\d+(?:\.\d+)?-codex-(?:high|mid|low|max)$/.test(id);
}

export function useStatus(accountCount: number) {
  const [baseUrl, setBaseUrl] = useState("Loading...");
  const [apiKey, setApiKey] = useState("Loading...");
  const [models, setModels] = useState<string[]>(["gpt-5.4"]);
  const [selectedModel, setSelectedModel] = useState("gpt-5.4");
  const [modelCatalog, setModelCatalog] = useState<CatalogModel[]>([]);
  const [selectedEffort, setSelectedEffort] = useState("medium");
  const [selectedSpeed, setSelectedSpeed] = useState<string | null>(null);

  const loadModels = useCallback(async () => {
    try {
      // Fetch full catalog for effort info
      const catalogResp = await fetch("/v1/models/catalog");
      const catalogData: CatalogModel[] = await catalogResp.json();
      setModelCatalog(catalogData);

      // Also fetch model list (includes aliases)
      const resp = await fetch("/v1/models");
      const data = await resp.json();
      const ids: string[] = data.data.map((m: { id: string }) => m.id);
      if (ids.length > 0) {
        setModels(ids);
        const preferred = ids.find((n) => n === "gpt-5.4");
        if (preferred) setSelectedModel(preferred);
      }
    } catch {
      setModels(["gpt-5.4"]);
    }
  }, []);

  useEffect(() => {
    async function loadStatus() {
      try {
        const resp = await fetch("/auth/status");
        const data = await resp.json();
        if (!data.authenticated) return;
        setBaseUrl(`${window.location.origin}/v1`);
        setApiKey(data.proxy_api_key || "any-string");
        await loadModels();
      } catch (err) {
        console.error("Status load error:", err);
      }
    }
    loadStatus();
  }, [loadModels, accountCount]);

  // Build model families — group catalog by family, excluding tier variants
  const modelFamilies = useMemo((): ModelFamily[] => {
    if (modelCatalog.length === 0) return [];

    const familyMap = new Map<string, ModelFamily>();
    for (const m of modelCatalog) {
      const fid = getFamilyId(m.id);
      // Only use the base family model (not tier variants) to define the family
      if (isTierVariant(m.id)) continue;
      if (familyMap.has(fid)) continue;
      familyMap.set(fid, {
        id: fid,
        displayName: m.displayName,
        efforts: m.supportedReasoningEfforts,
        defaultEffort: m.defaultReasoningEffort,
      });
    }
    return [...familyMap.values()];
  }, [modelCatalog]);

  return {
    baseUrl,
    apiKey,
    models,
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    selectedSpeed,
    setSelectedSpeed,
    modelFamilies,
    modelCatalog,
  };
}
