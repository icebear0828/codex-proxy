import React from "react";

interface MetricCard {
  readonly label: string;
  readonly value: string;
  readonly sublabel: string;
  readonly trendValue: string;
  readonly trendDirection: "up" | "down" | "neutral";
  readonly trendTone: "primary" | "error" | "secondary";
}

interface TelemetryLogEntry {
  readonly timestamp: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly requests: string;
  readonly errorRate: string;
  readonly errorTone: "healthy" | "warning";
}

interface UsageStatsProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly metrics?: readonly MetricCard[];
  readonly selectedGranularity?: "Hourly" | "Daily";
  readonly selectedRange?: "24h" | "72h" | "7d";
  readonly leftAxisLabels?: readonly string[];
  readonly rightAxisLabels?: readonly string[];
  readonly timelineLabels?: readonly string[];
  readonly telemetryLogs?: readonly TelemetryLogEntry[];
  readonly activeProxiesLabel?: string;
  readonly activeProxiesValue?: string;
  readonly activeProxiesPercent?: number;
  readonly quotaWarningTitle?: string;
  readonly quotaWarningDescription?: string;
  readonly exportLabel?: string;
}

const defaultMetrics: readonly MetricCard[] = [
  {
    label: "Input Tokens",
    value: "42.8M",
    sublabel: "AVG: 1.2M/HR",
    trendValue: "12.5%",
    trendDirection: "up",
    trendTone: "primary",
  },
  {
    label: "Output Tokens",
    value: "156.4M",
    sublabel: "AVG: 4.8M/HR",
    trendValue: "8.2%",
    trendDirection: "up",
    trendTone: "primary",
  },
  {
    label: "Total Requests",
    value: "892,401",
    sublabel: "PEAK: 24.2K/HR",
    trendValue: "2.4%",
    trendDirection: "down",
    trendTone: "error",
  },
  {
    label: "Active Accounts",
    value: "1,204",
    sublabel: "80.3% CAPACITY",
    trendValue: "14",
    trendDirection: "neutral",
    trendTone: "secondary",
  },
];

const defaultTelemetryLogs: readonly TelemetryLogEntry[] = [
  {
    timestamp: "2023-10-24 14:00:00",
    inputTokens: "1,402,192",
    outputTokens: "5,829,004",
    requests: "24,201",
    errorRate: "0.02%",
    errorTone: "healthy",
  },
  {
    timestamp: "2023-10-24 13:00:00",
    inputTokens: "1,120,544",
    outputTokens: "4,201,982",
    requests: "18,550",
    errorRate: "1.42%",
    errorTone: "warning",
  },
  {
    timestamp: "2023-10-24 12:00:00",
    inputTokens: "982,001",
    outputTokens: "3,540,112",
    requests: "14,200",
    errorRate: "0.05%",
    errorTone: "healthy",
  },
  {
    timestamp: "2023-10-24 11:00:00",
    inputTokens: "1,250,883",
    outputTokens: "4,992,041",
    requests: "21,042",
    errorRate: "0.01%",
    errorTone: "healthy",
  },
  {
    timestamp: "2023-10-24 10:00:00",
    inputTokens: "1,100,242",
    outputTokens: "4,120,559",
    requests: "19,882",
    errorRate: "0.03%",
    errorTone: "healthy",
  },
];

