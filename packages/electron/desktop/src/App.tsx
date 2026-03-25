import { useState, useEffect } from "preact/hooks";
import { I18nProvider } from "@shared/i18n/context";
import { ThemeProvider } from "@shared/theme/context";
import { Header } from "./components/Header";
import { AccountList } from "./components/AccountList";
import { AddAccount } from "./components/AddAccount";
import { ProxyPool } from "./components/ProxyPool";
import { ApiConfig } from "./components/ApiConfig";
import { AnthropicSetup } from "./components/AnthropicSetup";
import { CodeExamples } from "./components/CodeExamples";
import { TestConnection } from "./components/TestConnection";
import { Footer } from "./components/Footer";
import { ProxySettings } from "./pages/ProxySettings";
import { useAccounts } from "@shared/hooks/use-accounts";
import { useProxies } from "@shared/hooks/use-proxies";
import { useStatus } from "@shared/hooks/use-status";
import { useUpdateStatus } from "@shared/hooks/use-update-status";

/** Minimal status hook — only used for version/commit display.
 *  Updates are handled by electron-updater via system tray. */
function useVersionInfo() {
  const update = useUpdateStatus();
  return {
    version: update.status?.proxy.version ?? null,
    commit: update.status?.proxy.commit ?? null,
  };
}

function Dashboard() {
  const accounts = useAccounts();
  const proxies = useProxies();
  const status = useStatus(accounts.list.length);
  const versionInfo = useVersionInfo();

  const handleProxyChange = async (accountId: string, proxyId: string) => {
    accounts.patchLocal(accountId, { proxyId });
    await proxies.assignProxy(accountId, proxyId);
  };

  return (
    <>
      <Header
        onAddAccount={accounts.startAdd}
        version={versionInfo.version}
        commit={versionInfo.commit}
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
            onAddByRefreshToken={accounts.addByRefreshToken}
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
          <TestConnection />
        </div>
      </main>
      <Footer updateStatus={null} />
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
  const versionInfo = useVersionInfo();

  return (
    <>
      <Header
        onAddAccount={() => { location.hash = ""; }}
        version={versionInfo.version}
        commit={versionInfo.commit}
        isProxySettings
      />
      <ProxySettings />
    </>
  );
}
