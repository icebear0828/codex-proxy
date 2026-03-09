import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { ProxiesState } from "../../../shared/hooks/use-proxies";

const PROTOCOLS = ["http", "https", "socks5", "socks5h"] as const;

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

const inputCls = "px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary";

interface ProxyPoolProps {
  proxies: ProxiesState;
}

export function ProxyPool({ proxies }: ProxyPoolProps) {
  const t = useT();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProtocol, setNewProtocol] = useState("http");
  const [newHost, setNewHost] = useState("");
  const [newPort, setNewPort] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [addError, setAddError] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const resetForm = useCallback(() => {
    setNewName("");
    setNewProtocol("http");
    setNewHost("");
    setNewPort("");
    setNewUsername("");
    setNewPassword("");
    setAddError("");
  }, []);

  const handleAdd = useCallback(async () => {
    setAddError("");
    if (!newHost.trim()) {
      setAddError(t("proxyHost") + " is required");
      return;
    }
    const err = await proxies.addProxy({
      name: newName,
      protocol: newProtocol,
      host: newHost,
      port: newPort,
      username: newUsername,
      password: newPassword,
    });
    if (err) {
      setAddError(err);
    } else {
      resetForm();
      setShowAdd(false);
    }
  }, [newName, newProtocol, newHost, newPort, newUsername, newPassword, proxies, resetForm, t]);

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
              class="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
            >
              {checkingAll ? "..." : t("checkAllHealth")}
            </button>
          )}
          <button
            onClick={() => setShowAdd(!showAdd)}
            class="px-3 py-1.5 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
          >
            {t("addProxy")}
          </button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-4 mb-4">
          <div class="grid grid-cols-[auto_1fr_auto] sm:grid-cols-[auto_1fr_80px] gap-2 items-center">
            {/* Row 1: Protocol + Host + Port */}
            <select
              value={newProtocol}
              onChange={(e) => setNewProtocol((e.target as HTMLSelectElement).value)}
              class={`${inputCls} w-[110px] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none`}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>{p}://</option>
              ))}
            </select>
            <input
              type="text"
              placeholder={t("proxyHost")}
              value={newHost}
              onInput={(e) => setNewHost((e.target as HTMLInputElement).value)}
              class={`${inputCls} font-mono focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none`}
            />
            <input
              type="text"
              placeholder={t("proxyPort")}
              value={newPort}
              onInput={(e) => setNewPort((e.target as HTMLInputElement).value)}
              class={`${inputCls} font-mono focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none`}
            />
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
            {/* Row 2: Name + Username + Password */}
            <input
              type="text"
              placeholder={`${t("proxyName")} (${t("proxyOptional")})`}
              value={newName}
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              class={`${inputCls} focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none`}
            />
            <input
              type="text"
              placeholder={`${t("proxyUsername")} (${t("proxyOptional")})`}
              value={newUsername}
              onInput={(e) => setNewUsername((e.target as HTMLInputElement).value)}
              class={`${inputCls} focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none`}
            />
            <input
              type="password"
              placeholder={`${t("proxyPassword")} (${t("proxyOptional")})`}
              value={newPassword}
              onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
              class={`${inputCls} col-span-2 sm:col-span-1 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none`}
            />
          </div>
          <div class="flex items-center justify-between mt-3">
            {addError && (
              <p class="text-xs text-red-500">{addError}</p>
            )}
            <div class="ml-auto">
              <button
                onClick={handleAdd}
                class="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors whitespace-nowrap focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
              >
                {t("addProxy")}
              </button>
            </div>
          </div>
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
                        {proxy.url}
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
                      class="px-2 py-1 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-border-dark transition-colors disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
                      title={t("checkHealth")}
                    >
                      {isChecking ? "..." : t("checkHealth")}
                    </button>
                    {proxy.status === "disabled" ? (
                      <button
                        onClick={() => proxies.enableProxy(proxy.id)}
                        class="px-2 py-1 text-xs rounded-md hover:bg-green-50 dark:hover:bg-green-900/20 text-green-600 transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
                      >
                        {t("enableProxy")}
                      </button>
                    ) : (
                      <button
                        onClick={() => proxies.disableProxy(proxy.id)}
                        class="px-2 py-1 text-xs rounded-md hover:bg-slate-100 dark:hover:bg-border-dark text-slate-500 transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
                      >
                        {t("disableProxy")}
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(proxy.id)}
                      class="p-1 text-slate-400 dark:text-text-dim hover:text-red-500 transition-colors rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-bg-dark outline-none"
                      title={t("deleteProxy")}
                      aria-label={t("deleteProxy")}
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
