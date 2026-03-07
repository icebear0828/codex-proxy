import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { ProxiesState } from "../../../shared/hooks/use-proxies";

const statusStyles: Record<string, [string, TranslationKey]> = {
  active: [
    "bg-green-100 text-green-700 border-green-200 dark:bg-[#11281d] dark:text-primary dark:border-[#1a442e]",
    "proxyActive",
  ],
  unreachable: [
    "bg-red-100 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/30",
    "proxyUnreachable",
  ],
  disabled: [
    "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/30 dark:text-slate-400 dark:border-slate-700/30",
    "proxyDisabled",
  ],
};

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) {
      u.password = "***";
    }
    return u.toString();
  } catch {
    return url;
  }
}

interface ProxyPoolProps {
  proxies: ProxiesState;
}

export function ProxyPool({ proxies }: ProxyPoolProps) {
  const t = useT();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [addError, setAddError] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const handleAdd = useCallback(async () => {
    setAddError("");
    if (!newUrl.trim()) {
      setAddError("URL is required");
      return;
    }
    const err = await proxies.addProxy(newName || newUrl, newUrl);
    if (err) {
      setAddError(err);
    } else {
      setNewName("");
      setNewUrl("");
      setShowAdd(false);
    }
  }, [newName, newUrl, proxies]);

  const handleCheck = useCallback(
    async (id: string) => {
      setChecking(id);
      await proxies.checkProxy(id);
      setChecking(null);
    },
    [proxies],
  );

  const handleCheckAll = useCallback(async () => {
    setCheckingAll(true);
    await proxies.checkAll();
    setCheckingAll(false);
  }, [proxies]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm(t("removeProxyConfirm"))) return;
      await proxies.removeProxy(id);
    },
    [proxies, t],
  );

  return (
    <section>
      {/* Header */}
      <div class="flex items-center justify-between mb-2">
        <div>
          <h2 class="text-lg font-semibold">{t("proxyPool")}</h2>
          <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5">
            {t("proxyPoolDesc")}
          </p>
        </div>
        <div class="flex items-center gap-2">
          {proxies.proxies.length > 0 && (
            <button
              onClick={handleCheckAll}
              disabled={checkingAll}
              class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors disabled:opacity-50"
            >
              {checkingAll ? "..." : t("checkAllHealth")}
            </button>
          )}
          <button
            onClick={() => setShowAdd(!showAdd)}
            class="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
          >
            {t("addProxy")}
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-4 mb-4">
          <div class="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              placeholder={t("proxyName")}
              value={newName}
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              class="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-transparent focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <input
              type="text"
              placeholder="http://host:port or socks5://host:port"
              value={newUrl}
              onInput={(e) => setNewUrl((e.target as HTMLInputElement).value)}
              class="flex-[2] px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-transparent focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            />
            <button
              onClick={handleAdd}
              class="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors whitespace-nowrap"
            >
              {t("addProxy")}
            </button>
          </div>
          {addError && (
            <p class="text-xs text-red-500 mt-2">{addError}</p>
          )}
        </div>
      )}

      {/* Empty state */}
      {proxies.proxies.length === 0 && !showAdd && (
        <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-6 text-center text-sm text-slate-500 dark:text-text-dim">
          {t("noProxies")}
        </div>
      )}

      {/* Proxy list */}
      {proxies.proxies.length > 0 && (
        <div class="space-y-2">
          {proxies.proxies.map((proxy) => {
            const [statusCls, statusKey] =
              statusStyles[proxy.status] || statusStyles.disabled;
            const isChecking = checking === proxy.id;

            return (
              <div
                key={proxy.id}
                class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-3 hover:shadow-sm transition-all"
              >
                <div class="flex items-center justify-between">
                  {/* Left: name + url + status */}
                  <div class="flex items-center gap-3 min-w-0 flex-1">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-sm truncate">
                          {proxy.name}
                        </span>
                        <span
                          class={`px-2 py-0.5 rounded-full text-[0.65rem] font-medium border ${statusCls}`}
                        >
                          {t(statusKey)}
                        </span>
                      </div>
                      <p class="text-xs text-slate-400 dark:text-text-dim font-mono truncate mt-0.5">
                        {maskUrl(proxy.url)}
                      </p>
                    </div>
                  </div>

                  {/* Center: health info */}
                  {proxy.health && (
                    <div class="hidden sm:flex items-center gap-4 px-4 text-xs text-slate-500 dark:text-text-dim">
                      {proxy.health.exitIp && (
                        <span>
                          {t("exitIp")}: <span class="font-mono font-medium text-slate-700 dark:text-text-main">{proxy.health.exitIp}</span>
                        </span>
                      )}
                      <span>
                        {proxy.health.latencyMs}ms
                      </span>
                      {proxy.health.error && (
                        <span class="text-red-500 truncate max-w-[200px]" title={proxy.health.error}>
                          {proxy.health.error}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Right: actions */}
                  <div class="flex items-center gap-1 ml-2">
                    <button
                      onClick={() => handleCheck(proxy.id)}
                      disabled={isChecking}
                      class="px-2 py-1 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-border-dark transition-colors disabled:opacity-50"
                      title={t("checkHealth")}
                    >
                      {isChecking ? "..." : t("checkHealth")}
                    </button>
                    {proxy.status === "disabled" ? (
                      <button
                        onClick={() => proxies.enableProxy(proxy.id)}
                        class="px-2 py-1 text-xs rounded-md hover:bg-green-50 dark:hover:bg-green-900/20 text-green-600 transition-colors"
                      >
                        {t("enableProxy")}
                      </button>
                    ) : (
                      <button
                        onClick={() => proxies.disableProxy(proxy.id)}
                        class="px-2 py-1 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-border-dark text-slate-500 transition-colors"
                      >
                        {t("disableProxy")}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(proxy.id)}
                      class="p-1 text-slate-400 dark:text-text-dim hover:text-red-500 transition-colors rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
                      title={t("deleteProxy")}
                    >
                      <svg
                        class="size-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Mobile health info */}
                {proxy.health && (
                  <div class="sm:hidden flex items-center gap-3 mt-2 text-xs text-slate-500 dark:text-text-dim">
                    {proxy.health.exitIp && (
                      <span>IP: <span class="font-mono">{proxy.health.exitIp}</span></span>
                    )}
                    <span>{proxy.health.latencyMs}ms</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