const UsageStats: React.FC<UsageStatsProps> = ({
  title = "Usage Statistics",
  subtitle = "SYSTEM OVERVIEW & TOKEN ANALYTICS • REAL-TIME FEED",
  metrics = defaultMetrics,
  selectedGranularity = "Hourly",
  selectedRange = "72h",
  leftAxisLabels = ["200M", "150M", "100M", "50M", "0"],
  rightAxisLabels = ["30.0k", "22.5k", "15.0k", "7.5k", "0"],
  timelineLabels = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "23:59"],
  telemetryLogs = defaultTelemetryLogs,
  activeProxiesLabel = "Active Proxies",
  activeProxiesValue = "4,281 / 5,000",
  activeProxiesPercent = 85.6,
  quotaWarningTitle = "Automated Quota Warning",
  quotaWarningDescription = "System detected a +12% surge in Token Input over the last 4 hours. Recommend adjusting regional rate limits to maintain 99.9% availability.",
  exportLabel = "Export Full Telemetry.csv",
}) => {
  const trendBadgeClasses = (tone: MetricCard["trendTone"]) => {
    if (tone === "error") {
      return "text-error bg-error-container/30";
    }
    if (tone === "secondary") {
      return "text-secondary bg-secondary-fixed-dim/30";
    }
    return "text-primary-container bg-primary-fixed-dim/20";
  };

  const trendIcon = (direction: MetricCard["trendDirection"]) => {
    if (direction === "up") return "↗";
    if (direction === "down") return "↘";
    return "+";
  };

  return (
    <main className="mx-auto min-h-screen max-w-[1600px] space-y-8 bg-surface p-6 text-on-surface antialiased md:p-10 font-body">
      <header className="flex flex-col gap-1">
        <h1 className="font-headline text-3xl font-black uppercase tracking-tight text-on-surface">
          {title}
        </h1>
        <p className="font-label text-sm tracking-wide text-on-surface-variant">
          {subtitle}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="flex h-40 flex-col justify-between rounded-xl border border-outline-variant/15 bg-surface-container-lowest p-6"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
                {metric.label}
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold ${trendBadgeClasses(
                  metric.trendTone,
                )}`}
              >
                <span className="mr-1 text-sm leading-none">{trendIcon(metric.trendDirection)}</span>
                {metric.trendValue}
              </span>
            </div>
            <div>
              <div className="font-mono text-3xl font-black tracking-tighter text-on-surface">
                {metric.value}
              </div>
              <div className="mt-1 font-mono text-[0.625rem] uppercase text-outline">
                {metric.sublabel}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg bg-surface-container-low px-6 py-3">
          <div className="flex items-center gap-4">
            <span className="font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
              Granularity
            </span>
            <div className="flex rounded-lg bg-surface-container-high p-1">
              {(["Hourly", "Daily"] as const).map((option) => {
                const active = selectedGranularity === option;
                return (
                  <button
                    key={option}
                    type="button"
                    className={
                      active
                        ? "rounded-md bg-surface-container-lowest px-4 py-1.5 text-xs font-bold text-primary shadow-sm"
                        : "px-4 py-1.5 text-xs font-bold text-outline transition-colors hover:text-on-surface"
                    }
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <span className="font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
              Time Range
            </span>
            <div className="flex gap-2">
              {(["24h", "72h", "7d"] as const).map((range) => {
                const active = selectedRange === range;
                return (
                  <button
                    key={range}
                    type="button"
                    className={
                      active
                        ? "rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-on-primary shadow-lg shadow-primary/20"
                        : "rounded-lg border border-outline-variant/20 px-3 py-1.5 text-xs font-bold text-outline transition-colors hover:bg-surface-container-high"
                    }
                  >
                    {range}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-outline-variant/15 bg-surface-container-lowest p-8">
          <div className="mb-8 flex items-center justify-between">
            <div className="flex flex-wrap gap-6">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-primary" />
                <span className="font-label text-[0.6875rem] font-bold uppercase tracking-wider text-on-surface">
                  Input Tokens
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-secondary" />
                <span className="font-label text-[0.6875rem] font-bold uppercase tracking-wider text-on-surface">
                  Output Tokens
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1 w-3 rounded-full bg-tertiary" />
                <span className="font-label text-[0.6875rem] font-bold uppercase tracking-wider text-on-surface">
                  Requests
                </span>
              </div>
            </div>
          </div>

          <div className="relative h-[400px] w-full">
            <svg className="h-full w-full overflow-visible" viewBox="0 0 1000 400" aria-hidden="true">
              <defs>
                <linearGradient id="usageStatsInputGradient" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="currentColor" stopOpacity="0.3" className="text-primary" />
                  <stop offset="95%" stopColor="currentColor" stopOpacity="0" className="text-primary" />
                </linearGradient>
                <linearGradient id="usageStatsOutputGradient" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor="currentColor" stopOpacity="0.2" className="text-secondary" />
                  <stop offset="95%" stopColor="currentColor" stopOpacity="0" className="text-secondary" />
                </linearGradient>
              </defs>

              {[0, 100, 200, 300, 400].map((y, index) => (
                <line
                  key={y}
                  x1="0"
                  x2="1000"
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={index === 4 ? "0.2" : "0.1"}
                  className="text-outline-variant"
                />
              ))}

              <path
                d="M0 400 L0 320 Q 250 280, 500 340 T 1000 200 L 1000 400 Z"
                fill="url(#usageStatsOutputGradient)"
              />
              <path
                d="M0 320 Q 250 280, 500 340 T 1000 200"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="text-secondary"
              />

              <path
                d="M0 400 L0 350 Q 250 340, 500 360 T 1000 310 L 1000 400 Z"
                fill="url(#usageStatsInputGradient)"
              />
              <path
                d="M0 350 Q 250 340, 500 360 T 1000 310"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="text-primary"
              />

              <path
                d="M0 250 L 150 180 L 300 220 L 450 100 L 600 150 L 750 80 L 1000 120"
                fill="none"
                stroke="currentColor"
                strokeDasharray="6,4"
                strokeWidth="2"
                className="text-tertiary"
              />
              <circle cx="450" cy="100" r="4" fill="currentColor" className="text-tertiary" />
              <circle cx="750" cy="80" r="4" fill="currentColor" className="text-tertiary" />
            </svg>

            <div className="absolute -left-12 top-0 flex h-full flex-col justify-between py-2 font-mono text-[10px] font-bold text-outline">
              {leftAxisLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>

            <div className="absolute -right-12 top-0 flex h-full flex-col justify-between py-2 text-right font-mono text-[10px] font-bold text-tertiary">
              {rightAxisLabels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
          </div>

          <div className="mt-4 flex justify-between px-2 font-mono text-[10px] font-bold text-outline">
            {timelineLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="font-headline text-lg font-black uppercase tracking-tight text-on-surface">
          Granular Telemetry Log
        </h2>

        <div className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="bg-surface-container-highest">
                <tr>
                  <th className="px-6 py-4 font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
                    Timestamp
                  </th>
                  <th className="px-6 py-4 text-right font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
                    Input Tokens
                  </th>
                  <th className="px-6 py-4 text-right font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
                    Output Tokens
                  </th>
                  <th className="px-6 py-4 text-right font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
                    Requests
                  </th>
                  <th className="px-6 py-4 text-center font-label text-[0.6875rem] font-bold uppercase tracking-widest text-outline">
                    Error Rate
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/10">
                {telemetryLogs.map((log) => (
                  <tr key={log.timestamp} className="group transition-colors hover:bg-surface-container-low">
                    <td className="px-6 py-4 font-mono text-xs font-medium text-on-surface">
                      {log.timestamp}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-on-surface">
                      {log.inputTokens}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-on-surface">
                      {log.outputTokens}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-xs text-on-surface">
                      {log.requests}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span
                        className={
                          log.errorTone === "warning"
                            ? "rounded px-2.5 py-1 font-mono text-[10px] font-black text-on-error-container bg-error-container/40"
                            : "rounded bg-primary-fixed-dim/20 px-2.5 py-1 font-mono text-[10px] font-black text-on-primary-fixed-variant"
                        }
                      >
                        {log.errorRate}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-outline-variant/10 bg-surface-container-low px-6 py-4">
            <span className="font-mono text-[0.625rem] font-bold text-outline">
              SHOWING LAST {telemetryLogs.length} LOG ENTRIES
            </span>
            <button
              type="button"
              className="text-[0.6875rem] font-black uppercase tracking-wider text-primary transition-all hover:underline"
            >
              {exportLabel}
            </button>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 pt-4 lg:grid-cols-3">
        <div className="relative flex items-center justify-between overflow-hidden rounded-xl bg-primary-container p-8 text-on-primary-container lg:col-span-2">
          <div className="relative z-10">
            <h3 className="mb-2 text-xl font-black uppercase">{quotaWarningTitle}</h3>
            <p className="max-w-md text-sm opacity-90">{quotaWarningDescription}</p>
          </div>
          <button
            type="button"
            className="relative z-10 rounded-lg bg-on-primary-container px-6 py-3 text-sm font-bold text-primary transition-transform hover:scale-105"
          >
            Auto-Adjust Rules
          </button>
          <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-surface-container-lowest/20 blur-3xl" />
        </div>

        <div className="flex flex-col justify-center gap-4 rounded-xl border border-outline-variant/15 bg-surface-container-low p-8">
          <div className="flex items-center gap-4">
            <div className="rounded-lg bg-secondary/10 p-3">
              <span className="text-secondary">◫</span>
            </div>
            <div>
              <div className="text-[0.625rem] font-black uppercase text-outline">
                {activeProxiesLabel}
              </div>
              <div className="font-mono text-xl font-bold text-on-surface">{activeProxiesValue}</div>
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
            <div
              className="h-full bg-secondary"
              style={{ width: `${Math.max(0, Math.min(100, activeProxiesPercent))}%` }}
            />
          </div>
        </div>
      </section>
    </main>
  );
};

export default UsageStats;