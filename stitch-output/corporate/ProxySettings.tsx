import React from "react";

interface NavigationItem {
  readonly label: string;
  readonly icon: string;
  readonly count: string;
  readonly active?: boolean;
}

interface ProxyOption {
  readonly label: string;
  readonly value: string;
}

interface AccountRow {
  readonly email: string;
  readonly uuid: string;
  readonly status: "Active/Operational" | "Initializing" | "Faulted";
  readonly assignedProxy: string;
  readonly lastHeartbeat: string;
  readonly selected?: boolean;
}

interface UserProfile {
  readonly name: string;
  readonly role: string;
  readonly avatarUrl: string;
}

export interface ProxySettingsProps {
  readonly brandTitle?: string;
  readonly brandSubtitle?: string;
  readonly pageTitle?: string;
  readonly pageDescription?: string;
  readonly searchPlaceholder?: string;
  readonly selectedCount?: string;
  readonly navigationItems?: readonly NavigationItem[];
  readonly proxyOptions?: readonly ProxyOption[];
  readonly accounts?: readonly AccountRow[];
  readonly userProfile?: UserProfile;
  readonly infoMessage?: string;
  readonly bulkAllocationLabel?: string;
  readonly bulkTargetPlaceholder?: string;
  readonly applyButtonLabel?: string;
  readonly distributeButtonLabel?: string;
  readonly ruleBasedButtonLabel?: string;
  readonly systemLoad?: number;
  readonly activeThreads?: string;
  readonly deployButtonLabel?: string;
}

const defaultNavigationItems: readonly NavigationItem[] = [
  { label: "All", icon: "dashboard", count: "1,248", active: true },
  { label: "Global", icon: "public", count: "842" },
  { label: "Named Proxies", icon: "label", count: "156" },
  { label: "Direct", icon: "east", count: "92" },
  { label: "Auto Round-Robin", icon: "autorenew", count: "158" },
];

const defaultProxyOptions: readonly ProxyOption[] = [
  { label: "Select Target Proxy...", value: "" },
  { label: "Global-East-01 (10.0.4.15)", value: "global-east-01" },
  { label: "US-West-Dedicated-A", value: "us-west-dedicated-a" },
  { label: "EU-Central-Relay", value: "eu-central-relay" },
  { label: "None (Awaiting Rule)", value: "none" },
];

const defaultAccounts: readonly AccountRow[] = [
  {
    email: "admin_root@codex.io",
    uuid: "8F2A-4B21-99CC",
    status: "Active/Operational",
    assignedProxy: "global-east-01",
    lastHeartbeat: "24ms ago",
    selected: true,
  },
  {
    email: "node_772@infrastructure.net",
    uuid: "1A23-9F02-8811",
    status: "Initializing",
    assignedProxy: "none",
    lastHeartbeat: "--",
    selected: true,
  },
  {
    email: "legacy_relay@relay.cloud",
    uuid: "CC91-112A-B903",
    status: "Faulted",
    assignedProxy: "us-west-dedicated-a",
    lastHeartbeat: "120ms ago",
    selected: true,
  },
];

const defaultUserProfile: UserProfile = {
  name: "Marcus Cole",
  role: "Infrastructure Admin",
  avatarUrl:
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDq8e8gA6hFjEAgCbI3DGsCHCfzi6NIef7Vhq2WJxC4R2KFdmlL8LzrbrVMldd79MdW2EzGi6jyPBomt_FnjB595JBgP6Dj5SKCgSeZSISaQR2R1trKCKWvn8HovFFVK1rqMFzvfV4JA6DoWu8let0JqVAhRJuDDZHByXGMKLriGwl2HbiKxWnn1jkNcsj2mE4qMxpymk6_kPepKKZi7wYvPJV4EUAXhiongLikA5BCl2zbL-ITjUNqz03EBTEAPB6hh6-Gl3RUees9",
};

const getStatusStyles = (status: AccountRow["status"]): { dot: string; text: string } => {
  switch (status) {
    case "Active/Operational":
      return {
        dot: "bg-primary",
        text: "text-primary",
      };
    case "Initializing":
      return {
        dot: "bg-secondary",
        text: "text-secondary",
      };
    case "Faulted":
      return {
        dot: "bg-error",
        text: "text-error",
      };
    default:
      return {
        dot: "bg-outline",
        text: "text-outline",
      };
  }
};

