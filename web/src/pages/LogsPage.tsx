import { useMemo, useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useLogs, type LogRecord } from "../../../shared/hooks/use-logs";
import { useSettings } from "../../../shared/hooks/use-settings";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";
import { CopyButton } from "../components/CopyButton";

function formatDuration(ms?: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSpeed(tokPerSec?: number | null): string {
  if (tokPerSec == null || tokPerSec <= 0) return "-";
  return `${tokPerSec.toFixed(1)} t/s`;
}

function formatCost(usd?: number | null): string {
  if (usd == null || usd === 0) return "-";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function formatTokens(tokens?: number | null): string {
  if (tokens == null) return "-";
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

export function LogsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const logs = useLogs();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);
  const logsLlmOnly = gs.data?.logs_llm_only ?? true;
  const [detailTab, setDetailTab] = useState<"formatted" | "raw">("formatted");

  const toggleLogsMode = async () => {
    await gs.save({ logs_llm_only: !logsLlmOnly });
  };

  const list = useMemo(() => {
    return logs.records.map((r) => ({
      ...r,
      time: new Date(r.ts).toLocaleTimeString(),
    }));
  }, [logs.records]);

  // Compute observability aggregate stats from current page/records
  const stats = useMemo(() => {
    if (logs.records.length === 0) {
      return {
        avgTtft: null as number | null,
        avgSpeed: null as number | null,
        avgLatency: null as number | null,
        totalCost: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedTokens: 0,
        successRate: 100,
      };
    }

    let ttftSum = 0;
    let ttftCount = 0;
    let speedSum = 0;
    let speedCount = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let successCount = 0;
    let completedCount = 0;

    for (const r of logs.records) {
      if (r.status != null) {
        completedCount++;
        if (r.status >= 200 && r.status < 400) {
          successCount++;
        }
      }
      if (r.ttftMs != null && r.ttftMs > 0) {
        ttftSum += r.ttftMs;
        ttftCount++;
      }
      if (r.tokensPerSecond != null && r.tokensPerSecond > 0) {
        speedSum += r.tokensPerSecond;
        speedCount++;
      }
      const lat = r.durationMs ?? r.latencyMs;
      if (lat != null && lat >= 0) {
        latencySum += lat;
        latencyCount++;
      }
      if (r.costUsd != null && r.costUsd > 0) {
        totalCost += r.costUsd;
      }
      if (r.usage) {
        totalInputTokens += r.usage.input_tokens ?? 0;
        totalOutputTokens += r.usage.output_tokens ?? 0;
        totalCachedTokens += r.usage.cached_tokens ?? 0;
      }
    }

    return {
      avgTtft: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : null,
      avgSpeed: speedCount > 0 ? Math.round((speedSum / speedCount) * 10) / 10 : null,
      avgLatency: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      successRate: completedCount > 0 ? Math.round((successCount / completedCount) * 100) : 100,
    };
  }, [logs.records]);

  const pageStart = logs.total === 0 ? 0 : logs.page * logs.pageSize + 1;
  const pageEnd = logs.total === 0 ? 0 : Math.min(logs.total, (logs.page + 1) * logs.pageSize);
  const pageInfo = `${pageStart}-${pageEnd}`;

  return (
    <div class={`flex flex-col gap-4 ${embedded ? "" : "p-6"}`}>
      {/* Top Filter & Control Bar */}
      <div class="flex items-center gap-3 flex-wrap">
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            logs.state?.enabled ? "bg-primary-container text-primary" : "bg-slate-200 text-slate-600"
          }`}
          onClick={() => logs.setLogState({ enabled: !logs.state?.enabled })}
        >
          {logs.state?.enabled ? t("logsEnabled") : t("logsDisabled")}
        </button>

        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            !logs.state?.enabled
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : logs.state?.paused
                ? "bg-warning-container text-warning"
                : "bg-slate-200 text-slate-600"
          }`}
          onClick={() => logs.state?.enabled && logs.setLogState({ paused: !logs.state?.paused })}
          disabled={!logs.state?.enabled}
        >
          {logs.state?.paused ? t("logsPaused") : t("logsRunning")}
        </button>

        <div class="flex items-center gap-1.5 bg-slate-100 dark:bg-border-dark p-0.5 rounded-lg">
          {(["all", "ingress", "egress"] as const).map((dir) => (
            <button
              key={dir}
              class={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                logs.direction === dir
                  ? "bg-primary-action text-white shadow-sm"
                  : "text-slate-600 dark:text-text-dim hover:text-slate-900"
              }`}
              onClick={() => logs.setDirection(dir)}
            >
              {t(`logsFilter.${dir}`)}
            </button>
          ))}
        </div>

        <button
          class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-200 dark:bg-border-dark text-slate-700 dark:text-text-dim hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors"
          onClick={toggleLogsMode}
          disabled={gs.saving}
        >
          {logsLlmOnly ? t("logsModeLlmOnlyToggle") : t("logsModeAllToggle")}
        </button>

        <input
          class="px-3 py-1.5 rounded-lg text-xs bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark focus:outline-none focus:ring-1 focus:ring-primary w-48"
          value={logs.search}
          onInput={(e) => logs.setSearch((e.target as HTMLInputElement).value)}
          placeholder={t("logsSearch")}
        />

        <button
          class="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200/60 dark:border-rose-800 hover:bg-rose-100 transition-colors"
          onClick={() => void logs.clearLogs()}
          title={t("logsClear")}
        >
          {t("logsClear")}
        </button>

        <div class="text-xs text-slate-500 font-medium ml-auto">
          {t("logsCount", { count: logs.total })}
        </div>
      </div>

      {/* Observability Metrics Banner */}
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div class="p-3 bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark rounded-lg shadow-sm">
          <div class="text-[11px] text-slate-500 font-medium">{t("logsAvgTtft")}</div>
          <div class="text-lg font-semibold text-slate-800 dark:text-white mt-1">
            {formatDuration(stats.avgTtft)}
          </div>
        </div>

        <div class="p-3 bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark rounded-lg shadow-sm">
          <div class="text-[11px] text-slate-500 font-medium">{t("logsAvgSpeed")}</div>
          <div class="text-lg font-semibold text-emerald-600 dark:text-emerald-400 mt-1">
            {formatSpeed(stats.avgSpeed)}
          </div>
        </div>

        <div class="p-3 bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark rounded-lg shadow-sm">
          <div class="text-[11px] text-slate-500 font-medium">{t("logsAvgLatency")}</div>
          <div class="text-lg font-semibold text-slate-800 dark:text-white mt-1">
            {formatDuration(stats.avgLatency)}
          </div>
        </div>

        <div class="p-3 bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark rounded-lg shadow-sm">
          <div class="text-[11px] text-slate-500 font-medium">{t("logsTotalCost")}</div>
          <div class="text-lg font-semibold text-amber-600 dark:text-amber-400 mt-1">
            {stats.totalCost > 0 ? `$${stats.totalCost.toFixed(4)}` : "$0.00"}
          </div>
        </div>

        <div class="p-3 bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark rounded-lg shadow-sm">
          <div class="text-[11px] text-slate-500 font-medium">{t("logsTokens")}</div>
          <div class="text-lg font-semibold text-slate-800 dark:text-white mt-1">
            {formatTokens(stats.totalInputTokens + stats.totalOutputTokens)}
          </div>
          <div class="text-[10px] text-slate-400">
            {formatTokens(stats.totalInputTokens)} in / {formatTokens(stats.totalOutputTokens)} out
          </div>
        </div>

        <div class="p-3 bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark rounded-lg shadow-sm">
          <div class="text-[11px] text-slate-500 font-medium">{t("logsSuccessRate")}</div>
          <div class={`text-lg font-semibold mt-1 ${stats.successRate >= 95 ? "text-green-600" : "text-amber-500"}`}>
            {stats.successRate}%
          </div>
        </div>
      </div>

      {/* Main Content Area: Table + Details Drawer */}
      <div class="flex flex-col lg:flex-row gap-4 min-w-0">
        {/* Log List Table */}
        <div class="flex-1 min-w-0">
          <div class="border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-bg-dark shadow-sm">
            <div class="overflow-x-auto">
              <div class="min-w-[760px]">
                <div class="grid grid-cols-12 text-xs text-slate-500 font-medium px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border-b border-slate-200 dark:border-border-dark">
                  <div class="col-span-2">{t("logsTime")}</div>
                  <div class="col-span-1">{t("logsStatus")}</div>
                  <div class="col-span-1">{t("logsDirection")}</div>
                  <div class="col-span-3">{t("logsPath")} / {t("logsModel")}</div>
                  <div class="col-span-1">{t("logsTtft")}</div>
                  <div class="col-span-1">{t("logsSpeed")}</div>
                  <div class="col-span-1">{t("logsCost")}</div>
                  <div class="col-span-2 text-right">{t("logsLatency")}</div>
                </div>

                {logs.loading && (
                  <div class="p-6 text-center text-xs text-slate-500">{t("logsLoading")}</div>
                )}
                {!logs.loading && list.length === 0 && (
                  <div class="p-6 text-center text-xs text-slate-500">{t("logsEmpty")}</div>
                )}

                <div class="max-h-[520px] overflow-y-auto divide-y divide-slate-100 dark:divide-border-dark">
                  {list.map((row) => {
                    const statusClass =
                      row.status === 200
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800"
                        : row.status != null && row.status >= 400 && row.status < 500
                          ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200 dark:border-amber-800"
                          : row.status != null && row.status >= 500
                            ? "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 border border-rose-200 dark:border-rose-800"
                            : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";

                    return (
                      <button
                        key={row.id}
                        class={`w-full text-left grid grid-cols-12 px-3 py-2.5 text-xs transition-colors items-center hover:bg-slate-50 dark:hover:bg-border-dark/50 ${
                          logs.selected?.id === row.id ? "bg-primary/10 dark:bg-primary/20" : ""
                        }`}
                        onClick={() => logs.selectLog(row.id)}
                      >
                        <div class="col-span-2 text-slate-500 font-mono text-[11px] truncate">{row.time}</div>
                        <div class="col-span-1">
                          <span class={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${statusClass}`}>
                            {row.status ?? "-"}
                          </span>
                        </div>
                        <div class="col-span-1">
                          <span
                            class={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              row.direction === "ingress"
                                ? "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400"
                                : "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400"
                            }`}
                          >
                            {t(`logsFilter.${row.direction}`)}
                          </span>
                        </div>
                        <div class="col-span-3 min-w-0 pr-2">
                          <div class="font-medium text-slate-800 dark:text-white truncate">
                            {row.model || row.path}
                          </div>
                          {row.model && (
                            <div class="text-[10px] text-slate-400 truncate">{row.path}</div>
                          )}
                        </div>
                        <div class="col-span-1 font-mono text-slate-600 dark:text-slate-300">
                          {formatDuration(row.ttftMs)}
                        </div>
                        <div class="col-span-1 font-mono text-emerald-600 dark:text-emerald-400">
                          {formatSpeed(row.tokensPerSecond)}
                        </div>
                        <div class="col-span-1 font-mono text-amber-600 dark:text-amber-400">
                          {formatCost(row.costUsd)}
                        </div>
                        <div class="col-span-2 font-mono text-right text-slate-600 dark:text-slate-300 font-medium">
                          {row.latencyMs != null ? `${row.latencyMs}ms` : "-"}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div class="flex items-center justify-between px-3 py-2.5 border-t border-slate-200 dark:border-border-dark text-xs text-slate-500 bg-slate-50 dark:bg-bg-dark">
                  <button
                    class="px-2.5 py-1 rounded bg-white dark:bg-border-dark border border-slate-200 dark:border-border-dark disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
                    disabled={!logs.hasPrev}
                    onClick={logs.prevPage}
                  >
                    {t("logsPrev")}
                  </button>
                  <span class="font-medium">{t("logsPageSummary", { total: logs.total, range: pageInfo })}</span>
                  <button
                    class="px-2.5 py-1 rounded bg-white dark:bg-border-dark border border-slate-200 dark:border-border-dark disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
                    disabled={!logs.hasNext}
                    onClick={logs.nextPage}
                  >
                    {t("logsNext")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Observability Details Panel */}
        <div class="w-full lg:w-[420px] shrink-0">
          <div class="border border-slate-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark shadow-sm h-full flex flex-col">
            <div class="px-3 py-2.5 border-b border-slate-200 dark:border-border-dark flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xs font-semibold text-slate-800 dark:text-white">
                  {t("logsDetails")}
                </span>
                {logs.selected && (
                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-border-dark text-slate-600 dark:text-text-dim font-mono">
                    {logs.selected.requestId?.slice(0, 8)}
                  </span>
                )}
              </div>

              {logs.selected && (
                <div class="flex items-center gap-1.5">
                  <div class="flex bg-slate-100 dark:bg-border-dark p-0.5 rounded-md">
                    <button
                      class={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
                        detailTab === "formatted"
                          ? "bg-white dark:bg-bg-dark text-primary shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => setDetailTab("formatted")}
                    >
                      {t("logsTabFormatted")}
                    </button>
                    <button
                      class={`px-2 py-0.5 text-[11px] rounded font-medium transition-colors ${
                        detailTab === "raw"
                          ? "bg-white dark:bg-bg-dark text-primary shadow-sm"
                          : "text-slate-500 hover:text-slate-900"
                      }`}
                      onClick={() => setDetailTab("raw")}
                    >
                      {t("logsTabRaw")}
                    </button>
                  </div>
                  <CopyButton getText={() => JSON.stringify(logs.selected, null, 2)} />
                </div>
              )}
            </div>

            <div class="p-3 text-xs flex-1 max-h-[580px] overflow-y-auto">
              {!logs.selected ? (
                <div class="p-6 text-center text-slate-400 dark:text-text-dim">
                  {t("logsSelectHint")}
                </div>
              ) : detailTab === "formatted" ? (
                <div class="flex flex-col gap-3.5">
                  {/* KPI 4-Card Grid */}
                  <div class="grid grid-cols-2 gap-2">
                    <div class="p-2.5 rounded-lg bg-slate-50 dark:bg-border-dark/30 border border-slate-200/60 dark:border-border-dark">
                      <div class="text-[10px] text-slate-400 font-medium">{t("logsTtft")}</div>
                      <div class="text-base font-semibold font-mono text-slate-800 dark:text-white mt-0.5">
                        {formatDuration(logs.selected.ttftMs)}
                      </div>
                    </div>

                    <div class="p-2.5 rounded-lg bg-slate-50 dark:bg-border-dark/30 border border-slate-200/60 dark:border-border-dark">
                      <div class="text-[10px] text-slate-400 font-medium">{t("logsSpeed")}</div>
                      <div class="text-base font-semibold font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">
                        {formatSpeed(logs.selected.tokensPerSecond)}
                      </div>
                    </div>

                    <div class="p-2.5 rounded-lg bg-slate-50 dark:bg-border-dark/30 border border-slate-200/60 dark:border-border-dark">
                      <div class="text-[10px] text-slate-400 font-medium">{t("logsCost")}</div>
                      <div class="text-base font-semibold font-mono text-amber-600 dark:text-amber-400 mt-0.5">
                        {formatCost(logs.selected.costUsd)}
                      </div>
                    </div>

                    <div class="p-2.5 rounded-lg bg-slate-50 dark:bg-border-dark/30 border border-slate-200/60 dark:border-border-dark">
                      <div class="text-[10px] text-slate-400 font-medium">{t("logsLatency")}</div>
                      <div class="text-base font-semibold font-mono text-slate-800 dark:text-white mt-0.5">
                        {logs.selected.latencyMs != null ? `${logs.selected.latencyMs}ms` : "-"}
                      </div>
                    </div>
                  </div>

                  {/* Token Breakdown Card */}
                  {logs.selected.usage && (
                    <div class="p-3 rounded-lg border border-slate-200 dark:border-border-dark bg-slate-50/50 dark:bg-border-dark/20 flex flex-col gap-2">
                      <div class="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                        {t("logsTokensDetail")}
                      </div>
                      <div class="grid grid-cols-2 gap-2 text-[11px]">
                        <div>
                          <span class="text-slate-400">{t("logsPromptTokens")}:</span>{" "}
                          <span class="font-mono font-medium">{logs.selected.usage.input_tokens ?? 0}</span>
                        </div>
                        <div>
                          <span class="text-slate-400">{t("logsCompletionTokens")}:</span>{" "}
                          <span class="font-mono font-medium">{logs.selected.usage.output_tokens ?? 0}</span>
                        </div>
                        {logs.selected.usage.cached_tokens != null && logs.selected.usage.cached_tokens > 0 && (
                          <div class="col-span-2">
                            <span class="text-slate-400">{t("logsCachedTokens")}:</span>{" "}
                            <span class="font-mono font-medium text-primary">
                              {logs.selected.usage.cached_tokens}
                              {logs.selected.usage.input_tokens > 0 && (
                                <span class="text-xs text-slate-400 ml-1">
                                  ({((logs.selected.usage.cached_tokens / logs.selected.usage.input_tokens) * 100).toFixed(1)}%)
                                </span>
                              )}
                            </span>
                          </div>
                        )}
                        {logs.selected.usage.reasoning_tokens != null && logs.selected.usage.reasoning_tokens > 0 && (
                          <div class="col-span-2">
                            <span class="text-slate-400">{t("logsReasoningTokens")}:</span>{" "}
                            <span class="font-mono font-medium text-indigo-600 dark:text-indigo-400">
                              {logs.selected.usage.reasoning_tokens}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Metadata List */}
                  <div class="p-3 rounded-lg border border-slate-200 dark:border-border-dark bg-white dark:bg-bg-dark flex flex-col gap-1.5 text-[11px]">
                    <div class="text-[11px] font-semibold text-slate-700 dark:text-slate-200 mb-1">
                      {t("logsMetadata")}
                    </div>
                    <div class="flex justify-between py-0.5 border-b border-slate-100 dark:border-border-dark">
                      <span class="text-slate-400">{t("logsRequestId")}</span>
                      <span class="font-mono text-slate-700 dark:text-slate-200 select-all">{logs.selected.requestId}</span>
                    </div>
                    {logs.selected.model && (
                      <div class="flex justify-between py-0.5 border-b border-slate-100 dark:border-border-dark">
                        <span class="text-slate-400">{t("logsModel")}</span>
                        <span class="font-medium text-slate-700 dark:text-slate-200">{logs.selected.model}</span>
                      </div>
                    )}
                    {logs.selected.provider && (
                      <div class="flex justify-between py-0.5 border-b border-slate-100 dark:border-border-dark">
                        <span class="text-slate-400">{t("logsProvider")}</span>
                        <span class="text-slate-700 dark:text-slate-200">{logs.selected.provider}</span>
                      </div>
                    )}
                    <div class="flex justify-between py-0.5 border-b border-slate-100 dark:border-border-dark">
                      <span class="text-slate-400">{t("logsPath")}</span>
                      <span class="font-mono text-slate-700 dark:text-slate-200">{logs.selected.method} {logs.selected.path}</span>
                    </div>
                    {logs.selected.stream !== undefined && (
                      <div class="flex justify-between py-0.5">
                        <span class="text-slate-400">{t("logsStreaming")}</span>
                        <span class="text-slate-700 dark:text-slate-200">
                          {logs.selected.stream ? t("logsStreaming") : t("logsNonStreaming")}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Request Payload View */}
                  {logs.selected.request !== undefined && (
                    <div class="rounded-lg border border-slate-200 dark:border-border-dark overflow-hidden">
                      <div class="px-3 py-1.5 bg-slate-50 dark:bg-border-dark/50 text-[11px] font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-border-dark flex justify-between items-center">
                        <span>{t("logsRequestPayload")}</span>
                      </div>
                      <pre class="p-3 bg-slate-900 text-slate-100 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto max-h-48">
                        {JSON.stringify(logs.selected.request, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* Response Payload / Error View */}
                  {(logs.selected.response !== undefined || logs.selected.error) && (
                    <div class="rounded-lg border border-slate-200 dark:border-border-dark overflow-hidden">
                      <div class="px-3 py-1.5 bg-slate-50 dark:bg-border-dark/50 text-[11px] font-semibold text-slate-700 dark:text-slate-200 border-b border-slate-200 dark:border-border-dark">
                        <span>{t("logsResponsePayload")}</span>
                      </div>
                      <pre class="p-3 bg-slate-900 text-slate-100 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto max-h-48">
                        {logs.selected.error
                          ? logs.selected.error
                          : JSON.stringify(logs.selected.response, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <pre class="bg-slate-900 text-slate-100 p-3 rounded-lg text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-[520px]">
                  {JSON.stringify(logs.selected, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
