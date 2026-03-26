import React from "react";

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly active?: boolean;
}

interface FilterChip {
  readonly label: string;
  readonly count: number;
  readonly tone: "active" | "default" | "danger" | "refreshing" | "muted" | "banned";
  readonly pulsing?: boolean;
}

interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly uid: string;
  readonly status: "Active" | "Limited" | "Disabled" | "Expired" | "Refreshing" | "Banned";
  readonly type: "native" | "relay";
  readonly plan: "Free" | "Plus" | "Team";
  readonly requests: string;
  readonly lastUsed: string;
  readonly quotaPercent: number;
  readonly enabled: boolean;
  readonly selected: boolean;
}

interface PaginationData {
  readonly currentPage: number;
  readonly totalPages: number;
  readonly showingFrom: number;
  readonly showingTo: number;
  readonly totalAccounts: number;
}

export interface AccountManagementProps {
  readonly appName?: string;
  readonly appTagline?: string;
  readonly searchPlaceholder?: string;
  readonly profileImageUrl?: string;
  readonly selectedCount?: number;
  readonly topNavItems?: readonly NavItem[];
  readonly bottomNavItems?: readonly NavItem[];
  readonly filterChips?: readonly FilterChip[];
  readonly accounts?: readonly AccountRow[];
  readonly pagination?: PaginationData;
}

const defaultTopNavItems: readonly NavItem[] = [
  { label: "Overview", icon: "dashboard" },
  { label: "Accounts", icon: "supervisor_account", active: true },
  { label: "Proxies", icon: "router" },
  { label: "Stats", icon: "analytics" },
];

const defaultBottomNavItems: readonly NavItem[] = [
  { label: "Support", icon: "help" },
  { label: "Logs", icon: "terminal" },
];

const defaultFilterChips: readonly FilterChip[] = [
  { label: "Active", count: 1240, tone: "active", pulsing: true },
  { label: "Expired", count: 82, tone: "default" },
  { label: "Rate Limited", count: 14, tone: "danger" },
  { label: "Refreshing", count: 5, tone: "refreshing", pulsing: true },
  { label: "Disabled", count: 210, tone: "muted" },
  { label: "Banned", count: 3, tone: "banned" },
];

const defaultAccounts: readonly AccountRow[] = [
  {
    id: "1",
    email: "alyssa.vance@codex.io",
    uid: "8829-XJ-90",
    status: "Active",
    type: "native",
    plan: "Plus",
    requests: "42,901",
    lastUsed: "2 mins ago",
    quotaPercent: 45,
    enabled: true,
    selected: true,
  },
  {
    id: "2",
    email: "dev.ops@proxy-cloud.net",
    uid: "1102-LL-22",
    status: "Limited",
    type: "relay",
    plan: "Team",
    requests: "892,104",
    lastUsed: "14 secs ago",
    quotaPercent: 98,
    enabled: true,
    selected: true,
  },
  {
    id: "3",
    email: "test-user-09@gmail.com",
    uid: "4431-KK-11",
    status: "Disabled",
    type: "native",
    plan: "Free",
    requests: "122",
    lastUsed: "8 days ago",
    quotaPercent: 2,
    enabled: false,
    selected: false,
  },
  {
    id: "4",
    email: "billing@enterprise.corp",
    uid: "9901-AA-01",
    status: "Active",
    type: "relay",
    plan: "Plus",
    requests: "2,331,009",
    lastUsed: "Just now",
    quotaPercent: 72,
    enabled: true,
    selected: true,
  },
];

const defaultPagination: PaginationData = {
  currentPage: 1,
  totalPages: 25,
  showingFrom: 1,
  showingTo: 50,
  totalAccounts: 1240,
};

const formatNumber = (value: number): string => value.toLocaleString();