const ProxySettings: React.FC<ProxySettingsProps> = ({
  brandTitle = "Control Room",
  brandSubtitle = "Infrastructure Admin",
  pageTitle = "Managed Accounts",
  pageDescription = "Review and assign infrastructure endpoints to specific user nodes.",
  searchPlaceholder = "Search proxy groups...",
  selectedCount = "128",
  navigationItems = defaultNavigationItems,
  proxyOptions = defaultProxyOptions,
  accounts = defaultAccounts,
  userProfile = defaultUserProfile,
  infoMessage = "Changes are staged and will take effect globally upon 'Apply' command.",
  bulkAllocationLabel = "Bulk Allocation",
  bulkTargetPlaceholder = "Select Target Proxy...",
  applyButtonLabel = "Apply to Selected",
  distributeButtonLabel = "Evenly Distribute",
  ruleBasedButtonLabel = "Rule-based Assign",
  systemLoad = 42,
  activeThreads = "1,024",
  deployButtonLabel = "Deploy New Node",
}) => {
  const bulkOptions = proxyOptions.filter((option) => option.label !== "None (Awaiting Rule)");
  const normalizedLoad = Math.max(0, Math.min(100, systemLoad));

  return (
    <div className="min-h-screen bg-surface font-body text-on-surface selection:bg-primary-fixed selection:text-on-primary-fixed">
      <div className="flex min-h-screen">
        <aside className="fixed left-0 top-0 z-50 flex h-screen w-64 flex-col bg-surface-container-low">
          <div className="flex flex-col gap-1 px-6 py-8">
            <span className="text-xl font-bold tracking-tight text-on-surface">{brandTitle}</span>
            <span className="text-xs font-medium uppercase tracking-widest text-outline">
              {brandSubtitle}
            </span>
          </div>

          <div className="mb-6 px-4">
            <div className="group relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-outline transition-colors group-focus-within:text-primary">
                search
              </span>
              <input
                type="text"
                placeholder={searchPlaceholder}
                readOnly
                className="w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest py-2 pl-10 pr-4 text-sm placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
          </div>

          <nav className="flex-1 space-y-1 overflow-y-auto px-2">
            {navigationItems.map((item) => (
              <a
                key={item.label}
                href="#"
                className={
                  item.active
                    ? "flex items-center justify-between border-r-2 border-primary bg-surface-container px-4 py-3 font-bold text-primary transition-all duration-200"
                    : "flex items-center justify-between px-4 py-3 text-on-surface-variant transition-colors hover:bg-surface-container-high"
                }
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-xl">{item.icon}</span>
                  <span className="text-sm">{item.label}</span>
                </div>
                <span
                  className={
                    item.active
                      ? "rounded bg-primary-container/10 px-1.5 py-0.5 font-mono text-[10px] text-primary-container"
                      : "font-mono text-[10px] text-outline"
                  }
                >
                  {item.count}
                </span>
              </a>
            ))}
          </nav>

          <div className="border-t border-outline-variant/10 p-4">
            <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-xs font-bold uppercase tracking-wider text-on-primary shadow-sm transition-all hover:bg-primary-container active:opacity-80">
              <span className="material-symbols-outlined text-lg">add_circle</span>
              {deployButtonLabel}
            </button>
          </div>
        </aside>

        <main className="ml-64 flex min-h-screen flex-1 flex-col">
          <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-outline-variant/20 bg-surface-container-lowest/80 px-8 backdrop-blur-md">
            <div className="flex flex-col">
              <h1 className="text-lg font-bold leading-tight tracking-tight text-on-surface">
                {pageTitle}
              </h1>
              <p className="text-[11px] font-medium text-outline">{pageDescription}</p>
            </div>

            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2 rounded-full bg-primary-fixed px-3 py-1">
                <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-on-primary-fixed">
                  {selectedCount} selected
                </span>
              </div>

              <div className="flex items-center gap-4 text-outline">
                <span className="material-symbols-outlined cursor-pointer transition-colors hover:text-primary">
                  notifications
                </span>
                <span className="material-symbols-outlined cursor-pointer transition-colors hover:text-primary">
                  help_outline
                </span>
                <div className="h-8 w-8 overflow-hidden rounded-full border border-outline-variant/20 bg-surface-container-high">
                  <img
                    className="h-full w-full object-cover"
                    src={userProfile.avatarUrl}
                    alt={`${userProfile.name} avatar`}
                  />
                </div>
              </div>
            </div>
          </header>

          <div className="flex-1 p-8 pb-32">
            <div className="overflow-hidden rounded-xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-surface-container-low/50">
                    <th className="w-10 py-4 pl-6">
                      <input
                        type="checkbox"
                        checked
                        readOnly
                        className="h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary/20"
                      />
                    </th>
                    <th className="px-4 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                      Email Identity
                    </th>
                    <th className="px-4 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                      Health Status
                    </th>
                    <th className="px-4 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                      Assigned Proxy Node
                    </th>
                    <th className="px-4 py-4 text-[10px] font-bold uppercase tracking-widest text-outline">
                      Last Heartbeat
                    </th>
                    <th className="w-10 py-4 pr-6" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-low">
                  {accounts.map((account) => {
                    const statusStyles = getStatusStyles(account.status);

                    return (
                      <tr
                        key={account.uuid}
                        className="group transition-colors hover:bg-surface-container-low/30"
                      >
                        <td className="py-4 pl-6">
                          <input
                            type="checkbox"
                            checked={account.selected ?? false}
                            readOnly
                            className="h-4 w-4 rounded border-outline-variant text-primary focus:ring-primary/20"
                          />
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-col">
                            <span className="text-sm font-semibold text-on-surface">
                              {account.email}
                            </span>
                            <span className="font-mono text-[10px] uppercase text-outline">
                              UUID: {account.uuid}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${statusStyles.dot}`} />
                            <span className={`text-xs font-medium ${statusStyles.text}`}>
                              {account.status}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="relative max-w-[240px]">
                            <select
                              value={account.assignedProxy}
                              onChange={() => undefined}
                              className="w-full appearance-none rounded-lg border-none bg-surface-container-low/50 py-1.5 pl-3 pr-8 font-mono text-xs focus:ring-1 focus:ring-secondary/40"
                            >
                              {proxyOptions.map((option) => (
                                <option key={option.value || option.label} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-outline">
                              unfold_more
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={`font-mono text-xs ${
                              account.lastHeartbeat === "--"
                                ? "text-outline-variant"
                                : "text-on-surface"
                            }`}
                          >
                            {account.lastHeartbeat}
                          </span>
                        </td>
                        <td className="py-4 pr-6 text-right">
                          <button className="material-symbols-outlined text-outline-variant transition-colors hover:text-on-surface">
                            more_vert
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-6 flex items-center gap-3 rounded-xl border border-secondary/10 bg-secondary-fixed/30 px-5 py-3">
              <span className="material-symbols-outlined text-xl text-secondary">info</span>
              <p className="text-xs font-medium text-secondary/80">{infoMessage}</p>
            </div>
          </div>

          <footer className="fixed bottom-0 right-0 z-50 flex h-20 w-[calc(100%-16rem)] items-center justify-between border-t border-outline-variant/20 bg-surface-container-lowest px-8 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="flex flex-col">
                <span className="mb-1 text-[9px] font-bold uppercase tracking-widest text-outline">
                  {bulkAllocationLabel}
                </span>
                <div className="flex gap-2">
                  <div className="relative">
                    <select
                      value=""
                      onChange={() => undefined}
                      className="min-w-[180px] appearance-none rounded-lg border border-outline-variant/30 bg-surface-container py-2 pl-3 pr-8 text-xs font-medium focus:border-primary focus:ring-1 focus:ring-primary/40"
                    >
                      <option value="">{bulkTargetPlaceholder}</option>
                      {bulkOptions.slice(1).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label.replace(/\s+\(.+\)$/, "")}
                        </option>
                      ))}
                    </select>
                    <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-outline">
                      expand_more
                    </span>
                  </div>
                  <button className="rounded-lg bg-primary px-5 py-2 text-xs font-bold uppercase tracking-wide text-on-primary transition-all hover:bg-primary-container active:scale-95">
                    {applyButtonLabel}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button className="rounded-lg bg-surface-container px-5 py-2.5 text-xs font-bold text-on-surface transition-colors hover:bg-surface-container-high">
                {distributeButtonLabel}
              </button>
              <button className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-xs font-bold text-on-secondary transition-all hover:bg-secondary-container active:scale-95">
                <span className="material-symbols-outlined text-lg">auto_fix</span>
                {ruleBasedButtonLabel}
              </button>
            </div>

            <div className="flex items-center gap-8 border-l border-outline-variant/20 pl-8">
              <div className="flex flex-col">
                <span className="text-[9px] font-bold uppercase tracking-widest text-outline">
                  System Load
                </span>
                <div className="flex items-center gap-2">
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-container-high">
                    <div className="h-full bg-primary" style={{ width: `${normalizedLoad}%` }} />
                  </div>
                  <span className="font-mono text-xs font-bold">{normalizedLoad}%</span>
                </div>
              </div>

              <div className="flex flex-col">
                <span className="text-[9px] font-bold uppercase tracking-widest text-outline">
                  Active Threads
                </span>
                <span className="font-mono text-xs font-bold text-secondary">{activeThreads}</span>
              </div>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
};

export default ProxySettings;