import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useUsageSummary, useUsageHistory, type Granularity } from "../../../shared/hooks/use-usage-stats";
import { UsageChart, formatNumber } from "../components/UsageChart";
import type { TranslationKey } from "../../../shared/i18n/translations";

const granularityOptions: Array<{ value: Granularity; label: TranslationKey }> = [
  { value: "hourly", label: "granularityHourly" },
  { value: "daily", label: "granularityDaily" },
];

const rangeOptions: Array<{ hours: number; label: TranslationKey }> = [
  { hours: 24, label: "last24h" },
  { hours: 72, label: "last3d" },
  { hours: 168, label: "last7d" },
];

function UsageContent({ t, summary, summaryLoading, granularity, setGranularity, hours, setHours, dataPoints, historyLoading }: {
  t: (key: TranslationKey) => string;
  summary: ReturnType<typeof useUsageSummary>["summary"];
  summaryLoading: boolean;
  granularity: Granularity;
  setGranularity: (g: Granularity) => void;
  hours: number;
  setHours: (h: number) => void;
  dataPoints: ReturnType<typeof useUsageHistory>["dataPoints"];
  historyLoading: boolean;
}) {
  return (
    <>
      {/* Summary cards */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard
          label={t("totalInputTokens")}
          value={summaryLoading ? "—" : formatNumber(summary?.total_input_tokens ?? 0)}
        />
        <SummaryCard
          label={t("totalOutputTokens")}
          value={summaryLoading ? "—" : formatNumber(summary?.total_output_tokens ?? 0)}
        />
        <SummaryCard
          label={t("totalRequestCount")}
          value={summaryLoading ? "—" : formatNumber(summary?.total_request_count ?? 0)}
        />
        <SummaryCard
          label={t("activeAccounts")}
          value={summaryLoading ? "—" : `${summary?.active_accounts ?? 0} / ${summary?.total_accounts ?? 0}`}
        />
      </div>

      {/* Controls */}
      <div class="flex flex-wrap gap-2 mb-4">
        {granularityOptions.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setGranularity(value)}
            class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              granularity === value
                ? "bg-primary text-white border-primary"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
        <div class="w-px h-5 bg-gray-200 dark:bg-border-dark self-center" />
        {rangeOptions.map(({ hours: h, label }) => (
          <button
            key={h}
            onClick={() => setHours(h)}
            class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              hours === h
                ? "bg-primary text-white border-primary"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4">
        {historyLoading ? (
          <div class="text-center py-12 text-slate-400 dark:text-text-dim text-sm">Loading...</div>
        ) : (
          <UsageChart data={dataPoints} />
        )}
      </div>
    </>
  );
}

export function UsageStats({ embedded }: { embedded?: boolean } = {}) {
  const t = useT();
  const { summary, loading: summaryLoading } = useUsageSummary();
  const [granularity, setGranularity] = useState<Granularity>("hourly");
  const [hours, setHours] = useState(24);
  const { dataPoints, loading: historyLoading } = useUsageHistory(granularity, hours);

  const contentProps = { t, summary, summaryLoading, granularity, setGranularity, hours, setHours, dataPoints, historyLoading };

  if (embedded) {
    return (
      <div class="flex flex-col gap-4">
        <UsageContent {...contentProps} />
      </div>
    );
  }

  return (
    <div class="min-h-screen bg-slate-50 dark:bg-bg-dark flex flex-col">
      <header class="sticky top-0 z-50 bg-white dark:bg-card-dark border-b border-gray-200 dark:border-border-dark px-4 py-3">
        <div class="max-w-[1100px] mx-auto flex items-center gap-3">
          <a
            href="#/"
            class="text-sm text-slate-500 dark:text-text-dim hover:text-primary transition-colors"
          >
            &larr; {t("backToDashboard")}
          </a>
          <h1 class="text-base font-semibold text-slate-800 dark:text-text-main">
            {t("usageStats")}
          </h1>
        </div>
      </header>

      <main class="flex-grow px-4 md:px-8 py-6 max-w-[1100px] mx-auto w-full">
        <UsageContent {...contentProps} />
      </main>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4">
      <div class="text-xs text-slate-500 dark:text-text-dim mb-1">{label}</div>
      <div class="text-lg font-semibold text-slate-800 dark:text-text-main">{value}</div>
    </div>
  );
}
