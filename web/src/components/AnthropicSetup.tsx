import { useState, useMemo, useCallback } from "preact/hooks";
import { useT } from "../i18n/context";
import { CopyButton } from "./CopyButton";

interface AnthropicSetupProps {
  apiKey: string;
  models: string[];
  selectedModel: string;
}

export function AnthropicSetup({ apiKey, models, selectedModel }: AnthropicSetupProps) {
  const t = useT();
  const [model, setModel] = useState(selectedModel);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";

  const envLines = useMemo(() => ({
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
  }), [origin, apiKey, model]);

  const allEnvText = useMemo(
    () => Object.entries(envLines).map(([k, v]) => `${k}=${v}`).join("\n"),
    [envLines],
  );

  const getAllEnv = useCallback(() => allEnvText, [allEnvText]);
  const getBaseUrl = useCallback(() => envLines.ANTHROPIC_BASE_URL, [envLines]);
  const getApiKey = useCallback(() => envLines.ANTHROPIC_API_KEY, [envLines]);
  const getModel = useCallback(() => envLines.ANTHROPIC_MODEL, [envLines]);

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors">
      <div class="flex items-center justify-between mb-6 border-b border-slate-100 dark:border-border-dark pb-4">
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("anthropicSetup")}</h2>
        </div>
        <select
          class="px-3 py-1.5 text-xs font-mono rounded-lg bg-slate-100 dark:bg-bg-dark border border-gray-200 dark:border-border-dark text-slate-700 dark:text-text-main outline-none"
          value={model}
          onChange={(e) => setModel((e.target as HTMLSelectElement).value)}
        >
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Env vars */}
      <div class="space-y-3">
        {(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"] as const).map((key) => {
          const getter = key === "ANTHROPIC_BASE_URL" ? getBaseUrl : key === "ANTHROPIC_API_KEY" ? getApiKey : getModel;
          return (
            <div key={key} class="flex items-center gap-3">
              <label class="text-xs font-mono font-semibold text-slate-600 dark:text-text-dim w-44 shrink-0">{key}</label>
              <div class="relative flex items-center flex-1">
                <input
                  class="w-full pl-3 pr-10 py-2 bg-slate-100 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-500 dark:text-text-dim outline-none cursor-default select-all"
                  type="text"
                  value={envLines[key]}
                  readOnly
                />
                <CopyButton getText={getter} class="absolute right-2" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Copy all button */}
      <div class="mt-5 flex items-center gap-3">
        <CopyButton getText={getAllEnv} variant="label" />
        <span class="text-xs text-slate-400 dark:text-text-dim">{t("anthropicCopyAllHint")}</span>
      </div>
    </section>
  );
}
