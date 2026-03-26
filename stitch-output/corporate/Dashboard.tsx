import React from "react";

interface AccountCard {
  readonly email: string;
  readonly environment: string;
  readonly status: "ACTIVE" | "RATE_LIMITED" | "DISABLED";
  readonly quotaUsedGb: number;
  readonly quotaTotalGb: number;
  readonly totalRequests: number;
  readonly proxyLabel: string;
  readonly enabled: boolean;
}

interface ProxyEndpoint {
  readonly status: "Healthy" | "Failing";
  readonly endpoint: string;
  readonly latency: string;
  readonly uptime: string;
}

interface EnvVar {
  readonly key: string;
  readonly value: string;
}

interface DiagnosticItem {
  readonly label: string;
  readonly result: "PASS" | "FAIL" | "SKIP";
}

export interface DashboardProps {
  readonly title?: string;
  readonly relayPlaceholder?: string;
  readonly relayCode?: string;
  readonly accounts?: readonly AccountCard[];
  readonly proxies?: readonly ProxyEndpoint[];
  readonly modelFamily?: string;
  readonly baseUrl?: string;
  readonly masterApiKey?: string;
  readonly envVars?: readonly EnvVar[];
  readonly codeSnippet?: string;
  readonly appVersion?: string;
  readonly alertThreshold?: number;
  readonly selectedRotation?: "least_used" | "round_robin" | "sticky";
  readonly diagnostics?: readonly DiagnosticItem[];
}

const defaultAccounts: readonly AccountCard[] = [
  {
    email: "admin@codex-proxy.io",
    environment: "Primary Infrastructure",
    status: "ACTIVE",
    quotaUsedGb: 4.2,
    quotaTotalGb: 10,
    totalRequests: 1204582,
    proxyLabel: "us-east-cluster-01",
    enabled: true,
  },
  {
    email: "dev-ops@codex-proxy.io",
    environment: "Staging Environment",
    status: "RATE_LIMITED",
    quotaUsedGb: 9.8,
    quotaTotalGb: 10,
    totalRequests: 4892110,
    proxyLabel: "eu-central-fallback",
    enabled: false,
  },
];

const defaultProxies: readonly ProxyEndpoint[] = [
  {
    status: "Healthy",
    endpoint: "192.168.1.45:8080",
    latency: "42ms",
    uptime: "99.9%",
  },
  {
    status: "Healthy",
    endpoint: "45.23.11.102:443",
    latency: "112ms",
    uptime: "98.4%",
  },
  {
    status: "Failing",
    endpoint: "104.1.22.8:80",
    latency: "Timed Out",
    uptime: "12.0%",
  },
];

const defaultEnvVars: readonly EnvVar[] = [
  { key: "ANTHROPIC_API_KEY", value: "sk-codex-***" },
  { key: "ANTHROPIC_BASE_URL", value: "https://api.codex-proxy.io" },
  { key: "CODEX_LOG_LEVEL", value: "debug" },
  { key: "CODEX_TIMEOUT_MS", value: "30000" },
  { key: "CODEX_RETRY_COUNT", value: "3" },
  { key: "CODEX_STRICT_HEADERS", value: "true" },
];

const defaultDiagnostics: readonly DiagnosticItem[] = [
  { label: "Local Proxy Binding (Port 8080)", result: "PASS" },
  { label: "Upstream DNS Resolution", result: "PASS" },
  { label: "Legacy Auth Handshake (OAuth 1.0)", result: "FAIL" },
  { label: "SSL Verification (Global Pool)", result: "SKIP" },
];

const defaultSnippet = `import anthropic

client = anthropic.Anthropic(
    api_key="sk-codex-master-key",
    base_url="https://api.codex-proxy.io"
)

message = client.messages.create(
    model="claude-3-5-sonnet-20240620",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello, Codex!"}]
)`;