const AccountManagement: React.FC<AccountManagementProps> = (props) => {
  const {
    appName = "Codex Proxy",
    appTagline = "Precision Control",
    searchPlaceholder = "Search accounts by email...",
    profileImageUrl = "https://lh3.googleusercontent.com/aida-public/AB6AXuAxakFaql8fcgKLc2e7RgAwg6X_Co9BKgQmthf0uYlZOJ0AIxuiSLTiImau56VtRBKxWAEvPeH1DW5MLyoof1_vDh-TqJWjjXp57ZzVrpvrM5L8CjHiyjAS9IQ1UnAcroxpbS8OMjW8VjrDPjPcjYCgMApNZ6ixMt5JVBQ_gMxCeS0yG5bBFc_R2tk3yLlPOm7BAKgnoygKrTzZXZs5pBwIVVngFj_OfBnII0CvOWSy6vtzY0zgOLTeNp2hO6yaoGmSMFV1J34WtCbS",
    selectedCount = 12,
    topNavItems = defaultTopNavItems,
    bottomNavItems = defaultBottomNavItems,
    filterChips = defaultFilterChips,
    accounts = defaultAccounts,
    pagination = defaultPagination,
  } = props;

  const chipClasses = (tone: FilterChip["tone"]): string => {
    switch (tone) {
      case "active":
        return "bg-primary-container text-on-primary-container shadow-sm";
      case "danger":
        return "bg-slate-100 text-slate-600 hover:bg-slate-200";
      case "refreshing":
        return "bg-slate-100 text-slate-600 hover:bg-slate-200";
      case "muted":
        return "bg-slate-100 text-slate-600 hover:bg-slate-200";
      case "banned":
        return "bg-error-container text-on-error-container";
      default:
        return "bg-slate-100 text-slate-600 hover:bg-slate-200";
    }
  };

  const chipDotClasses = (tone: FilterChip["tone"], pulsing?: boolean): string => {
    const pulse = pulsing ? " animate-pulse" : "";
    switch (tone) {
      case "active":
        return `h-2 w-2 rounded-full bg-primary-fixed-dim${pulse}`;
      case "danger":
        return `h-2 w-2 rounded-full bg-error${pulse}`;
      case "refreshing":
        return `h-2 w-2 rounded-full bg-secondary-container${pulse}`;
      case "muted":
        return `h-2 w-2 rounded-full bg-slate-300${pulse}`;
      case "banned":
        return `h-2 w-2 rounded-full bg-error${pulse}`;
      default:
        return `h-2 w-2 rounded-full bg-slate-400${pulse}`;
    }
  };

  const statusBadgeClasses = (status: AccountRow["status"]): string => {
    switch (status) {
      case "Active":
        return "bg-primary-fixed/20 text-on-primary-fixed-variant";
      case "Limited":
      case "Banned":
        return "bg-error-container/40 text-on-error-container";
      case "Refreshing":
        return "bg-secondary-fixed text-on-secondary-fixed-variant";
      case "Expired":
      case "Disabled":
      default:
        return "bg-slate-100 text-slate-500";
    }
  };

  const statusDotClasses = (status: AccountRow["status"]): string => {
    switch (status) {
      case "Active":
        return "bg-primary animate-pulse";
      case "Limited":
      case "Banned":
        return "bg-error";
      case "Refreshing":
        return "bg-secondary-container animate-pulse";
      case "Expired":
      case "Disabled":
      default:
        return "bg-slate-400";
    }
  };

  const planClasses = (plan: AccountRow["plan"]): string => {
    switch (plan) {
      case "Plus":
        return "bg-secondary/10 text-secondary";
      case "Team":
        return "bg-slate-200 text-slate-600";
      case "Free":
      default:
        return "border border-slate-200 text-slate-400";
    }
  };

  const quotaBarClasses = (status: AccountRow["status"]): string => {
    switch (status) {
      case "Limited":
      case "Banned":
        return "bg-error";
      case "Disabled":
      case "Expired":
        return "bg-slate-300";
      default:
        return "bg-primary";
    }
  };

  return (
    <div className="min-h-screen bg-surface font-body text-on-surface antialiased">
      <div className="fixed right-0 top-0 -z-10 h-[500px] w-[500px] rounded-full bg-primary-fixed/5 blur-[120px]" />
      <div className="fixed bottom-0 left-0 -z-10 h-[400px] w-[400px] rounded-full bg-secondary-fixed/5 blur-[100px]" />

      <aside className="fixed left-0 top-0 z-50 flex h-screen w-64 flex-col gap-2 border-r border-slate-200 bg-slate-50 px-4 py-6">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-container">
            <span className="material-symbols-outlined text-xl text-on-primary-container">router</span>
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tighter text-slate-900">{appName}</h1>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{appTagline}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          {topNavItems.map((item) => (
            <a
              key={item.label}
              href="#"
              className={
                item.active
                  ? "flex items-center gap-3 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-primary shadow-sm"
                  : "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-200/50"
              }
            >
              <span className="material-symbols-outlined text-xl">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className="mt-auto space-y-1 border-t border-slate-200 pt-6">
          {bottomNavItems.map((item) => (
            <a
              key={item.label}
              href="#"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-200/50"
            >
              <span className="material-symbols-outlined text-xl">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
        </div>
      </aside>

      <main className="ml-64 min-h-screen">
        <header className="fixed left-64 right-0 top-0 z-40 flex h-16 items-center justify-between border-b border-slate-100 bg-white px-8">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <button className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100">
                <span className="material-symbols-outlined text-lg">upload_file</span>
                Import JSON
              </button>
              <button className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100">
                <span className="material-symbols-outlined text-lg">download</span>
                Export JSON
              </button>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                search
              </span>
              <input
                type="text"
                placeholder={searchPlaceholder}
                className="w-64 rounded-xl border-none bg-slate-100 py-2 pl-10 pr-4 text-sm transition-all focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="mx-2 h-8 w-px bg-slate-200" />
            <button className="text-slate-500 transition-colors hover:text-primary">
              <span className="material-symbols-outlined">notifications</span>
            </button>
            <button className="text-slate-500 transition-colors hover:text-primary">
              <span className="material-symbols-outlined">settings</span>
            </button>
            <img
              src={profileImageUrl}
              alt="User Profile"
              className="h-8 w-8 rounded-full border-2 border-slate-100"
            />
          </div>
        </header>

        <div className="px-8 pb-32 pt-24">
          <div className="mb-8 flex flex-wrap items-center gap-3">
            {filterChips.map((chip) => (
              <button
                key={chip.label}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider transition-colors ${chipClasses(
                  chip.tone
                )}`}
              >
                <span className={chipDotClasses(chip.tone, chip.pulsing)} />
                {chip.label} {formatNumber(chip.count)}
              </button>
            ))}
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-100 bg-surface-container-lowest shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="w-12 px-6 py-4">
                      <input
                        type="checkbox"
                        className="rounded border-slate-300 text-primary focus:ring-primary"
                        defaultChecked
                      />
                    </th>
                    <th className="px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Email Identity
                    </th>
                    <th className="px-4 py-4 text-center text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Status
                    </th>
                    <th className="px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Type
                    </th>
                    <th className="px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Plan
                    </th>
                    <th className="px-4 py-4 text-right text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Requests
                    </th>
                    <th className="px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Last Used
                    </th>
                    <th className="w-48 px-4 py-4 text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Quota
                    </th>
                    <th className="px-6 py-4 text-right text-[11px] font-bold uppercase tracking-widest text-slate-500">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {accounts.map((account) => (
                    <tr key={account.id} className="group transition-colors hover:bg-slate-50/50">
                      <td className="px-6 py-4">
                        <input
                          type="checkbox"
                          defaultChecked={account.selected}
                          className="rounded border-slate-300 text-primary focus:ring-primary"
                        />
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col">
                          <span className="text-sm font-semibold text-on-surface">{account.email}</span>
                          <span className="font-mono text-[10px] text-slate-400">UID: {account.uid}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex justify-center">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-bold uppercase ${statusBadgeClasses(
                              account.status
                            )}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${statusDotClasses(account.status)}`} />
                            {account.status}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`font-mono text-xs font-medium ${
                            account.type === "native" ? "text-secondary" : "text-slate-500"
                          }`}
                        >
                          {account.type}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${planClasses(
                            account.plan
                          )}`}
                        >
                          {account.plan}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-right font-mono text-sm text-slate-600">{account.requests}</td>
                      <td className="px-4 py-4 text-xs text-slate-500">{account.lastUsed}</td>
                      <td className="px-4 py-4">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full ${quotaBarClasses(account.status)}`}
                            style={{ width: `${account.quotaPercent}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          aria-label={account.enabled ? "Disable account" : "Enable account"}
                          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            account.enabled ? "bg-primary" : "bg-slate-300"
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              account.enabled ? "translate-x-4" : "translate-x-0"
                            }`}
                          />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-6 py-4">
              <p className="text-xs font-medium text-slate-500">
                Showing <span className="font-bold text-on-surface">{pagination.showingFrom}-{pagination.showingTo}</span> of{" "}
                <span className="font-bold text-on-surface">{formatNumber(pagination.totalAccounts)}</span> accounts
              </p>

              <div className="flex items-center gap-1">
                <button className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-white hover:shadow-sm">
                  <span className="material-symbols-outlined text-lg">chevron_left</span>
                </button>
                <button className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-xs font-bold text-primary shadow-sm">
                  {pagination.currentPage}
                </button>
                <button className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium text-slate-600 hover:bg-white hover:shadow-sm">
                  2
                </button>
                <button className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium text-slate-600 hover:bg-white hover:shadow-sm">
                  3
                </button>
                <span className="px-2 text-xs text-slate-400">...</span>
                <button className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium text-slate-600 hover:bg-white hover:shadow-sm">
                  {pagination.totalPages}
                </button>
                <button className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-white hover:shadow-sm">
                  <span className="material-symbols-outlined text-lg">chevron_right</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <nav className="fixed bottom-8 left-1/2 z-50 flex w-[600px] -translate-x-1/2 items-center justify-between gap-12 rounded-2xl border border-slate-200 bg-white/80 px-8 py-4 shadow-2xl backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-fixed/30">
            <span className="material-symbols-outlined text-xl text-primary">checklist</span>
          </span>
          <span className="text-sm font-bold text-slate-800">{selectedCount} accounts selected</span>
        </div>

        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-primary/20 transition-all hover:scale-105 active:scale-95">
            <span className="material-symbols-outlined text-sm">play_arrow</span>
            Set Active
          </button>
          <button className="flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-600 transition-all hover:bg-slate-200 active:scale-95">
            <span className="material-symbols-outlined text-sm">block</span>
            Set Disabled
          </button>
          <div className="mx-1 h-6 w-px bg-slate-200" />
          <button
            title="Delete Selection"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-error-container text-error transition-all hover:bg-error hover:text-white active:scale-90"
          >
            <span className="material-symbols-outlined">delete</span>
          </button>
        </div>
      </nav>
    </div>
  );
};

export default AccountManagement;