import { useMemo } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useLogs } from "../../../shared/hooks/use-logs";
import { useSettings } from "../../../shared/hooks/use-settings";
import { useGeneralSettings } from "../../../shared/hooks/use-general-settings";

export function LogsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const logs = useLogs();
  const settings = useSettings();
  const gs = useGeneralSettings(settings.apiKey);
  const logsLlmOnly = gs.data?.logs_llm_only ?? true;

  const toggleLogsMode = async () => {
    await gs.save({ logs_llm_only: !logsLlmOnly });
  };

  const list = useMemo(() => {
    return logs.records.map((r) => ({
      ...r,
      time: new Date(r.ts).toLocaleTimeString(),
    }));
  }, [logs.records]);

  const pageStart = logs.total === 0 ? 0 : logs.page * logs.pageSize + 1;
  const pageEnd = logs.total === 0 ? 0 : Math.min(logs.total, (logs.page + 1) * logs.pageSize);
  const pageInfo = `${pageStart}-${pageEnd}`;

  return (
    <div class={`flex flex-col gap-4 ${embedded ? "" : "p-6"}`}>
      <div class="flex items-center gap-3 flex-wrap">
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium ${logs.state?.enabled ? "bg-primary-container text-primary" : "bg-slate-200 text-slate-600"}`}
          onClick={() => logs.setLogState({ enabled: !logs.state?.enabled })}
        >
          {logs.state?.enabled ? t("logsEnabled") : t("logsDisabled")}
        </button>
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium ${
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

        <div class="flex items-center gap-1.5">
          {(["all", "ingress", "egress"] as const).map((dir) => (
            <button
              key={dir}
              class={`px-2.5 py-1 rounded-md text-xs font-medium ${logs.direction === dir ? "bg-primary-action text-white" : "bg-slate-200 text-slate-600"}`}
              onClick={() => logs.setDirection(dir)}
            >
              {t(`logsFilter.${dir}`)}
            </button>
          ))}
        </div>

        <button
          class="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-200 text-slate-700 hover:bg-slate-300"
          onClick={toggleLogsMode}
          disabled={gs.saving}
        >
          {logsLlmOnly ? t("logsModeLlmOnlyToggle") : t("logsModeAllToggle")}
        </button>

        <input
          class="px-2.5 py-1 rounded-md text-xs bg-white dark:bg-bg-dark border border-slate-200 dark:border-border-dark"
          value={logs.search}
          onInput={(e) => logs.setSearch((e.target as HTMLInputElement).value)}
          placeholder={t("logsSearch")}
        />

        <div class="text-xs text-slate-500">
          {t("logsCount", { count: logs.total })}
        </div>
      </div>

      <div class="flex flex-col lg:flex-row gap-4 min-w-0">
        <div class="flex-1 min-w-0">
          <div class="border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-bg-dark">
            <div class="overflow-x-auto">
              <div class="min-w-[520px]">
                <div class="grid grid-cols-12 text-xs text-slate-500 px-3 py-2 border-b border-slate-200 dark:border-border-dark">
                  <div class="col-span-2">{t("logsTime")}</div>
                  <div class="col-span-2">{t("logsDirection")}</div>
                  <div class="col-span-4">{t("logsPath")}</div>
                  <div class="col-span-2">{t("logsStatus")}</div>
                  <div class="col-span-2">{t("logsLatency")}</div>
                </div>
                {logs.loading && (
                  <div class="p-4 text-xs text-slate-500">{t("logsLoading")}</div>
                )}
                {!logs.loading && list.length === 0 && (
                  <div class="p-4 text-xs text-slate-500">{t("logsEmpty")}</div>
                )}
                <div class="max-h-[420px] overflow-y-auto">
                  {list.map((row) => (
                    <button
                      key={row.id}
                      class={`w-full text-left grid grid-cols-12 px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark ${logs.selected?.id === row.id ? "bg-primary/5" : ""}`}
                      onClick={() => logs.selectLog(row.id)}
                    >
                      <div class="col-span-2 text-slate-500">{row.time}</div>
                      <div class="col-span-2">
                        <span class={`px-1.5 py-0.5 rounded ${row.direction === "ingress" ? "bg-success-container text-success" : "bg-info-container text-info"}`}>
                          {t(`logsFilter.${row.direction}`)}
                        </span>
                      </div>
                      <div class="col-span-4 truncate">{row.path}</div>
                      <div class="col-span-2">{row.status ?? "-"}</div>
                      <div class="col-span-2">{row.latencyMs != null ? `${row.latencyMs}ms` : "-"}</div>
                    </button>
                  ))}
                </div>
                <div class="flex items-center justify-between px-3 py-2 border-t border-slate-200 dark:border-border-dark text-xs text-slate-500">
                  <button
                    class="px-2 py-1 rounded bg-slate-100 dark:bg-border-dark disabled:opacity-50"
                    disabled={!logs.hasPrev}
                    onClick={logs.prevPage}
                  >
                    {t("logsPrev")}
                  </button>
                  <span>{t("logsPageSummary", { total: logs.total, range: pageInfo })}</span>
                  <button
                    class="px-2 py-1 rounded bg-slate-100 dark:bg-border-dark disabled:opacity-50"
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

        <div class="w-full lg:w-[360px] shrink-0">
          <div class="border border-slate-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark h-full">
            <div class="px-3 py-2 text-xs text-slate-500 border-b border-slate-200 dark:border-border-dark">
              {t("logsDetails")}
            </div>
            <div class="p-3 text-xs whitespace-pre-wrap max-h-[460px] overflow-auto">
              {logs.selected ? JSON.stringify(logs.selected, null, 2) : t("logsSelectHint")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
