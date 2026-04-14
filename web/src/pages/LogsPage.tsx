import { useMemo } from "preact/hooks";
import { useT } from "../../shared/i18n/context";
import { useLogs } from "../../shared/hooks/use-logs";

export function LogsPage({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const logs = useLogs();

  const list = useMemo(() => {
    return logs.records.map((r) => ({
      ...r,
      time: new Date(r.ts).toLocaleTimeString(),
    }));
  }, [logs.records]);

  return (
    <div class={`flex flex-col gap-4 ${embedded ? "" : "p-6"}`}>
      <div class="flex items-center gap-3 flex-wrap">
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium ${logs.state?.enabled ? "bg-primary/10 text-primary" : "bg-slate-200 text-slate-600"}`}
          onClick={() => logs.setLogState({ enabled: !logs.state?.enabled })}
        >
          {logs.state?.enabled ? t("logsEnabled") : t("logsDisabled")}
        </button>
        <button
          class={`px-3 py-1.5 rounded-lg text-xs font-medium ${logs.state?.paused ? "bg-amber-100 text-amber-700" : "bg-slate-200 text-slate-600"}`}
          onClick={() => logs.setLogState({ paused: !logs.state?.paused })}
        >
          {logs.state?.paused ? t("logsPaused") : t("logsRunning")}
        </button>

        <div class="flex items-center gap-1.5">
          {(["all", "ingress", "egress"] as const).map((dir) => (
            <button
              key={dir}
              class={`px-2.5 py-1 rounded-md text-xs font-medium ${logs.direction === dir ? "bg-primary text-white" : "bg-slate-200 text-slate-600"}`}
              onClick={() => logs.setDirection(dir)}
            >
              {t(`logsFilter.${dir}`)}
            </button>
          ))}
        </div>

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

      <div class="flex gap-4">
        <div class="flex-1 min-w-0">
          <div class="border border-slate-200 dark:border-border-dark rounded-lg overflow-hidden bg-white dark:bg-bg-dark">
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
            <div class="max-h-[420px] overflow-auto">
              {list.map((row) => (
                <button
                  key={row.id}
                  class={`w-full text-left grid grid-cols-12 px-3 py-2 text-xs border-b border-slate-100 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark ${logs.selected?.id === row.id ? "bg-primary/5" : ""}`}
                  onClick={() => logs.selectLog(row.id)}
                >
                  <div class="col-span-2 text-slate-500">{row.time}</div>
                  <div class="col-span-2">
                    <span class={`px-1.5 py-0.5 rounded ${row.direction === "ingress" ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>
                      {t(`logsFilter.${row.direction}`)}
                    </span>
                  </div>
                  <div class="col-span-4 truncate">{row.path}</div>
                  <div class="col-span-2">{row.status ?? "-"}</div>
                  <div class="col-span-2">{row.latencyMs ? `${row.latencyMs}ms` : "-"}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div class="w-[360px] shrink-0">
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
