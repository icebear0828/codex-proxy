import { useState, useEffect, useCallback } from "preact/hooks";

export function useStatus() {
  const [baseUrl, setBaseUrl] = useState("Loading...");
  const [apiKey, setApiKey] = useState("Loading...");
  const [models, setModels] = useState<string[]>(["codex"]);
  const [selectedModel, setSelectedModel] = useState("codex");

  const loadModels = useCallback(async () => {
    try {
      const resp = await fetch("/v1/models");
      const data = await resp.json();
      const ids: string[] = data.data.map((m: { id: string }) => m.id);
      if (ids.length > 0) {
        setModels(ids);
        const preferred = ids.find((n) => n.includes("5.3-codex"));
        if (preferred) setSelectedModel(preferred);
      }
    } catch {
      setModels(["codex"]);
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
  }, [loadModels]);

  return { baseUrl, apiKey, models, selectedModel, setSelectedModel };
}
