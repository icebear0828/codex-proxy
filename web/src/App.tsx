import { useState, useEffect, useRef } from "preact/hooks";
import { I18nProvider } from "../../shared/i18n/context";
import { ThemeProvider } from "../../shared/theme/context";
import { Header } from "./components/Header";
import { UpdateModal } from "./components/UpdateModal";
import { AccountList } from "./components/AccountList";
import { AddAccount } from "./components/AddAccount";
import { ProxyPool } from "./components/ProxyPool";
import { ApiConfig } from "./components/ApiConfig";
import { AnthropicSetup } from "./components/AnthropicSetup";
import { CodeExamples } from "./components/CodeExamples";
import { Footer } from "./components/Footer";
import { ProxySettings } from "./pages/ProxySettings";
import { useAccounts } from "../../shared/hooks/use-accounts";
import { useProxies } from "../../shared/hooks/use-proxies";
import { useStatus } from "../../shared/hooks/use-status";
import { useUpdateStatus } from "../../shared/hooks/use-update-status";
import { useI18n } from "../../shared/i18n/context";

function useUpdateMessage() {
  const { t } = useI18n();
  const update = useUpdateStatus();

  let msg: string | null = null;
  let color = "text-primary";

  if (!update.checking && update.result) {
    const parts: string[] = [];
    const r = update.result;

    if (r.proxy?.error) {
      parts.push(`Proxy: ${r.proxy.error}`);
      color = "text-red-500";
    } else if (r.proxy?.update_available) {
      parts.push(t("updateAvailable"));
      color = "text-amber-500";
    }

    if (r.codex?.error) {
      parts.push(`Codex: ${r.codex.error}`);
      color = "text-red-500";
    } else if (r.codex_update_in_progress) {
      parts.push(t("fingerprintUpdating"));
    } else if (r.codex?.version_changed) {
      parts.push(`Codex: v${r.codex.current_version}`);
      color = "text-blue-500";
    }

    msg = parts.length > 0 ? parts.join(" · ") : t("upToDate");
  } else if (!update.checking && update.error) {
    msg = update.error;
    color = "text-red-500";
  }

  const hasUpdate = update.status?.proxy.update_available ?? false;
  const proxyUpdateInfo = hasUpdate
    ? {
        mode: update.status!.proxy.mode,
        commits: update.status!.proxy.commits,
        release: update.status!.proxy.release,
      }
    : null;

  return { ...update, msg, color, hasUpdate, proxyUpdateInfo };
}

function Dashboard() {
  const accounts = useAccounts();
  const proxies = useProxies();
  const status = useStatus(accounts.list.length);
  const update = useUpdateMessage();
  const [showModal, setShowModal] = useState(false);
  const prevUpdateAvailable = useRef(false);

  // Auto-open modal when update becomes available after a check
  useEffect(() => {
    if (update.hasUpdate && !prevUpdateAvailable.current) {
      setShowModal(true);
    }
    prevUpdateAvailable.current = update.hasUpdate;
  }, [update.hasUpdate]);

  const handleProxyChange = async (accountId: string, proxyId: string) => {
    accounts.patchLocal(accountId, { proxyId });
    await proxies.assignProxy(accountId, proxyId);
  };

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
      />
      <main class="flex-grow px-4 md:px-8 lg:px-40 py-8 flex justify-center">
        <div class="flex flex-col w-full max-w-[960px] gap-6">
          <AddAccount
            visible={accounts.addVisible}
            onSubmitRelay={accounts.submitRelay}
            addInfo={accounts.addInfo}
            addError={accounts.addError}
          />
          <AccountList
            accounts={accounts.list}
            loading={accounts.loading}
            onDelete={accounts.deleteAccount}
            onRefresh={accounts.refresh}
            refreshing={accounts.refreshing}
            lastUpdated={accounts.lastUpdated}
            proxies={proxies.proxies}
            onProxyChange={handleProxyChange}
          />
          <ProxyPool proxies={proxies} />
          <ApiConfig
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
          <AnthropicSetup
            apiKey={status.apiKey}
            selectedModel={status.selectedModel}
            reasoningEffort={status.selectedEffort}
            serviceTier={status.selectedSpeed}
          />
          <CodeExamples
            baseUrl={status.baseUrl}
            apiKey={status.apiKey}
            model={status.selectedModel}
            reasoningEffort={status.selectedEffort}
            serviceTier={status.selectedSpeed}
          />
        </div>
      </main>
      <Footer updateStatus={update.status} />
      {update.proxyUpdateInfo && (
        <UpdateModal
          open={showModal}
          onClose={() => setShowModal(false)}
          mode={update.proxyUpdateInfo.mode}
          commits={update.proxyUpdateInfo.commits}
          release={update.proxyUpdateInfo.release}
          onApply={update.applyUpdate}
          applying={update.applying}
          restarting={update.restarting}
          restartFailed={update.restartFailed}
        />
      )}
    </>
  );
}

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const handler = () => setHash(location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const isProxySettings = hash === "#/proxy-settings";

  return (
    <I18nProvider>
      <ThemeProvider>
        {isProxySettings ? <ProxySettingsPage /> : <Dashboard />}
      </ThemeProvider>
    </I18nProvider>
  );
}

function ProxySettingsPage() {
  const update = useUpdateMessage();

  return (
    <>
      <Header
        onAddAccount={() => { location.hash = ""; }}
        onCheckUpdate={update.checkForUpdate}
        checking={update.checking}
        updateStatusMsg={update.msg}
        updateStatusColor={update.color}
        version={update.status?.proxy.version ?? null}
        commit={update.status?.proxy.commit ?? null}
        isProxySettings
        hasUpdate={update.hasUpdate}
      />
      <ProxySettings />
    </>
  );
}
