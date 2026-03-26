import React from "react";

interface MetricCard {
  readonly label: string;
  readonly value: string;
  readonly sublabel: string;
  readonly trendLabel: string;
  readonly trendIcon: string;
  readonly trendTone: "primary" | "tertiary";
  readonly progressClassName: string;
}

interface TelemetryRow {
  readonly timestamp: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly requests: string;
  readonly errorRate: string;
  readonly errorTone: "primary" | "tertiary" | "secondary";
  readonly highlighted?: boolean;
}

export interface UsageStatProps {
  readonly appName?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly metrics?: readonly MetricCard[];
  readonly telemetryRows?: readonly TelemetryRow[];
  readonly activeGranularity?: "Hourly" | "Daily";
  readonly activeRange?: "24H" | "72H" | "7D" | "Custom Range";
  readonly searchPlaceholder?: string;
  readonly userImageUrl?: string;
}

const defaultMetrics: readonly MetricCard[] = [
  {
    label: "Input Tokens",
    value: "42.8M",
    sublabel: "Avg 1.2M / Hr",
    trendLabel: "+12.5%",
    trendIcon: "trending_up",
    trendTone: "primary",
    progressClassName: "w-3/4 bg-primary",
  },
  {
    label: "Output Tokens",
    value: "156.4M",
    sublabel: "Avg 4.8M / Hr",
    trendLabel: "+8.2%",
    trendIcon: "trending_up",
    trendTone: "primary",
    progressClassName: "w-2/3 bg-primary",
  },
  {
    label: "Total Requests",
    value: "892,401",
    sublabel: "Peak 24.2k / Hr",
    trendLabel: "-2.4%",
    trendIcon: "trending_down",
    trendTone: "tertiary",
    progressClassName: "w-[82%] bg-tertiary",
  },
  {
    label: "Active Accounts",
    value: "1,204",
    sublabel: "Capacity 80.3%",
    trendLabel: "+14",
    trendIcon: "group_add",
    trendTone: "primary",
    progressClassName: "w-4/5 bg-primary",
  },
];

const defaultTelemetryRows: readonly TelemetryRow[] = [
  {
    timestamp: "2024-05-24 14:00",
    inputTokens: "1,421,082",
    outputTokens: "5,112,044",
    requests: "2,104",
    errorRate: "0.02%",
    errorTone: "primary",
  },
  {
    timestamp: "2024-05-24 13:00",
    inputTokens: "1,388,401",
    outputTokens: "4,902,110",
    requests: "1,988",
    errorRate: "0.05%",
    errorTone: "primary",
    highlighted: true,
  },
  {
    timestamp: "2024-05-24 12:00",
    inputTokens: "2,104,882",
    outputTokens: "8,442,001",
    requests: "4,552",
    errorRate: "1.42%",
    errorTone: "tertiary",
  },
  {
    timestamp: "2024-05-24 11:00",
    inputTokens: "902,441",
    outputTokens: "3,221,440",
    requests: "1,202",
    errorRate: "0.01%",
    errorTone: "primary",
  },
  {
    timestamp: "2024-05-24 10:00",
    inputTokens: "1,105,221",
    outputTokens: "4,002,119",
    requests: "1,877",
    errorRate: "0.12%",
    errorTone: "secondary",
  },
];

const navItems = ["Dashboard", "Accounts", "Proxies", "Stats"] as const;
const rangeOptions = ["24H", "72H", "7D"] as const;
const chartLabels = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "23:59"] as const;

