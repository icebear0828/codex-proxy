import { useState, useEffect, useRef, useContext } from "preact/hooks";
import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { I18nProvider } from "../../shared/i18n/context";
import { ThemeProvider } from "../../shared/theme/context";
import { Header } from "./components/Header";
import { UpdateModal } from "./components/UpdateModal";
import { AddAccount } from "./components/AddAccount";
import { AccountList } from "./components/AccountList";
import { SettingsTab } from "./components/SettingsTab";
import { ProxyPool } from "./components/ProxyPool";
import { Footer } from "./components/Footer";
import { ProxySettings } from "./pages/ProxySettings";
import { AccountManagement } from "./pages/AccountManagement";
import { UsageStats } from "./pages/UsageStats";
import { useAccounts } from "../../shared/hooks/use-accounts";
import { useProxies } from "../../shared/hooks/use-proxies";
import { useStatus } from "../../shared/hooks/use-status";
import { useUpdateStatus } from "../../shared/hooks/use-update-status";
import { useI18n, useT } from "../../shared/i18n/context";
import { useDashboardAuth } from "../../shared/hooks/use-dashboard-auth";
import type { TranslationKey } from "../../shared/i18n/translations";

const DashboardAuthCtx = createContext<{ onLogout?: () => void }>({});
function useDashboardAuthCtx() { return useContext(DashboardAuthCtx); }

function useUpdateMessage() {
  const { t } = useI18n();
  const update = useUpdateStatus();

  let msg: string | null = null;
  let color = "text-primary";

  if (!update.checking && update.result) {
    const parts: string[] = [];
    const r = update.result;
    if (r.proxy?.error) { parts.push(`Proxy: ${r.proxy.error}`); color = "text-red-500"; }
    else if (r.proxy?.update_available) { parts.push(t("updateAvailable")); color = "text-amber-500"; }
    if (r.codex?.error) { parts.push(`Codex: ${r.codex.error}`); color = "text-red-500"; }
    else if (r.codex_update_in_progress) { parts.push(t("fingerprintUpdating")); }
    else if (r.codex?.version_changed) { parts.push(`Codex: v${r.codex.current_version}`); color = "text-blue-500"; }
    msg = parts.length > 0 ? parts.join(" · ") : t("upToDate");
  } else if (!update.checking && update.error) { msg = update.error; color = "text-red-500"; }

  const hasUpdate = update.status?.proxy.update_available ?? false;
  const proxyUpdateInfo = hasUpdate
    ? { mode: update.status!.proxy.mode, commits: update.status!.proxy.commits, changelog: update.status!.proxy.changelog ?? null, release: update.status!.proxy.release }
    : null;

  return { ...update, msg, color, hasUpdate, proxyUpdateInfo };
}

// ── Tab definitions ─────────────────────────────────────────────────

const TABS: Array<{ hash: string; label: TranslationKey }> = [
  { hash: "", label: "overview" },
  { hash: "#/accounts", label: "manageAccounts" },
  { hash: "#/proxies", label: "proxySettings" },
  { hash: "#/settings", label: "settings" },
];

