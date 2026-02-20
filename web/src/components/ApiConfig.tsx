import { useT } from "../i18n/context";
import { CopyButton } from "./CopyButton";
import { useCallback } from "preact/hooks";

interface ApiConfigProps {
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
}

export function ApiConfig({ baseUrl, apiKey, models, selectedModel, onModelChange }: ApiConfigProps) {
  const t = useT();

  const getBaseUrl = useCallback(() => baseUrl, [baseUrl]);
  const getApiKey = useCallback(() => apiKey, [apiKey]);

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors">
      <div class="flex items-center justify-between mb-6 border-b border-slate-100 dark:border-border-dark pb-4">
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("apiConfig")}</h2>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Base URL */}
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("baseProxyUrl")}</label>
          <div class="relative flex items-center">
            <input
              class="w-full pl-3 pr-10 py-2.5 bg-slate-100 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-500 dark:text-text-dim outline-none cursor-default select-all"
              type="text"
              value={baseUrl}
              readOnly
            />
            <CopyButton getText={getBaseUrl} class="absolute right-2" titleKey="copyUrl" />
          </div>
        </div>
        {/* Default Model */}
        <div class="space-y-1.5">
          <label class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("defaultModel")}</label>
          <div class="relative">
            <select
              class="w-full appearance-none pl-3 pr-10 py-2.5 bg-white dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] text-slate-700 dark:text-text-main font-medium focus:ring-1 focus:ring-primary focus:border-primary outline-none cursor-pointer transition-colors"
              value={selectedModel}
              onChange={(e) => onModelChange((e.target as HTMLSelectElement).value)}
            >
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-500 dark:text-text-dim">
              <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
          </div>
        </div>
        {/* API Key */}
        <div class="space-y-1.5 md:col-span-2">
          <label class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("yourApiKey")}</label>
          <div class="relative flex items-center">
            <div class="absolute left-3 text-slate-400 dark:text-text-dim">
              <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
              </svg>
            </div>
            <input
              class="w-full pl-10 pr-10 py-2.5 bg-slate-100 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-500 dark:text-text-dim outline-none cursor-default select-all tracking-wider"
              type="text"
              value={apiKey}
              readOnly
            />
            <CopyButton getText={getApiKey} class="absolute right-2" titleKey="copyApiKey" />
          </div>
          <p class="text-xs text-slate-400 dark:text-text-dim mt-1">{t("apiKeyHint")}</p>
        </div>
      </div>
    </section>
  );
}