const UsageStat: React.FC<UsageStatProps> = ({
  appName = "Codex Proxy",
  title = "Usage Statistics",
  subtitle = "Infrastructure v2.4 • Live data stream",
  metrics = defaultMetrics,
  telemetryRows = defaultTelemetryRows,
  activeGranularity = "Hourly",
  activeRange = "72H",
  searchPlaceholder = "Search resources...",
  userImageUrl = "https://lh3.googleusercontent.com/aida-public/AB6AXuAzvsBHZJyPIn-FPno9LZDnf1Y5IYkLdg3DkLVsibdahJlbW9Fvq-V5aIRDYnvPGHy2xRtLBcMICTCsUP4rQbYIWYMOB-LYl629uqNgvt6PFk65iCIOstPD1_p1uv8Xli_ptH1D8MMfl8jS8295G2G0cYc3ULtOjxD65mU4qq9vNzDNN2dyBKtO6pVpZ1fI1W8XESQbmpmjp33M4W7ISi9q0RQXTA5tsdgTIa0K-FVV3mhny80ZifHuMcYFukHLNIGZs78VHnELFtXW",
}) => {
  const getTrendClasses = (tone: MetricCard["trendTone"]) =>
    tone === "tertiary"
      ? "text-tertiary bg-tertiary/5"
      : "text-primary bg-primary/5";

  const getErrorClasses = (tone: TelemetryRow["errorTone"]) => {
    if (tone === "tertiary") {
      return "bg-tertiary/10 text-tertiary";
    }

    if (tone === "secondary") {
      return "bg-secondary-container/30 text-secondary";
    }

    return "bg-primary/10 text-primary";
  };

  const getErrorDotClasses = (tone: TelemetryRow["errorTone"]) => {
    if (tone === "tertiary") {
      return "bg-tertiary";
    }

    if (tone === "secondary") {
      return "bg-secondary";
    }

    return "bg-primary";
  };

  return (
    <div className="min-h-screen bg-background font-body text-on-surface antialiased selection:bg-primary/20">
      <nav className="fixed top-0 z-50 flex h-16 w-full items-center justify-between bg-surface-container-lowest/80 px-6 backdrop-blur-xl">
        <div className="flex items-center gap-8">
          <span className="text-xl font-bold tracking-tighter text-primary">
            {appName}
          </span>
          <div className="hidden h-full items-center gap-6 md:flex">
            {navItems.map((item) => {
              const isActive = item === "Stats";

              return (
                <a
                  key={item}
                  href="#"
                  className={
                    isActive
                      ? "flex h-16 items-center border-b-2 border-primary px-3 py-2 text-sm font-semibold tracking-tight text-primary"
                      : "rounded-lg px-3 py-2 text-sm tracking-tight text-on-surface-variant transition-colors hover:bg-surface-container-low"
                  }
                >
                  {item}
                </a>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative hidden sm:block">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-sm text-outline">
              search
            </span>
            <input
              type="text"
              placeholder={searchPlaceholder}
              className="w-64 rounded-full border-none bg-surface-container-low py-1.5 pl-10 pr-4 text-sm focus:ring-2 focus:ring-primary/20"
            />
          </div>

          <button className="relative rounded-full p-2 transition-colors hover:bg-surface-container-low">
            <span className="material-symbols-outlined text-on-surface-variant">
              notifications
            </span>
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 border-surface-container-lowest bg-primary" />
          </button>

          <div className="h-8 w-8 overflow-hidden rounded-full border border-outline-variant bg-surface-container-high">
            <img
              src={userImageUrl}
              alt="User profile"
              className="h-full w-full object-cover"
            />
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-7xl px-6 pb-20 pt-24">
        <header className="mb-10">
          <h1 className="mb-2 text-3xl font-black tracking-tight text-on-surface">
            {title}
          </h1>
          <p className="flex items-center gap-2 font-medium text-on-surface-variant">
            <span className="h-2 w-2 rounded-full bg-primary shadow-lg shadow-primary/30" />
            {subtitle}
          </p>
        </header>

        <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="rounded-2xl bg-surface-container-lowest p-6 transition-all duration-300 hover:bg-surface-bright"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <span className="text-xs font-bold uppercase tracking-widest text-outline">
                  {metric.label}
                </span>
                <span
                  className={`flex items-center gap-1 rounded-full px-2 py-1 text-xs font-bold ${getTrendClasses(
                    metric.trendTone,
                  )}`}
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {metric.trendIcon}
                  </span>
                  {metric.trendLabel}
                </span>
              </div>

              <div className="flex flex-col">
                <span className="text-3xl font-black tracking-tight">
                  {metric.value}
                </span>
                <span className="mt-1 font-mono text-[10px] uppercase tracking-tighter text-outline">
                  {metric.sublabel}
                </span>
              </div>

              <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-surface-container-low">
                <div className={`h-full ${metric.progressClassName}`} />
              </div>
            </div>
          ))}
        </div>

        <div className="mb-8 flex flex-col items-center justify-between gap-4 rounded-2xl border border-surface-container-high bg-surface-container-low p-2 sm:flex-row">
          <div className="flex w-full gap-1 rounded-xl bg-surface-container-lowest/70 p-1 sm:w-auto">
            {(["Hourly", "Daily"] as const).map((option) => {
              const isActive = activeGranularity === option;

              return (
                <button
                  key={option}
                  className={
                    isActive
                      ? "flex-1 rounded-lg bg-surface-container-lowest px-6 py-2 text-xs font-bold uppercase tracking-widest text-primary shadow-sm sm:flex-none"
                      : "flex-1 rounded-lg px-6 py-2 text-xs font-bold uppercase tracking-widest text-outline transition-all hover:bg-surface-container-lowest/60 sm:flex-none"
                  }
                >
                  {option}
                </button>
              );
            })}
          </div>

          <div className="flex w-full gap-2 overflow-x-auto pb-1 sm:w-auto sm:pb-0">
            {rangeOptions.map((option) => {
              const isActive = activeRange === option;

              return (
                <button
                  key={option}
                  className={
                    isActive
                      ? "whitespace-nowrap rounded-xl bg-primary/5 px-4 py-2 text-xs font-bold text-primary ring-1 ring-primary/20"
                      : "whitespace-nowrap rounded-xl px-4 py-2 text-xs font-bold text-outline transition-all hover:text-primary"
                  }
                >
                  {option}
                </button>
              );
            })}

            <div className="mx-1 h-8 w-px bg-outline-variant" />

            <button
              className={
                activeRange === "Custom Range"
                  ? "flex items-center gap-2 whitespace-nowrap rounded-xl border border-primary/20 bg-primary/5 px-4 py-2 text-xs font-bold text-primary"
                  : "flex items-center gap-2 whitespace-nowrap rounded-xl border border-outline-variant px-4 py-2 text-xs font-bold text-outline hover:bg-surface-bright"
              }
            >
              <span className="material-symbols-outlined text-sm">
                calendar_month
              </span>
              Custom Range
            </button>
          </div>
        </div>

        <section className="group relative mb-10 overflow-hidden rounded-2xl bg-surface-container-lowest p-8">
          <div className="mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h3 className="text-lg font-bold tracking-tight text-on-surface">
                Throughput &amp; Token Consumption
              </h3>
              <p className="text-xs font-medium text-on-surface-variant">
                Dual-axis telemetry visualization
              </p>
            </div>

            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-blue-500" />
                <span className="font-mono text-[10px] font-bold uppercase text-outline">
                  Input
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-primary" />
                <span className="font-mono text-[10px] font-bold uppercase text-outline">
                  Output
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-amber-500" />
                <span className="font-mono text-[10px] font-bold uppercase text-outline">
                  Requests
                </span>
              </div>
            </div>
          </div>

          <div className="relative mb-6 h-80 w-full">
            <svg className="h-full w-full" viewBox="0 0 1000 300" preserveAspectRatio="none">
              <line x1="0" y1="0" x2="1000" y2="0" stroke="currentColor" strokeWidth="1" className="text-outline-variant/10" />
              <line x1="0" y1="75" x2="1000" y2="75" stroke="currentColor" strokeWidth="1" className="text-outline-variant/10" />
              <line x1="0" y1="150" x2="1000" y2="150" stroke="currentColor" strokeWidth="1" className="text-outline-variant/10" />
              <line x1="0" y1="225" x2="1000" y2="225" stroke="currentColor" strokeWidth="1" className="text-outline-variant/10" />
              <line x1="0" y1="300" x2="1000" y2="300" stroke="currentColor" strokeWidth="1" className="text-outline-variant/20" />

              <path
                d="M0 280 Q 100 220 200 240 T 400 180 T 600 220 T 800 140 T 1000 160 V 300 H 0 Z"
                className="fill-blue-500/10"
              />
              <path
                d="M0 280 Q 100 220 200 240 T 400 180 T 600 220 T 800 140 T 1000 160"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="3"
                className="text-blue-500"
              />

              <path
                d="M0 260 Q 100 180 200 200 T 400 120 T 600 160 T 800 80 T 1000 100 V 300 H 0 Z"
                className="fill-primary/10"
              />
              <path
                d="M0 260 Q 100 180 200 200 T 400 120 T 600 160 T 800 80 T 1000 100"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="3"
                className="text-primary"
              />

              <path
                d="M0 150 L 100 130 L 200 180 L 300 140 L 400 110 L 500 160 L 600 130 L 700 90 L 800 120 L 900 70 L 1000 85"
                fill="none"
                stroke="currentColor"
                strokeDasharray="8 4"
                strokeWidth="2"
                className="text-amber-500"
              />

              <line
                x1="680"
                y1="0"
                x2="680"
                y2="300"
                stroke="currentColor"
                strokeDasharray="4"
                strokeWidth="1.5"
                className="text-primary opacity-0 transition-opacity group-hover:opacity-100"
              />
              <circle
                cx="680"
                cy="98"
                r="6"
                strokeWidth="2"
                className="fill-primary stroke-surface-container-lowest opacity-0 transition-opacity group-hover:opacity-100"
              />
            </svg>

            <div className="absolute left-[70%] top-[15%] -translate-x-1/2 rounded-xl border border-surface-container-high bg-surface-container-lowest/80 p-4 opacity-0 shadow-2xl backdrop-blur-xl transition-all duration-300 group-hover:opacity-100">
              <div className="mb-2 font-mono text-[10px] font-bold uppercase text-outline">
                May 24, 14:00
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-6">
                  <span className="flex items-center gap-2 text-xs font-bold">
                    <span className="h-2 w-2 rounded-full bg-blue-500" />
                    Input
                  </span>
                  <span className="font-mono text-xs font-bold">1.42M</span>
                </div>
                <div className="flex items-center justify-between gap-6">
                  <span className="flex items-center gap-2 text-xs font-bold">
                    <span className="h-2 w-2 rounded-full bg-primary" />
                    Output
                  </span>
                  <span className="font-mono text-xs font-bold">5.11M</span>
                </div>
                <div className="flex items-center justify-between gap-6">
                  <span className="flex items-center gap-2 text-xs font-bold">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    Requests
                  </span>
                  <span className="font-mono text-xs font-bold">2,104</span>
                </div>
              </div>
            </div>

            <div className="absolute -left-12 top-0 flex h-full flex-col justify-between py-1 font-mono text-[10px] font-bold text-outline">
              <span>10M</span>
              <span>7.5M</span>
              <span>5M</span>
              <span>2.5M</span>
              <span>0</span>
            </div>

            <div className="absolute -right-12 top-0 flex h-full flex-col justify-between py-1 font-mono text-[10px] font-bold text-amber-500">
              <span>5K</span>
              <span>4K</span>
              <span>3K</span>
              <span>2K</span>
              <span>0</span>
            </div>
          </div>

          <div className="mt-4 flex w-full justify-between px-4 font-mono text-[10px] font-bold uppercase tracking-widest text-outline">
            {chartLabels.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-surface-container-high bg-surface-container-lowest shadow-sm">
          <div className="flex items-center justify-between border-b border-surface-container-low bg-surface-container-lowest/60 p-6">
            <h3 className="font-bold tracking-tight">Granular Telemetry Log</h3>
            <button className="flex items-center gap-1 text-xs font-black uppercase tracking-widest text-primary hover:underline">
              <span className="material-symbols-outlined text-sm">download</span>
              Export CSV
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-surface-container-low/30">
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                    Timestamp
                  </th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                    Input Tokens
                  </th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                    Output Tokens
                  </th>
                  <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                    Requests
                  </th>
                  <th className="px-6 py-4 text-right text-[10px] font-bold uppercase tracking-widest text-outline">
                    Error Rate
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-container-low">
                {telemetryRows.map((row) => (
                  <tr
                    key={row.timestamp}
                    className={`transition-colors hover:bg-surface-bright ${
                      row.highlighted ? "bg-surface-container-low/10" : ""
                    }`}
                  >
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs font-medium">
                        {row.timestamp}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs text-on-surface">
                        {row.inputTokens}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs text-on-surface">
                        {row.outputTokens}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs text-on-surface">
                        {row.requests}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase ${getErrorClasses(
                          row.errorTone,
                        )}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${getErrorDotClasses(
                            row.errorTone,
                          )} ${row.errorTone === "primary" ? "animate-pulse" : ""}`}
                        />
                        {row.errorRate}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between bg-surface-container-low/50 px-6 py-4">
            <span className="font-mono text-[10px] font-bold uppercase text-outline">
              Showing 1-24 of 1,440 entries
            </span>
            <div className="flex gap-2">
              <button className="rounded-lg border border-outline-variant p-1.5 transition-all hover:bg-surface-container-lowest">
                <span className="material-symbols-outlined text-sm">
                  chevron_left
                </span>
              </button>
              <button className="rounded-lg border border-outline-variant p-1.5 transition-all hover:bg-surface-container-lowest">
                <span className="material-symbols-outlined text-sm">
                  chevron_right
                </span>
              </button>
            </div>
          </div>
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 z-50 flex h-14 items-center justify-end gap-6 border-t border-surface-container-high bg-surface-container-lowest px-8">
        <button className="group flex items-center gap-2 text-outline transition-all duration-100 hover:text-primary active:scale-95">
          <span className="material-symbols-outlined text-xl">
            rocket_launch
          </span>
          <span className="font-mono text-[10px] uppercase tracking-tight">
            Deploy
          </span>
        </button>
        <button className="group flex items-center gap-2 text-outline transition-all duration-100 hover:text-primary active:scale-95">
          <span className="material-symbols-outlined text-xl">refresh</span>
          <span className="font-mono text-[10px] uppercase tracking-tight">
            Restart
          </span>
        </button>
        <button className="flex items-center gap-2 font-bold text-primary transition-all duration-100 active:scale-95">
          <span className="material-symbols-outlined text-xl">
            file_download
          </span>
          <span className="font-mono text-[10px] uppercase tracking-tight">
            Export
          </span>
        </button>
      </div>
    </div>
  );
};

export default UsageStat;