function TabBar({ activeHash }: { activeHash: string }) {
  const t = useT();
  return (
    <div class="flex items-center gap-1.5 mb-4">
      {TABS.map((tab) => {
        const isActive = activeHash === tab.hash;
        return (
          <a
            key={tab.hash}
            href={tab.hash || "#/"}
            class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isActive
                ? "bg-primary/10 text-primary dark:bg-primary/20"
                : "text-slate-500 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark"
            }`}
          >
            {t(tab.label)}
          </a>
        );
      })}
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────

function Dashboard() {
  const accounts = useAccounts();
  const proxies = useProxies();
  const status = useStatus(accounts.list.length);
  const update = useUpdateMessage();
  const { onLogout } = useDashboardAuthCtx();
  const [showModal, setShowModal] = useState(false);
  const prevUpdateAvailable = useRef(false);
  const hash = useHash();

  useEffect(() => {
    if (update.hasUpdate && !prevUpdateAvailable.current && update.proxyUpdateInfo?.mode !== "electron") {
      setShowModal(true);
    }
    prevUpdateAvailable.current = update.hasUpdate;
  }, [update.hasUpdate, update.proxyUpdateInfo?.mode]);

  const handleProxyChange = async (accountId: string, proxyId: string) => {
    accounts.patchLocal(accountId, { proxyId });
    await proxies.assignProxy(accountId, proxyId);
  };

  // Redirect legacy routes
  if (hash === "#/account-management") { location.hash = "#/accounts"; return null; }
  if (hash === "#/proxy-settings") { location.hash = "#/proxies"; return null; }

  // Usage stats stays standalone (separate page with its own header)
  if (hash === "#/usage-stats") {
    return (
      <>
        <Header
          onAddAccount={accounts.startAdd}
          onCheckUpdate={update.checkForUpdate}
          onOpenUpdateModal={() => setShowModal(true)}
          checking={update.checking}
          updateStatusMsg={update.msg}
          updateStatusColor={update.color}
          version={update.status?.proxy.version ?? null}
          commit={update.status?.proxy.commit ?? null}
          hasUpdate={update.hasUpdate}
          onLogout={onLogout}
        />
        <UsageStats />
      </>
    );
  }

  const activeTab = TABS.find((t) => t.hash === hash)?.hash ?? "";

  return (
    <>
      <Header
        onAddAccount={accounts.startAdd}
        onCheckUpdate={update.checkForUpdate}
        onOpenUpdateModal={() => setShowModal(true)}
        checking={update.checking}
        updateStatusMsg={update.msg}
        updateStatusColor={update.color}
        version={update.status?.proxy.version ?? null}
        commit={update.status?.proxy.commit ?? null}
        hasUpdate={update.hasUpdate}
        onLogout={onLogout}
      />

      <main class="flex-grow px-4 md:px-8 lg:px-40 py-8 flex justify-center">
        <div class="flex flex-col w-full max-w-[960px]">
          <AddAccount
            visible={accounts.addVisible}
            onSubmitRelay={accounts.submitRelay}
            onAddByRefreshToken={accounts.addByRefreshToken}
            addInfo={accounts.addInfo}
            addError={accounts.addError}
          />

          <TabBar activeHash={activeTab} />

          {activeTab === "" && (
            <div class="flex flex-col gap-6">
              <AccountList
                accounts={accounts.list}
                loading={accounts.loading}
                onDelete={accounts.deleteAccount}
                onRefresh={accounts.refresh}
                refreshing={accounts.refreshing}
                lastUpdated={accounts.lastUpdated}
                proxies={proxies.proxies}
                onProxyChange={handleProxyChange}
                onExport={accounts.exportAccounts}
                onImport={accounts.importAccounts}
                onToggleStatus={accounts.toggleStatus}
                onUpdateLabel={accounts.updateLabel}
                onAddByRefreshToken={accounts.addByRefreshToken}
              />
              <ProxyPool proxies={proxies} />
            </div>
          )}

          {activeTab === "#/accounts" && (
            <AccountManagement embedded />
          )}

          {activeTab === "#/proxies" && (
            <div class="flex flex-col gap-6">
              <ProxyPool proxies={proxies} />
              <ProxySettings embedded />
            </div>
          )}

          {activeTab === "#/settings" && (
            <SettingsTab
              baseUrl={status.baseUrl}
              apiKey={status.apiKey}
              models={status.models}
              selectedModel={status.selectedModel}
              onModelChange={status.setSelectedModel}
              modelFamilies={status.modelFamilies}
              selectedEffort={status.selectedEffort}
              onEffortChange={status.setSelectedEffort}
              selectedSpeed={status.selectedSpeed}
              onSpeedChange={status.setSelectedSpeed}
            />
          )}
        </div>
      </main>

      <Footer updateStatus={update.status} />
      {update.proxyUpdateInfo && (
        <UpdateModal
          open={showModal}
          onClose={() => setShowModal(false)}
          mode={update.proxyUpdateInfo.mode}
          commits={update.proxyUpdateInfo.commits}
          changelog={update.proxyUpdateInfo.changelog}
          release={update.proxyUpdateInfo.release}
          onApply={update.applyUpdate}
          applying={update.applying}
          restarting={update.restarting}
          restartFailed={update.restartFailed}
          updateSteps={update.updateSteps}
        />
      )}
    </>
  );
}

// ── Utilities ────────────────────────────────────────────────────────

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const handler = () => setHash(location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return hash;
}

function LoginGate({ children }: { children: ComponentChildren }) {
  const { t } = useI18n();
  const auth = useDashboardAuth();
  const [password, setPassword] = useState("");

  if (auth.status === "loading") {
    return (
      <div class="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-bg-dark">
        <div class="animate-pulse text-slate-400 dark:text-text-dim text-sm">Loading...</div>
      </div>
    );
  }

  if (auth.status === "login") {
    const handleSubmit = (e: Event) => { e.preventDefault(); if (password.trim()) auth.login(password.trim()); };
    return (
      <div class="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-bg-dark px-4">
        <div class="w-full max-w-sm bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-2xl shadow-lg p-8">
          <div class="flex flex-col items-center gap-2 mb-6">
            <div class="flex items-center justify-center size-12 rounded-full bg-primary/10 text-primary border border-primary/20">
              <svg class="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h1 class="text-lg font-bold text-slate-800 dark:text-text-main">{t("dashboardLogin")}</h1>
            <p class="text-xs text-slate-500 dark:text-text-dim text-center">{t("dashboardLoginRequired")}</p>
          </div>
          <form onSubmit={handleSubmit} class="flex flex-col gap-4">
            <div>
              <label class="block text-xs font-medium text-slate-600 dark:text-text-dim mb-1.5">{t("dashboardPassword")}</label>
              <input type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                class="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-sm text-slate-800 dark:text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
                placeholder="proxy_api_key" autofocus />
            </div>
            {auth.error && (
              <p class="text-xs text-red-500 font-medium">
                {auth.error.includes("Too many") ? t("dashboardTooManyAttempts") : t("dashboardLoginError")}
              </p>
            )}
            <button type="submit" class="w-full py-2.5 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-lg transition-colors shadow-sm active:scale-[0.98]">
              {t("dashboardLoginBtn")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const ctxValue = auth.isRemoteSession ? { onLogout: auth.logout } : {};
  return <DashboardAuthCtx.Provider value={ctxValue}>{children}</DashboardAuthCtx.Provider>;
}

export function App() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <LoginGate>
          <Dashboard />
        </LoginGate>
      </ThemeProvider>
    </I18nProvider>
  );
}
