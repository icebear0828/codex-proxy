import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useTestConnection } from "../../../shared/hooks/use-test-connection";
import type { DiagnosticCheck, DiagnosticStatus } from "../../../shared/types";

const STATUS_COLORS: Record<DiagnosticStatus, string> = {
  pass: "text-green-600 dark:text-green-400",
  fail: "text-red-500 dark:text-red-400",
  skip: "text-slate-400 dark:text-text-dim",
};

const STATUS_BG: Record<DiagnosticStatus, string> = {
  pass: "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
  fail: "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800",
  skip: "bg-slate-50 dark:bg-[#161b22] border-slate-200 dark:border-border-dark",
};

const CHECK_NAME_KEYS: Record<string, string> = {
  server: "checkServer",
  accounts: "checkAccounts",
  transport: "checkTransport",
  upstream: "checkUpstream",
};

const STATUS_KEYS: Record<DiagnosticStatus, string> = {
  pass: "statusPass",
  fail: "statusFail",
  skip: "statusSkip",
};

function StatusIcon({ status }: { status: DiagnosticStatus }) {
  if (status === "pass") {
    return (
      <svg class="size-5 text-green-600 dark:text-green-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (status === "fail") {
    return (
      <svg class="size-5 text-red-500 dark:text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  return (
    <svg class="size-5 text-slate-400 dark:text-text-dim shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function CheckRow({ check }: { check: DiagnosticCheck }) {
  const t = useT();
  const nameKey = CHECK_NAME_KEYS[check.name] ?? check.name;
  const statusKey = STATUS_KEYS[check.status];

  return (
    <div class={`flex items-start gap-3 p-3 rounded-lg border ${STATUS_BG[check.status]}`}>
      <StatusIcon status={check.status} />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-slate-700 dark:text-text-main">
            {t(nameKey as Parameters<typeof t>[0])}
          </span>
          <span class={`text-xs font-medium ${STATUS_COLORS[check.status]}`}>
            {t(statusKey as Parameters<typeof t>[0])}
          </span>
          {check.latencyMs > 0 && (
            <span class="text-xs text-slate-400 dark:text-text-dim">{check.latencyMs}ms</span>
          )}
        </div>
        {check.detail && (
          <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5 break-all">{check.detail}</p>
        )}
        {check.error && (
          <p class="text-xs text-red-500 dark:text-red-400 mt-0.5 break-all">{check.error}</p>
        )}
      </div>
    </div>
  );
}

export function TestConnection() {
  const t = useT();
  const { testing, result, error, runTest } = useTestConnection();
  const [collapsed, setCollapsed] = useState(true);

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("testConnection")}</h2>
          {result && !collapsed && (
            <span class={`text-xs font-medium ml-1 ${result.overall === "pass" ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}>
              {result.overall === "pass" ? t("testPassed") : t("testFailed")}
            </span>
          )}
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Content */}
      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4">
          {/* Run test button */}
          <button
            onClick={runTest}
            disabled={testing}
            class={`w-full py-2.5 text-sm font-medium rounded-lg transition-colors ${
              testing
                ? "bg-slate-100 dark:bg-[#21262d] text-slate-400 dark:text-text-dim cursor-not-allowed"
                : "bg-primary text-white hover:bg-primary/90 cursor-pointer"
            }`}
          >
            {testing ? t("testing") : t("testConnection")}
          </button>

          {/* Error */}
          {error && (
            <p class="mt-3 text-sm text-red-500">{error}</p>
          )}

          {/* Results */}
          {result && (
            <div class="mt-4 space-y-2">
              {result.checks.map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