const Dashboard: React.FC<DashboardProps> = ({
  title = "Codex Proxy | Precision Infrastructure",
  relayPlaceholder = "Enter Relay Code...",
  relayCode = "",
  accounts = defaultAccounts,
  proxies = defaultProxies,
  modelFamily = "Claude 3.5 Sonnet",
  baseUrl = "https://api.codex-proxy.io/v1",
  masterApiKey = "sk-codex-9921-3942-8812-xk2",
  envVars = defaultEnvVars,
  codeSnippet = defaultSnippet,
  appVersion = "Codex Proxy Laboratory v2.4.1",
  alertThreshold = 85,
  selectedRotation = "least_used",
  diagnostics = defaultDiagnostics,
}) => {
  const formatNumber = (value: number): string => value.toLocaleString();

  const getQuotaWidth = (used: number, total: number): string => {
    const percent = Math.max(0, Math.min(100, (used / total) * 100));
    return `${percent}%`;
  };

  const getAccountStatusBadge = (status: AccountCard["status"]) => {
    if (status === "ACTIVE") {
      return "bg-primary-fixed text-on-primary-fixed-variant";
    }
    if (status === "RATE_LIMITED") {
      return "bg-amber-100 text-amber-800";
    }
    return "bg-surface-container-high text-on-surface";
  };

  const getQuotaBarClass = (status: AccountCard["status"]) => {
    if (status === "RATE_LIMITED") return "bg-amber-500";
    if (status === "DISABLED") return "bg-outline";
    return "bg-primary";
  };

  const getProxyRowClass = (status: ProxyEndpoint["status"]) =>
    status === "Failing"
      ? "bg-surface-container"
      : "hover:bg-surface-container-lowest/50";

  const getProxyDotClass = (status: ProxyEndpoint["status"]) =>
    status === "Failing" ? "bg-error" : "bg-primary";

  const getDiagnosticIcon = (result: DiagnosticItem["result"]) => {
    if (result === "PASS") {
      return {
        icon: "check_circle",
        iconClass: "text-primary",
        textClass: "text-primary",
        rowClass: "bg-surface-container-low",
      };
    }
    if (result === "FAIL") {
      return {
        icon: "cancel",
        iconClass: "text-error",
        textClass: "text-error",
        rowClass: "bg-surface-container-low",
      };
    }
    return {
      icon: "fast_forward",
      iconClass: "text-outline",
      textClass: "text-outline",
      rowClass: "bg-surface-container-low opacity-50",
    };
  };

  return (
    <div className="min-h-screen bg-background font-body text-on-background">
      <main className="mx-auto max-w-7xl space-y-10 px-6 py-12">
        <section className="flex flex-col items-center justify-between gap-6 md:flex-row">
          <div className="sr-only">{title}</div>

          <button className="flex items-center gap-3 rounded-xl border border-outline/15 bg-surface-container-lowest px-6 py-3 transition-all duration-200 hover:bg-surface-container-low">
            <img
              alt="Google Logo"
              className="h-6 w-6"
              src="https://lh3.googleusercontent.com/aida-public/AB6AXuBeDYaf-rsJS0RY7Gc0vwaEk2Zbj_Pym-f8Fcl70E7KlMowp9hllOCfxa63bambooaTPvZ609HI_JuvXuaR3W4ap_4CGVtYX8kdKsrhgtH3hysZbb3GO-d19dXfQ4ZIh_iCeg_OcLNSVTUNxi-ey3sI0dj6KR9pTGdfyw4IZOWpz3XA7Zgc2gxya9_Y4NoHJ2ZJ25TvfJqRUzS9Qd_3eqCIb9WCv6acr_nXTn5JrO2Q90SY3gXSIDvKrAYYfsh1DpxcajUDf9vYGJzV"
            />
            <span className="font-semibold text-on-surface">
              Login with Google OAuth
            </span>
          </button>

          <div className="flex w-full items-center gap-3 md:w-auto">
            <div className="relative flex-grow md:w-80">
              <input
                className="w-full rounded-xl border border-outline/15 bg-surface-container-lowest px-4 py-3 pr-12 font-mono text-sm transition-all focus:ring-2 focus:ring-secondary"
                defaultValue={relayCode}
                placeholder={relayPlaceholder}
                type="text"
              />
              <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 text-outline">
                vpn_key
              </span>
            </div>
            <button className="rounded-xl bg-primary px-6 py-3 font-bold text-on-primary shadow-sm transition-all hover:opacity-90">
              Connect
            </button>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {accounts.map((account) => (
            <div
              key={account.email}
              className="group relative rounded-xl bg-surface-container-lowest p-6 shadow-sm transition-all hover:scale-[1.01]"
            >
              <div className="mb-6 flex items-start justify-between">
                <div>
                  <h3 className="font-headline text-lg font-bold text-on-surface">
                    {account.email}
                  </h3>
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-outline">
                    {account.environment}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full px-3 py-1 font-mono text-[11px] font-bold ${getAccountStatusBadge(
                      account.status,
                    )}`}
                  >
                    {account.status}
                  </span>
                  <div
                    className={`relative h-5 w-10 rounded-full ${
                      account.enabled
                        ? "bg-primary-container/20"
                        : "bg-surface-container-high"
                    }`}
                  >
                    <div
                      className={`absolute top-1 h-3 w-3 rounded-full ${
                        account.enabled
                          ? "right-1 bg-primary"
                          : "left-1 bg-outline"
                      }`}
                    />
                  </div>
                </div>
              </div>

              <div className={account.status === "RATE_LIMITED" ? "space-y-4 opacity-75" : "space-y-4"}>
                <div>
                  <div className="mb-2 flex justify-between font-mono text-xs">
                    <span className="text-outline">QUOTA USAGE</span>
                    <span className="text-on-surface">
                      {account.quotaUsedGb}GB / {account.quotaTotalGb}GB
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-low">
                    <div
                      className={`h-full ${getQuotaBarClass(account.status)}`}
                      style={{ width: getQuotaWidth(account.quotaUsedGb, account.quotaTotalGb) }}
                    />
                  </div>
                </div>

                <div className="flex items-end justify-between">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-tighter text-outline">
                      Total Requests
                    </p>
                    <p className="font-mono text-xl font-medium">
                      {formatNumber(account.totalRequests)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-bold uppercase tracking-tighter text-outline">
                      Proxy Label
                    </p>
                    <span className="rounded bg-surface-container-high px-2 py-1 font-mono text-xs">
                      {account.proxyLabel}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-6">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="font-headline text-3xl font-black tracking-tighter text-on-surface">
                Proxy Pool
              </h2>
              <p className="text-sm text-outline">
                Real-time infrastructure health and management.
              </p>
            </div>
            <button className="flex items-center gap-2 rounded-xl bg-secondary px-5 py-2.5 text-sm font-semibold text-on-secondary">
              <span className="material-symbols-outlined text-sm">speed</span>
              Health Check
            </button>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="overflow-hidden rounded-xl bg-surface-container-low lg:col-span-2">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-surface-container-high text-[11px] font-bold uppercase tracking-widest text-outline">
                    <tr>
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4">Endpoint</th>
                      <th className="px-6 py-4">Latency</th>
                      <th className="px-6 py-4">Uptime</th>
                      <th className="px-6 py-4">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-container">
                    {proxies.map((proxy) => (
                      <tr
                        key={proxy.endpoint}
                        className={`transition-colors ${getProxyRowClass(proxy.status)}`}
                      >
                        <td className="px-6 py-4">
                          <span
                            className={`mr-2 inline-block h-2 w-2 rounded-full ${getProxyDotClass(
                              proxy.status,
                            )}`}
                          />
                          {proxy.status}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs">
                          {proxy.endpoint}
                        </td>
                        <td
                          className={`px-6 py-4 font-mono text-xs ${
                            proxy.status === "Failing" ? "text-error" : ""
                          }`}
                        >
                          {proxy.latency}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs">
                          {proxy.uptime}
                        </td>
                        <td className="px-6 py-4">
                          <span className="material-symbols-outlined cursor-pointer text-outline hover:text-error">
                            delete
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border border-outline/15 bg-surface-container-lowest p-6">
              <div className="space-y-4">
                <h4 className="font-headline font-bold text-on-surface">
                  Add New Proxy
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
                      Host/IP Address
                    </label>
                    <input
                      className="w-full rounded-lg bg-surface-container-low px-3 py-2 font-mono text-sm focus:ring-1 focus:ring-primary"
                      placeholder="127.0.0.1"
                      type="text"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
                      Port
                    </label>
                    <input
                      className="w-full rounded-lg bg-surface-container-low px-3 py-2 font-mono text-sm focus:ring-1 focus:ring-primary"
                      placeholder="8080"
                      type="text"
                    />
                  </div>
                </div>
              </div>
              <button className="mt-6 w-full rounded-lg bg-primary-container py-3 font-bold text-on-primary-container transition-colors hover:bg-primary">
                Append to Pool
              </button>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-10 lg:grid-cols-2">
          <div className="space-y-6">
            <h2 className="font-headline text-3xl font-black tracking-tighter text-on-surface">
              API Config
            </h2>
            <div className="space-y-5 rounded-2xl bg-surface-container-low p-6">
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-outline">
                  Model Family
                </label>
                <select
                  className="w-full rounded-xl border border-outline/15 bg-surface-container-lowest px-4 py-3 text-sm focus:ring-primary"
                  defaultValue={modelFamily}
                >
                  <optgroup label="Anthropic">
                    <option>Claude 3.5 Sonnet</option>
                    <option>Claude 3 Opus</option>
                  </optgroup>
                  <optgroup label="OpenAI">
                    <option>GPT-4o</option>
                    <option>GPT-4 Turbo</option>
                  </optgroup>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-outline">
                  Base URL
                </label>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-grow rounded-xl border border-outline/15 bg-surface-container-lowest px-4 py-3 font-mono text-xs text-secondary"
                    readOnly
                    type="text"
                    value={baseUrl}
                  />
                  <button className="rounded-xl bg-surface-container-high p-3 transition-colors hover:bg-surface-container-highest">
                    <span className="material-symbols-outlined text-sm">
                      content_copy
                    </span>
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-outline">
                  Master API Key
                </label>
                <div className="flex items-center gap-2">
                  <input
                    className="flex-grow rounded-xl border border-outline/15 bg-surface-container-lowest px-4 py-3 font-mono text-xs"
                    readOnly
                    type="password"
                    value={masterApiKey}
                  />
                  <button className="rounded-xl bg-surface-container-high p-3 transition-colors hover:bg-surface-container-highest">
                    <span className="material-symbols-outlined text-sm">
                      content_copy
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="font-headline text-3xl font-black tracking-tighter text-on-surface">
              SDK Environment
            </h2>
            <div className="rounded-2xl border border-dashed border-outline-variant bg-surface-container-highest/30 p-6">
              <div className="mb-6 space-y-3">
                {envVars.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center justify-between rounded-lg border border-outline/15 bg-surface-container-lowest p-3"
                  >
                    <span className="font-mono text-xs text-on-surface">
                      {item.key}={item.value}
                    </span>
                    <span className="material-symbols-outlined cursor-pointer text-xs text-outline">
                      content_copy
                    </span>
                  </div>
                ))}
              </div>
              <button className="w-full rounded-xl bg-on-background py-2.5 text-sm font-bold text-background hover:opacity-90">
                Copy All Env Vars
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-6">
          <h2 className="text-center font-headline text-3xl font-black tracking-tighter text-on-surface">
            Implementation Snippets
          </h2>
          <div className="overflow-hidden rounded-3xl bg-surface-container-low shadow-sm">
            <div className="flex gap-2 bg-surface-container px-6 pt-4">
              <button className="rounded-t-xl bg-surface-container-lowest px-6 py-3 text-xs font-bold uppercase tracking-widest text-primary">
                Anthropic
              </button>
              <button className="rounded-t-xl px-6 py-3 text-xs font-bold uppercase tracking-widest text-outline hover:text-on-surface">
                OpenAI
              </button>
              <button className="rounded-t-xl px-6 py-3 text-xs font-bold uppercase tracking-widest text-outline hover:text-on-surface">
                Gemini
              </button>
            </div>

            <div className="p-8">
              <div className="mb-6 flex gap-4">
                <button className="border-b-2 border-primary pb-1 font-mono text-xs font-bold">
                  Python
                </button>
                <button className="pb-1 font-mono text-xs font-bold text-outline hover:text-on-surface">
                  Node.js
                </button>
                <button className="pb-1 font-mono text-xs font-bold text-outline hover:text-on-surface">
                  cURL
                </button>
              </div>

              <div className="group relative rounded-2xl bg-on-surface p-6 font-mono text-sm leading-relaxed text-surface-container-lowest">
                <button className="absolute right-4 top-4 rounded-lg bg-surface-container-highest/20 p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <span className="material-symbols-outlined text-sm">
                    content_copy
                  </span>
                </button>
                <pre className="whitespace-pre-wrap">
                  <code>{codeSnippet}</code>
                </pre>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="mb-6 font-headline text-2xl font-black tracking-tight text-on-surface">
            System Settings
          </h2>

          <details
            className="group overflow-hidden rounded-2xl border border-outline/15 bg-surface-container-lowest"
            open
          >
            <summary className="flex cursor-pointer list-none items-center justify-between p-6 transition-colors hover:bg-surface-container-low">
              <div className="flex items-center gap-4">
                <span className="material-symbols-outlined text-primary">
                  settings
                </span>
                <h3 className="font-bold text-on-surface">
                  General Configuration
                </h3>
              </div>
              <span className="material-symbols-outlined transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="grid grid-cols-1 gap-6 border-t border-surface-container-low px-6 pb-8 pt-4 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-outline">
                  Proxy Port
                </label>
                <input
                  className="w-full rounded-lg bg-surface-container-low font-mono text-sm"
                  type="text"
                  value="8080"
                  readOnly
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-widest text-outline">
                  Inference Level
                </label>
                <select className="w-full rounded-lg bg-surface-container-low text-sm" defaultValue="Optimized (Default)">
                  <option>Optimized (Default)</option>
                  <option>Strict Raw</option>
                  <option>Maximum Performance</option>
                </select>
              </div>
              <div className="mt-4 flex h-[42px] items-center justify-between rounded-lg bg-surface-container-low px-4">
                <span className="text-xs font-bold text-on-surface">
                  HTTP/1.1 Legacy
                </span>
                <div className="relative h-4 w-8 rounded-full bg-outline/20">
                  <div className="absolute left-1 top-1 h-2 w-2 rounded-full bg-outline" />
                </div>
              </div>
            </div>
          </details>

          <details className="group overflow-hidden rounded-2xl border border-outline/15 bg-surface-container-lowest">
            <summary className="flex cursor-pointer list-none items-center justify-between p-6 transition-colors hover:bg-surface-container-low">
              <div className="flex items-center gap-4">
                <span className="material-symbols-outlined text-secondary">
                  donut_large
                </span>
                <h3 className="font-bold text-on-surface">
                  Quota &amp; Thresholds
                </h3>
              </div>
              <span className="material-symbols-outlined transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="space-y-6 border-t border-surface-container-low px-6 pb-8 pt-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-outline">
                    Alert Threshold
                  </label>
                  <span className="font-mono text-xs font-bold text-primary">
                    {alertThreshold}%
                  </span>
                </div>
                <input
                  className="h-1.5 w-full appearance-none rounded-full bg-surface-container-low accent-primary"
                  defaultValue={alertThreshold}
                  type="range"
                />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="flex items-center gap-3">
                  <input
                    className="rounded border-none bg-surface-container-low text-primary focus:ring-primary"
                    defaultChecked
                    type="checkbox"
                  />
                  <span className="text-sm font-medium">
                    Skip exhausted proxies
                  </span>
                </label>
                <label className="flex items-center gap-3">
                  <input
                    className="rounded border-none bg-surface-container-low text-primary focus:ring-primary"
                    type="checkbox"
                  />
                  <span className="text-sm font-medium">
                    Strict concurrency locking
                  </span>
                </label>
              </div>
            </div>
          </details>

          <details className="group overflow-hidden rounded-2xl border border-outline/15 bg-surface-container-lowest">
            <summary className="flex cursor-pointer list-none items-center justify-between p-6 transition-colors hover:bg-surface-container-low">
              <div className="flex items-center gap-4">
                <span className="material-symbols-outlined text-orange-600">
                  published_with_changes
                </span>
                <h3 className="font-bold text-on-surface">Rotation Policy</h3>
              </div>
              <span className="material-symbols-outlined transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="space-y-4 border-t border-surface-container-low px-6 pb-8 pt-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <label className="flex cursor-pointer flex-col gap-3 rounded-xl border-2 border-transparent bg-surface-container-low p-4 has-[:checked]:border-primary">
                  <input
                    className="hidden"
                    defaultChecked={selectedRotation === "least_used"}
                    name="rotation"
                    type="radio"
                    value="least_used"
                  />
                  <span className="text-xs font-bold">Least Used</span>
                  <p className="text-[10px] text-outline">
                    Prioritize proxies with the lowest total request count.
                  </p>
                </label>
                <label className="flex cursor-pointer flex-col gap-3 rounded-xl border-2 border-transparent bg-surface-container-low p-4 has-[:checked]:border-primary">
                  <input
                    className="hidden"
                    defaultChecked={selectedRotation === "round_robin"}
                    name="rotation"
                    type="radio"
                    value="round_robin"
                  />
                  <span className="text-xs font-bold">Round Robin</span>
                  <p className="text-[10px] text-outline">
                    Cycle through available proxies in sequential order.
                  </p>
                </label>
                <label className="flex cursor-pointer flex-col gap-3 rounded-xl border-2 border-transparent bg-surface-container-low p-4 has-[:checked]:border-primary">
                  <input
                    className="hidden"
                    defaultChecked={selectedRotation === "sticky"}
                    name="rotation"
                    type="radio"
                    value="sticky"
                  />
                  <span className="text-xs font-bold">Sticky Sessions</span>
                  <p className="text-[10px] text-outline">
                    Pin a user ID to a specific proxy endpoint for 1 hour.
                  </p>
                </label>
              </div>
            </div>
          </details>

          <details className="group overflow-hidden rounded-2xl border border-outline/15 bg-surface-container-lowest">
            <summary className="flex cursor-pointer list-none items-center justify-between p-6 transition-colors hover:bg-surface-container-low">
              <div className="flex items-center gap-4">
                <span className="material-symbols-outlined text-error">
                  security
                </span>
                <h3 className="font-bold text-on-surface">API Security</h3>
              </div>
              <span className="material-symbols-outlined transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="space-y-4 border-t border-surface-container-low px-6 pb-8 pt-4">
              <div className="max-w-md space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-outline">
                    Update Master API Key
                  </label>
                  <input
                    className="w-full rounded-xl bg-surface-container-low px-4 py-3 text-sm focus:ring-error"
                    placeholder="••••••••••••••••"
                    type="password"
                  />
                </div>
                <button className="rounded-xl bg-error px-6 py-2.5 text-sm font-bold text-on-error hover:opacity-90">
                  Save Key Changes
                </button>
              </div>
            </div>
          </details>

          <details className="group overflow-hidden rounded-2xl border border-outline/15 bg-surface-container-lowest">
            <summary className="flex cursor-pointer list-none items-center justify-between p-6 transition-colors hover:bg-surface-container-low">
              <div className="flex items-center gap-4">
                <span className="material-symbols-outlined text-cyan-600">
                  analytics
                </span>
                <h3 className="font-bold text-on-surface">
                  Connection Diagnostic
                </h3>
              </div>
              <span className="material-symbols-outlined transition-transform group-open:rotate-180">
                expand_more
              </span>
            </summary>
            <div className="space-y-6 border-t border-surface-container-low px-6 pb-8 pt-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-outline">
                  Verify infrastructure connectivity and upstream health.
                </p>
                <button className="rounded-xl bg-surface-container-high px-6 py-2 text-sm font-bold text-on-surface hover:bg-surface-container-highest">
                  Run Diagnostic
                </button>
              </div>

              <div className="space-y-3 font-mono text-xs">
                {diagnostics.map((item) => {
                  const styles = getDiagnosticIcon(item.result);
                  return (
                    <div
                      key={item.label}
                      className={`flex items-center gap-4 rounded-lg p-3 ${styles.rowClass}`}
                    >
                      <span
                        className={`material-symbols-outlined text-sm ${styles.iconClass}`}
                      >
                        {styles.icon}
                      </span>
                      <span className="text-outline">{item.label}</span>
                      <span className={`ml-auto ${styles.textClass}`}>
                        {item.result}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </details>
        </section>
      </main>

      <footer className="mx-auto max-w-7xl border-t border-surface-container px-6 py-12 text-center">
        <p className="font-headline text-[10px] font-bold uppercase tracking-[0.2em] text-outline">
          {appVersion}
        </p>
      </footer>
    </div>
  );
};

export default Dashboard;