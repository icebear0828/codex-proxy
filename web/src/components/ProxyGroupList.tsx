import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { AssignmentAccount } from "../../../shared/hooks/use-proxy-assignments";
import type { ProxyEntry } from "../../../shared/types";

interface ProxyGroup {
  id: string;
  label: string;
  count: number;
}

interface ProxyGroupListProps {
  accounts: AssignmentAccount[];
  proxies: ProxyEntry[];
  selectedGroup: string | null;
  onSelectGroup: (groupId: string | null) => void;
}

export function ProxyGroupList({ accounts, proxies, selectedGroup, onSelectGroup }: ProxyGroupListProps) {
  const t = useT();
  const [search, setSearch] = useState("");

  // Build groups with counts
  const groups: ProxyGroup[] = [];

  // "All"
  groups.push({ id: "__all__", label: t("allAccounts"), count: accounts.length });

  // Count by assignment
  const countMap = new Map<string, number>();
  for (const acct of accounts) {
    const key = acct.proxyId || "global";
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }

  // Special groups
  groups.push({ id: "global", label: t("globalDefault"), count: countMap.get("global") || 0 });

  // Proxy entries
  for (const p of proxies) {
    groups.push({ id: p.id, label: p.name, count: countMap.get(p.id) || 0 });
  }

  groups.push({ id: "direct", label: t("directNoProxy"), count: countMap.get("direct") || 0 });
  groups.push({ id: "auto", label: t("autoRoundRobin"), count: countMap.get("auto") || 0 });

  // "Unassigned" — accounts not in any explicit assignment (they default to "global")
  // Since getAssignment defaults to "global", all accounts have a proxyId.
  // "Unassigned" is not really a separate bucket in this model — skip or show 0.

  const lowerSearch = search.toLowerCase();
  const filtered = search
    ? groups.filter((g) => g.label.toLowerCase().includes(lowerSearch))
    : groups;

  const active = selectedGroup ?? "__all__";

  return (
    <div class="flex flex-col gap-1">
      {/* Search */}
      <input
        type="text"
        placeholder={t("searchProxy")}
        value={search}
        onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        class="px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary mb-2"
      />

      {filtered.map((g) => {
        const isActive = active === g.id;
        return (
          <button
            key={g.id}
            onClick={() => onSelectGroup(g.id === "__all__" ? null : g.id)}
            class={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors text-left ${
              isActive
                ? "bg-primary/10 text-primary font-medium border border-primary/20"
                : "hover:bg-slate-50 dark:hover:bg-border-dark text-slate-700 dark:text-text-main"
            }`}
          >
            <span class="truncate">{g.label}</span>
            <span
              class={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${
                isActive
                  ? "bg-primary/20 text-primary"
                  : "bg-slate-100 dark:bg-border-dark text-slate-500 dark:text-text-dim"
              }`}
            >
              {g.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
