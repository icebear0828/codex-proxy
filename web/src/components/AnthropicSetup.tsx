import { useState, useMemo, useCallback, useEffect } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { CopyButton } from "./CopyButton";

interface AnthropicSetupProps {
  apiKey: string;
  selectedModel: string;
  reasoningEffort: string;
  serviceTier: string | null;
}

const PRESETS: Array<{ label: string; value: string }> = [
  { label: "gpt-5.4 (Opus)", value: "gpt-5.4" },
  { label: "gpt-5.3-codex (Sonnet)", value: "gpt-5.3-codex" },
  { label: "gpt-5.4-mini (Haiku)", value: "gpt-5.4-mini" },
];

export function AnthropicSetup({ apiKey, selectedModel, reasoningEffort, serviceTier }: AnthropicSetupProps) {
  const t = useT();
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8080";

  const [opusModel, setOpusModel] = useState("gpt-5.4");
  const [sonnetModel, setSonnetModel] = useState("gpt-5.3-codex");
  const [haikuModel, setHaikuModel] = useState("gpt-5.4-mini");

  // Custom model from ApiConfig
  const customModel = useMemo(() => {
    let name = selectedModel;
    if (reasoningEffort && reasoningEffort !== "medium") name += `-${reasoningEffort}`;
    if (serviceTier === "fast") name += "-fast";
    return name;
  }, [selectedModel, reasoningEffort, serviceTier]);

  // Fetch all models for dropdowns
  const [allModels, setAllModels] = useState<string[]>([]);
  useEffect(() => {
    fetch("/v1/models")
      .then((r) => r.json())
      .then((data) => setAllModels(data.data?.map((m: { id: string }) => m.id) ?? []))
      .catch(() => {});
  }, []);

  const presetValues = new Set(PRESETS.map((p) => p.value));
  const extraModels = allModels.filter((id) => !presetValues.has(id));

  const envText = useMemo(() => [
    `ANTHROPIC_BASE_URL=${origin}`,
    `ANTHROPIC_API_KEY=${apiKey}`,
    `ANTHROPIC_DEFAULT_OPUS_MODEL=${opusModel}`,
    `ANTHROPIC_DEFAULT_SONNET_MODEL=${sonnetModel}`,
    `ANTHROPIC_DEFAULT_HAIKU_MODEL=${haikuModel}`,
    `ANTHROPIC_MODEL=${customModel}`,
  ].join("\n"), [origin, apiKey, opusModel, sonnetModel, haikuModel, customModel]);

  const getEnvText = useCallback(() => envText, [envText]);

  const inputCls = "w-full pl-3 pr-10 py-2 bg-slate-100 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-500 dark:text-text-dim outline-none cursor-default select-all";
  const selectCls = "w-full pl-3 pr-2 py-2 bg-slate-100 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-[0.78rem] font-mono text-slate-500 dark:text-text-dim outline-none focus:ring-1 focus:ring-primary cursor-pointer";

  const modelDropdown = (value: string, onChange: (v: string) => void) => (
    <select class={selectCls} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      {extraModels.length > 0 && <option disabled>───</option>}
      {extraModels.map((id) => <option key={id} value={id}>{id}</option>)}
      {!presetValues.has(value) && !extraModels.includes(value) && <option value={value}>{value}</option>}
    </select>
  );

  const rows: Array<{ label: string; node: preact.VNode }> = [
    { label: "ANTHROPIC_BASE_URL", node: <div class="relative flex items-center"><input class={inputCls} type="text" value={origin} readOnly /><CopyButton getText={() => origin} class="absolute right-2" /></div> },
    { label: "ANTHROPIC_API_KEY", node: <div class="relative flex items-center"><input class={inputCls} type="text" value={apiKey} readOnly /><CopyButton getText={() => apiKey} class="absolute right-2" /></div> },
    { label: "ANTHROPIC_DEFAULT_OPUS_MODEL", node: modelDropdown(opusModel, setOpusModel) },
    { label: "ANTHROPIC_DEFAULT_SONNET_MODEL", node: modelDropdown(sonnetModel, setSonnetModel) },
    { label: "ANTHROPIC_DEFAULT_HAIKU_MODEL", node: modelDropdown(haikuModel, setHaikuModel) },
    { label: "ANTHROPIC_MODEL", node: <div class="relative flex items-center"><input class={inputCls} type="text" value={customModel} readOnly /><CopyButton getText={() => customModel} class="absolute right-2" /></div> },
  ];

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors">
      <div class="flex items-center justify-between mb-6 border-b border-slate-100 dark:border-border-dark pb-4">
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("anthropicSetup")}</h2>
        </div>
      </div>

      <div class="space-y-3">
        {rows.map((r) => (
          <div key={r.label} class="flex items-center gap-3">
            <label class="text-[0.68rem] font-mono font-semibold text-slate-600 dark:text-text-dim w-64 shrink-0 truncate">{r.label}</label>
            <div class="flex-1">{r.node}</div>
          </div>
        ))}
      </div>

      <div class="mt-5 flex items-center gap-3">
        <CopyButton getText={getEnvText} variant="label" />
        <span class="text-xs text-slate-400 dark:text-text-dim">{t("anthropicCopyAllHint")}</span>
      </div>
    </section>
  );
}
